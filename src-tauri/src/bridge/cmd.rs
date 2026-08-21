use crate::config;
use crate::service::cli;
use crate::service::download::{self, Installable};
use crate::service::export;
use crate::service::plugin;
use crate::service::update;
use crate::service::workflow;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

/// 二次开发期间暂停桌面客户端跟随上游仓库自更新。
/// DSH/Harness 更新使用独立的 check_dsh_update/install_dependencies 流程，不受影响。
const DESKTOP_UPDATES_PAUSED: bool = true;

/// DSH 核心包的更新只能由启动器执行。实例宿主共享同一套命令注册表，
/// 但它只负责运行已安装的 DSH，不能从实例窗口触发下载或替换运行时文件。
fn ensure_launcher_update_context() -> Result<(), String> {
    if matches!(
        crate::desktop::mode::current(),
        crate::desktop::mode::RunMode::Launcher
    ) {
        Ok(())
    } else {
        Err("DSH_UPDATE_LAUNCHER_ONLY".to_string())
    }
}

static INSTANCE_HOSTS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, std::process::Child>>,
> = std::sync::OnceLock::new();

// Active-instance based commands temporarily project an instance into legacy
// DSH helpers. Serialize that projection so concurrent requests cannot swap
// the global context while an async install/remove is still running.
static INSTANCE_OPERATION_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> =
    std::sync::OnceLock::new();

fn instance_operation_lock() -> &'static tokio::sync::Mutex<()> {
    INSTANCE_OPERATION_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[cfg(windows)]
struct InstanceWindowSearch {
    pid: u32,
    hwnd: Option<windows_sys::Win32::Foundation::HWND>,
}

#[cfg(windows)]
unsafe extern "system" fn find_instance_window(
    hwnd: windows_sys::Win32::Foundation::HWND,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::core::BOOL {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindowVisible};
    let search = &mut *(lparam as *mut InstanceWindowSearch);
    let mut window_pid = 0;
    GetWindowThreadProcessId(hwnd, &mut window_pid);
    if window_pid == search.pid && IsWindowVisible(hwnd) != 0 {
        search.hwnd = Some(hwnd);
        return 0;
    }
    1
}

