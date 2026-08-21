import type { RefObject } from 'react'
import { useState } from 'react'
import { useEvent } from 'react-use'
import { getIframeOrigin } from '@/utils/iframe-origin'

/**
 * 壳层导航桥（宿主侧）：ShellNavBar 左侧三个控件的消息通道。
 *
 * 协议（与 dsh-tauri 插件 / 桌面端 NAV_SHIM_JS 一致）：
 * - 发送（宿主 → iframe）：`{ source: 'dsh-desktop', type }`
 *   - `dsh://sidebar:toggle`  切换侧边栏
 *   - `dsh://page:prev` / `dsh://page:next`  后退 / 前进
 * - 接收（iframe → 宿主）：`{ source: 'dsh-nav-bridge', type, ... }`
 *   - `dsh://sidebar:collapsed` `{ collapsed }` 侧边栏折叠状态
 *   - `dsh://page:firsted` / `dsh://page:lasted` `{ firsted/lasted }`
 *     历史边界（宿主据此禁用后退/前进按钮）
 *
 * 只在 iframe 直接发来的消息上生效（event.source 校验），与通知桥一致。
 * iframeRef 为空（安装/错误/预装引导页）时只返回默认状态，不发送任何消息。
 */

/** 左侧导航控制动作（宿主 → iframe 命令）。 */
export type ShellNavAction = 'sidebar:toggle' | 'page:prev' | 'page:next'

/** 命令类型映射（消息 type 与 action 一一对应）。 */
const COMMAND_TYPES: Record<ShellNavAction, string> = {
  'sidebar:toggle': 'dsh://sidebar:toggle',
  'page:prev': 'dsh://page:prev',
  'page:next': 'dsh://page:next',
}

/** iframe 导航桥回报协议。 */
interface NavBridgeMessage {
  source?: 'dsh-nav-bridge'
  type?: 'dsh://sidebar:collapsed' | 'dsh://page:firsted' | 'dsh://page:lasted'
  collapsed?: boolean
  firsted?: boolean
  lasted?: boolean
}

export function useIframeTauri(
  iframeRef: RefObject<HTMLIFrameElement | null> | undefined,
): {
  sidebarCollapsed: boolean
  /** 可否后退（!firsted）；默认不可，收到桥回报后更新 */
  canGoBack: boolean
  /** 可否前进（!lasted）；默认不可，收到桥回报后更新 */
  canGoForward: boolean
  sendNav: (action: ShellNavAction) => void
} {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 历史边界默认置位（按钮禁用），等待 iframe 内导航桥回报后更新
  const [pageEdge, setPageEdge] = useState({ firsted: true, lasted: true })

  function handleMessage(event: MessageEvent<NavBridgeMessage>) {
    const data = event.data
    if (!data || typeof data !== 'object' || data.source !== 'dsh-nav-bridge') {
      return
    }
    // 只接受 DSH 直接 iframe 发来的消息；不兼容多层嵌套 iframe。
    if (event.source !== iframeRef?.current?.contentWindow) {
      return
    }
    const iframeOrigin = iframeRef ? getIframeOrigin(iframeRef) : null
    if (!iframeOrigin || event.origin !== iframeOrigin) {
      return
    }
    switch (data.type) {
      case 'dsh://sidebar:collapsed':
        setSidebarCollapsed(Boolean(data.collapsed))
        break
      case 'dsh://page:firsted':
        setPageEdge(prev => ({ ...prev, firsted: Boolean(data.firsted) }))
        break
      case 'dsh://page:lasted':
        setPageEdge(prev => ({ ...prev, lasted: Boolean(data.lasted) }))
        break
    }
  }

  useEvent('message', handleMessage)

  function sendNav(action: ShellNavAction) {
    if (!iframeRef)
      return
    const iframeOrigin = getIframeOrigin(iframeRef)
    if (!iframeOrigin)
      return
    iframeRef?.current?.contentWindow?.postMessage(
      { source: 'dsh-desktop', type: COMMAND_TYPES[action] },
      iframeOrigin,
    )
  }

  return {
    sidebarCollapsed,
    canGoBack: !pageEdge.firsted,
    canGoForward: !pageEdge.lasted,
    sendNav,
  }
}
