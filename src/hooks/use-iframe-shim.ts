import type { RefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect } from 'react'
import { useEvent, useInterval, useMountedState } from 'react-use'
import { getIframeOrigin } from '@/utils/iframe-origin'

interface NativeNotificationMessage {
  source?: 'dsh-notification-bridge'
  type?: string
  title?: string
  body?: string
  tag?: string
  sessionId?: string
  requireInteraction?: boolean
}

export function useIframeShim(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const isMounted = useMountedState()

  // 接收 iframe 的「原生通知」请求，转发给 Tauri 命令弹出系统通知
  function handleMessage(event: MessageEvent<NativeNotificationMessage>) {
    const data = event.data
    if (!data || typeof data !== 'object' || data.source !== 'dsh-notification-bridge') {
      return
    }
    // 只接受 DSH 直接 iframe 发来的消息；不兼容多层嵌套 iframe。
    if (event.source !== iframeRef.current?.contentWindow) {
      return
    }
    const iframeOrigin = getIframeOrigin(iframeRef)
    if (!iframeOrigin || event.origin !== iframeOrigin) {
      return
    }
    if (data.type !== 'dsh://native-notification') {
      return
    }
    void invoke('show_native_notification', {
      payload: {
        title: data.title ?? '',
        body: data.body ?? '',
        tag: data.tag ?? null,
        sessionId: data.sessionId ?? null,
        requireInteraction: Boolean(data.requireInteraction),
      },
    }).catch(error => console.error('[notification] show_native_notification failed:', error))
  }

  useEvent('message', handleMessage)

  // 系统通知点击 → 通知 iframe 聚焦对应会话
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void listen<{ sessionId?: string | null, title?: string, tag?: string }>(
      'dsh-notification-clicked',
      (event) => {
        const payload = event.payload
        const iframeOrigin = getIframeOrigin(iframeRef)
        if (!iframeOrigin)
          return
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: 'dsh://focus-session',
            sessionId: payload.sessionId || undefined,
            title: payload.title || undefined,
            tag: payload.tag || undefined,
          },
          iframeOrigin,
        )
      },
    ).then((unlistener) => {
      // 订阅完成前若已卸载则立即释放，避免回调泄漏
      if (isMounted()) {
        unlisten = unlistener
      }
      else {
        unlistener()
      }
    })
    return () => {
      unlisten?.()
    }
  // eslint-disable-next-line react/exhaustive-deps
  }, [])

  // 将窗口可见性（最小化/隐藏/失焦）同步给 iframe，便于其暂停渲染
  function syncVisibility() {
    void (async () => {
      try {
        const appWindow = getCurrentWindow()
        const [minimized, visible] = await Promise.all([
          appWindow.isMinimized(),
          appWindow.isVisible(),
        ])
        const hidden = minimized || !visible
        const iframeOrigin = getIframeOrigin(iframeRef)
        if (!iframeOrigin)
          return
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'dsh://visibility-state', hidden },
          iframeOrigin,
        )
      }
      catch (error) {
        console.error('[notification] sync visibility failed:', error)
      }
    })()
  }

  // 窗口焦点/尺寸变化时即时同步可见性
  useEffect(() => {
    let unlisteners: Array<() => void> = []
    void (async () => {
      try {
        const appWindow = getCurrentWindow()
        syncVisibility()
        const unFocus = await appWindow.onFocusChanged(() => {
          void syncVisibility()
        })
        const unResized = await appWindow.onResized(() => {
          void syncVisibility()
        })
        if (isMounted()) {
          unlisteners = [unFocus, unResized]
        }
        else {
          unFocus()
          unResized()
        }
      }
      catch (error) {
        console.error('[notification] visibility listeners failed:', error)
      }
    })()
    return () => {
      unlisteners.forEach(fn => fn())
    }
  // eslint-disable-next-line react/exhaustive-deps
  }, [])

  // 兜底轮询：覆盖监听不到的状态变化（如任务栏切换）
  useInterval(syncVisibility, 1000)
}
