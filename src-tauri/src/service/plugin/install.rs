//! 插件包安装：校验包规格、准备环境（pnpm/dsh shim、按需补齐捆绑 pnpm、
//! 停止运行中的服务），随后调用 `dsh plugin --profile <active> add <specs...>`，
//! 并把子进程输出转发到下载中心。
//!
//! pnpm v11 对两类构建脚本默认不放行、缺白名单时报硬错误：
//! 1. git 托管插件的 `prepare` 构建（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）——
//!    其允许键（depPath = `name@<pkgResolutionId>`）随 pnpm 的克隆方式变化
//!    （git+ssh#sha / codeload tar.gz），无法预先确定；
//! 2. 传递依赖的原生构建（如 `node-pty`，`ERR_PNPM_IGNORED_BUILDS`）。
//! 因此在安装失败时从 pnpm 错误输出解析它建议的 `allowBuilds` 键，写入 profile
//! 的 `pnpm-workspace.yaml` 后重试，直至成功或无可解析项。

use crate::config;
use crate::service::cli;
use crate::service::download;
use crate::service::download::Installable;
use crate::service::workflow;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::installed::profile_dir;
use super::process::{run_plugin_process, PluginInstallLogPayload, PLUGIN_INSTALL_LOG_EVENT};

/// 允许构建重试的上限。每次重试解决 pnpm 报出的一个允许键（git depPath 或
/// 传递构建包名），多个 git 插件 / 多个原生依赖各占一次，上限封顶防死循环。
const MAX_ALLOW_LIST_RETRIES: usize = 8;
const MISSING_TARBALL_INTEGRITY_MARKER: &str = "ERR_PNPM_MISSING_TARBALL_INTEGRITY";

/// 可安全用于插件安装的用户 pnpm 最低主版本。
///
/// pnpm 10+ 才从 `pnpm-workspace.yaml` 读取 `autoInstallPeers`（9 及更早只读
/// `.npmrc`），且 10+ 移除了 workspace-root 安装门槛（`ERR_PNPM_ADDING_TO_ROOT`
/// 是 8/9 行为）。低于此版本时插件安装必须改用捆绑版 pnpm，否则会出现
/// 自动合成 peer 后 `No matching version found for @deepseek-ai/...` 的假失败。
const MIN_TRUSTED_PNPM_MAJOR: u32 = 10;

/// Parse manual input using the same command shape accepted by community pack READMEs.
/// Full commands contribute only their package spec; the selected instance still owns
/// the effective Profile. Bare specs remain supported for backwards compatibility.
pub fn parse_manual_specs(input: &str) -> Result<Vec<String>, String> {
    let mut specs = Vec::new();
    for line in input.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with("dsh ") {
            let tokens = tokenize_manual_command(line)?;
            specs.push(tokens[5].clone());
        } else {
            specs.extend(
                line.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.trim_matches(['\'', '"']).to_string()),
            );
        }
    }
    if specs.is_empty() {
        return Err("PLUGIN_INSTALL_EMPTY: no package specs supplied".to_string());
    }
    Ok(specs)
}