fn instance_hosts(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, std::process::Child>> {
    INSTANCE_HOSTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn prune_instance_hosts(
    hosts: &mut std::collections::HashMap<String, std::process::Child>,
) -> Result<(), String> {
    let mut stopped = Vec::new();
    for (id, child) in hosts.iter_mut() {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            stopped.push(id.clone());
        }
    }
    for id in stopped {
        hosts.remove(&id);
    }
    Ok(())
}

fn instance_host_is_running(id: &str) -> Result<bool, String> {
    let mut hosts = instance_hosts()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    prune_instance_hosts(&mut hosts)?;
    Ok(hosts.contains_key(id))
}

fn instance_home_is_running(
    app_handle: &AppHandle,
    target: &config::instance::DshInstance,
) -> Result<Option<config::instance::DshInstance>, String> {
    let registry = config::instance::list(app_handle)?;
    for instance in registry.instances {
        if instance.dsh_home == target.dsh_home && instance_host_is_running(&instance.id)? {
            return Ok(Some(instance));
        }
    }
    Ok(None)
}

/// 按当前设置同步命令行集成（shim + PATH 注册）。
///
/// 安装/更新流程的收尾步骤，失败只记日志、不阻断主流程。
fn sync_cli_link(app_handle: &AppHandle) {
    let setting = config::get_store_dat_setting(app_handle);
    let result = if setting.cli_link_enabled {
        cli::ensure(app_handle)
    } else {
        cli::remove(app_handle)
    };
    if let Err(e) = result {
        log::warn!("cli link sync failed: {e}");
    }
}

/// 一键安装依赖（Node.js 运行时 + 打包的 Harness 发行版）
///
/// 返回是否真正执行了安装/更新：`true` 表示本次调用落盘了运行时（前端
/// 需重启服务以加载新版本），`false` 表示未发生任何安装（已是最新、记录
/// 自愈，或 GitHub 限流无法校验完整性而保持本地安装——此时前端不应重启、
/// 也不应丢弃“有新版本”提示，而应提示稍后重试）。
///
/// 启动逻辑由前端显式调用 `launch_harness` 完成，避免重复拉起进程。
#[tauri::command]
pub async fn install_dependencies(app_handle: AppHandle) -> Result<bool, String> {
    ensure_launcher_update_context()?;
    if workflow::status::get_status() == workflow::status::Status::Installing {
        log::info!("Installation process already running, skipping");
        return Ok(false);
    }

    // 以实际安装状态为准：本地安装与 GitHub 最新 release 的 commit hash
    // 不一致时，说明上游 pkg 有更新/修复，需要自动重新下载。
    let node_ok = download::Nodejs.check_installed(&app_handle);
    let dsh_files_ok = download::Dsh.check_installed(&app_handle);
    // pnpm 是 dsh plugin 子命令的运行时依赖（v0.3.0 起随环境安装）；老版本
    // 升级后 `installed` 已为 true 会跳过环境安装，捆绑 pnpm 可能从未落盘，
    // 需一并纳入"已就绪"判定，缺失时由 workflow::install 按任务补齐。
    let pnpm_ok = download::Pnpm.check_installed(&app_handle);

    // 启动自愈捷径：记录显示未安装、但运行时文件已全部在盘。常见于桌面端自更新
    // 安装器强杀进程，或上次启动时核心文件短暂缺失被 workflow::start 复位
    // `installed`（一旦复位，此后每次启动都会走进安装分支）。此时直接补记
    // installed 收尾：不做联网核对、绝不整包重下——联网核对可能把「记录滞后」
    // 误判为真更新，而重下整目录在 Windows 上极易破坏 node_modules（历史 issue：
    // 重解压后启动报找不到 @deepseek-ai/dsh-client-ui-settings）。真更新一律由
    // 启动后的 check_dsh_update 提示用户手动安装，启动路径不该自行下载。
    if node_ok && dsh_files_ok && pnpm_ok {
        let setting = config::get_store_dat_setting(&app_handle);
        if !setting.installed {
            log::info!(
                "Runtime files already present although store says not installed, healing installed flag"
            );
            let mut setting = config::get_store_dat_setting(&app_handle);
            setting.installed = true;
            config::set_store_dat_setting(&app_handle, setting);
            sync_cli_link(&app_handle);
            return Ok(false);
        }
    }

    let dsh_latest = download::fetch_latest_dsh_pkg_info().await;

    // 已安装文件在盘时，用 resolve_update 甄别「记录滞后」与「真更新」：
    // 记录滞后（HealUpToDate）只修正 store 记录、绝不整包重下。否则会把一个
    // 可用的 node_modules 整目录删除重解压，Windows 上原生模块 DLL 锁/重解压
    // 很容易留下破损安装，导致启动报找不到 @deepseek-ai/dsh-client-ui-settings
    // 或 HARNESS_NOT_FOUND。仅在真更新（UpdateAvailable）时才允许重新下载。
    let dsh_need_install = match &dsh_latest {
        Ok(latest) if dsh_files_ok => {
            let record_commit = config::get_dsh_pkg_commit(&app_handle);
            let record_tag = config::get_dsh_pkg_tag(&app_handle);
            let installed_version = config::get_dsh_version(&app_handle);
            // 老记录没有 tag，反查 pkg 仓库 tags 列表确认记录对应的发布版本；
            // 反查失败时由 resolve_update 回退到“以实际文件为准”的保守分支
            let legacy_tags = if record_tag.is_none() {
                download::fetch_dsh_pkg_tags().await.unwrap_or_default()
            } else {
                Vec::new()
            };
            match download::resolve_update(
                record_commit.as_deref(),
                record_tag.as_deref(),
                installed_version.as_deref(),
                latest,
                &legacy_tags,
            ) {
                // 安装文件已是最新 release，只是记录滞后：修正记录后下次
                // 启动直接走 commit 快速比对，不再误判、也绝不整包重下
                download::UpdateCheck::UpToDate | download::UpdateCheck::HealUpToDate => {
                    if record_commit.as_deref() != Some(latest.commit.as_str()) {
                        log::info!(
                            "Installed Harness files already at latest release, healing stale record: {} ({})",
                            latest.tag,
                            latest.commit
                        );
                        config::set_dsh_pkg_commit(&app_handle, latest.commit.clone());
                        config::set_dsh_pkg_tag(&app_handle, latest.tag.clone());
                    }
                    false
                }
                download::UpdateCheck::UpdateAvailable => {
                    // 有新版但 GitHub API 限流拿不到可信源码摘要时，不自动整包重下
                    // （无法校验完整性，Windows 上重解压还易损坏 node_modules）。
                    // 保持本地安装，更新提示由启动后的 check_dsh_update 给出，稍后可重试。
                    if latest.digest.is_none() {
                        log::warn!(
                            "New dsh release {} found but trusted digest unavailable (API rate-limited), keeping local install",
                            latest.tag
                        );
                        false
                    } else {
                        true
                    }
                }
            }
        }
        // 核心文件缺失（首次安装或目录被清空）→ 需要安装
        Ok(_) => true,
        Err(e) => {
            // 网络不可用或 GitHub API 限流时保留本地安装，不阻塞启动
            log::warn!(
                "Failed to check latest dsh release info, keeping local install: {}",
                e
            );
            !dsh_files_ok
        }
    };

    if node_ok && !dsh_need_install && pnpm_ok {
        log::info!("Dependencies already installed and up to date, skipping installation");
        let mut setting = config::get_store_dat_setting(&app_handle);
        if !setting.installed {
            setting.installed = true;
            config::set_store_dat_setting(&app_handle, setting);
        }
        sync_cli_link(&app_handle);
        return Ok(false);
    }

    log::info!("Dependencies missing or outdated, starting installation process");
    workflow::status::set_status(workflow::status::Status::Installing);
    workflow::status::emit_status(&app_handle);
    // 返回 dsh 是否真正落盘更新：仅重装 Node/pnpm 或全部任务被跳过（例如
    // 版本相同仅记录滞后）时为 false，前端据此决定是否重启页面/保留更新提示
    let updated = workflow::install(&app_handle, dsh_latest.ok()).await?;
    log::debug!("Installation completed, marked as installed");
    let mut setting = config::get_store_dat_setting(&app_handle);
    setting.installed = true;
    config::set_store_dat_setting(&app_handle, setting);
    if updated {
        workflow::refresh_web_capabilities(&app_handle);
    }
    sync_cli_link(&app_handle);
    Ok(updated)
}

/// 静默检查是否有新版 Harness 可用（只查不装，供进入页面后后台调用）
///
/// 以“实际安装文件”为准核对，而不是只看本地记录：记录可能因安装时 API
/// 失败或外围途径更新而滞后于文件，此时修正记录并免打扰；同版本热修
/// （版本相同但 commit 不同）仍正常提示。
#[tauri::command]
pub async fn check_dsh_update(
    app_handle: AppHandle,
) -> Result<Option<download::LatestDshPkg>, String> {
    ensure_launcher_update_context()?;
    // 本地没有安装时无需提示更新
    let dsh_files_ok = download::Dsh.check_installed(&app_handle);
    if !dsh_files_ok {
        return Ok(None);
    }

    let latest = download::fetch_latest_dsh_pkg_info().await?;
    let record_commit = config::get_dsh_pkg_commit(&app_handle);
    let record_tag = config::get_dsh_pkg_tag(&app_handle);
    let installed_version = config::get_dsh_version(&app_handle);

    // 老记录没有 tag，反查 pkg 仓库 tags 列表确认记录对应的发布版本；
    // 反查失败时由 resolve_update 回退到“以实际文件为准”的保守分支
    let legacy_tags = if record_tag.is_none() {
        download::fetch_dsh_pkg_tags().await.unwrap_or_default()
    } else {
        Vec::new()
    };

    match download::resolve_update(
        record_commit.as_deref(),
        record_tag.as_deref(),
        installed_version.as_deref(),
        &latest,
        &legacy_tags,
    ) {
        download::UpdateCheck::UpToDate => Ok(None),
        download::UpdateCheck::UpdateAvailable => Ok(Some(latest)),
        download::UpdateCheck::HealUpToDate => {
            // 安装文件已是最新 release，只是记录滞后：修正记录后下次启动
            // 直接走 commit 比对快速路径，不再误报
            log::info!(
                "Installed Harness files already at latest release, healing stale record: {} ({})",
                latest.tag,
                latest.commit
            );
            config::set_dsh_pkg_commit(&app_handle, latest.commit.clone());
            config::set_dsh_pkg_tag(&app_handle, latest.tag.clone());
            Ok(None)
        }
    }
}

/// 启动 Harness 服务
#[tauri::command]
pub async fn launch_harness(app_handle: AppHandle) -> Result<(), String> {
    workflow::launch(app_handle).await
}

#[tauri::command]
pub async fn export_instance_profile(
    app_handle: AppHandle,
    input: export::ProfileExportInput,
) -> Result<String, String> {
    export::export_profile(app_handle, input).await
}

#[tauri::command]
pub async fn export_instance_home(
    app_handle: AppHandle,
    instance_id: String,
) -> Result<String, String> {
    export::export_instance_home(app_handle, &instance_id).await
}

/// 从启动器派生一个独立实例宿主进程。宿主进程拥有自己的 Tauri 窗口、
/// Harness 子进程和运行时端口，不与启动器进程共享 workflow 全局状态。
#[tauri::command]
pub async fn launch_instance_window(app_handle: AppHandle, id: String) -> Result<u32, String> {
    let registry = config::instance::list(&app_handle)?;
    let target = registry
        .instances
        .iter()
        .find(|instance| instance.id == id)
        .cloned()
        .ok_or_else(|| format!("INSTANCE_NOT_FOUND: {id}"))?;

    // 实例宿主不负责下载运行时。首次安装仍在启动器进程完成，避免多个实例
    // 同时写入共享 dependencies 目录。
    let setting = config::get_store_dat_setting(&app_handle);
    if !setting.installed || !runtime_ready(app_handle.clone()) {
        install_dependencies(app_handle.clone()).await?;
    }

    let mut hosts = instance_hosts()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    prune_instance_hosts(&mut hosts)?;
    if let Some(child) = hosts.get_mut(&id) {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Ok(child.id());
        }
        hosts.remove(&id);
    }

    // 会话等数据写入 DSH_HOME。多个宿主即使 Profile 不同，同时写同一个
    // Home 仍会使 session log 的提交序号交叉，最终出现 seq gap。
    if let Some(running) = registry.instances.iter().find(|instance| {
        instance.id != id
            && instance.dsh_home == target.dsh_home
            && hosts.contains_key(&instance.id)
    }) {
        return Err(format!(
            "INSTANCE_HOME_RUNNING:{}:{}",
            running.id, running.name
        ));
    }

    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new(exe);
    command.args(["--mode", "instance", "--instance-id", &id]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("INSTANCE_HOST_SPAWN: {error}"))?;
    let pid = child.id();
    hosts.insert(id.clone(), child);
    log::info!("Instance host {id} started: pid={pid}");
    Ok(pid)
}

