/** Rust 侧 on_download 接管下载后 emit 的完成事件载荷 */
export interface DownloadFinishedPayload {
  url: string
  path: string | null
  success: boolean
}