fn tokenize_manual_command(line: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in line.chars() {
        match (quote, ch) {
            (Some(expected), value) if value == expected => quote = None,
            (Some(_), value) => current.push(value),
            (None, '\'' | '"') => quote = Some(ch),
            (None, value) if value.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            (None, value) => current.push(value),
        }
    }
    if quote.is_some() {
        return Err("PLUGIN_INSTALL_COMMAND_INVALID: unclosed quote".to_string());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.len() != 6
        || tokens[0] != "dsh"
        || tokens[1] != "plugin"
        || tokens[2] != "--profile"
        || tokens[3].is_empty()
        || tokens[4] != "add"
    {
        return Err(
            "PLUGIN_INSTALL_COMMAND_INVALID: expected `dsh plugin --profile <profile> add <spec>`"
                .to_string(),
        );
    }
    Ok(tokens)
}

/// 安装用户提供的 npm/git 包规格：`dsh plugin --profile <active> add <specs...>`。
/// 不读取或依赖任何本地插件目录，包规格由远程市场或用户手动输入提供。
pub async fn install(app_handle: &AppHandle, specs: &[String]) -> Result<(), String> {
    if specs.is_empty() {
        return Err("PLUGIN_INSTALL_EMPTY: no package specs supplied".to_string());
    }
    let mut normalized_specs = Vec::with_capacity(specs.len());
    for spec in specs {
        let value = spec.trim();
        if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
            return Err(
                "PLUGIN_INSTALL_INVALID_SPEC: package spec is empty or invalid".to_string(),
            );
        }
        if value.starts_with('-') {
            return Err(
                "PLUGIN_INSTALL_INVALID_SPEC: package spec cannot start with '-'".to_string(),
            );
        }
        normalized_specs.push(value.to_string());
    }

    let before_dependencies = snapshot_dependencies(app_handle);

    // 确保 pnpm/dsh shim 存在
    cli::ensure_shims(app_handle)?;

    let node = config::get_node_binary_path(app_handle);
    let dsh_bin = config::get_dsh_binary_path(app_handle);
    if !node.exists() {
        return Err("NODE_NOT_FOUND: Node.js runtime missing".to_string());
    }
    if !dsh_bin.exists() {
        return Err("HARNESS_NOT_FOUND: dsh CLI missing".to_string());
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;

    // 选定/补齐安装用的 pnpm：返回是否应强制使用捆绑版（版本感知，见 ensure_pnpm）
    let prefer_bundled_pnpm = ensure_pnpm(app_handle, &window).await?;

    // 安装前停止运行中的服务，避免资源冲突
    if workflow::has_owned_process() {
        log::info!("Stopping running harness service before installing plugin packages");
        if let Err(e) = workflow::stop(app_handle.clone()).await {
            log::warn!("failed to stop harness before plugin install: {e}");
        }
    }

    // 构建环境变量
    let bin_dir = cli::get_bin_dir(app_handle);
    let mut envs = HashMap::from([
        (
            "DSH_HOME".to_string(),
            config::get_dsh_data_path(app_handle)
                .to_string_lossy()
                .into_owned(),
        ),
        ("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
    ]);
    // 用户 pnpm 过旧/不可探测时强制 pnpm shim 优先捆绑版，避免 8/9 的
    // autoInstallPeers 语义与 workspace-root gate 破坏插件安装（见 ensure_pnpm）
    if prefer_bundled_pnpm {
        envs.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
    }

    let mut paths = vec![bin_dir];
    if let Some(node_dir) = node.parent() {
        paths.push(node_dir.to_path_buf());
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));

    if let Ok(joined) = std::env::join_paths(paths) {
        envs.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
    }

    // 拼装命令行参数
    let mut args = vec![
        dsh_bin.as_os_str().to_os_string(),
        OsString::from("plugin"),
        OsString::from("--profile"),
        OsString::from(config::get_active_profile()),
        OsString::from("add"),
    ];
    args.extend(normalized_specs.iter().map(|s| OsString::from(s.as_str())));

    let cwd = config::get_dsh_install_path(app_handle);
    // 日志打印实际传给 dsh 的 spec（此前打印 id 会误导排查：安装用的是 spec）
    log::info!("Running dsh plugin install for {normalized_specs:?}");

    // `dsh plugin add` 在 profile 目录里驱动 pnpm。pnpm v11 会拦下 git 托管
    // 插件的 prepare 构建与传递原生依赖（见模块头注），其允许键不可预知，因此
    // 失败时解析输出里印出的 `allowBuilds` 键写回 profile 的 pnpm-workspace.yaml
    // 后重试，直至成功或再无键可加。
    let mut retries = 0usize;
    let mut repaired_lockfile = false;
    let exit_code = loop {
        let (code, captured) = run_plugin_process(&node, &args, &cwd, &envs, &window).await?;
        if code == 0 {
            break 0;
        }

        // pnpm refuses a frozen install when a git/tarball lock entry lacks
        // integrity. Repair only this known condition with pnpm itself, then
        // retry the original command with supply-chain verification intact.
        if !repaired_lockfile && captured.contains(MISSING_TARBALL_INTEGRITY_MARKER) {
            repaired_lockfile = true;
            let _ = window.emit(
                PLUGIN_INSTALL_LOG_EVENT,
                PluginInstallLogPayload {
                    line: "[pnpm] 正在修复缺少完整性校验的锁文件条目…".to_string(),
                },
            );
            if repair_lockfile(app_handle, &node, &envs, &window).await? {
                let _ = window.emit(
                    PLUGIN_INSTALL_LOG_EVENT,
                    PluginInstallLogPayload {
                        line: "[pnpm] 锁文件完整性已修复，重试安装…".to_string(),
                    },
                );
                continue;
            }
        }

        let new_keys = parse_allowlist_keys(&captured);
        if new_keys.is_empty() || retries >= MAX_ALLOW_LIST_RETRIES {
            log::error!(
                "dsh plugin install failed with exit code {code}; no more allowBuilds entries to add"
            );
            break code;
        }

        retries += 1;
        add_allow_build_keys(app_handle, &new_keys)?;
        log::info!("pnpm allowBuilds updated with {new_keys:?}, retrying ({retries})");
        let _ = window.emit(
            PLUGIN_INSTALL_LOG_EVENT,
            PluginInstallLogPayload {
                line: "[pnpm] 已放行插件构建（allowBuilds），重试安装…".to_string(),
            },
        );
    };

    if exit_code != 0 {
        log::error!("dsh plugin install failed with exit code {exit_code}");
        if crate::service::plugin::install_was_cancelled() {
            return Err("PLUGIN_INSTALL_CANCELLED: plugin installation was stopped".to_string());
        }
        return Err(format!(
            "PLUGIN_INSTALL_FAILED: dsh plugin exited with code {exit_code}"
        ));
    }

    validate_added_plugins(app_handle, &before_dependencies)?;

    log::info!("Plugin packages installed successfully: {normalized_specs:?}");
    Ok(())
}

/// Ask pnpm to regenerate missing tarball integrity fields without changing
/// package versions or running lifecycle scripts. Returns false on failure so
/// the original verified install error remains visible to the user.
async fn repair_lockfile(
    app_handle: &AppHandle,
    node: &std::path::Path,
    envs: &HashMap<String, String>,
    window: &WebviewWindow,
) -> Result<bool, String> {
    let bundled = config::get_pnpm_binary_path(app_handle);
    let mut program = node.to_path_buf();
    let mut args = Vec::new();
    if bundled.is_file() {
        args.push(bundled.as_os_str().to_os_string());
    } else if let Some(user_pnpm) = cli::find_user_pnpm(app_handle) {
        #[cfg(windows)]
        {
            let parent = user_pnpm
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            let cjs = parent.join("node_modules/pnpm/bin/pnpm.cjs");
            let mjs = parent.join("node_modules/pnpm/bin/pnpm.mjs");
            if cjs.is_file() {
                args.push(cjs.into_os_string());
            } else if mjs.is_file() {
                args.push(mjs.into_os_string());
            } else if user_pnpm.extension().is_some_and(|value| value == "exe") {
                program = user_pnpm;
            } else {
                return Ok(false);
            }
        }
        #[cfg(not(windows))]
        {
            program = user_pnpm;
        }
    } else {
        return Ok(false);
    }
    args.extend([
        OsString::from("install"),
        OsString::from("--lockfile-only"),
        OsString::from("--fix-lockfile"),
        OsString::from("--ignore-scripts"),
    ]);
    let cwd = profile_dir(app_handle);
    let (code, output) = run_plugin_process(&program, &args, &cwd, envs, window).await?;
    if code == 0 {
        Ok(true)
    } else {
        log::warn!("pnpm lockfile repair failed with exit code {code}: {output}");
        Ok(false)
    }
}

/// 使用 DSH 原生命令移除一个 Profile 插件及其依赖记录。
pub async fn remove(app_handle: &AppHandle, plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty()
        || plugin_id.len() > 256
        || plugin_id.starts_with('-')
        || plugin_id.chars().any(char::is_control)
        || plugin_id.contains('\\')
        || plugin_id
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("PLUGIN_INVALID_ID: plugin id is invalid".to_string());
    }

    cli::ensure_shims(app_handle)?;
    let node = config::get_node_binary_path(app_handle);
    let dsh_bin = config::get_dsh_binary_path(app_handle);
    if !node.exists() {
        return Err("NODE_NOT_FOUND: Node.js runtime missing".to_string());
    }
    if !dsh_bin.exists() {
        return Err("HARNESS_NOT_FOUND: dsh CLI missing".to_string());
    }
    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;
    let prefer_bundled_pnpm = ensure_pnpm(app_handle, &window).await?;
    let bin_dir = cli::get_bin_dir(app_handle);
    let mut envs = HashMap::from([
        (
            "DSH_HOME".to_string(),
            config::get_dsh_data_path(app_handle)
                .to_string_lossy()
                .into_owned(),
        ),
        ("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
    ]);
    if prefer_bundled_pnpm {
        envs.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
    }
    let mut paths = vec![bin_dir];
    if let Some(node_dir) = node.parent() {
        paths.push(node_dir.to_path_buf());
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    if let Ok(joined) = std::env::join_paths(paths) {
        envs.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
    }
    let args = vec![
        dsh_bin.as_os_str().to_os_string(),
        OsString::from("plugin"),
        OsString::from("--profile"),
        OsString::from(config::get_active_profile()),
        OsString::from("remove"),
        OsString::from(plugin_id),
    ];
    let cwd = config::get_dsh_install_path(app_handle);
    let (exit_code, _) = run_plugin_process(&node, &args, &cwd, &envs, &window).await?;
    if exit_code != 0 {
        return Err(format!(
            "PLUGIN_REMOVE_FAILED: dsh exited with code {exit_code}"
        ));
    }
    Ok(())
}

fn snapshot_dependencies(app_handle: &AppHandle) -> HashSet<String> {
    let path = profile_dir(app_handle).join("package.json");
    let Ok(content) = std::fs::read_to_string(path) else {
        return HashSet::new();
    };
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|value| {
            value
                .get("dependencies")
                .and_then(|deps| deps.as_object())
                .cloned()
        })
        .map(|deps| deps.keys().cloned().collect())
        .unwrap_or_default()
}

/// 校验本次新增依赖是否是真正的 DSH Profile bundle。
fn validate_added_plugins(
    app_handle: &AppHandle,
    before_dependencies: &HashSet<String>,
) -> Result<(), String> {
    let profile = profile_dir(app_handle);
    let manifest_path = profile.join("package.json");
    let content = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("PLUGIN_INSTALL_PROFILE_READ: {error}"))?;
    let manifest = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("PLUGIN_INSTALL_PROFILE_JSON: {error}"))?;
    let Some(dependencies) = manifest
        .get("dependencies")
        .and_then(|value| value.as_object())
    else {
        return Ok(());
    };

    let mut invalid = Vec::new();
    for name in dependencies
        .keys()
        .filter(|name| !before_dependencies.contains(*name))
    {
        let package_dir = profile.join("node_modules").join(name);
        let package_path = package_dir.join("package.json");
        let Ok(package_content) = std::fs::read_to_string(&package_path) else {
            invalid.push(name.clone());
            continue;
        };
        let Ok(package) = serde_json::from_str::<serde_json::Value>(&package_content) else {
            invalid.push(name.clone());
            continue;
        };
        let patch = package
            .get("dsh")
            .and_then(|dsh| dsh.get("bundle"))
            .and_then(|bundle| bundle.get("patch"))
            .and_then(|value| value.as_str());
        let Some(patch) = patch else {
            invalid.push(name.clone());
            continue;
        };
        if std::path::Path::new(patch).is_absolute() || patch.contains("..") {
            invalid.push(name.clone());
            continue;
        }
        if !package_dir.join(patch).is_file() {
            invalid.push(name.clone());
        }
    }

    if invalid.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "PLUGIN_INSTALL_INVALID_PACKAGE: packages do not expose a valid dsh.bundle.patch: {}",
            invalid.join(", ")
        ))
    }
}

