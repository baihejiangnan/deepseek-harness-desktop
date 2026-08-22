//! 桌面应用自更新模块。
//!
//! 与 `dsh` 内核更新（`download` 模块）不同，这里负责「DeepSeek Harness 桌面端」
//! 自身的更新：查询 GitHub Release 的最新版本、下载安装包、并交给系统打开安装器。
//!
//! 设计考量：
//! - 每次「检查更新」都实时向 GitHub 查询最新 Release（不做缓存），保证看到的
//!   永远是最新发布，不会因上传期间的旧结果而误判「已是最新」。
//! - 通过 GitHub 的 **HTML/atom 页面**（releases.atom、expanded_assets）而非
//!   api.github.com 查询，绕开未认证 API 60 次/小时/IP 的限流。
//! - 安装包下载到 AppData/updates 目录；已存在则视为「已下载」，不再重复拉取。
//! - 打开安装器（exe/msi/dmg 等）交给系统默认处理器（ShellExecute/LaunchServices）。

use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

/// 仓库主页（同时用于构造 atom / expanded_assets / 下载地址）
const REPO_URL: &str = "https://github.com/baihejiangnan/deepseek-harness-desktop";
/// 新仓库尚未发布桌面安装包时的兼容发布源；新仓库有 Release 后自动优先使用它。
const LEGACY_REPO_URL: &str = "https://github.com/hairyf/deepseek-harness-desktop";
/// AppData 下安装包存放目录名
const UPDATES_DIR: &str = "updates";

/// 最新可用发布信息（仅在有更新且匹配到当前平台安装包时才有意义）
#[derive(Debug, Clone)]
struct LatestRelease {
    version: String,
    tag: String,
    published_at: String,
    url: String,
    asset_name: String,
}

/// 当前桌面端版本号（来自 Cargo.toml / tauri.conf.json）
fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 解析版本号为数字段序列：`v0.5.2` / `0.5.2` → [0, 5, 2]
fn parse_version(v: &str) -> Option<Vec<u64>> {
    let s = v.trim().trim_start_matches('v');
    s.split('.')
        .map(|p| p.parse().ok())
        .collect::<Option<Vec<_>>>()
}

/// 判断 `latest` 是否严格高于 `current`（逐段比较，段数多者视作更新）
fn is_newer(latest: &str, current: &str) -> bool {
    let Some(a) = parse_version(latest) else {
        return false;
    };
    let Some(b) = parse_version(current) else {
        return false;
    };
    for (x, y) in a.iter().zip(b.iter()) {
        if x != y {
            return x > y;
        }
    }
    a.len() > b.len()
}

/// 根据资产文件名判断其架构匹配度，用于同扩展名下挑选正确架构的安装包：
/// - `2`：与当前运行架构完全匹配（如 `_x64.dmg` / `_aarch64.dmg` / `_amd64.deb`）
/// - `1`：通用包（`universal`），任何架构都可用
/// - `0`：不匹配或文件名未携带架构信息（作为兜底仍可尝试）
fn arch_rank(name: &str) -> i8 {
    let lower = name.to_lowercase();
    if lower.contains("universal") {
        return 1;
    }
    #[cfg(target_arch = "aarch64")]
    let markers = ["aarch64", "arm64", "apple-silicon", "-arm", "_arm"];
    #[cfg(target_arch = "x86_64")]
    let markers = ["x86_64", "amd64", "x64", "intel", "-x86", "_x86"];
    if markers.iter().any(|k| lower.contains(k)) {
        2
    } else {
        0
    }
}

/// 选择当前平台对应的安装包资产文件名。
///
/// 选择规则分两层：先按平台偏好扩展名排序，同扩展名下再按架构匹配度挑选。
/// - Windows 优先 NSIS setup.exe（其次 msi）：NSIS 不会像 MSI 那样由
///   RestartManager 强杀旧进程并在安装完成后自动重开应用，避免应用在旧进程
///   被强杀、运行文件瞬时缺失的窗口被自动拉起，从而误触发核心重下载。
/// - macOS 选 dmg，并按架构区分，避免 Intel 芯片 Mac 下载到 M 芯片
///   （aarch64）的安装包（issue #33）。
/// - Linux 选 AppImage（其次 deb/rpm），同样按架构匹配。
fn pick_asset(assets: &[String]) -> Option<String> {
    #[cfg(target_os = "windows")]
    let prefs = [".exe", ".msi"];
    #[cfg(target_os = "macos")]
    let prefs = [".dmg"];
    #[cfg(target_os = "linux")]
    let prefs = [".AppImage", ".deb", ".rpm"];

    let mut best: Option<(usize, i8, String)> = None;
    for name in assets {
        let Some(idx) = prefs.iter().position(|p| name.ends_with(p)) else {
            continue;
        };
        let rank = prefs.len() - idx; // 扩展名优先级：越靠前越高
        let ar = arch_rank(name); // 架构匹配度：同扩展名下优先选匹配架构
        if best
            .as_ref()
            .is_none_or(|(r, a, _)| rank > *r || (rank == *r && ar > *a))
        {
            best = Some((rank, ar, name.clone()));
        }
    }
    best.map(|(_, _, name)| name)
}

