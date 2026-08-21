#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::Arc;

use tauri::{
    ipc::Invoke,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, Runtime, Url, WebviewUrl, WebviewWindowBuilder, Wry,
};

use crate::desktop::mode::RunMode;
#[cfg(windows)]
use crate::desktop::window::on_page_load;
use crate::desktop::window::{on_download, on_new_window};

fn launcher_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../../icons/launcher.ico"))
        .map(|image| image.to_owned())
}

/// setup app
pub fn setup(app_handle: tauri::AppHandle) {
    // 启动前清扫上次崩溃残留的孤儿 Harness（端口/PID 双重确认，见
    // workflow::sweep_orphan_harness），避免新实例一路漂移端口
    crate::service::workflow::sweep_orphan_harness(&app_handle);

    // 启动进程监控（tick 检测 dsh 服务状态）
    crate::service::scheduler::start(&app_handle);

    // 命令行集成自愈：已安装且开启时，确保 shim 与 PATH 注册完整
    // （shim 被删除、PATH 条目丢失等情况下自动重建）
    tauri::async_runtime::spawn(async move {
        let setting = crate::config::get_store_dat_setting(&app_handle);
        if !setting.installed || !setting.cli_link_enabled {
            return;
        }
        if let Err(e) = crate::service::cli::ensure(&app_handle) {
            log::warn!("cli link self-heal failed: {e}");
        }
    });
}

/// setup tray
pub fn tray(app: &tauri::AppHandle<Wry>) -> tauri::Result<()> {
    // 启动器托盘使用启动器专属图标；实例窗口仍使用默认图标。
    let icon = launcher_icon()?;
    fn show_tray_menu<R: Runtime>(app: &tauri::AppHandle<R>, position: PhysicalPosition<f64>) {
        let Some(window) = app.get_webview_window("tray-menu") else {
            log::warn!("[tray] tray-menu window not found");
            return;
        };

        // Use the real physical window size: inner_size is expressed in logical
        // pixels, while tray click coordinates are physical pixels. Mixing the
        // two made the panel drift away from the icon on 125%/150% scaling.
        let size = window
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(320, 460));
        let scale = window.scale_factor().unwrap_or(1.0);
        let edge_gap = (6.0 * scale).round() as i32;
        let taskbar_offset = (22.0 * scale).round() as i32;
        let x = (position.x.round() as i32 - size.width as i32 + taskbar_offset).max(edge_gap);
        let y = (position.y.round() as i32 - size.height as i32 - taskbar_offset).max(edge_gap);
        if let Err(error) = window.set_position(PhysicalPosition::new(x, y)) {
            log::warn!("[tray] failed to position tray menu: {error}");
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }

    fn handle_tray_icon_event<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, event: &TrayIconEvent) {
        if let TrayIconEvent::Click {
            position,
            button: MouseButton::Left | MouseButton::Right,
            ..
        } = event
        {
            show_tray_menu(tray.app_handle(), *position);
        }
    }

    // 构建托盘图标
    let _ = TrayIconBuilder::new()
        .icon(icon)
        // The native menu cannot match the launcher's rounded cloud-white UI.
        .show_menu_on_left_click(false)
        .tooltip("DSH Launcher")
        .on_tray_icon_event(move |tray, event| handle_tray_icon_event(tray, &event))
        .build(app)?;

    Ok(())
}

/// Build the rounded, theme-aware WebView used as the system-tray panel.
pub fn build_tray_window(app: &tauri::AppHandle<Wry>) -> tauri::Result<()> {
    if app.get_webview_window("tray-menu").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "tray-menu",
        WebviewUrl::App("index.html?view=tray".into()),
    )
    .title("DSH Launcher")
    .icon(launcher_icon()?)?
    .inner_size(320.0, 460.0)
    .min_inner_size(300.0, 380.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .always_on_top(true)
    .shadow(true)
    .focused(false)
    .visible(false)
    .build()?;
    Ok(())
}