/// 确保插件安装使用的 pnpm 可用，返回是否应强制使用捆绑版
/// （true 时调用方注入 `DSH_PREFER_BUNDLED_PNPM=1`，pnpm shim 优先捆绑版）。
///
/// 版本感知策略，避免给已装正确 pnpm 的用户增加下载步骤：
/// - 捆绑版已存在 → 直接用捆绑版（零额外下载，确定性最强）；
/// - 用户 pnpm 主版本 ≥ MIN_TRUSTED_PNPM_MAJOR → 复用用户 pnpm，零额外步骤；
/// - 用户 pnpm 过旧（8/9：不读 pnpm-workspace.yaml 的 autoInstallPeers、有
///   workspace-root gate；corepack shim 在 Node 24 上还会 ERR_INVALID_THIS 崩溃）
///   或版本不可探测 → 下载捆绑版并强制使用。
async fn ensure_pnpm(app_handle: &AppHandle, window: &WebviewWindow) -> Result<bool, String> {
    if config::get_pnpm_binary_path(app_handle).exists() {
        return Ok(true);
    }

    match user_pnpm_major_version(app_handle) {
        Some(major) if major >= MIN_TRUSTED_PNPM_MAJOR => {
            log::info!("Reusing user-installed pnpm (major {major}) for plugin install");
            return Ok(false);
        }
        Some(major) => {
            log::warn!(
                "User pnpm major {major} < {MIN_TRUSTED_PNPM_MAJOR} (missing autoInstallPeers/workspace-root semantics), downloading bundled pnpm"
            );
        }
        None => {
            log::warn!(
                "User pnpm version not detectable (broken/blocked shim?), downloading bundled pnpm"
            );
        }
    }

    let _ = window.emit(
        PLUGIN_INSTALL_LOG_EVENT,
        PluginInstallLogPayload {
            line: "[pnpm] bundled pnpm not found, downloading before plugin install".to_string(),
        },
    );

    let tracker = download::ProgressTracker::new(window, 2);
    let url = download::Pnpm.get_download_url()?;
    let name = url.split('/').next_back().unwrap_or(&url).to_string();
    let buffer = download::download_file(&tracker, url)
        .await
        .map_err(|e| format!("PNPM_DOWNLOAD_FAILED: {e}"))?;
    download::verify_sha256(&buffer, config::PNPM_SHA256)
        .map_err(|e| format!("PNPM_INTEGRITY_FAILED: {e}"))?;
    let dest = download::Pnpm.get_install_path(app_handle);

    download::ensure_extract(&tracker, name, buffer, dest)
        .await
        .map_err(|e| format!("PNPM_EXTRACT_FAILED: {e}"))?;

    let _ = window.emit(
        PLUGIN_INSTALL_LOG_EVENT,
        PluginInstallLogPayload {
            line: "[pnpm] bundled pnpm ready".to_string(),
        },
    );
    Ok(true)
}

