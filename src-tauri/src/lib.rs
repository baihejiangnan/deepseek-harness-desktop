mod bridge;
mod config;
mod core;
pub mod desktop;
mod logger;
mod service;
mod task;

pub fn run() {
    // 初始化日志系统
    logger::init();

    desktop::builder()
        .invoke_handler(desktop::handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // macOS：关闭按钮只是隐藏窗口（见 builder 的 on_window_event），
            // 点击 Dock 图标时系统回调 applicationShouldHandleReopen 触发
            // RunEvent::Reopen，这里重新显示主窗口，否则窗口会一直隐藏在托盘。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                crate::core::utils::show_main_window(&app_handle);
            }
            // 退出时回收 Harness 进程：不回收的话，node 进程会在应用退出后
            // 残留并把原生模块 DLL（如 sharp 的 libvips-42.dll）锁在内存，
            // 下次启动重新解压时会失败（Windows os error 32）
            tauri::RunEvent::Exit => {
                let setting = config::get_store_dat_setting(app_handle);
                if setting.installed {
                    service::workflow::stop_on_exit(app_handle.clone(), setting.port);
                }
            }
            _ => {}
        });
}