/// 构造带统一 UA 的 HTTP 客户端（并发小、超时短）。
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("deepseek-harness-desktop")
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("UPDATE_CLIENT: {e}"))
}

/// 定位 `marker` 之后到 `end_marker` 之间的内容（用于轻量解析 atom/HTML）。
fn find_token<'a>(s: &'a str, marker: &str, end_marker: &str) -> Option<&'a str> {
    let start = s.find(marker)? + marker.len();
    let end = s[start..].find(end_marker).map(|e| start + e)?;
    Some(&s[start..end])
}

/// 从 releases.atom 解析最新 release 的 (tag, 发布时间)。
///
/// 不走 api.github.com，故不受未认证限流约束。
async fn fetch_latest_meta(repo_url: &str) -> Result<(String, String), String> {
    let body = http_client()?
        .get(format!("{repo_url}/releases.atom"))
        .send()
        .await
        .map_err(|e| format!("UPDATE_ATOM: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_ATOM: {e}"))?
        .text()
        .await
        .map_err(|e| format!("UPDATE_ATOM: {e}"))?;

    // 取第一条 <entry> 作为最新 release
    let entry = body
        .find("<entry>")
        .and_then(|p| body[p..].find("</entry>").map(|e| &body[p..p + e]))
        .unwrap_or(&body);
    let tag = find_token(entry, "releases/tag/", "\"")
        .ok_or_else(|| "UPDATE_PARSE: missing tag in atom feed".to_string())?
        .to_string();
    let published_at = find_token(entry, "<updated>", "</updated>")
        .unwrap_or_default()
        .to_string();
    Ok((tag, published_at))
}

/// 从 expanded_assets 页面 HTML 中提取给定 tag 的全部资产文件名（纯函数，便于测试）。
fn extract_asset_names(html: &str, tag: &str) -> Vec<String> {
    let needle = format!("releases/download/{tag}/");
    let mut names = Vec::new();
    let mut start = 0;
    while let Some(pos) = html[start..].find(&needle) {
        let after = start + pos + needle.len();
        let end = html[after..]
            .find('"')
            .map(|e| after + e)
            .unwrap_or(html.len());
        names.push(html[after..end].to_string());
        start = end;
    }
    names
}

/// 从 release 的 expanded_assets 页面解析全部安装包资产文件名。
///
/// 不走 api.github.com，故不受未认证限流约束。
async fn fetch_asset_names(repo_url: &str, tag: &str) -> Result<Vec<String>, String> {
    let body = http_client()?
        .get(format!("{repo_url}/releases/expanded_assets/{tag}"))
        .send()
        .await
        .map_err(|e| format!("UPDATE_ASSETS: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_ASSETS: {e}"))?
        .text()
        .await
        .map_err(|e| format!("UPDATE_ASSETS: {e}"))?;
    Ok(extract_asset_names(&body, tag))
}

/// 查询最新 Release（无缓存，每次实时检查，走 HTML/atom 而非 api.github.com）。
///
/// 返回 `Ok(Some(LatestRelease))` 表示有更新且匹配到当前平台安装包；
/// `Ok(None)` 表示无更新（或未匹配到资产）。网络失败返回 Err。
async fn fetch_latest_release() -> Result<Option<LatestRelease>, String> {
    for repo_url in [REPO_URL, LEGACY_REPO_URL] {
        let Ok((tag, published_at)) = fetch_latest_meta(repo_url).await else {
            log::debug!("No desktop release feed at {repo_url}");
            continue;
        };
        let version = tag.trim_start_matches('v').to_string();
        if !is_newer(&version, &current_version()) {
            return Ok(None);
        }

        let names = fetch_asset_names(repo_url, &tag).await?;
        let Some(asset_name) = pick_asset(&names) else {
            return Ok(None);
        };

        // 下载地址由 tag + 资产名直接构造，无需 API
        let url = format!("{repo_url}/releases/download/{tag}/{asset_name}");
        return Ok(Some(LatestRelease {
            version,
            tag,
            published_at,
            url,
            asset_name,
        }));
    }
    Err("UPDATE_ATOM: no trusted desktop release feed available".to_string())
}

/// 安装包存放路径（AppData/updates/<asset_name>）
fn installer_path(app_handle: &AppHandle, asset_name: &str) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("UPDATE_DIR: {e}"))?
        .join(UPDATES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("UPDATE_DIR: {e}"))?;
    Ok(dir.join(asset_name))
}

