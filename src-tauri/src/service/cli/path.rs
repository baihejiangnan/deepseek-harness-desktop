//! 用户 PATH 注册与路径计算：bin 目录定位、Windows 注册表读写与
//! `WM_SETTINGCHANGE` 广播、Unix shell rc 幂等注入，以及用户 pnpm 探测。

#[cfg(not(windows))]
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

#[cfg(windows)]
use super::shim::SHIM_CMD_NAME;
#[cfg(unix)]
use super::shim::SHIM_SH_NAME;

/// Windows 下 shim 根目录名（`%LOCALAPPDATA%\<此目录>\bin`）
const CLI_ROOT_DIR_NAME: &str = "deepseek-harness";

/// Unix 下 shim 所在目录（XDG 约定）
#[cfg(unix)]
const UNIX_BIN_DIR: &str = ".local/bin";

/// shell rc 注入标记（用于幂等增删）
#[cfg(unix)]
const RC_MARK_START: &str = "# >>> deepseek-harness dsh >>>";
#[cfg(unix)]
const RC_MARK_END: &str = "# <<< deepseek-harness dsh <<<";

/// Unix 下需要写入 PATH 导出的 rc 文件（按顺序处理）
#[cfg(unix)]
const RC_FILES: [&str; 2] = [".zshrc", ".bashrc"];

// ---------------------------------------------------------------------------
// 路径计算
// ---------------------------------------------------------------------------

/// bin 目录：
/// - Windows：`%LOCALAPPDATA%\deepseek-harness\bin`（用户级、不随应用数据目录变动）
/// - Unix：`~/.local/bin`（XDG 约定，通常已在 PATH 中）
pub fn get_bin_dir<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                app_handle
                    .path()
                    .local_data_dir()
                    .ok()
                    .and_then(|d| d.parent().map(|p| p.to_path_buf()))
            })
            .unwrap_or_else(std::env::temp_dir)
            .join(CLI_ROOT_DIR_NAME)
            .join("bin")
    }
    #[cfg(not(windows))]
    {
        app_handle
            .path()
            .home_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(UNIX_BIN_DIR)
    }
}

/// 主 shim 文件路径（状态展示用）
pub fn get_shim_path(app_handle: &AppHandle) -> PathBuf {
    let bin_dir = get_bin_dir(app_handle);
    #[cfg(windows)]
    {
        bin_dir.join(SHIM_CMD_NAME)
    }
    #[cfg(not(windows))]
    {
        bin_dir.join(SHIM_SH_NAME)
    }
}

/// 当前用户 PATH 中是否已包含 bin 目录（Windows 以注册表为准，
/// 因为进程内 PATH 在广播 WM_SETTINGCHANGE 后不会自动更新）
pub fn path_registered(app_handle: &AppHandle) -> bool {
    #[cfg(windows)]
    {
        let bin_dir = get_bin_dir(app_handle);
        let Some(bin_str) = bin_dir.to_str() else {
            return false;
        };
        read_user_path()
            .map(|value| path_contains_token(&value, bin_str))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let bin_dir = get_bin_dir(app_handle);
        // 1. 当前进程 PATH 已包含（新终端直接可用）
        if std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .any(|p| p == bin_dir)
        {
            return true;
        }
        // 2. rc 文件中已注入标记块（重启 shell 后可用）
        let home = app_handle
            .path()
            .home_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        RC_FILES.iter().any(|name| {
            fs::read_to_string(home.join(name))
                .map(|content| content.contains(RC_MARK_START))
                .unwrap_or(false)
        })
    }
}

