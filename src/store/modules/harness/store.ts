/* eslint-disable no-control-regex */
import type { UnlistenFn } from '@tauri-apps/api/event'
import type {
  InstallerState,
  InstallProgress,
  SetupStatus,
  SidebarBusyAction,
} from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { queryClient } from '@/config/client'

const MAX_RETRIES = 8
const IFRAME_LOAD_TIMEOUT = 20000
/** 启动失败时从服务日志尾部挑选的原始行上限（ANSI 清洗后按行截断） */
const LOG_TAIL_MAX_BYTES = 16 * 1024
/** 日志中常见的错误标记，用于失败时挑出真正的问题行而不是整个堆栈 */
const ERROR_LINE_MARKERS = /error|duplicate|fatal|panic|throw|✖|exception|failed/i

/** 启动失败错误：附带从 dsh 服务日志中读取的真实错误行与可选的冲突提示 */
interface StartupError extends Error {
  logs?: string[]
  pluginConflictHint?: string
}

const initialInstaller: InstallerState = {
  title: '',
  detail: '',
  percentage: 0,
  logs: [],
}

/** 启动流程令牌：boot 并发/重复调用时只采纳最后一次的结果 */
let bootToken = 0
/** 首次自动启动去重（React StrictMode 会重复挂载 effect） */
let bootStarted = false

