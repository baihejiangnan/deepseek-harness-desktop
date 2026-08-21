import type { RefObject } from 'react'

/** 返回当前 Harness iframe 的精确来源；无有效 HTTP(S) 来源时拒绝通信。 */
export function getIframeOrigin(iframeRef: RefObject<HTMLIFrameElement | null>): string | null {
  const source = iframeRef.current?.src
  if (!source)
    return null
  try {
    const url = new URL(source)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  }
  catch {
    return null
  }
}