/// Bring a running instance host window to the foreground from the tray panel.
#[tauri::command]
pub fn focus_instance_window(id: String) -> Result<(), String> {
    let pid = {
        let mut hosts = instance_hosts()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        prune_instance_hosts(&mut hosts)?;
        hosts
            .get(&id)
            .map(std::process::Child::id)
            .ok_or_else(|| format!("INSTANCE_NOT_RUNNING: {id}"))?
    };

    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        let mut search = InstanceWindowSearch { pid, hwnd: None };
        unsafe {
            EnumWindows(
                Some(find_instance_window),
                &mut search as *mut InstanceWindowSearch as isize,
            );
            if let Some(hwnd) = search.hwnd {
                ShowWindow(hwnd, SW_RESTORE);
                SetForegroundWindow(hwnd);
                return Ok(());
            }
        }
        return Err(format!("INSTANCE_WINDOW_NOT_FOUND: {id}"));
    }

    #[cfg(not(windows))]
    {
        let _ = pid;
        Err("INSTANCE_WINDOW_FOCUS_UNSUPPORTED".to_string())
    }
}

#[tauri::command]
pub fn quit_app(app_handle: AppHandle) {
    app_handle.exit(0);
}

#[tauri::command]
pub fn list_running_instances() -> Result<Vec<String>, String> {
    let mut hosts = instance_hosts()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    prune_instance_hosts(&mut hosts)?;
    Ok(hosts.keys().cloned().collect())
}

