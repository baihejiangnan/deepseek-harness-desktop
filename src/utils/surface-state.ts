import { useEffect, useRef, useState } from 'react'

/**
 * 跨挂载记忆列表页的查询状态（方案 §3.4：页面切换保留搜索、分页与滚动位置）。
 *
 * 启动器的导航对 launch/settings/more 采用条件渲染 + key 重挂载，并且
 * `launchRequest` / `moreRequest` 是有意用 key 变化来强制刷新的。改成"全部常驻"
 * 会破坏这套刷新语义，还会让隐藏页在启动时提前发 IPC，所以这里只把值提到组件之外。
 *
 * 仅存内存、随会话结束失效；需要落盘的用户偏好仍走各自的配置存储。
 */
const surfaces = new Map<string, Record<string, unknown>>()

function bucket(surface: string) {
  let value = surfaces.get(surface)
  if (!value) {
    value = {}
    surfaces.set(surface, value)
  }
  return value
}

/** 与 useState 同签名，但初值取自 surface，写回时同步记忆。 */
export function useSurfaceState<T>(surface: string, key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = bucket(surface)[key]
    return saved === undefined ? initial : saved as T
  })

  function remember(next: T) {
    bucket(surface)[key] = next
    setValue(next)
  }

  return [value, remember]
}

/**
 * 让可滚动容器在重挂载后回到离开时的位置。
 * 滚动事件里即时记录，因此卸载时无需再补一次读取。
 */
export function useSurfaceScroll<T extends HTMLElement>(surface: string, key = 'scrollTop') {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const node = ref.current
    if (!node)
      return
    const saved = bucket(surface)[key]
    if (typeof saved === 'number' && saved > 0)
      node.scrollTop = saved

    function onScroll() {
      bucket(surface)[key] = node!.scrollTop
    }

    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [surface, key])

  return ref
}
