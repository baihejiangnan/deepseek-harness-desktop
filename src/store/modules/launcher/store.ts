import type { UnlistenFn } from '@tauri-apps/api/event'
import type { InstallProgress } from '../harness/types'
import type { DshInstance, InstanceRegistry, InstanceSharing, LauncherView } from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { toast } from '@/utils'
import { providerErrorMessage } from '@/utils/provider-error'
import { harness } from '../harness'
import { updater } from '../updater'

const emptyRegistry: InstanceRegistry = {
  instances: [],
  activeInstanceId: null,
}

export interface InstanceLaunchFailure {
  instanceId: string
  stage: string
  message: string
  plugins: string[]
  log: string
}

/** 本次启动期间的环境准备进度；文案与百分比由后端按阶段上报 */
export interface InstanceInstallProgress {
  title: string
  detail: string
  percentage: number
}

function parseLaunchFailure(error: unknown): InstanceLaunchFailure | null {
  const message = String(error)
  const marker = 'INSTANCE_LAUNCH_FAILED:'
  const index = message.indexOf(marker)
  if (index < 0)
    return null
  try {
    return JSON.parse(message.slice(index + marker.length)) as InstanceLaunchFailure
  }
  catch {
    return null
  }
}

export const launcher = defineStore({
  state: () => ({
    loading: true,
    registry: emptyRegistry,
    runningInstanceIds: [] as string[],
    runningInstancePorts: {} as Record<string, number>,
    busyInstanceId: null as string | null,
    view: 'launcher' as LauncherView,
    error: '',
    sharing: null as InstanceSharing | null,
    launchFailure: null as InstanceLaunchFailure | null,
    installProgress: null as InstanceInstallProgress | null,
  }),
  actions: {
    async load() {
      this.loading = true
      this.error = ''
      try {
        const [registry, running, ports] = await Promise.all([
          invoke<InstanceRegistry>('list_instances'),
          invoke<string[]>('list_running_instances'),
          invoke<Record<string, number>>('get_running_instance_ports'),
        ])
        this.registry = registry
        this.runningInstanceIds = running
        this.runningInstancePorts = ports
      }
      catch (error) {
        this.error = String(error)
      }
      finally {
        this.loading = false
      }
    },

    async refreshRunning() {
      try {
        const [running, ports] = await Promise.all([
          invoke<string[]>('list_running_instances'),
          invoke<Record<string, number>>('get_running_instance_ports'),
        ])
        this.runningInstanceIds = running
        this.runningInstancePorts = ports
      }
      catch (error) {
        console.warn('[Launcher] failed to refresh running instances:', error)
      }
    },

    async chooseHome(): Promise<string | null> {
      return invoke<string | null>('choose_dsh_home')
    },

    async inspectSharing(dshHome: string, profile: string, excludeId?: string) {
      if (!dshHome || !profile) {
        this.sharing = null
        return
      }
      this.sharing = await invoke<InstanceSharing>('get_instance_sharing', {
        dshHome,
        profile,
        excludeId,
      })
    },

    async create(name: string, dshHome: string, profile: string, repairAssistant = false, providerIds: string[] = []) {
      this.error = ''
      try {
        const instance = await invoke<DshInstance>('create_instance', {
          input: {
            repairAssistant,
            name,
            dshHome,
            profile,
            version: { channel: 'preview', tag: 'latest' },
          },
        })
        await this.load()
        this.registry.activeInstanceId = instance.id
        if (providerIds.length > 0) {
          try {
            await invoke('import_provider_templates', { instanceId: instance.id, ids: providerIds, overwrite: false })
          }
          catch (error) {
            this.error = `${i18next.t('providers.created_import_failed')} ${providerErrorMessage(error)}`
          }
        }
      }
      catch (error) {
        this.error = String(error)
        throw error
      }
    },

    async update(id: string, name: string, dshHome: string, profile: string, repairAssistant?: boolean) {
      if (updater.updating)
        return
      this.error = ''
      try {
        const instance = await invoke<DshInstance>('update_instance', {
          input: { id, name, dshHome, profile, repairAssistant },
        })
        this.registry = {
          ...this.registry,
          instances: this.registry.instances.map(item => item.id === id ? instance : item),
        }
        if (this.registry.activeInstanceId === id)
          await this.inspectSharing(instance.dshHome, instance.profile, instance.id)
        return instance
      }
      catch (error) {
        this.error = String(error)
        throw error
      }
    },

    async select(id: string) {
      if (updater.updating)
        return
      if (id === this.registry.activeInstanceId)
        return
      this.error = ''
      try {
        await invoke<DshInstance>('select_instance', { id })
        this.registry.activeInstanceId = id
      }
      catch (error) {
        if (String(error).includes('INSTANCE_RUNNING')) {
          toast(i18next.t('launcher.stop_before_switching'), {
            placement: 'top',
            variant: 'warning',
          })
          return
        }
        this.error = String(error)
      }
    },

    async remove(id: string): Promise<boolean> {
      if (updater.updating)
        return false
      this.error = ''
      try {
        this.registry = await invoke<InstanceRegistry>('remove_instance', { id })
        return true
      }
      catch (error) {
        this.error = String(error)
        return false
      }
    },

    async removeRegistryOnly(id: string): Promise<boolean> {
      if (updater.updating)
        return false
      this.error = ''
      try {
        this.registry = await invoke<InstanceRegistry>('remove_instance_registry_only', { id })
        return true
      }
      catch (error) {
        this.error = String(error)
        return false
      }
    },

    /** 启动指定实例的宿主进程；协作编排需要按节点拉起任意实例，因此与“启动当前实例”共用同一后端入口 */
    async launchInstance(id: string, minimize = false, startMinimized = false, port?: number): Promise<boolean> {
      if (updater.updating)
        return false
      const target = this.registry.instances.find(item => item.id === id)
      if (!target)
        return false
      this.error = ''
      this.launchFailure = null
      this.installProgress = null
      this.busyInstanceId = id
      let unlistenInstall: UnlistenFn | null = null
      try {
        // 运行时下载在启动器进程内同步完成并上报 install-progress，
        // 监听必须早于 launch_instance_window，否则首个阶段事件会丢失。
        unlistenInstall = await listen<InstallProgress>('install-progress', (event) => {
          const payload = event.payload
          if (payload.type === 'done') {
            this.installProgress = null
            return
          }
          const percentage = Math.min(100, Math.max(0, payload.percentage))
          this.installProgress = {
            title: payload.title,
            detail: payload.detail,
            // 解压 TGZ 时总文件数未知，后端会上报回退值，界面只前进不后退。
            percentage: Math.max(percentage, this.installProgress?.percentage ?? 0),
          }
        })
        await invoke<number>('launch_instance_window', { id, minimized: startMinimized, port })
        this.runningInstanceIds = [...new Set([...this.runningInstanceIds, id])]
        if (minimize) {
          // Window chrome failures must not turn a healthy instance into a startup failure.
          await getCurrentWindow().minimize().catch(() => {})
        }
        return true
      }
      catch (error) {
        const message = String(error)
        const failure = parseLaunchFailure(error)
        if (failure) {
          this.launchFailure = failure
          await this.refreshRunning()
          return false
        }
        if (message.includes('INSTANCE_HOME_RUNNING')) {
          const runningName = message.split(':').slice(2).join(':')
          toast(i18next.t('launcher.same_home_running', { name: runningName }), {
            placement: 'top',
            variant: 'warning',
          })
          await this.refreshRunning()
          return false
        }
        this.error = message
        this.launchFailure = { instanceId: id, stage: 'launcher', message, plugins: [], log: '' }
        await this.refreshRunning()
        return false
      }
      finally {
        unlistenInstall?.()
        this.installProgress = null
        if (this.busyInstanceId === id)
          this.busyInstanceId = null
      }
    },

    clearLaunchFailure() {
      this.launchFailure = null
    },

    async launch() {
      const active = this.registry.instances.find(item => item.id === this.registry.activeInstanceId)
      if (!active)
        return
      await this.launchInstance(active.id, true)
    },

    async stopInstance(id: string) {
      if (updater.updating)
        return
      this.error = ''
      this.busyInstanceId = id
      try {
        await invoke('stop_instance_window', { id })
        this.runningInstanceIds = this.runningInstanceIds.filter(item => item !== id)
        const { [id]: _stoppedPort, ...remainingPorts } = this.runningInstancePorts
        this.runningInstancePorts = remainingPorts
      }
      catch (error) {
        this.error = String(error)
      }
      finally {
        this.busyInstanceId = null
      }
    },

    showLauncher() {
      this.view = 'launcher'
    },

    showDsh() {
      if (harness.serviceRunning)
        this.view = 'dsh'
    },

    async stop() {
      await harness.shutdown()
    },
  },
})