/// 用户 pnpm 主版本号（解析 `pnpm --version` 首个点分字段）；不存在或不可运行
/// （corepack shim 在 Node 24 上 ERR_INVALID_THIS 崩溃等）返回 None。
fn user_pnpm_major_version(app_handle: &AppHandle) -> Option<u32> {
    let pnpm = cli::find_user_pnpm(app_handle)?;
    let output = std::process::Command::new(&pnpm)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.split('.').next()?.trim().parse::<u32>().ok()
}

/// 从 pnpm 失败输出中解析需写入 `allowBuilds` 的键集合：
/// - git 托管插件 prepare 被拦时，pnpm 会提示 `allowBuilds:\n  <depPath>: true`，
///   原样采纳 depPath（形式随克隆方式变化，只能是运行期报出的值）；
/// - 传递原生依赖被忽略构建（`Ignored build scripts:`）时，取其 `name@version` 的包名。
fn parse_allowlist_keys(output: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let lines: Vec<&str> = output.lines().collect();

    // 1) git depPath 允许键：跟随 `allowBuilds:` 示例行后的缩进 `<key>: true`。
    for (idx, line) in lines.iter().enumerate() {
        if line.trim() == "allowBuilds:" {
            if let Some(next) = lines.get(idx + 1) {
                if let Some(key) = extract_allow_line_key(next) {
                    if !keys.iter().any(|k| k == &key) {
                        keys.push(key);
                    }
                }
            }
        }
    }

    // Some pnpm versions omit or truncate the YAML example. The error itself still
    // identifies both the package and the exact fetched URL, which form the same
    // depPath key (`name@resolution`) that pnpm expects in allowBuilds.
    if keys.is_empty() {
        let package_ref = lines
            .iter()
            .find_map(|line| quoted_after(line, "The git-hosted package "));
        let fetched_url = lines
            .iter()
            .find_map(|line| quoted_after(line, "git-hosted package fetched from "));
        if let (Some(package_ref), Some(fetched_url)) = (package_ref, fetched_url) {
            if let Some(package_name) = package_name_from_ref(&package_ref) {
                keys.push(format!("{package_name}@{fetched_url}"));
                keys.push(package_name.to_string());
            }
        }
    }

    // 2) 传递原生构建包名：`Ignored build scripts: <name>@<ver>, ...`。
    for line in &lines {
        if let Some(sub) = line.split("Ignored build scripts:").nth(1) {
            for token in sub.split([',', ' ']) {
                let token = token.trim();
                if token.is_empty() {
                    continue;
                }
                let name = token.split('@').next().unwrap_or(token).trim();
                if !name.is_empty() && !keys.iter().any(|k| k == name) {
                    keys.push(name.to_string());
                }
            }
        }
    }

    keys
}

