import type { UnlistenFn } from '@tauri-apps/api/event'
import type { InstallProgress } from '../harness/types'
import type { DshUpdateInfo } from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next, { t } from 'i18next'
import { defineStore } from 'valtio-define'
import { toast } from '@/utils'

/**
 * DSH 更新模块：由启动器独立负责检查、下载和进度展示。
 * 实例窗口只负责运行 DSH，不参与核心包更新。
 */
export const updater = defineStore({
  state: () => ({
    /** 发现的新版本信息（null 表示暂无/已被忽略） */
    updateInfo: null as DshUpdateInfo | null,
    /** 是否正在安装更新 */
    updating: false,
    /** 是否正在检查更新 */
    checking: false,
    /** 最近一次检查失败信息（用于版本页展示） */
    checkError: '',
    /** DSH 更新全局进度（由启动器顶部进度条展示） */
    progress: 0,
    phaseTitle: '',
    phaseDetail: '',
  }),
  actions: {
    /** 后台静默检查是否有新版 Harness（网络失败/API 限流时静默跳过） */
    async checkForUpdate(options?: { throwOnError?: boolean }) {
      if (this.updating || this.checking)
        return this.updateInfo
      this.checking = true
      this.checkError = ''
      try {
        const info = await invoke<DshUpdateInfo | null>('check_dsh_update')
        this.updateInfo = info
        return info
      }
      catch (err) {
        this.checkError = String(err)
        console.warn('[Harness] update check skipped:', err)
        if (options?.throwOnError)
          throw err
      }
      finally {
        this.checking = false
      }
    },

    /** 手动检查更新：成功但无新版本时给出明确反馈，网络错误交给页面提示。 */
    async checkManually() {
      if (this.updating || this.checking)
        return this.updateInfo
      try {
        const info = await this.checkForUpdate({ throwOnError: true })
        if (!info) {
          toast(i18next.t('update.up_to_date'), { placement: 'bottom end' })
        }
        return info
      }
      catch (err) {
        toast(i18next.t('update.check_failed'), {
          description: String(err),
          placement: 'bottom end',
          variant: 'danger',
        })
        return null
      }
    },

    /** 启动器侧执行 DSH 更新；实例窗口不参与下载、重启或更新 UI。 */
    async handleUpdate() {
      if (this.updating)
        return

      if (!this.updateInfo) {
        try {
          await this.checkForUpdate({ throwOnError: true })
        }
        catch (err) {
          console.error('[DSH updater] preflight update check failed:', err)
          toast(i18next.t('update.dsh_update_failed'), {
            description: String(err),
            placement: 'bottom end',
            variant: 'danger',
          })
          return
        }
      }
      if (!this.updateInfo)
        return

      let running: string[]
      try {
        running = await invoke<string[]>('list_running_instances')
      }
      catch (err) {
        console.error('[DSH updater] failed to inspect running instances:', err)
        toast(i18next.t('update.dsh_update_failed'), {
          description: String(err),
          placement: 'bottom end',
          variant: 'danger',
        })
        return
      }
      if (running.length > 0) {
        toast(i18next.t('update.dsh_running_instances'), {
          placement: 'bottom end',
          variant: 'warning',
        })
        return
      }

      this.updating = true
      this.progress = 0
      this.phaseTitle = i18next.t('update.dsh_updating')
      this.phaseDetail = ''
      let unlistenInstall: UnlistenFn | null = null
      try {
        unlistenInstall = await listen<InstallProgress>('install-progress', (event) => {
          const payload = event.payload
          this.progress = Math.max(this.progress, Math.min(100, payload.percentage))
          this.phaseTitle = payload.title || this.phaseTitle
          this.phaseDetail = payload.detail || payload.log || this.phaseDetail
        })

        const changed = await invoke<boolean>('install_dependencies')
        if (!changed) {
          this.progress = 100
          toast(i18next.t('update.dsh_verify_failed'), { variant: 'danger', placement: 'bottom end' })
          return
        }

        this.progress = 100
        this.updateInfo = null
        toast(i18next.t('update.dsh_updated'), { placement: 'bottom end', variant: 'accent' })
      }
      catch (err) {
        console.error('[DSH updater] update failed:', err)
        toast(i18next.t('update.dsh_update_failed'), {
          description: String(err),
          placement: 'bottom end',
          variant: 'danger',
        })
      }
      finally {
        unlistenInstall?.()
        // Keep the completed bar visible briefly so 100% is perceptible before it leaves.
        if (this.progress >= 100)
          await new Promise(resolve => setTimeout(resolve, 450))
        this.updating = false
        this.progress = 0
        this.phaseTitle = ''
        this.phaseDetail = ''
      }
    },

    /** 忽略本次更新提示 */
    dismissUpdate() {
      this.updateInfo = null
    },

    showToast() {
      if (!this.updateInfo)
        return
      toast(t('update.available', { tag: this.updateInfo.tag }), {
        actionProps: {
          children: t('update.now'),
          onPress: () => {
            toast.clear()
            void updater.handleUpdate()
          },
          variant: 'tertiary',
        },
        placement: 'bottom end',
        description: this.updateInfo.commit.slice(0, 7),
        variant: 'default',
      })
    },
  },
})