/// 检查是否有桌面端新版本。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    /// 最新可用版本号（无 `v` 前缀）
    pub version: String,
    /// 当前已安装版本号（无 `v` 前缀）
    pub current_version: String,
    pub tag: String,
    pub published_at: String,
    pub url: String,
    pub asset_name: String,
    pub path: String,
    pub downloaded: bool,
}

/// 检查是否有新版本可用（含安装包是否已下载）
pub async fn check(app_handle: &AppHandle) -> Result<Option<DesktopUpdateInfo>, String> {
    match fetch_latest_release().await? {
        None => Ok(None),
        Some(r) => {
            let path = installer_path(app_handle, &r.asset_name)?;
            let downloaded = path.exists();
            Ok(Some(DesktopUpdateInfo {
                version: r.version,
                current_version: current_version(),
                tag: r.tag,
                published_at: r.published_at,
                url: r.url,
                asset_name: r.asset_name,
                path: path.to_string_lossy().into_owned(),
                downloaded,
            }))
        }
    }
}

/// 下载进度载荷（前端进度条展示）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDownloadProgress {
    pub percentage: f64,
    pub downloaded: u64,
    pub total: u64,
}

/// 下载桌面端安装包；已下载则直接返回。
///
/// 下载期间通过 `desktop-update-progress` 事件推送进度；完成后返回
/// `DesktopUpdateInfo`（path/downloaded 已更新）。
pub async fn download(app_handle: &AppHandle) -> Result<DesktopUpdateInfo, String> {
    let release = fetch_latest_release()
        .await?
        .ok_or_else(|| "UPDATE_NONE".to_string())?;
    let path = installer_path(app_handle, &release.asset_name)?;

    if path.exists() {
        log::info!("Installer already downloaded: {}", path.display());
        return check(app_handle)
            .await?
            .ok_or_else(|| "UPDATE_NONE".to_string());
    }

    log::info!("Downloading desktop installer from {}", release.url);
    let client = reqwest::Client::builder()
        .user_agent("deepseek-harness-desktop")
        .build()
        .map_err(|e| format!("UPDATE_CLIENT: {e}"))?;

    let res = client
        .get(&release.url)
        .send()
        .await
        .map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?;

    let total = res.content_length().unwrap_or(0);
    // 先写临时文件再原子改名，避免下载中断残留半成品被误判为「已下载」
    let tmp = path.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("UPDATE_FILE: {e}"))?;

    use std::io::Write;
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("UPDATE_FILE: {e}"))?;
        downloaded += chunk.len() as u64;
        let pct = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app_handle.emit(
            "desktop-update-progress",
            DesktopDownloadProgress {
                percentage: pct,
                downloaded,
                total,
            },
        );
    }
    drop(file);
    std::fs::rename(&tmp, &path).map_err(|e| format!("UPDATE_FILE: {e}"))?;

    check(app_handle)
        .await?
        .ok_or_else(|| "UPDATE_NONE".to_string())
}