fn quoted_after(line: &str, marker: &str) -> Option<String> {
    let value = line.split_once(marker)?.1.trim_start_matches('\\');
    let value = value.strip_prefix('"')?;
    Some(value.split_once('"')?.0.trim_end_matches('\\').to_string())
}

fn package_name_from_ref(package_ref: &str) -> Option<&str> {
    let version_separator = package_ref.rfind('@')?;
    if version_separator == 0 {
        return None;
    }
    Some(&package_ref[..version_separator])
}

/// 若 `line` 形如 `  <key>: true`（有缩进），返回 `<key>`（去缩进与后缀）。
/// pnpm 报出的 depPath 键本身不带引号，这里只做剥离该行格式。
fn extract_allow_line_key(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.len() == line.len() {
        return None; // 无缩进，不是白名单条目
    }
    let suffix = trimmed.strip_suffix(": true")?;
    let key = suffix.trim_end();
    if key.is_empty() {
        return None;
    }
    Some(key.to_string())
}

/// profile 下的 `pnpm-workspace.yaml` 路径（$DSH_HOME/profiles/web）
fn profile_workspace_path(app_handle: &AppHandle) -> PathBuf {
    profile_dir(app_handle).join("pnpm-workspace.yaml")
}

/// 把新的 `allowBuilds` 键合并写回 profile 的 `pnpm-workspace.yaml`。
///
/// dsh 的 `initProfile` 仅在文件缺失时创建（其模板无 `allowBuilds`），因此桌面端
/// 自行维护该块：缺失时按 dsh 模板补建基础设置并追加 `allowBuilds`；已有时按键
/// 去重合并。git depPath 键含 `@`/`/`/`:`/`#`，按 YAML 单引号标量写入避免误解析；
/// `false` 不应出现于此（我们只放行）。重复写入同一键是无害的（幂等）。
fn add_allow_build_keys(app_handle: &AppHandle, keys: &[String]) -> Result<(), String> {
    let path = profile_workspace_path(app_handle);
    let dir = path
        .parent()
        .ok_or("PLUGIN_INSTALL_BAD_PROFILE_DIR: no profile dir")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("PLUGIN_INSTALL_MKDIR: {e}"))?;

    let mut content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| format!("PLUGIN_INSTALL_READ_WORKSPACE: {e}"))?
    } else {
        // 与 dsh `initProfile` 生成的基础模板保持一致（尚无 allowBuilds）
        "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n".to_string()
    };

    let has_allow_builds = content
        .lines()
        .any(|l| l.trim_start().starts_with("allowBuilds:"));
    if !has_allow_builds {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str("allowBuilds:\n");
    }

    // 收集已有 `  <key>: true` 条目（含单引号形式），避免重复。基础模板里
    // 的 `packages`/`nodeLinker`/`autoInstallPeers` 等行不会以 `: true` 结尾，
    // 天然被排除。
    let existing: Vec<String> = content
        .lines()
        .filter_map(|l| {
            let trimmed = l.trim_start();
            if trimmed.len() == l.len() {
                return None; // 非缩进行（顶层键）不参与
            }
            let suffix = trimmed.strip_suffix(": true")?;
            let key = suffix.trim().trim_matches(['\'', '"']);
            if key.is_empty() || key.contains(':') {
                return None;
            }
            Some(key.to_string())
        })
        .collect();

    let mut dirty = false;
    for key in keys {
        if existing.iter().any(|k| k == key) {
            continue;
        }
        // 单引号包裹键：git depPath 含 `:`/`#`/`@`，裸写会让 YAML 误解析
        content.push_str(&format!("  '{}': true\n", key.replace('\'', "''")));
        dirty = true;
    }
    if !dirty {
        return Ok(());
    }

    std::fs::write(&path, content).map_err(|e| format!("PLUGIN_INSTALL_WRITE_WORKSPACE: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{extract_allow_line_key, parse_allowlist_keys, parse_manual_specs};

    #[test]
    fn parses_community_commands_and_bare_specs() {
        let input = r#"dsh plugin --profile web add github:baihejiangnan/dsh-session-context-menu
dsh plugin --profile web add "https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.3.tar.gz"
@liustack/modlens"#;
        assert_eq!(
            parse_manual_specs(input).unwrap(),
            vec![
                "github:baihejiangnan/dsh-session-context-menu",
                "https://github.com/omdsh-dev/dsh-at-file/archive/refs/tags/v0.6.3.tar.gz",
                "@liustack/modlens",
            ]
        );
    }

    #[test]
    fn rejects_non_community_command_shape() {
        assert!(parse_manual_specs("dsh plugin add example").is_err());
    }

    #[test]
    fn parse_git_dep_path_key() {
        let out = "\
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from \"...\"
The git-hosted package \"dsh-better-sidebar@0.14.0\" needs to execute build scripts but is not in the \"allowBuilds\" allowlist.
...
allowBuilds:
  dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89: true
";
        let keys = parse_allowlist_keys(out);
        assert!(keys.contains(
            &"dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                .to_string()
        ));
        assert!(!keys.contains(&"dsh-better-sidebar".to_string()));
    }

    #[test]
    fn parse_git_dep_path_without_yaml_example() {
        let out = r#"[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "https://codeload.github.com/LX2000WASD/dsh-web-plugin-manager/tar.gz/633d9fc2abd851a5a811d2ed06921a9711606c6f"
The git-hosted package "dsh-web-plugin-manager@0.4.7" needs to execute build scripts but is not in the "allowBuilds" allowlist."#;
        assert_eq!(
            parse_allowlist_keys(out),
            vec![
                "dsh-web-plugin-manager@https://codeload.github.com/LX2000WASD/dsh-web-plugin-manager/tar.gz/633d9fc2abd851a5a811d2ed06921a9711606c6f",
                "dsh-web-plugin-manager",
            ]
        );
    }

    #[test]
    fn parses_escaped_quote_prefix_from_rendered_logs() {
        assert_eq!(
            super::quoted_after(
                r#"Failed to prepare git-hosted package fetched from \"https://example.test/plugin.tgz\""#,
                "git-hosted package fetched from ",
            )
            .as_deref(),
            Some("https://example.test/plugin.tgz")
        );
    }

    #[test]
    fn parse_ignored_builds_name() {
        let out = "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["node-pty".to_string()]);
    }

    #[test]
    fn parse_empty_when_irrelevant() {
        let out = "everything looks fine output\nno allowlist here\n";
        assert!(parse_allowlist_keys(out).is_empty());
    }

    #[test]
    fn allow_line_key_requires_indent() {
        let key = extract_allow_line_key("  node-pty: true");
        assert_eq!(key.as_deref(), Some("node-pty"));

        // 无缩进（顶层键）不应被当作白名单条目
        assert_eq!(extract_allow_line_key("packages:"), None);
        assert_eq!(extract_allow_line_key("allowBuilds:"), None);
    }
}
