//! 取消正在进行的预装插件安装。
//!
//! 所有平台都会置位协作式取消标志并推送 `plugin-install-cancelled` 事件，安装
//! 循环据此停止拉起后续子进程。此外：
//! - Windows：按本项目 DSH CLI 完整路径与命令行特征查找插件安装进程树并强制
//!   结束（`taskkill /T /F`）；
//! - Unix：结束被跟踪的子进程所在进程组（子进程以 `process_group(0)` 启动）。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::process::{Command, Stdio};

#[cfg(not(windows))]
use std::sync::atomic::AtomicU32;

#[cfg(windows)]
use crate::config;

/// 前端监听“安装已取消”事件名
const PLUGIN_INSTALL_CANCEL_EVENT: &str = "plugin-install-cancelled";
static INSTALL_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Unix 下当前插件子进程 PID；取消时据此结束整个进程组。
#[cfg(not(windows))]
static ACTIVE_CHILD_PID: AtomicU32 = AtomicU32::new(0);

#[cfg(not(windows))]
pub(crate) fn track_child(pid: u32) {
    ACTIVE_CHILD_PID.store(pid, Ordering::SeqCst);
}

#[cfg(not(windows))]
pub(crate) fn untrack_child() {
    ACTIVE_CHILD_PID.store(0, Ordering::SeqCst);
}

pub fn reset() {
    INSTALL_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
}

pub fn was_requested() -> bool {
    INSTALL_CANCEL_REQUESTED.load(Ordering::SeqCst)
}

fn mark_requested() {
    INSTALL_CANCEL_REQUESTED.store(true, Ordering::SeqCst);
}

/// 取消事件载荷（预留扩展字段）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallCancelPayload {}

/// 取消正在进行的预装插件安装
pub async fn cancel(app_handle: &AppHandle) {
    mark_requested();

    #[cfg(not(windows))]
    {
        let pid = ACTIVE_CHILD_PID.swap(0, Ordering::SeqCst);
        if pid != 0 {
            crate::service::workflow::kill_pid_tree(pid);
        }
    }

    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };

    #[cfg(windows)]
    {
        let dsh = config::get_dsh_binary_path(app_handle)
            .to_string_lossy()
            .replace('\'', "''");
        let profile = config::get_active_profile().replace('\'', "''");
        let ps_cmd = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object {{ ($_.CommandLine -like '*{dsh}*') -and ($_.CommandLine -like '*plugin*--profile*{profile}*add*') }} | ForEach-Object {{ taskkill /PID $_.ProcessId /T /F 2>$null }}"
        );

        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &ps_cmd,
        ]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        if let Err(e) = cmd.output() {
            log::warn!("failed to cancel plugin install: {e}");
        }
    }

    let _ = window.emit(PLUGIN_INSTALL_CANCEL_EVENT, PluginInstallCancelPayload {});
}
