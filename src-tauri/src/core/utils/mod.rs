use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

pub fn show_window<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 显示主窗口：托盘「打开面板」、托盘左键点击、macOS Dock 图标点击共用。
/// 关闭按钮只隐藏窗口（见 builder 的 on_window_event），所以这里取到即可 show；
/// 若窗口确实不存在（非预期路径），仅记录日志，不重建。
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        show_window(&window);
    } else {
        log::warn!("[window] main window not found, skip show");
    }
}

pub fn app_icon_temp_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let icon = app.default_window_icon()?;
    let path = std::env::temp_dir().join(format!("dsh-notification-{}.png", std::process::id()));
    let rgba = icon.rgba().to_vec();
    let img = image::RgbaImage::from_raw(icon.width(), icon.height(), rgba)?;
    img.save(&path).ok()?;
    Some(path)
}