/// 在 PATH 中查找用户自己安装的 pnpm（排除应用注册的 shim 目录）。
///
/// "用户优先"策略：安装时（`Pnpm::check_installed`）用户已有 pnpm 则跳过
/// 捆绑安装；`pnpm` shim 运行时也会优先转发到用户的 pnpm。
pub fn find_user_pnpm(app_handle: &AppHandle) -> Option<PathBuf> {
    let bin_dir = get_bin_dir(app_handle);
    let candidates: &[&str] = if cfg!(windows) {
        // npm 全局安装的是 pnpm.cmd，standalone 安装的是 pnpm.exe
        &["pnpm.cmd", "pnpm.exe", "pnpm.bat"]
    } else {
        &["pnpm"]
    };
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if dir == bin_dir || dir.as_os_str().is_empty() {
            continue;
        }
        for name in candidates {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// PATH 注册 / 注销（Windows：注册表 + WM_SETTINGCHANGE；Unix：shell rc）
// ---------------------------------------------------------------------------

/// 注册 bin 目录到用户 PATH（幂等）
pub fn register_path(app_handle: &AppHandle) -> Result<(), String> {
    if path_registered(app_handle) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let bin_dir = get_bin_dir(app_handle);
        let bin_str = bin_dir
            .to_str()
            .ok_or_else(|| "bin dir is not valid UTF-8".to_string())?;
        let current = read_user_path().unwrap_or_default();
        let new_value = if current.trim().is_empty() {
            bin_str.to_string()
        } else {
            format!("{};{}", current.trim_end_matches(';'), bin_str)
        };
        write_user_path(&new_value)?;
        notify_environment_change();
        log::info!("Registered dsh bin dir in user PATH: {bin_str}");
    }
    #[cfg(not(windows))]
    {
        inject_shell_rc(app_handle)?;
    }
    Ok(())
}

/// 从用户 PATH 中移除 bin 目录（幂等）
pub fn unregister_path(app_handle: &AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let bin_dir = get_bin_dir(app_handle);
        let Some(bin_str) = bin_dir.to_str() else {
            return Ok(());
        };
        if let Some(current) = read_user_path() {
            if !path_contains_token(&current, bin_str) {
                return Ok(());
            }
            let new_value = remove_path_token(&current, bin_str);
            write_user_path(&new_value)?;
            notify_environment_change();
            log::info!("Removed dsh bin dir from user PATH");
        }
    }
    #[cfg(not(windows))]
    {
        strip_shell_rc(app_handle)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Windows 注册表辅助
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[inline]
fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn read_user_path() -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
    };

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key_name = to_wide_null("Environment");
        let ret = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_name.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut hkey,
        );
        if ret != 0 {
            log::warn!("failed to open HKCU\\Environment (error {ret})");
            return None;
        }

        let value_name = to_wide_null("Path");
        let mut value_type: u32 = 0;
        let mut size: u32 = 0;
        let mut ret = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut size,
        );

        if ret == ERROR_FILE_NOT_FOUND {
            RegCloseKey(hkey);
            return Some(String::new());
        }
        if ret != ERROR_MORE_DATA && ret != 0 {
            RegCloseKey(hkey);
            log::warn!("failed to query HKCU\\Environment\\Path (error {ret})");
            return None;
        }

        let mut buf = vec![0u16; (size as usize / 2).max(1) + 1];
        ret = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        );
        RegCloseKey(hkey);

        if ret != 0 {
            log::warn!("failed to read HKCU\\Environment\\Path (error {ret})");
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

#[cfg(windows)]
fn write_user_path(new_value: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ,
    };

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key_name = to_wide_null("Environment");
        let ret = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_name.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &mut hkey,
        );
        if ret != 0 {
            return Err(format!("failed to open HKCU\\Environment (error {ret})"));
        }

        let value_name = to_wide_null("Path");
        let mut value_type: u32 = REG_EXPAND_SZ;
        let mut size: u32 = 0;
        RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut size,
        );
        if value_type != REG_SZ && value_type != REG_EXPAND_SZ {
            value_type = REG_EXPAND_SZ;
        }

        let wide_value = to_wide_null(new_value);
        let bytes = (wide_value.len() * 2) as u32;
        let ret = RegSetValueExW(
            hkey,
            value_name.as_ptr(),
            0,
            value_type,
            wide_value.as_ptr() as *const u8,
            bytes,
        );
        RegCloseKey(hkey);

        if ret != 0 {
            return Err(format!(
                "failed to write HKCU\\Environment\\Path (error {ret})"
            ));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn notify_environment_change() {
    use windows_sys::Win32::Foundation::{LPARAM, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let wide = to_wide_null("Environment");
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0 as WPARAM,
            wide.as_ptr() as LPARAM,
            SMTO_ABORTIFHUNG,
            5000,
            std::ptr::null_mut(),
        );
    }
}