/// 构建主窗口。
///
/// 主窗口在这里手动创建（不再从 tauri.conf.json 声明）：
/// config 声明的窗口无法挂载 on_download，而内嵌 iframe 的 dsh 页面
/// 触发下载时 WebView2 静默保存、用户零感知，需要接管下载以给出反馈。
pub fn build_main_window(app: &tauri::AppHandle<Wry>) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let app_handle = app.clone();

    #[cfg(windows)]
    let _notification_handlers_registered = Arc::new(AtomicBool::new(false));
    #[cfg(windows)]
    let notification_handlers_registered_for_page = _notification_handlers_registered.clone();

    let webview_builder =
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Deepseek Harness Desktop")
            .icon(launcher_icon()?)?
            .inner_size(1078.0, 654.0)
            .min_inner_size(860.0, 560.0)
            .resizable(true)
            // 无系统标题栏：窗口 chrome 由壳层 ShellNavBar 常驻提供
            // （44px 顶部导航：左侧 iframe 导航控制 + 右侧窗口控制）
            .decorations(false)
            // 恢复 iframe 内 HTML5 拖拽（拖入图片/拖动元素）：
            // Tauri 默认注册 wry drag_drop_handler → WebView2 SetAllowExternalDrop(false)
            // 并注入 IDropTarget 接管拖放，iframe 内拖拽被禁用。
            // 注意不能用 .drag_and_drop(false)：它只设置 tao 窗口层的拖放开关
            // （tauri issue #13761），不影响 webview 层，拖拽依旧失效；
            // disable_drag_drop_handler 才能关掉 wry 的接管（等价于旧配置 dragDropEnabled: false）。
            .disable_drag_drop_handler()
            // 接管内嵌 iframe 的 window.open() / target=_blank 新窗口请求：
            // WebView2 里这类请求走 NewWindowRequested，wry 在没有 handler 时
            // 直接 SetHandled(true) 吞掉（点了没反应）——dshmarket 等预设插件的
            // “源码”按钮在桌面端因此无法跳转（浏览器里正常）。
            // 这里把 http(s) 链接交给系统浏览器打开，其余协议一律拒绝。
            .on_new_window(move |url, features| on_new_window(app_handle.clone(), url, features))
            .on_download(|webview, event| on_download(webview, event));

    #[cfg(windows)]
    let webview_builder = webview_builder.on_page_load(move |webview_window, payload| {
        on_page_load(
            webview_window,
            payload,
            notification_handlers_registered_for_page.clone(),
        )
    });

    // 非 Windows（macOS/Linux）没有 WebView2 的 FrameCreated/ContentLoading 流程，
    // 直接用 Tauri 的 initialization_script_for_all_frames 把通知桥、导航桥与样式桥注入
    // 所有 frame（脚本均带 window.__dsh_*_bridge__ 幂等守卫，重复注入安全）。
    #[cfg(not(windows))]
    let webview_builder = webview_builder
        .initialization_script_for_all_frames(crate::desktop::notification::NOTIFICATION_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::nav::NAV_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::style::IFRAME_STYLES_JS);

    let webview_window = webview_builder.build()?;

    #[cfg(windows)]
    {
        if !_notification_handlers_registered.swap(true, Ordering::SeqCst) {
            log::info!("[notification] scheduling handler registration from setup");
            let webview_for_dialog = webview_window.clone();
            if let Err(e) = webview_window.with_webview(move |webview| {
                if let Err(e) = crate::desktop::notification::enable_notification_permissions(
                    webview,
                    webview_for_dialog,
                ) {
                    log::warn!("[webview] failed to enable notification permission: {e}");
                }
            }) {
                log::warn!("[webview] failed to schedule notification permission setup: {e}");
            }
        }
    }

    Ok(webview_window)
}

/// 构建实例宿主窗口。实例窗口不加载桌面端 React 壳层，而是直接加载
/// Harness 自己提供的 Web 地址；因此 DSH 的路由、更新和存储完全由 DSH 管理。
pub fn build_instance_window(
    app: &tauri::AppHandle<Wry>,
    instance: &crate::config::instance::DshInstance,
    port: u16,
) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let url = Url::parse(&crate::config::get_dsh_service_url(port))
        .expect("DSH service URL is generated from a loopback address and numeric port");
    let app_handle = app.clone();
    let window = WebviewWindowBuilder::new(
        app,
        format!("instance-{}", instance.id),
        WebviewUrl::External(url),
    )
    .title(format!("DSH - {}", instance.name))
    .inner_size(1280.0, 800.0)
    .min_inner_size(960.0, 640.0)
    .resizable(true)
    .on_new_window(move |url, features| on_new_window(app_handle.clone(), url, features))
    .on_download(|webview, event| on_download(webview, event))
    .build()?;
    Ok(window)
}

