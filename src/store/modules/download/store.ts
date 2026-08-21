import type { DownloadFinishedPayload } from './types'
import { listen } from '@tauri-apps/api/event'
import { defineStore } from 'valtio-define'

/**
 * 下载完成提示模块：dsh iframe 内的下载在 WebView2 中是静默保存的
 * （用户零感知），由外壳监听 Rust 侧完成事件，弹出"已保存 + 打开文件夹"提示。
 */
export const download = defineStore({
  state: () => ({
    notice: null as DownloadFinishedPayload | null,
  }),
  actions: {
    dismiss() {
      this.notice = null
    },
  },
})

// 模块级监听 Rust 侧下载完成事件（应用生命周期内常驻，无需手动清理）
listen<DownloadFinishedPayload>('harness-download-finished', (e) => {
  download.notice = e.payload
}).catch((err) => {
  console.error('[Download] failed to listen harness-download-finished:', err)
})
