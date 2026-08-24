use super::constants::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Setting {
    pub installed: bool,
    pub port: u16,
    pub auto_start: bool,
    #[serde(default = "default_launcher_opacity")]
    pub launcher_opacity: u8,
    #[serde(default = "default_startup_mode")]
    pub startup_mode: String,
    #[serde(default = "default_launcher_theme")]
    pub launcher_theme: String,
    #[serde(default)]
    pub launcher_blur: bool,
    pub language: String,
    #[serde(default)]
    pub dsh_pkg_commit: Option<String>,
    /// 已安装 Harness 发行版对应的 GitHub release tag（与 dsh_pkg_commit 配套，
    /// 用于甄别“记录滞后于文件”与“同版本热修”两种不一致）
    #[serde(default)]
    pub dsh_pkg_tag: Option<String>,
    /// DSH Web CLI capability cache. The key binds the result to the installed
    /// runtime so an update automatically invalidates it.
    #[serde(default)]
    pub dsh_web_capability_key: Option<String>,
    #[serde(default)]
    pub dsh_web_supports_no_open: Option<bool>,
    /// 命令行集成开关：安装后在用户 PATH 中注册 `dsh` 命令
    #[serde(default = "default_cli_link_enabled")]
    pub cli_link_enabled: bool,
    /// 移除实例前是否询问用户先进入导出页面。
    #[serde(default = "default_confirm_before_instance_removal")]
    pub confirm_before_instance_removal: bool,
    /// Explicitly selected DSH runtime. Missing/invalid values are healed by
    /// discovery, preserving compatibility with settings written before
    /// multi-source runtime management existed.
    #[serde(default)]
    pub active_dsh_runtime_id: Option<String>,
}

/// 命令行集成默认开启（开发者工具场景，安装完成即可用）
fn default_cli_link_enabled() -> bool {
    true
}

fn default_confirm_before_instance_removal() -> bool {
    true
}

fn default_launcher_opacity() -> u8 {
    100
}

fn default_startup_mode() -> String {
    "manager".to_string()
}

fn default_launcher_theme() -> String {
    "mist-blue-sakura-pink".to_string()
}

/// 默认服务端口：debug 构建与生产隔离，避免开发时与已运行的桌面端争用 3080。
fn default_port() -> u16 {
    if cfg!(debug_assertions) {
        DSH_DEV_PORT
    } else {
        DSH_PORT
    }
}

impl Default for Setting {
    fn default() -> Self {
        Self {
            installed: false,
            port: default_port(),
            auto_start: true,
            launcher_opacity: default_launcher_opacity(),
            startup_mode: default_startup_mode(),
            launcher_theme: default_launcher_theme(),
            launcher_blur: false,
            language: "zh-CN".to_string(),
            dsh_pkg_commit: None,
            dsh_pkg_tag: None,
            dsh_web_capability_key: None,
            dsh_web_supports_no_open: None,
            cli_link_enabled: default_cli_link_enabled(),
            confirm_before_instance_removal: default_confirm_before_instance_removal(),
            active_dsh_runtime_id: None,
        }
    }
}

pub fn set_store_dat_setting<R: Runtime>(app_handle: &AppHandle<R>, setting: Setting) {
    let store = app_handle
        .store(STORE_DAT_FILE)
        .expect("Failed to load store");
    store.set(STORE_SETTING_KEY, serde_json::to_value(&setting).unwrap());
    store.save().expect("Failed to save store");
    app_handle
        .emit("setting_updated", &serde_json::to_value(&setting).unwrap())
        .expect("Failed to emit event");
}

pub fn get_store_dat_setting<R: Runtime>(app_handle: &AppHandle<R>) -> Setting {
    let store = app_handle
        .store(STORE_DAT_FILE)
        .expect("Failed to load store");
    let raw = store.get(STORE_SETTING_KEY);
    let value = raw.as_ref().and_then(|v| {
        v.as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| Some(v.clone()))
    });
    value
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_else(Setting::default)
}

/// 已安装 Harness 发行版对应的 GitHub release commit hash
pub fn get_dsh_pkg_commit<R: Runtime>(app_handle: &AppHandle<R>) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_commit
}

/// 记录已安装 Harness 发行版的 GitHub release commit hash
pub fn set_dsh_pkg_commit<R: Runtime>(app_handle: &AppHandle<R>, commit: String) {
    let mut setting = get_store_dat_setting(app_handle);
    setting.dsh_pkg_commit = Some(commit);
    set_store_dat_setting(app_handle, setting);
}

/// 已安装 Harness 发行版对应的 GitHub release tag
pub fn get_dsh_pkg_tag<R: Runtime>(app_handle: &AppHandle<R>) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_tag
}

/// 记录已安装 Harness 发行版的 GitHub release tag
pub fn set_dsh_pkg_tag<R: Runtime>(app_handle: &AppHandle<R>, tag: String) {
    let mut setting = get_store_dat_setting(app_handle);
    setting.dsh_pkg_tag = Some(tag);
    set_store_dat_setting(app_handle, setting);
}