// configure invoke handler
pub fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::bridge::cmd::install_dependencies,
        crate::bridge::cmd::check_dsh_update,
        crate::bridge::cmd::launch_harness,
        crate::bridge::cmd::export_instance_profile,
        crate::bridge::cmd::export_instance_home,
        crate::bridge::cmd::launch_instance_window,
        crate::bridge::cmd::focus_instance_window,
        crate::bridge::cmd::list_running_instances,
        crate::bridge::cmd::get_running_instance_ports,
        crate::bridge::cmd::stop_instance_window,
        crate::bridge::cmd::list_instances,
        crate::bridge::cmd::create_instance,
        crate::bridge::cmd::update_instance,
        crate::bridge::cmd::select_instance,
        crate::bridge::cmd::remove_instance,
        crate::bridge::cmd::get_instance_removal_impact,
        crate::bridge::cmd::get_instance_sharing,
        crate::bridge::cmd::choose_dsh_home,
        crate::bridge::cmd::shutdown_harness,
        crate::bridge::cmd::restart_harness,
        crate::bridge::cmd::get_dsh_status,
        crate::bridge::cmd::install_plugin_packages,
        crate::bridge::cmd::install_plugin_packages_for_instance,
        crate::bridge::cmd::get_plugin_catalog,
        crate::bridge::cmd::install_catalog_plugin_for_instance,
        crate::bridge::cmd::get_plugin_pack_catalog,
        crate::bridge::cmd::get_plugin_pack_detail,
        crate::bridge::cmd::install_plugin_pack_for_instance,
        crate::bridge::cmd::cancel_plugin_install,
        crate::bridge::cmd::get_dsh_plugins,
        crate::bridge::cmd::get_dsh_plugins_for_instance,
        crate::bridge::cmd::set_plugin_enabled_for_instance,
        crate::bridge::cmd::remove_plugin_for_instance,
        crate::bridge::cmd::proxy_health_check,
        crate::bridge::cmd::get_runtime_info,
        crate::bridge::cmd::runtime_ready,
        crate::bridge::cmd::get_app_config,
        crate::bridge::cmd::update_app_config,
        crate::bridge::cmd::get_cli_link_status,
        crate::bridge::cmd::open_in_browser,
        crate::bridge::cmd::copy_service_url,
        crate::bridge::cmd::reveal_data_dir,
        crate::bridge::cmd::reveal_in_folder,
        crate::bridge::cmd::read_service_logs,
        crate::bridge::cmd::read_run_logs,
        crate::bridge::cmd::clear_service_logs,
        crate::bridge::cmd::set_language,
        crate::bridge::cmd::toggle_sidebar,
        crate::bridge::cmd::get_dsh_theme,
        crate::bridge::cmd::check_desktop_update,
        crate::bridge::cmd::download_desktop_update,
        crate::bridge::cmd::open_desktop_installer,
        crate::bridge::cmd::get_desktop_about,
        crate::bridge::cmd::open_external_url,
        crate::bridge::cmd::quit_app,
        crate::desktop::notification::show_native_notification,
    ]
}

// configure tauri builder
pub fn builder() -> tauri::Builder<tauri::Wry> {
    let mode = crate::desktop::mode::current();
    let window_event_mode = mode.clone();
    let builder = tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();
            let mode = crate::desktop::mode::current();
            match mode {
                RunMode::Launcher => {
                    build_main_window(&app_handle)?;
                    build_tray_window(&app_handle)?;
                    let opacity =
                        crate::config::get_store_dat_setting(&app_handle).launcher_opacity;
                    if let Err(error) =
                        crate::bridge::cmd::apply_launcher_window_opacity(&app_handle, opacity)
                    {
                        log::warn!("Failed to restore launcher opacity: {error}");
                    }
                    tray(&app_handle)?;
                    setup(app_handle.clone());
                }
                RunMode::Instance { id } => {
                    let instance = crate::config::instance::find(&app_handle, &id)
                        .map_err(std::io::Error::other)?;
                    crate::config::instance::set_active(Some(instance.clone()));
                    tauri::async_runtime::block_on(async {
                        crate::service::workflow::start(app_handle.clone()).await
                    })
                    .map_err(std::io::Error::other)?;
                    let port = crate::service::workflow::runtime_port()
                        .ok_or_else(|| std::io::Error::other("INSTANCE_PORT_UNAVAILABLE"))?;
                    build_instance_window(&app_handle, &instance, port)?;
                    crate::service::scheduler::start(&app_handle);
                }
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() == "tray-menu" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    tauri::WindowEvent::Focused(false) => {
                        let _ = window.hide();
                    }
                    _ => {}
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if matches!(window_event_mode, RunMode::Launcher) {
                    // 启动器关闭按钮只隐藏到托盘，实例窗口则允许正常关闭。
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });

    // 单例模式：多次双击图标（或重复启动）时不会新开窗口，而是把
    // 已存在的（可能已隐藏到托盘）主窗口调到前台，实现“单例 + 复用后台窗口”。
    // 该回调在首次启动时也会以当前进程的参数触发一次（幂等，仅 show/focus），
    // 之后每次二次启动都会派发到这里，重新展示后台运行的主窗口。
    // 仅在生产环境（release）启用：debug 开发调试时若启用单例，
    // 二次启动的调试进程会被吞掉（例如 tauri dev 多实例调试），
    // 因此开发环境跳过该插件。
    #[cfg(not(debug_assertions))]
    let builder = if matches!(mode, RunMode::Launcher) {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            crate::core::utils::show_main_window(app);
        }))
    } else {
        builder
    };

    builder
        // Opener plugin
        .plugin(tauri_plugin_opener::init())
        // Notification plugin（Windows 上以 tauri-winrt-notification 实现点击回调，
        // 注册官方插件保留跨平台回退能力）
        .plugin(tauri_plugin_notification::init())
        // FS plugin
        .plugin(tauri_plugin_fs::init())
        // Simple Store plugin
        .plugin(tauri_plugin_store::Builder::new().build())
        // Clipboard plugin
        .plugin(tauri_plugin_clipboard_manager::init())
}