/// 返回启动器当前托管实例的实际运行端口。
///
/// 每个实例宿主把 Harness 的 PID/端口写入自己的 DSH Home 下的
/// `.harness.pid`。只读取仍被实例宿主托管且端口仍在监听的记录，避免把
/// 崩溃后的陈旧端口展示给用户。
#[tauri::command]
pub fn get_running_instance_ports(
    app_handle: AppHandle,
) -> Result<std::collections::HashMap<String, u16>, String> {
    let registry = config::instance::list(&app_handle)?;
    let mut hosts = instance_hosts()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    prune_instance_hosts(&mut hosts)?;
    let running_ids: Vec<String> = hosts.keys().cloned().collect();
    drop(hosts);

    let mut ports = std::collections::HashMap::new();
    for id in running_ids {
        let Some(instance) = registry.instances.iter().find(|item| item.id == id) else {
            continue;
        };
        let path = std::path::Path::new(&instance.dsh_home).join(".harness.pid");
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let Some(port) = content
            .lines()
            .nth(1)
            .and_then(|line| line.trim().parse::<u16>().ok())
        else {
            continue;
        };
        if crate::service::workflow::utils::is_port_in_use(port) {
            ports.insert(id, port);
        }
    }
    Ok(ports)
}

#[tauri::command]
pub fn stop_instance_window(id: String) -> Result<(), String> {
    let mut hosts = instance_hosts()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    prune_instance_hosts(&mut hosts)?;
    let Some(mut child) = hosts.remove(&id) else {
        return Ok(());
    };
    let pid = child.id();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .status()
            .map_err(|error| format!("INSTANCE_HOST_STOP: {error}"))?;
        if !status.success() {
            return Err(format!("INSTANCE_HOST_STOP: taskkill exited with {status}"));
        }
    }
    #[cfg(not(windows))]
    child
        .kill()
        .map_err(|error| format!("INSTANCE_HOST_STOP: {error}"))?;

    let _ = child.wait();
    log::info!("Instance host {id} stopped: pid={pid}");
    Ok(())
}

#[tauri::command]
pub fn list_instances(app_handle: AppHandle) -> Result<config::instance::InstanceRegistry, String> {
    let registry = config::instance::list(&app_handle)?;
    config::instance::restore_active(&app_handle)?;
    Ok(registry)
}

#[tauri::command]
pub fn create_instance(
    app_handle: AppHandle,
    input: config::instance::CreateInstanceInput,
) -> Result<config::instance::DshInstance, String> {
    config::instance::create(&app_handle, input)
}

#[tauri::command]
pub fn update_instance(
    app_handle: AppHandle,
    input: config::instance::UpdateInstanceInput,
) -> Result<config::instance::DshInstance, String> {
    if instance_host_is_running(&input.id)? {
        return Err("INSTANCE_RUNNING: stop the instance before editing it".to_string());
    }
    config::instance::update(&app_handle, input)
}

#[tauri::command]
pub fn select_instance(
    app_handle: AppHandle,
    id: String,
) -> Result<config::instance::DshInstance, String> {
    if workflow::has_owned_process() {
        return Err("INSTANCE_RUNNING: stop the current instance before switching".to_string());
    }
    config::instance::select(&app_handle, &id)
}

#[tauri::command]
pub fn remove_instance(
    app_handle: AppHandle,
    id: String,
) -> Result<config::instance::InstanceRegistry, String> {
    let impact = config::instance::removal_impact(&app_handle, &id)?;
    let mut running = None;
    for instance in &impact.instances {
        if instance_host_is_running(&instance.id)? {
            running = Some(instance);
            break;
        }
    }
    if let Some(running) = running {
        return Err(format!(
            "INSTANCE_HOME_RUNNING:{}:{}",
            running.id, running.name
        ));
    }
    if workflow::has_owned_process()
        && config::instance::active().as_ref().is_some_and(|item| {
            impact
                .instances
                .iter()
                .any(|affected| affected.id == item.id)
        })
    {
        return Err(
            "INSTANCE_HOME_RUNNING:stop all instances sharing this DSH_HOME before removing it"
                .to_string(),
        );
    }
    config::instance::remove(&app_handle, &id)
}

#[tauri::command]
pub fn get_instance_removal_impact(
    app_handle: AppHandle,
    instance_id: String,
) -> Result<config::instance::InstanceRemovalImpact, String> {
    config::instance::removal_impact(&app_handle, &instance_id)
}

#[tauri::command]
pub fn get_instance_sharing(
    app_handle: AppHandle,
    dsh_home: std::path::PathBuf,
    profile: String,
    exclude_id: Option<String>,
) -> Result<config::instance::InstanceSharing, String> {
    config::instance::sharing(&app_handle, &dsh_home, &profile, exclude_id.as_deref())
}