/// 展开字符串中的 `%VAR%`（Windows）
#[cfg(windows)]
fn expand_env(value: &str) -> String {
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
    let wide = to_wide_null(value);
    let mut buf = vec![0u16; 32768];
    let n = unsafe { ExpandEnvironmentStringsW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if n == 0 || n > buf.len() as u32 {
        return value.to_string();
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// PATH 值（`;` 分隔）中是否已包含指定目录（大小写不敏感，先展开 %VAR%）
#[cfg(windows)]
fn path_contains_token(path_value: &str, token: &str) -> bool {
    let expanded = expand_env(path_value);
    let token_lower = token.to_lowercase();
    expanded
        .split(';')
        .any(|p| !p.is_empty() && p.trim_end_matches('\\').to_lowercase() == token_lower)
}

/// 从 PATH 值中移除指定目录 token（同时处理 `%LOCALAPPDATA%` 未展开形式）
#[cfg(windows)]
fn remove_path_token(path_value: &str, token: &str) -> String {
    let token_lower = token.to_lowercase();
    let unexpanded_lower = token_lower.replace(
        &std::env::var("LOCALAPPDATA")
            .unwrap_or_default()
            .to_lowercase(),
        "%localappdata%",
    );
    let kept: Vec<&str> = path_value
        .split(';')
        .filter(|p| {
            if p.is_empty() {
                return false;
            }
            let norm = p.trim_end_matches('\\').to_lowercase();
            norm != token_lower && norm != unexpanded_lower
        })
        .collect();
    kept.join(";")
}

// ---------------------------------------------------------------------------
// Unix shell rc 辅助
// ---------------------------------------------------------------------------

/// Unix：向 `~/.zshrc` / `~/.bashrc` 幂等注入 `~/.local/bin` 的 PATH 导出
#[cfg(not(windows))]
fn inject_shell_rc(app_handle: &AppHandle) -> Result<(), String> {
    let home = app_handle
        .path()
        .home_dir()
        .map_err(|_| "failed to resolve home directory".to_string())?;
    let block = format!("{RC_MARK_START}\nexport PATH=\"$HOME/.local/bin:$PATH\"\n{RC_MARK_END}\n");

    for name in RC_FILES {
        let rc_path = home.join(name);
        let mut content = fs::read_to_string(&rc_path).unwrap_or_default();
        if content.contains(RC_MARK_START) {
            continue;
        }
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&block);
        fs::write(&rc_path, content)
            .map_err(|e| format!("write {} failed: {e}", rc_path.display()))?;
        log::info!("Injected PATH export into {}", rc_path.display());
    }
    Ok(())
}

/// Unix：从 rc 文件中移除注入块
#[cfg(not(windows))]
fn strip_shell_rc(app_handle: &AppHandle) -> Result<(), String> {
    let home = app_handle
        .path()
        .home_dir()
        .map_err(|_| "failed to resolve home directory".to_string())?;
    for name in RC_FILES {
        let rc_path = home.join(name);
        let content = fs::read_to_string(&rc_path).unwrap_or_default();
        let cleaned = strip_rc_block(&content);
        if cleaned != content {
            fs::write(&rc_path, cleaned)
                .map_err(|e| format!("write {} failed: {e}", rc_path.display()))?;
            log::info!("Removed PATH export from {}", rc_path.display());
        }
    }
    Ok(())
}

/// 移除 rc 文件中的标记块（含标记行本身）。
/// 仅 Unix 的 strip_shell_rc 使用；RC 标记常量也是 #[cfg(unix)]，
/// 故此处同样门控，避免 Windows 构建引用不存在的常量。
#[cfg(not(windows))]
fn strip_rc_block(content: &str) -> String {
    let mut lines = content.lines().peekable();
    let mut out = String::with_capacity(content.len());
    let mut skipping = false;
    while let Some(line) = lines.next() {
        if line.trim() == RC_MARK_START {
            skipping = true;
            continue;
        }
        if skipping {
            if line.trim() == RC_MARK_END {
                skipping = false;
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}
