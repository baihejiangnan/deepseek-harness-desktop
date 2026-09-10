import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 统一的保存状态（方案 §3.4）。现状是完全各写各的：personalization 用 `saved`
 * 布尔量加裸 setTimeout，debug-sidebar 用 useMutation 且常常没有 onError，
 * 实例配置则把错误串留在 store 里可能是上一次操作的残留。
 *
 * 只负责"一次写操作的状态机"，不猜具体错误文案：调用方把后端返回的稳定错误码
 * 原样放进 `error`，界面负责把它就近展示。
 */
export type SavePhase = 'idle' | 'saving' | 'saved' | 'failed'

export interface SaveStatus {
  phase: SavePhase
  /** 失败时的原始原因，成功或进行中为空串。 */
  error: string
  /** 供按钮禁用与"保存中"文案直接使用的派生值。 */
  pending: boolean
  /** 执行一次写入并驱动状态机；错误会被重新抛出，方便调用方决定是否再弹提示。 */
  run: (task: () => Promise<unknown>) => Promise<void>
  /** 主动回到空闲，例如表单字段被再次修改时。 */
  reset: () => void
}

export function useSaveStatus(options?: { /** "已保存"提示的停留时长，传 0 表示常驻直到下次操作。 */ holdMs?: number }): SaveStatus {
  const holdMs = options?.holdMs ?? 1800
  const [phase, setPhase] = useState<SavePhase>('idle')
  const [error, setError] = useState('')
  const timerRef = useRef<number | null>(null)

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => clearTimer, [])

  const reset = useCallback(() => {
    clearTimer()
    setPhase('idle')
    setError('')
  }, [])

  const run = useCallback(async (task: () => Promise<unknown>) => {
    clearTimer()
    setPhase('saving')
    setError('')
    try {
      await task()
      setPhase('saved')
      if (holdMs > 0)
        timerRef.current = window.setTimeout(setPhase, holdMs, 'idle')
    }
    catch (err) {
      // 失败必须停在这里，不能自动回落到"看起来成功"的状态。
      setPhase('failed')
      setError(String(err))
      throw err
    }
  }, [holdMs])

  return { phase, error, pending: phase === 'saving', run, reset }
}

/** 把状态机映射成一句可见反馈；文案由调用方提供，避免共享层固化命名空间。 */
export function saveStatusLabel(status: SaveStatus, texts: { saving: ReactNode, saved: ReactNode, failed: ReactNode }): ReactNode {
  if (status.phase === 'saving')
    return texts.saving
  if (status.phase === 'failed')
    return texts.failed
  if (status.phase === 'saved')
    return texts.saved
  return null
}