#[tauri::command]
pub async fn choose_dsh_home() -> Option<String> {
    #[cfg(windows)]
    {
        rfd::AsyncFileDialog::new()
            .set_title("Choose DSH_HOME")
            .pick_folder()
            .await
            .map(|folder| folder.path().to_string_lossy().into_owned())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 停止 Harness 服务
#[tauri::command]
pub async fn shutdown_harness(app_handle: AppHandle) -> Result<(), String> {
    workflow::stop(app_handle).await
}

/// 重启 Harness 服务
#[tauri::command]
pub async fn restart_harness(app_handle: AppHandle) -> Result<(), String> {
    workflow::restart(app_handle).await
}

/// 获取当前 Harness 服务状态
#[tauri::command]
pub fn get_dsh_status() -> workflow::status::Status {
    workflow::status::get_status()
}

/// 安装用户提供的插件包规格（npm、git 或本地包路径）。
#[tauri::command]
pub async fn install_plugin_packages(
    app_handle: AppHandle,
    specs: Vec<String>,
) -> Result<(), String> {
    plugin::reset_cancel();
    if let Some(instance) = config::instance::active() {
        if instance_host_is_running(&instance.id)? {
            return Err(
                "INSTANCE_RUNNING: stop the instance before installing plugins".to_string(),
            );
        }
    }
    plugin::install(&app_handle, &specs).await
}

/// 在指定实例的 Home/Profile 上安装插件，不改变启动器当前选中实例。
#[tauri::command]
pub async fn install_plugin_packages_for_instance(
    app_handle: AppHandle,
    instance_id: String,
    input: String,
) -> Result<(), String> {
    plugin::reset_cancel();
    let target = config::instance::find(&app_handle, &instance_id)?;
    if let Some(running) = instance_home_is_running(&app_handle, &target)? {
        return Err(format!("INSTANCE_RUNNING:{}:{}", running.id, running.name));
    }
    let specs = plugin::install::parse_manual_specs(&input)?;
    let _operation_guard = instance_operation_lock().lock().await;
    let previous = config::instance::active();
    config::instance::set_active(Some(target));
    let mut result = Ok(());
    for spec in specs {
        if let Err(error) = plugin::install(&app_handle, &[spec]).await {
            result = Err(error);
            break;
        }
    }
    config::instance::set_active(previous);
    result
}

/// 获取社区精选插件目录；普通读取复用短期缓存，强制刷新由下载页按钮触发。
#[tauri::command]
pub async fn get_plugin_catalog(force: bool) -> Result<plugin::registry::PluginCatalog, String> {
    if force {
        plugin::registry::refresh().await
    } else {
        plugin::registry::fetch().await
    }
}

/// 按社区目录中的插件名称安装，并在安装前重新校验当前目录来源。
#[tauri::command]
pub async fn install_catalog_plugin_for_instance(
    app_handle: AppHandle,
    instance_id: String,
    plugin_name: String,
) -> Result<(), String> {
    plugin::reset_cancel();
    let catalog = plugin::registry::fetch().await?;
    let entry = catalog
        .plugins
        .iter()
        .find(|plugin| plugin.name == plugin_name)
        .ok_or_else(|| format!("PLUGIN_CATALOG_NOT_FOUND: {plugin_name}"))?;
    let spec = plugin::registry::install_spec(entry)?;
    let target = config::instance::find(&app_handle, &instance_id)?;
    if let Some(running) = instance_home_is_running(&app_handle, &target)? {
        return Err(format!("INSTANCE_RUNNING:{}:{}", running.id, running.name));
    }
    let _operation_guard = instance_operation_lock().lock().await;
    let previous = config::instance::active();
    config::instance::set_active(Some(target));
    let result = plugin::install(&app_handle, &[spec]).await;
    config::instance::set_active(previous);
    result
}

/// 读取插件包市场索引；市场数据只在启动器下载页按需加载。
#[tauri::command]
pub async fn get_plugin_pack_catalog(
    force: bool,
) -> Result<plugin::pack::PluginPackCatalog, String> {
    if force {
        plugin::pack::refresh_catalog().await
    } else {
        plugin::pack::fetch_catalog().await
    }
}

/// 读取并校验一个插件包的完整清单。
#[tauri::command]
pub async fn get_plugin_pack_detail(
    pack_id: String,
) -> Result<plugin::pack::PluginPackDetail, String> {
    plugin::pack::fetch_detail(&pack_id).await
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginPackInstallProgress {
    completed: usize,
    total: usize,
    plugin: String,
}

/// 在指定实例的 Profile 中安装插件包，已存在的直接依赖会被跳过。
/// 插件包清单里的 profile 只描述来源命令，不限制目标实例；实际安装始终使用当前实例的 Profile。
#[tauri::command]
pub async fn install_plugin_pack_for_instance(
    app_handle: AppHandle,
    instance_id: String,
    pack_id: String,
) -> Result<plugin::pack::PluginPackInstallResult, String> {
    let target = config::instance::find(&app_handle, &instance_id)?;
    if let Some(running) = instance_home_is_running(&app_handle, &target)? {
        return Err(format!("INSTANCE_RUNNING:{}:{}", running.id, running.name));
    }

    let detail = plugin::pack::fetch_detail(&pack_id).await?;

    plugin::reset_cancel();
    let _operation_guard = instance_operation_lock().lock().await;
    let previous = config::instance::active();
    config::instance::set_active(Some(target));
    let installed = plugin::watch::list(&app_handle);
    let missing = plugin::pack::missing_plugins(&detail, &installed)?;
    let requested = detail.plugins.len();
    let skipped = requested.saturating_sub(missing.len());
    let total = missing.len();
    let mut result = Ok(());
    for (index, item) in missing.iter().enumerate() {
        let _ = app_handle.emit(
            "plugin-pack-install-progress",
            PluginPackInstallProgress {
                completed: index,
                total,
                plugin: item.name.clone(),
            },
        );
        // Execute each community README command independently and in source order.
        // install() supplies the selected instance Profile while preserving its spec.
        if let Err(error) = plugin::install(&app_handle, std::slice::from_ref(&item.spec)).await {
            result = Err(error);
            break;
        }
        let _ = app_handle.emit(
            "plugin-pack-install-progress",
            PluginPackInstallProgress {
                completed: index + 1,
                total,
                plugin: item.name.clone(),
            },
        );
    }
    config::instance::set_active(previous);
    result.map(|()| plugin::pack::PluginPackInstallResult {
        pack_id,
        requested,
        installed: missing.len(),
        skipped,
    })
}

/// 取消正在进行的插件安装。
#[tauri::command]
pub async fn cancel_plugin_install(app_handle: AppHandle) {
    plugin::cancel(&app_handle).await;
}

/// 当前 profile 已安装插件列表（含解析后的元信息），`use-dsh-plugins` 首次加载用；
/// 之后 Rust 侧监控插件文件，变化时通过 `dsh-plugins-updated` 事件实时推送。
#[tauri::command]
pub fn get_dsh_plugins(app_handle: AppHandle) -> Vec<plugin::DshPlugin> {
    plugin::watch::list(&app_handle)
}

/// 读取指定实例的已安装插件，不改变启动器当前选中实例。
#[tauri::command]
pub fn get_dsh_plugins_for_instance(
    app_handle: AppHandle,
    instance_id: String,
) -> Result<Vec<plugin::DshPlugin>, String> {
    let target = config::instance::find(&app_handle, &instance_id)?;
    let _operation_guard = instance_operation_lock().blocking_lock();
    let previous = config::instance::active();
    config::instance::set_active(Some(target));
    let plugins = plugin::watch::list(&app_handle);
    config::instance::set_active(previous);
    Ok(plugins)
}

/// 设置指定实例 Profile 中插件的启动加载状态。
#[tauri::command]
pub fn set_plugin_enabled_for_instance(
    app_handle: AppHandle,
    instance_id: String,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    let target = config::instance::find(&app_handle, &instance_id)?;
    if let Some(running) = instance_home_is_running(&app_handle, &target)? {
        return Err(format!("INSTANCE_RUNNING:{}:{}", running.id, running.name));
    }
    let _operation_guard = instance_operation_lock().blocking_lock();
    let previous = config::instance::active();
    config::instance::set_active(Some(target));
    let result = plugin::watch::set_enabled(&app_handle, &plugin_id, enabled);
    config::instance::set_active(previous);
    result
}

/// 通过 DSH 原生命令移除指定实例 Profile 中的插件。
#[tauri::command]
pub async fn remove_plugin_for_instance(
    app_handle: AppHandle,
    instance_id: String,
    plugin_id: String,
) -> Result<(), String> {
    let target = config::instance::find(&app_handle, &instance_id)?;
    if let Some(running) = instance_home_is_running(&app_handle, &target)? {
        return Err(format!("INSTANCE_RUNNING:{}:{}", running.id, running.name));
    }
    let _operation_guard = instance_operation_lock().lock().await;
    let previous = config::instance::active();
    config::instance::set_active(Some(target));
    let result = plugin::remove(&app_handle, &plugin_id).await;
    config::instance::set_active(previous);
    result
}

/// 健康检查（通过 Rust 代理，避免 WebView CORS 问题）
#[tauri::command]
pub async fn proxy_health_check(_app_handle: AppHandle) -> Result<String, String> {
    let port = workflow::runtime_port()
        .ok_or_else(|| "HARNESS_NOT_OWNED: no runtime port allocated".to_string())?;
    workflow::proxy_health_check(port).await
}

/// 运行时/版本/诊断信息（侧边栏展示）
#[tauri::command]
pub async fn get_runtime_info(app_handle: AppHandle) -> Result<config::RuntimeInfo, String> {
    let port =
        workflow::runtime_port().unwrap_or_else(|| config::get_store_dat_setting(&app_handle).port);
    Ok(config::runtime_info(&app_handle, port))
}

/// 运行时文件是否已全部在盘（Node / Dsh / pnpm 三件套，纯本地检查、无网络）。
///
/// 判定条件与 `install_dependencies` 的「启动自愈」捷径完全一致：桌面端自更新
/// （MSI 强杀进程）后 store 可能被复位或损坏显示「未安装」，但运行时文件其实
/// 已就绪——此时前端跳过安装/下载界面，交给 install_dependencies 内部自愈
/// 补记 installed 后直接启动，避免自动重开时闪现误导用户的安装界面。
#[tauri::command]
pub fn runtime_ready(app_handle: AppHandle) -> bool {
    download::Nodejs.check_installed(&app_handle)
        && download::Dsh.check_installed(&app_handle)
        && download::Pnpm.check_installed(&app_handle)
}

/// 当前桌面端配置
#[tauri::command]
pub async fn get_app_config(app_handle: AppHandle) -> Result<config::Setting, String> {
    Ok(config::get_store_dat_setting(&app_handle))
}

/// 更新桌面端配置
#[tauri::command]
pub async fn update_app_config(
    app_handle: AppHandle,
    port: Option<u16>,
    auto_start: Option<bool>,
    cli_link_enabled: Option<bool>,
    launcher_opacity: Option<u8>,
    startup_mode: Option<String>,
    launcher_theme: Option<String>,
    launcher_blur: Option<bool>,
    confirm_before_instance_removal: Option<bool>,
) -> Result<config::Setting, String> {
    let mut setting = config::get_store_dat_setting(&app_handle);
    if let Some(port) = port {
        if port == 0 {
            return Err("port must be a positive number".to_string());
        }
        setting.port = port;
    }
    if let Some(auto_start) = auto_start {
        setting.auto_start = auto_start;
    }
    if let Some(opacity) = launcher_opacity {
        if !(20..=100).contains(&opacity) {
            return Err("launcher_opacity must be between 20 and 100".to_string());
        }
        setting.launcher_opacity = opacity;
        apply_launcher_window_opacity(&app_handle, opacity)?;
    }
    if let Some(mode) = startup_mode {
        if !matches!(mode.as_str(), "manager" | "last_instance") {
            return Err("startup_mode must be manager or last_instance".to_string());
        }
        setting.startup_mode = mode;
    }
    if let Some(theme) = launcher_theme {
        if !matches!(
            theme.as_str(),
            "mist-blue"
                | "forest-teal"
                | "charcoal"
                | "warm-clay"
                | "rose-gray"
                | "lake-blue-soft-pink"
                | "turquoise-ice-blue"
                | "rose-red-snow-white"
                | "mint-orange-gold"
                | "mint-peacock-green"
                | "deep-blue-soft-pink"
                | "mist-blue-sakura-pink"
                | "mist-cyan-light-green"
                | "sage-light-yellow"
                | "pale-blue-mint"
                | "aqua-green-almond"
                | "neon-aqua-green"
                | "deep-green-mist"
        ) {
            return Err("launcher_theme is not supported".to_string());
        }
        setting.launcher_theme = theme;
    }
    if let Some(blur) = launcher_blur {
        setting.launcher_blur = blur;
    }
    if let Some(confirm) = confirm_before_instance_removal {
        setting.confirm_before_instance_removal = confirm;
    }
    // 命令行集成：先执行文件系统/PATH 操作，成功后再持久化开关，
    // 失败时配置保持不变，避免"开关已开但 shim 未生成"的不一致状态。
    if let Some(enabled) = cli_link_enabled {
        if enabled {
            cli::ensure(&app_handle)?;
        } else {
            cli::remove(&app_handle)?;
        }
        setting.cli_link_enabled = enabled;
    }
    config::set_store_dat_setting(&app_handle, setting.clone());
    Ok(setting)
}

pub(crate) fn apply_launcher_window_opacity(
    app_handle: &AppHandle,
    opacity: u8,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
            LWA_ALPHA, WS_EX_LAYERED,
        };
        let window = app_handle
            .get_webview_window("main")
            .ok_or_else(|| "LAUNCHER_WINDOW_NOT_FOUND".to_string())?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0
            as windows_sys::Win32::Foundation::HWND;
        let alpha = ((opacity as u16 * 255) / 100) as u8;
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED as isize);
            if SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) == 0 {
                return Err(format!(
                    "LAUNCHER_OPACITY_FAILED: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (app_handle, opacity);
    Ok(())
}

/// 命令行集成状态（shim 文件与 PATH 注册情况）
#[tauri::command]
pub fn get_cli_link_status(app_handle: AppHandle) -> Result<cli::CliLinkStatus, String> {
    Ok(cli::get_status(&app_handle))
}

/// 在系统浏览器中打开 Harness 界面
#[tauri::command]
pub async fn open_in_browser(app_handle: AppHandle) -> Result<(), String> {
    let port = workflow::runtime_port()
        .ok_or_else(|| "HARNESS_NOT_RUNNING: no runtime port allocated".to_string())?;
    let url = config::get_dsh_service_url(port);
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 复制 Harness 服务地址到剪贴板
#[tauri::command]
pub async fn copy_service_url(app_handle: AppHandle) -> Result<(), String> {
    let port = workflow::runtime_port()
        .ok_or_else(|| "HARNESS_NOT_RUNNING: no runtime port allocated".to_string())?;
    let url = config::get_dsh_service_url(port);
    app_handle
        .clipboard()
        .write_text(url)
        .map_err(|e| e.to_string())
}

/// 在系统文件管理器中定位指定文件（Session 日志下载完成后的"在文件夹中显示"）
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("REVEAL_FAILED: {e}"))
}

/// 在系统文件管理器中打开数据目录
#[tauri::command]
pub async fn reveal_data_dir(app_handle: AppHandle) -> Result<(), String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    if cfg!(windows) {
        std::process::Command::new("explorer")
            .arg(&app_data_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(&app_data_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    } else {
        std::process::Command::new("xdg-open")
            .arg(&app_data_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 读取 dsh 服务日志
#[tauri::command]
pub async fn read_service_logs(
    app_handle: AppHandle,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let log_path = config::get_service_log_path(&app_handle);
    if !log_path.exists() {
        return Ok(String::new());
    }

    let content = std::fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    let max_bytes = max_bytes.unwrap_or(64 * 1024);
    if content.len() <= max_bytes {
        Ok(content)
    } else {
        Ok(content[content.len() - max_bytes..].to_string())
    }
}

/// 清空 dsh 服务日志
#[tauri::command]
pub async fn clear_service_logs(app_handle: AppHandle) -> Result<(), String> {
    let log_path = config::get_service_log_path(&app_handle);
    std::fs::write(&log_path, "").map_err(|e| e.to_string())
}

/// 读取运行日志（DSH 服务日志 + 桌面端 Rust 运行日志），格式化为便于
/// 反馈/报障复制的纯文本块：`### 环境信息`、`### 服务日志` 与 `### 运行日志` 三段。
///
/// 服务日志来自 `logs/dsh-web.log`，运行日志来自 `logs/desktop.log`
/// （桌面端自身 `logger::init` 每次启动落盘，见 logger/mod.rs）。
/// 每段取末尾最多 `MAX_LINES` 行，避免粘贴内容超出 GitHub issue 长度上限。
#[tauri::command]
pub async fn read_run_logs(app_handle: AppHandle) -> Result<String, String> {
    const MAX_LINES: usize = 100;

    let base = config::get_base_dir(&app_handle);
    let service = config::get_service_log_path(&app_handle);
    let desktop = base.join("logs").join("desktop.log");

    let read_tail = |path: &std::path::Path| -> String {
        if !path.exists() {
            return String::new();
        }
        let content = std::fs::read_to_string(path).unwrap_or_default();
        let lines: Vec<&str> = content.lines().collect();
        let start = lines.len().saturating_sub(MAX_LINES);
        lines[start..].join("\n")
    };

    // 环境信息：桌面端应用版本、dsh 发行版本、Node 版本与系统平台/架构，便于报障时快速定位环境差异
    let dsh_version = config::get_dsh_version(&app_handle)
        .map(|v| format!("dsh: {v}\n"))
        .unwrap_or_default();
    let env_text = format!(
        "app: {}\n{}node: {}\nos: {} ({})",
        app_handle.package_info().version,
        dsh_version,
        config::get_active_node_version(),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );

    let service_text = read_tail(&service);
    let desktop_text = read_tail(&desktop);

    Ok(format!(
        "### 环境信息\n\n{}\n\n### 服务日志\n\n```\n{}\n```\n\n### 运行日志\n\n```\n{}\n```",
        env_text,
        service_text.trim_end(),
        desktop_text.trim_end()
    ))
}

/// 保存界面语言偏好
#[tauri::command]
pub fn set_language(app_handle: AppHandle, lang: String) {
    let mut setting = config::get_store_dat_setting(&app_handle);
    setting.language = lang.clone();
    config::set_store_dat_setting(&app_handle, setting);
    config::i18n::set_language(match lang.as_str() {
        "en" | "en-US" => config::i18n::Lang::En,
        _ => config::i18n::Lang::Zh,
    });
}

/// 切换侧边栏（布局状态保存在前端，保留该命令以对齐参考实现）
#[tauri::command]
pub async fn toggle_sidebar() -> Result<bool, String> {
    Ok(true)
}

/// 当前 dsh 主题偏好（light/dark/system），用于让桌面外壳跟随内嵌页面主题
#[tauri::command]
pub fn get_dsh_theme(app_handle: AppHandle) -> config::DshTheme {
    config::get_dsh_theme(&app_handle)
}

/// 检查桌面端自身是否有新版本（含安装包是否已下载）
#[tauri::command]
pub async fn check_desktop_update(
    app_handle: AppHandle,
) -> Result<Option<update::DesktopUpdateInfo>, String> {
    if DESKTOP_UPDATES_PAUSED {
        log::debug!("Desktop upstream update check skipped: updates are paused for this build");
        return Ok(None);
    }
    update::check(&app_handle).await
}

/// 下载桌面端新版本安装包；已下载则直接返回。进度通过 `desktop-update-progress` 事件推送
#[tauri::command]
pub async fn download_desktop_update(
    app_handle: AppHandle,
) -> Result<update::DesktopUpdateInfo, String> {
    if DESKTOP_UPDATES_PAUSED {
        return Err("DESKTOP_UPDATE_PAUSED: desktop upstream updates are paused".to_string());
    }
    update::download(&app_handle).await
}

/// 打开已下载的桌面端安装包（exe/msi/dmg...，交给系统默认处理器）
#[tauri::command]
pub async fn open_desktop_installer(app_handle: AppHandle, path: String) -> Result<(), String> {
    update::open_installer(&app_handle, path).await
}

/// 关于对话框信息（版本 / 发布时间 / 版权 / 仓库）
#[tauri::command]
pub async fn get_desktop_about() -> Result<update::DesktopAboutInfo, String> {
    Ok(update::about().await)
}

/// 在系统浏览器中打开任意 http(s) 链接（更新说明 / 关于对话框仓库链接等）
#[tauri::command]
pub async fn open_external_url(app_handle: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("EXTERNAL_URL_INVALID: {url}"));
    }
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
