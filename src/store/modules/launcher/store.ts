import type { DshInstance, InstanceRegistry, InstanceSharing, LauncherView } from './types'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { toast } from '@/utils'
import { harness } from '../harness'
import { updater } from '../updater'

const emptyRegistry: InstanceRegistry = {
  instances: [],
  activeInstanceId: null,
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

    async create(name: string, dshHome: string, profile: string) {
      this.error = ''
      try {
        const instance = await invoke<DshInstance>('create_instance', {
          input: {
            name,
            dshHome,
            profile,
            version: { channel: 'preview', tag: 'latest' },
          },
        })
        await this.load()
        this.registry.activeInstanceId = instance.id
      }
      catch (error) {
        this.error = String(error)
        throw error
      }
    },

    async update(id: string, name: string, dshHome: string, profile: string) {
      if (updater.updating)
        return
      this.error = ''
      try {
        const instance = await invoke<DshInstance>('update_instance', {
          input: { id, name, dshHome, profile },
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

    /** 启动指定实例的宿主进程；协作编排需要按节点拉起任意实例，因此与“启动当前实例”共用同一后端入口 */
    async launchInstance(id: string, minimize = false, startMinimized = false, port?: number) {
      if (updater.updating)
        return
      const target = this.registry.instances.find(item => item.id === id)
      if (!target)
        return
      this.error = ''
      this.busyInstanceId = id
      try {
        await invoke<number>('launch_instance_window', { id, minimized: startMinimized, port })
        this.runningInstanceIds = [...new Set([...this.runningInstanceIds, id])]
        if (minimize)
          await getCurrentWindow().minimize()
      }
      catch (error) {
        const message = String(error)
        if (message.includes('INSTANCE_HOME_RUNNING')) {
          const runningName = message.split(':').slice(2).join(':')
          toast(i18next.t('launcher.same_home_running', { name: runningName }), {
            placement: 'top',
            variant: 'warning',
          })
          await this.refreshRunning()
          return
        }
        this.error = message
        throw error
      }
      finally {
        this.busyInstanceId = null
      }
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
