import type { UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'

export type DshThemePreference = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function resolveTheme(preference: DshThemePreference): ResolvedTheme {
  if (preference === 'system') {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
  }
  return preference
}

/**
 * 让桌面外壳（侧边栏、设置页等）跟随内嵌 dsh 页面的主题。
 *
 * dsh 把主题偏好持久化在 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`
 * （light/dark/system），后端轮询到变化后通过 `dsh-theme-updated` 事件推送，
 * 这里解析为最终主题并写到 `<html data-theme="...">`，由 CSS 变量切换配色。
 */
export function useDshTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>('dark')
  const preferenceRef = useRef<DshThemePreference>('dark')

  useEffect(() => {
    let unlisten: UnlistenFn | null = null
    let disposed = false

    function apply(preference: DshThemePreference) {
      preferenceRef.current = preference
      if (!disposed) {
        setTheme(resolveTheme(preference))
      }
    }

    invoke<DshThemePreference>('get_dsh_theme')
      .then(preference => apply(preference))
      .catch(err => console.error('[useDshTheme] failed to load theme:', err))

    listen<DshThemePreference>('dsh-theme-updated', (event) => {
      apply(event.payload)
    }).then((fn) => {
      if (disposed) {
        fn()
      }
      else {
        unlisten = fn
      }
    })

    const mediaQuery = window.matchMedia(DARK_QUERY)
    function onSystemThemeChange() {
      if (preferenceRef.current === 'system') {
        setTheme(resolveTheme('system'))
      }
    }
    mediaQuery.addEventListener('change', onSystemThemeChange)

    return () => {
      disposed = true
      mediaQuery.removeEventListener('change', onSystemThemeChange)
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return theme
}
