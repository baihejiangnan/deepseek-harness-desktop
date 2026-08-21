use crate::service::workflow::{
    status::{self, Status},
    utils,
};
use tauri::AppHandle;

/// 检测 dsh 进程状态并更新
///
/// 使用 HTTP 请求检测 Harness 服务是否真正就绪，就绪后更新全局状态
pub async fn trigger(app_handle: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let current_status = status::get_status();

    let Some(port) = crate::service::workflow::runtime_port() else {
        return Ok(());
    };
    // 只有本应用仍持有启动 PID 时才接受 HTTP 健康结果，避免把同端口的
    // 其他本地 Web 服务误识别成 Harness。
    let is_dsh_running =
        crate::service::workflow::has_owned_process() && utils::is_dsh_running(port).await;
    log::trace!("DSH status check: dsh_running={}", is_dsh_running);

    // 只有当当前状态为运行中时，才更新状态
    if is_dsh_running && current_status != Status::Running {
        status::set_status(Status::Running);
        status::emit_status(&app_handle);
    }

    Ok(())
}
