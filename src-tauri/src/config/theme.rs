use std::fs;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use super::runtime::get_dsh_data_path;

/// dsh 主题偏好（对应 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DshTheme {
    Dark,
    Light,
    System,
}

const DEFAULT_THEME: DshTheme = DshTheme::Dark;

static LAST_EMITTED: OnceLock<Mutex<Option<DshTheme>>> = OnceLock::new();

/// 读取 dsh 主题偏好；settings.yaml 缺失或解析失败时回退为深色
pub fn get_dsh_theme(app_handle: &AppHandle) -> DshTheme {
    let settings_path = get_dsh_data_path(app_handle).join("settings.yaml");
    let content = match fs::read_to_string(&settings_path) {
        Ok(content) => content,
        Err(err) => {
            log::debug!("failed to read dsh settings.yaml: {}", err);
            return DEFAULT_THEME;
        }
    };
    parse_theme_preference(&content).unwrap_or(DEFAULT_THEME)
}

/// 从 settings.yaml 文本中提取 `ui-theme.preference`（light/dark/system）
fn parse_theme_preference(content: &str) -> Option<DshTheme> {
    let mut in_ui_theme = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("ui-theme:") {
            in_ui_theme = true;
            continue;
        }
        if !in_ui_theme {
            continue;
        }
        // ui-theme 段结束（遇到无缩进的新顶层 key）
        if !line.starts_with(' ') && !line.starts_with('\t') {
            return None;
        }
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some(value) = trimmed.strip_prefix("preference:") {
                return match value.trim() {
                    "light" => Some(DshTheme::Light),
                    "dark" => Some(DshTheme::Dark),
                    "system" => Some(DshTheme::System),
                    _ => None,
                };
            }
        }
    }
    None
}

/// 主题偏好变化时向前端推送 `dsh-theme-updated` 事件（仅在变化时触发一次）
pub fn check_and_emit_theme(app_handle: &AppHandle) {
    let theme = get_dsh_theme(app_handle);
    let mut last = LAST_EMITTED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap();
    if *last == Some(theme) {
        return;
    }
    *last = Some(theme);
    log::debug!("dsh theme preference changed: {:?}", theme);
    let _ = app_handle.emit("dsh-theme-updated", &theme);
}
