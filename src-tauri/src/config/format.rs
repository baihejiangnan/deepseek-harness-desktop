use crate::config::DSH_HOST;

/// 获取指定端口的 Harness 服务地址
pub fn get_dsh_service_url(port: u16) -> String {
    format!("{}:{}", DSH_HOST, port)
}