/** 构建带时间戳的 iframe URL，避免 WebView2 缓存旧页面 */
function generateTimestampedUrl(baseUrl: string): string {
  const timestamp = Date.now()
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}t=${timestamp}`
}

/** 健康检查结果：healthy 表示服务就绪；notOwned 表示 dsh 进程已退出（启动即崩溃，快速失败信号） */
interface HealthCheckResult {
  healthy: boolean
  notOwned: boolean
}

/** 通过 Rust 代理探测服务健康状态（超时 8s，网络抖动时重试） */
async function checkHealthViaProxy(): Promise<HealthCheckResult> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('health check timeout')), 8000)
    })
    const resultPromise = invoke<string>('proxy_health_check')
    const result = await Promise.race([resultPromise, timeoutPromise])

    const lower = result.toLowerCase()
    if (
      lower.includes('healthy')
      || lower.includes('ready')
      || result.includes('200')
      || result.includes('201')
      || lower.includes('ok')
    ) {
      console.warn('[Harness] health check passed:', result)
      return { healthy: true, notOwned: false }
    }
    console.warn('[Harness] health check returned:', result)
    return { healthy: false, notOwned: false }
  }
  catch (err) {
    const message = String(err)
    if (message.includes('HARNESS_NOT_OWNED')) {
      // dsh 进程已退出（典型如插件冲突导致启动即崩溃），继续等只会白白耗完
      // 8 轮超时，让调用方立刻结束重试并展示日志里的真实错误。
      console.warn('[Harness] dsh process exited during startup, failing fast')
      return { healthy: false, notOwned: true }
    }
    if (message.includes('502') || message.includes('Bad Gateway')) {
      console.warn('[Harness] transient 502 during health check, retrying')
    }
    else {
      console.error('[Harness] health check failed:', err)
    }
    return { healthy: false, notOwned: false }
  }
}

/** 读取服务日志尾部（去掉 ANSI 转义与空行），启动失败时展示真实错误 */
async function readServiceLogTail(): Promise<string[]> {
  try {
    const raw = await invoke<string>('read_service_logs', { maxBytes: LOG_TAIL_MAX_BYTES })
    return raw
      .split(/\r?\n/)
      .map(line => line.replace(/\x1B\[[0-9;]*m/g, '').trim())
      .filter(Boolean)
  }
  catch (err) {
    console.error('[Harness] failed to read service logs:', err)
    return []
  }
}

/** 从日志行中挑出真正的错误行（命中错误标记，最多 8 行）；没有命中则退回最后 8 行 */
function pickErrorLines(lines: string[]): string[] {
  const errored = lines.filter(line => ERROR_LINE_MARKERS.test(line)).slice(0, 8)
  return errored.length > 0 ? errored : lines.slice(-8)
}

/** 失败时把服务日志的真实错误行与冲突提示挂到错误对象上 */
async function attachStartupDiagnostics(err: unknown): Promise<StartupError> {
  const startupError = err as StartupError
  if (!startupError.logs) {
    const lines = await readServiceLogTail()
    startupError.logs = pickErrorLines(lines)
    // 识别插件路由冲突（如 `duplicate prefix route "/sidebar/api"`），给出可操作的提示
    if (lines.join('\n').includes('duplicate prefix route')) {
      startupError.pluginConflictHint = i18next.t('errors.plugin_route_conflict')
    }
  }
  return startupError
}

/**
 * 桌面外壳核心业务模块：安装/启动流程、服务生命周期（启动/健康检查/重启/停止）、
 * iframe 加载状态与挂起兜底。
 *
 * 拆分说明（参考 damn-reports 的 store 组织方式）：
 * 版本更新与下载完成提示分别收敛到 updater / download 模块，
 * 本模块专注服务生命周期与页面加载状态。
 */
export const harness = defineStore({
  state: () => ({
    status: 'ready' as SetupStatus,
    installer: initialInstaller,
    errorMsg: '',
    /** 启动失败时从 dsh 服务日志中读取的真实错误行（Loadable 错误态日志面板） */
    errorLogs: [] as string[],
    /** 识别到插件路由冲突时的针对性提示（Loadable children 展示） */
    pluginConflictHint: '',
    serviceUrl: 'http://127.0.0.1:3080',
    /** 带时间戳的 iframe 地址（boot 时生成一次，避免缓存） */
    iframeSrc: '',
    iframeLoaded: false,
    iframeError: false,
    iframeKey: 0,
    serviceHealthy: false,
    serviceRunning: false,
    busyAction: null as SidebarBusyAction,
  }),
  actions: {
    /** 首次挂载时自动启动（StrictMode 重复挂载下保证只执行一次） */
    startup() {
      if (bootStarted)
        return
      bootStarted = true
      void this.boot()
    },

    /** 刷新 iframe：清除加载态并延迟重新挂载 */
    refreshIframe() {
      this.iframeLoaded = false
      this.iframeError = false
      setTimeout(() => {
        this.iframeKey++
      }, 800)
    },

    /** iframe 加载成功/失败时由视图回调更新状态 */
    markIframeLoaded() {
      this.iframeLoaded = true
      this.iframeError = false
    },

    markIframeError() {
      this.iframeError = true
      this.iframeLoaded = false
    },

    /** 安装进度流：只前进不后退，供首次安装/手动更新共用 */
    async listenInstallProgress(): Promise<UnlistenFn> {
      return listen<InstallProgress>('install-progress', (e) => {
        const payload = e.payload
        if (payload.percentage < this.installer.percentage) {
          return
        }
        const logs = payload.log
          ? [...this.installer.logs, payload.log].slice(-5)
          : this.installer.logs
        this.installer = {
          title: payload.title || this.installer.title,
          detail: payload.detail || this.installer.detail,
          percentage: payload.percentage,
          logs,
        }
      })
    },

    /** 拉起服务并等待健康检查通过，通过后才允许挂载 iframe */
    async launchAndWait() {
      this.status = 'ready'
      this.installer = initialInstaller
      this.errorLogs = []
      this.pluginConflictHint = ''
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      try {
        await invoke('launch_harness')
        this.serviceRunning = true
        // 后端遇到端口占用时会自动递增并持久化端口，启动后重新读取真实地址。
        const runtimeInfo = await invoke<{ service_url: string }>('get_runtime_info')
        this.serviceUrl = runtimeInfo.service_url
        this.iframeSrc = generateTimestampedUrl(runtimeInfo.service_url)

        let healthy = false
        let notOwned = false
        for (let attempt = 0; attempt < MAX_RETRIES && !healthy && !notOwned; attempt++) {
          const result = await checkHealthViaProxy()
          healthy = result.healthy
          notOwned = result.notOwned
          if (!healthy && !notOwned) {
            await new Promise(resolve => setTimeout(resolve, 2000))
          }
        }
        if (!healthy) {
          throw new Error(
            i18next.t('errors.service_start_timeout', { port: new URL(this.serviceUrl).port || '3080' }),
          )
        }
        this.serviceHealthy = true
        // 服务（重）启动成功后，dsh 版本/端口/CLI 链接状态等运行时信息可能已变化
        // （典型：Harness 更新后旧版本缓存仍在，调试侧边栏需刷新页面才显示新版本）。
        // 使侧边栏相关查询缓存失效，重新打开/已挂载时自动拉取最新值。
        void queryClient.invalidateQueries({ queryKey: ['info'] })
        void queryClient.invalidateQueries({ queryKey: ['config'] })
        void queryClient.invalidateQueries({ queryKey: ['cli_status'] })
      }
      catch (err) {
        // 失败时附上服务日志里的真实错误行，供错误界面展示而不是只显示超时文案
        throw await attachStartupDiagnostics(err)
      }
    },

    /** 启动流程：检测环境/安装依赖 → 拉起服务 → 已安装时后台检查更新 */
    async boot() {
      const token = ++bootToken
      // 回到加载态：已安装时不再显示检测/启动界面，直接进入页面加载状态
      this.serviceHealthy = false
      this.iframeLoaded = false
      this.iframeError = false
      let unlistenInstall: UnlistenFn | null = null

      try {
        // 事件监听失败（例如 IPC 自定义协议被 CSP 拦截、回退 postMessage 也异常）
        // 不应阻断启动流程，因此容错跳过。
        try {
          unlistenInstall = await this.listenInstallProgress()
        }
        catch (err) {
          console.error('[Harness] failed to listen install-progress:', err)
        }
        const runtimeInfo = await invoke<{ service_url: string }>('get_runtime_info')
        this.serviceUrl = runtimeInfo.service_url
        this.iframeSrc = generateTimestampedUrl(runtimeInfo.service_url)

        // 已安装过则跳过安装界面，避免每次启动都闪现"正在安装依赖..."
        const config = await invoke<{
          installed: boolean
        }>('get_app_config')

        // 仅首次使用需要检测环境/安装依赖；之后直接进入页面。
        // 桌面端自更新（MSI 强杀进程）后 store 可能被复位/损坏显示未安装，
        // 但运行时文件已全部在盘——此时跳过安装/下载界面，install_dependencies
        // 内部自愈补记 installed 后直接启动，避免自动重开时闪现误导用户的界面。
        if (!config.installed) {
          const ready = await invoke<boolean>('runtime_ready')
          if (!ready) {
            this.status = 'installing'
            this.installer = { ...initialInstaller, title: i18next.t('status.installing') }
          }
          await invoke('install_dependencies')
        }

        await this.launchAndWait()
      }
      catch (err) {
        if (token !== bootToken)
          return
        console.error('[Harness] startup failed:', err)
        const startupError = await attachStartupDiagnostics(err)
        this.fail(String(startupError), startupError.logs, startupError.pluginConflictHint)
      }
      finally {
        unlistenInstall?.()
      }
    },

    /** 进入安装态（手动更新前复用，标题区分"安装/更新"） */
    prepareInstall(title: string) {
      this.status = 'installing'
      this.installer = { ...initialInstaller, title }
    },

    /** 进入错误态（供本模块与 updater 模块共用） */
    fail(message: string, logs?: string[], pluginConflictHint?: string) {
      this.errorMsg = message
      this.errorLogs = logs ?? []
      this.pluginConflictHint = pluginConflictHint ?? ''
      this.status = 'error'
      this.serviceRunning = false
    },

    /** 重启服务：先强杀再拉起，最终回到就绪/错误态 */
    async restart() {
      if (this.busyAction)
        return
      this.busyAction = 'restart'
      try {
        await invoke('shutdown_harness')
      }
      catch (err) {
        console.error('[Harness] shutdown during restart failed:', err)
      }
      this.serviceRunning = false
      this.iframeLoaded = false
      try {
        await this.boot()
      }
      finally {
        this.busyAction = null
      }
    },

    /** 停止服务并回到停止态界面 */
    async shutdown() {
      if (this.busyAction)
        return
      this.busyAction = 'shutdown'
      try {
        await invoke('shutdown_harness')
      }
      catch (err) {
        console.error('[Harness] shutdown failed:', err)
      }
      finally {
        this.busyAction = null
      }
      this.serviceRunning = false
      this.status = 'error'
      this.errorMsg = i18next.t('ui.stopped')
      this.errorLogs = []
      this.pluginConflictHint = ''
    },

    /** 服务未运行时点击"重试"：重新拉起服务并等待健康检查 */
    async start() {
      if (this.busyAction)
        return
      this.busyAction = 'start'
      try {
        await this.boot()
      }
      finally {
        this.busyAction = null
      }
    },

    /** 在系统浏览器中打开服务地址 */
    async openBrowser() {
      if (this.busyAction)
        return
      this.busyAction = 'openBrowser'
      try {
        await invoke('open_in_browser')
      }
      catch (err) {
        console.error('[Harness] open in browser failed:', err)
      }
      finally {
        this.busyAction = null
      }
    },

  },
})

// 进入 ready 后 iframe 长时间未加载（dsh 未就绪/挂起）→ 转为错误界面，
// 避免一直停在黑色加载遮罩
let iframeLoadTimer: ReturnType<typeof setTimeout> | null = null
harness.$subscribe(() => {
  const { status, serviceHealthy, iframeLoaded, iframeError } = harness.$state
  if (status === 'ready' && serviceHealthy && !iframeLoaded && !iframeError) {
    if (!iframeLoadTimer) {
      iframeLoadTimer = setTimeout(() => {
        iframeLoadTimer = null
        harness.iframeLoaded = false
        harness.iframeError = true
      }, IFRAME_LOAD_TIMEOUT)
    }
  }
  else {
    if (iframeLoadTimer) {
      clearTimeout(iframeLoadTimer)
      iframeLoadTimer = null
    }
  }
})
