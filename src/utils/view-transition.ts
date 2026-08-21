/** 在支持的 WebView 中平滑处理列表重排；其他环境直接执行更新。 */
export async function runViewTransition(update: () => Promise<void> | void) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || reduceMotion) {
    await update()
    return
  }

  const transition = document.startViewTransition(update)
  await transition.updateCallbackDone
}
