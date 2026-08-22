import type { DesktopDownloadProgress, DesktopUpdateInfo } from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { toast } from '@/utils'

const DISMISS_KEY = 'desktop-update-dismissed-tag'

/**
 * 桌面端自更新模块：检查新版本 → 弹出更新对话框 → 下载安装包 → 打开安装器。
 *
 * 与 `updater` 模块（dsh 内核更新）区分：本模块针对桌面应用自身。
 * 轮询检查低频触发（见 components/desktop-updater），Rust 侧每次实时查询、
 * 不做缓存，由低频轮询避免 GitHub 未认证限流。
 */
function readDismissedTag(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? ''
  }
  catch {
    return ''
  }
}

export const desktopUpdate = defineStore({
  state: () => ({
    /** 发现的新版本信息（null 表示暂无） */
    updateInfo: null as DesktopUpdateInfo | null,
    /** 是否正在检查更新（避免并发/重复） */
    checking: false,
    /** 是否正在下载安装包 */
    downloading: false,
    /** 下载进度 0-100 */
    downloadProgress: 0,
    /** 更新对话框开关 */
    updateDialogOpen: false,
    /** 用户已关闭提示的版本 tag（持久化，同版本不再弹 toast） */
    dismissedTag: readDismissedTag(),
  }),
  actions: {
    /**
     * 检查是否有新版本。
     * 轮询与「检查更新」共用；仅在 tag 变化时更新 updateInfo，
     * 既避免重复弹 toast，也让菜单「存在新版本」指示实时反映。
     * 网络失败/限流时抛出错误（不吞掉），由调用方决定如何提示——
     * 绝不能把「检查失败」误报成「已是最新」。
     */
    async check(): Promise<DesktopUpdateInfo | null> {
      if (this.checking)
        return this.updateInfo
      this.checking = true
      try {
        const info = await invoke<DesktopUpdateInfo | null>('check_desktop_update')
        if (info) {
          if (this.updateInfo?.tag !== info.tag)
            this.updateInfo = info
        }
        else {
          this.updateInfo = null
        }
        return info
      }
      finally {
        this.checking = false
      }
    },

    /** 用户关闭 toast 提示：记住该版本，本次会话不再弹出 */
    dismissToast() {
      const tag = this.updateInfo?.tag
      if (!tag)
        return
      this.dismissedTag = tag
      try {
        localStorage.setItem(DISMISS_KEY, tag)
      }
      catch {
        /* 忽略持久化失败 */
      }
    },

    /** 打开更新对话框（「检查更新」菜单）：先检查，有更新才弹框；检查失败提示错误而非「已是最新」 */
    async openUpdateDialog() {
      try {
        if (!this.updateInfo)
          await this.check()
        if (this.updateInfo) {
          this.updateDialogOpen = true
        }
        else {
          toast(i18next.t('update.up_to_date'), { variant: 'default' })
        }
      }
      catch (err) {
        console.warn('[DesktopUpdate] check failed:', err)
        toast(i18next.t('update.check_failed'), { variant: 'danger' })
      }
    },

    closeUpdateDialog() {
      this.updateDialogOpen = false
    },

    /**
     * toast「立即更新」：打开更新对话框并开始下载，避免静默下载无反馈。
     * 对话框内 `downloading` 状态会展示下载进度条；下载完成自动打开安装器并关闭对话框。
     */
    async updateNow() {
      if (!this.updateInfo)
        await this.check()
      if (!this.updateInfo)
        return
      this.updateDialogOpen = true
      await this.downloadAndOpen()
    },

    /**
     * 下载并打开安装包：已下载则直接打开；
     * 否则监听进度流式下载，完成后自动打开安装器。
     */
    async downloadAndOpen() {
      if (this.downloading)
        return
      const info = this.updateInfo
      if (!info)
        return

      // 已下载 → 直接打开安装包
      if (info.downloaded) {
        await this.openInstaller(info.path)
        return
      }

      this.downloading = true
      this.downloadProgress = 0
      try {
        const updated = await invoke<DesktopUpdateInfo>('download_desktop_update')
        this.updateInfo = updated
        if (updated.downloaded)
          await this.openInstaller(updated.path)
      }
      catch (err) {
        console.error('[DesktopUpdate] download failed:', err)
        toast(i18next.t('update.desktop_download_failed'), {
          variant: 'danger',
          placement: 'bottom end',
        })
      }
      finally {
        this.downloading = false
        this.downloadProgress = 0
      }
    },

    /** 打开安装包并收尾（关对话框 + 提示） */
    async openInstaller(path: string) {
      try {
        await invoke('open_desktop_installer', { path })
        this.closeUpdateDialog()
        toast(i18next.t('update.desktop_opened'), {
          variant: 'default',
          placement: 'bottom end',
        })
      }
      catch (err) {
        console.error('[DesktopUpdate] failed to open installer:', err)
        toast(i18next.t('update.desktop_open_failed'), {
          variant: 'danger',
          placement: 'bottom end',
        })
      }
    },
  },
})

// 模块级监听下载进度（应用生命周期内常驻）
listen<DesktopDownloadProgress>('desktop-update-progress', (e) => {
  desktopUpdate.downloadProgress = e.payload.percentage
}).catch((err) => {
  console.error('[DesktopUpdate] failed to listen desktop-update-progress:', err)
})