/// 打开安装包：交给系统默认处理器（Windows 会触发 UAC 执行安装器）。
pub async fn open_installer(app_handle: &AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("UPDATE_NOT_FOUND: {path}"));
    }
    log::info!("Opening desktop installer: {}", p.display());
    app_handle
        .opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("UPDATE_OPEN: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_strips_v_prefix() {
        assert_eq!(parse_version("v0.5.2").as_deref(), Some(&[0u64, 5, 2][..]));
        assert_eq!(parse_version("0.5.2").as_deref(), Some(&[0u64, 5, 2][..]));
        assert_eq!(parse_version("0.5").as_deref(), Some(&[0u64, 5][..]));
        assert_eq!(parse_version("abc"), None);
    }

    #[test]
    fn is_newer_compares_segments() {
        assert!(is_newer("0.5.2", "0.5.1"));
        assert!(is_newer("1.0.0", "0.9.0"));
        assert!(is_newer("0.5.0", "0.5"));
        assert!(!is_newer("0.5.1", "0.5.2"));
        assert!(!is_newer("0.5.1", "0.5.1"));
        assert!(!is_newer("0.5.1", "1.0.0"));
    }

    #[test]
    fn is_newer_ignores_unparseable() {
        assert!(!is_newer("abc", "0.5.1"));
        assert!(!is_newer("0.5.1", "abc"));
    }

    #[test]
    fn pick_asset_prefers_matching_suffix() {
        let mk = |name: &str| name.to_string();
        #[cfg(target_os = "windows")]
        {
            // NSIS setup.exe 优先于 msi（避免 MSI 的 RestartManager 强杀+自动重开）
            let assets: Vec<String> = vec![mk("app-x86_64-setup.exe"), mk("app-x64_en-US.msi")];
            assert_eq!(pick_asset(&assets).as_deref(), Some("app-x86_64-setup.exe"));
        }
        #[cfg(target_os = "macos")]
        {
            let assets: Vec<String> = vec![mk("app.dmg"), mk("app-x86_64.tar.gz")];
            assert_eq!(pick_asset(&assets).as_deref(), Some("app.dmg"));
        }
        let no_match: Vec<String> = vec![mk("README.md")];
        assert!(pick_asset(&no_match).is_none());
        assert!(pick_asset(&[]).is_none());
    }

    #[test]
    fn arch_rank_matches_host_and_universal() {
        // 通用包任何架构都可用
        assert_eq!(arch_rank("Deepseek.Harness.Desktop-universal.dmg"), 1);
        // 按编译目标分支断言，保证 CI 在任意架构上都能通过
        #[cfg(target_arch = "aarch64")]
        {
            assert_eq!(arch_rank("Deepseek.Harness.Desktop_0.6.6_aarch64.dmg"), 2);
            assert_eq!(arch_rank("Deepseek.Harness.Desktop_0.6.6_x64.dmg"), 0);
        }
        #[cfg(target_arch = "x86_64")]
        {
            assert_eq!(arch_rank("Deepseek.Harness.Desktop_0.6.6_x64.dmg"), 2);
            assert_eq!(
                arch_rank("Deepseek.Harness.Desktop_0.6.6_amd64.AppImage"),
                2
            );
            assert_eq!(arch_rank("Deepseek.Harness.Desktop-0.6.6-1.x86_64.rpm"), 2);
            assert_eq!(arch_rank("Deepseek.Harness.Desktop_0.6.6_aarch64.dmg"), 0);
        }
        // 未携带架构信息的文件名作为兜底（0）
        assert_eq!(arch_rank("app.dmg"), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pick_asset_prefers_host_arch_dmg() {
        let mk = |name: &str| name.to_string();
        // aarch64 与 x64 并存（与真实发布资产命名一致）：选当前架构匹配的包
        let assets: Vec<String> = vec![
            mk("Deepseek.Harness.Desktop_0.6.6_aarch64.dmg"),
            mk("Deepseek.Harness.Desktop_0.6.6_x64.dmg"),
        ];
        let picked = pick_asset(&assets).unwrap();
        #[cfg(target_arch = "aarch64")]
        assert_eq!(picked, "Deepseek.Harness.Desktop_0.6.6_aarch64.dmg");
        #[cfg(target_arch = "x86_64")]
        assert_eq!(picked, "Deepseek.Harness.Desktop_0.6.6_x64.dmg");
        // 通用包优于与本机架构不匹配的包（用「非本机架构」的名字构造，任意架构成立）
        #[cfg(target_arch = "aarch64")]
        let wrong = "Deepseek.Harness.Desktop_0.6.6_x64.dmg";
        #[cfg(target_arch = "x86_64")]
        let wrong = "Deepseek.Harness.Desktop_0.6.6_aarch64.dmg";
        let assets: Vec<String> = vec![
            wrong.to_string(),
            "Deepseek.Harness.Desktop_0.6.6-universal.dmg".to_string(),
        ];
        let picked = pick_asset(&assets).unwrap();
        assert_eq!(picked, "Deepseek.Harness.Desktop_0.6.6-universal.dmg");
    }

    #[test]
    fn find_token_extracts_between_markers() {
        let s = r#"<link rel="alternate" href="https://github.com/x/releases/tag/v0.6.6"/>"#;
        assert_eq!(find_token(s, "releases/tag/", "\""), Some("v0.6.6"));
        let s2 = "<updated>2026-08-19T09:27:38Z</updated>";
        assert_eq!(
            find_token(s2, "<updated>", "</updated>"),
            Some("2026-08-19T09:27:38Z")
        );
        assert_eq!(find_token("no marker", "releases/tag/", "\""), None);
    }

    #[test]
    fn extract_asset_names_parses_download_links() {
        let tag = "v0.6.6";
        let html = r#"
            <a href="/baihejiangnan/deepseek-harness-desktop/releases/download/v0.6.6/x64-setup.exe">x</a>
            <a href="/baihejiangnan/deepseek-harness-desktop/releases/download/v0.6.6/x64_en-US.msi">y</a>
            <a href="/baihejiangnan/deepseek-harness-desktop/releases/download/v0.6.5/old.dmg">z</a>
        "#;
        let names = extract_asset_names(html, tag);
        assert_eq!(names, vec!["x64-setup.exe", "x64_en-US.msi"]);
        assert!(extract_asset_names(html, "v9.9.9").is_empty());
        assert!(extract_asset_names("", tag).is_empty());
    }
}
