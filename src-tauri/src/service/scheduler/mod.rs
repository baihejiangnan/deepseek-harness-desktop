use std::time::Duration;
use tauri::AppHandle;
use tokio::time;

pub fn start(app_handle: &AppHandle) {
    log::info!("Starting dsh process monitor");
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        scheduler_permanent_loop(app_handle_clone).await;
    });
}

async fn scheduler_permanent_loop(app_handle: AppHandle) {
    let mut interval = time::interval(Duration::from_secs(1));

    loop {
        if let Err(e) = crate::task::tick_check_dsh_process::trigger(app_handle.clone()).await {
            log::warn!("tick_check_dsh_process failed: {e}");
        }
        crate::config::check_and_emit_theme(&app_handle);
        // 已安装插件文件监控：指纹变化（防抖后）推送 `dsh-plugins-updated`
        crate::service::plugin::watch::check_and_emit(&app_handle);
        interval.tick().await;
    }
}
