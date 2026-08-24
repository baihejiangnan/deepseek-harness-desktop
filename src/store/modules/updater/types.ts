/** Rust 侧 check_dsh_update 返回的版本信息 */
export interface DshUpdateInfo {
  tag: string
  commit: string | null
  source: 'launcher' | 'npm'
}
