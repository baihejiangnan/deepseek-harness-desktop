/** 安装/启动流程阶段状态 */
export type SetupStatus = 'checking' | 'installing' | 'starting' | 'ready' | 'error'

/** 侧边栏忙碌标记：标识当前正在执行的服务操作 */
export type SidebarBusyAction = 'restart' | 'shutdown' | 'start' | 'openBrowser' | null

/** 安装器展示状态 */
export interface InstallerState {
  title: string
  detail: string
  percentage: number
  logs: string[]
}

/** Rust 侧 install-progress 事件载荷 */
export interface InstallProgress {
  title: string
  detail: string
  log: string
  type: string
  percentage: number
  progress: number
}
