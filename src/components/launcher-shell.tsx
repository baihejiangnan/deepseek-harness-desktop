import type { PackInstallProgress } from './download-center'
import { ArrowDownToLine, CircleInfo, Gear, Minus, Persons, Rocket, Square, Xmark } from '@gravity-ui/icons'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { updater } from '@/store/modules/updater'
import CollaborationPanel from './collaboration-panel'
import DownloadCenter from './download-center'
import InstanceManager from './instance-manager'
import InstanceWizard from './instance-wizard'
import MorePanel from './more-panel'
import PersonalizationPanel from './personalization-panel'

type Section = 'launch' | 'resources' | 'collaboration' | 'settings' | 'more'
const DSH_UPDATE_POLL_INTERVAL = 10 * 60_000

/**
 * 全局任务条目（方案 §3.5）。长任务的状态散在三个 store 里，切页后就没有入口，
 * 因此在这里汇成一份清单：既能显示阶段与真实进度，也能点回任务所在页面。
 */
interface ShellTask {
  id: string
  label: string
  section: Section
  tone: 'accent' | 'danger'
  /** 有真实数值才给 percent；不可测量时留空并置 indeterminate，不伪造百分比。 */
  percent?: number
  indeterminate?: boolean
}

export default function LauncherShell() {
  const { t } = useTranslation()
  const { loading, registry, runningInstanceIds, busyInstanceId, installProgress, launchFailure } = useStore(store.launcher)
  const { updating, progress, phaseTitle, indeterminate } = useStore(updater)
  const [appearance, setAppearance] = useState({ theme: 'mist-blue-sakura-pink', blur: false })
  const [section, setSection] = useState<Section>('launch')
  const [launchRequest, setLaunchRequest] = useState(0)
  const [moreRequest, setMoreRequest] = useState(0)
  const [packProgress, setPackProgress] = useState<PackInstallProgress | null>(null)
  const items: Array<{ id: Section, icon: typeof Rocket }> = [
    { id: 'launch', icon: Rocket },
    { id: 'resources', icon: ArrowDownToLine },
    { id: 'collaboration', icon: Persons },
    { id: 'settings', icon: Gear },
    { id: 'more', icon: CircleInfo },
  ]

  useEffect(() => {
    void (async () => {
      await store.launcher.load()
      try {
        const config = await invoke<{ startup_mode?: string, launcher_theme?: string, launcher_blur?: boolean }>('get_app_config')
        setAppearance({ theme: config.launcher_theme ?? 'mist-blue-sakura-pink', blur: config.launcher_blur ?? false })
        if (config.startup_mode === 'last_instance' && store.launcher.registry.activeInstanceId) {
          await store.launcher.launch()
        }
      }
      catch {
        // Keep the manager available when startup preferences cannot be read.
      }
    })()
    const timer = window.setInterval(() => {
      void store.launcher.refreshRunning()
    }, 1000)
    void updater.checkForUpdate()
    const updateTimer = window.setInterval(() => {
      void updater.checkForUpdate()
    }, DSH_UPDATE_POLL_INTERVAL)
    let disposed = false
    let unlistenTrayOpen: (() => void) | undefined
    let unlistenTrayUpdate: (() => void) | undefined
    let unlistenTraySettings: (() => void) | undefined
    void listen('tray-open-launcher', () => {
      setSection('launch')
      void getCurrentWindow().show()
      void getCurrentWindow().setFocus()
    }).then((fn) => {
      if (disposed)
        fn()
      else
        unlistenTrayOpen = fn
    })
    void listen('tray-check-dsh-update', () => {
      setSection('more')
      setMoreRequest(request => request + 1)
      void getCurrentWindow().show()
      void getCurrentWindow().setFocus()
      void updater.checkManually()
    }).then((fn) => {
      if (disposed)
        fn()
      else
        unlistenTrayUpdate = fn
    })
    void listen('tray-open-settings', () => {
      setSection('settings')
      void getCurrentWindow().show()
      void getCurrentWindow().setFocus()
    }).then((fn) => {
      if (disposed)
        fn()
      else
        unlistenTraySettings = fn
    })
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.clearInterval(updateTimer)
      unlistenTrayOpen?.()
      unlistenTrayUpdate?.()
      unlistenTraySettings?.()
    }
  }, [])

  useEffect(() => {
    const handler = () => {
      void invoke<{ launcher_theme?: string, launcher_blur?: boolean }>('get_app_config').then((config) => {
        setAppearance({ theme: config.launcher_theme ?? 'mist-blue-sakura-pink', blur: config.launcher_blur ?? false })
      }).catch(() => {})
    }
    window.addEventListener('launcher-appearance-updated', handler)
    return () => window.removeEventListener('launcher-appearance-updated', handler)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const themeClass = `launcher-theme-${appearance.theme}`
    root.classList.add('launcher-theme', themeClass)
    return () => root.classList.remove('launcher-theme', themeClass)
  }, [appearance.theme])

  const busyInstance = busyInstanceId != null
    ? registry.instances.find(item => item.id === busyInstanceId) ?? null
    : null
  // busyInstanceId 同时覆盖启动与停止：仍在运行清单里的是停止中。
  const busyIsStopping = busyInstanceId != null && runningInstanceIds.includes(busyInstanceId)

  const tasks: ShellTask[] = []
  if (updating) {
    tasks.push({
      id: 'dsh-update',
      label: phaseTitle === '' ? t('update.dsh_updating') : phaseTitle,
      section: 'more',
      tone: 'accent',
      percent: indeterminate ? undefined : Math.max(0, Math.min(100, progress)),
      indeterminate,
    })
  }
  if (packProgress != null && packProgress.total > 0) {
    tasks.push({
      id: 'plugin-pack',
      label: t('download.pack_install_progress', { current: packProgress.completed, total: packProgress.total, plugin: packProgress.plugin }),
      section: 'resources',
      tone: 'accent',
      percent: Math.max(0, Math.min(100, (packProgress.completed / packProgress.total) * 100)),
    })
  }
  if (busyInstance != null) {
    const statusText = busyIsStopping ? t('launcher.instance_status.stopping') : t('launcher.instance_status.booting')
    tasks.push({
      id: 'instance-busy',
      label: `${busyInstance.name} · ${installProgress?.title || statusText}`,
      section: 'launch',
      tone: 'accent',
      percent: installProgress != null && !installProgress.indeterminate ? Math.max(0, Math.min(100, installProgress.percentage)) : undefined,
      indeterminate: true,
    })
  }
  if (launchFailure != null)
    tasks.push({ id: 'launch-failure', label: t('ui.task_launch_failed'), section: 'launch', tone: 'danger' })

  function openTask(task: ShellTask) {
    setSection(task.section)
    // 这两个页面用 key 变化强制刷新（见 §3.4 的 #16 说明），点进任务详情要走同一条路径。
    if (task.section === 'launch')
      setLaunchRequest(request => request + 1)
    if (task.section === 'more')
      setMoreRequest(request => request + 1)
  }

  return (
    <div className={`launcher-theme launcher-theme-${appearance.theme} ${appearance.blur ? 'launcher-blur' : ''} flex h-screen w-screen flex-col bg-[var(--launcher-canvas)] text-[var(--launcher-ink)]`}>
      <header className="launcher-header relative flex h-[57px] flex-none items-center px-4 text-white select-none">
        <div className="z-10 shrink-0 text-[19px] font-semibold tracking-[-0.02em]" data-tauri-drag-region>DSH Launcher</div>
        <nav className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 max-xl:static max-xl:min-w-0 max-xl:flex-1 max-xl:translate-x-0 max-xl:translate-y-0 max-xl:justify-center max-lg:gap-1" data-tauri-drag-region>
          {items.map((item) => {
            const Icon = item.icon
            const task = tasks.find(entry => entry.section === item.id)
            return (
              <button
                key={item.id}
                aria-label={t(`launcher.nav.${item.id}`)}
                title={t(`launcher.nav.${item.id}`)}
                aria-current={section === item.id ? 'page' : undefined}
                className={`relative flex h-[38px] items-center gap-2 rounded-md px-4 text-[15px] font-medium transition-colors duration-150 motion-reduce:transition-none ${section === item.id ? 'bg-white/55 text-[var(--launcher-brand-strong)] shadow-sm' : 'text-white hover:bg-white/15'}`}
                type="button"
                onClick={() => {
                  setSection(item.id)
                  if (item.id === 'launch')
                    setLaunchRequest(request => request + 1)
                }}
              >
                <Icon />
                <span className="max-lg:hidden">{t(`launcher.nav.${item.id}`)}</span>
                {task != null && <span aria-hidden="true" className={`size-1.5 flex-none rounded-full ${task.tone === 'danger' ? 'bg-danger' : 'bg-current'}`} />}
              </button>
            )
          })}
        </nav>
        <div className="flex-1 self-stretch max-xl:hidden" data-tauri-drag-region />
        <button className="z-10 grid size-8 place-items-center rounded-[7px] text-base transition-colors motion-reduce:transition-none hover:bg-white/10" type="button" aria-label={t('nav.minimize')} title={t('nav.minimize')} onClick={() => { void getCurrentWindow().minimize() }}>
          <Minus className="size-4" />
        </button>
        <button className="z-10 grid size-8 place-items-center rounded-[7px] text-base transition-colors motion-reduce:transition-none hover:bg-white/10" type="button" aria-label={t('nav.maximize')} title={t('nav.maximize')} onClick={() => { void getCurrentWindow().toggleMaximize() }}>
          <Square className="size-3.5" />
        </button>
        <button className="z-10 grid size-8 place-items-center rounded-[7px] text-base transition-colors motion-reduce:transition-none hover:bg-danger" type="button" aria-label={t('nav.close')} title={t('nav.close')} onClick={() => { void getCurrentWindow().hide() }}>
          <Xmark className="size-4" />
        </button>
      </header>
      {tasks.length > 0 && (
        <div className="flex-none border-b border-[var(--launcher-border)] bg-[var(--launcher-surface)]">
          {tasks.map(task => (
            <button
              key={task.id}
              type="button"
              className="group relative flex h-9 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-[var(--launcher-selected)] motion-reduce:transition-none"
              onClick={() => openTask(task)}
            >
              <span aria-hidden="true" className={`size-2 flex-none rounded-full ${task.tone === 'danger' ? 'bg-danger' : 'bg-[var(--launcher-brand)]'}`} />
              <span className={`min-w-0 flex-1 truncate text-xs ${task.tone === 'danger' ? 'text-danger' : ''}`}>{task.label}</span>
              {task.percent != null && (
                <span className="flex-none text-xs tabular-nums text-[var(--launcher-muted)]">
                  {Math.round(task.percent)}
                  %
                </span>
              )}
              <span className="flex-none text-xs text-[var(--launcher-muted)] group-hover:text-[var(--launcher-brand-strong)]">{t('ui.task_open')}</span>
              {task.tone !== 'danger' && (
                <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-[var(--launcher-selected)]">
                  {task.percent != null
                    ? <span className="block h-full bg-[var(--launcher-brand)] transition-[width] duration-200 ease-out motion-reduce:transition-none" style={{ width: `${task.percent}%` }} />
                    : <span className="block h-full w-2/5 animate-pulse bg-[var(--launcher-brand)] motion-reduce:animate-none" />}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <If cond={!loading} else={<div className="grid flex-1 place-items-center text-sm text-[var(--launcher-muted)]">{t('status.loading')}</div>}>
        <div className="flex min-h-0 flex-1">
          <div className={`${section === 'resources' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1`}>
            <DownloadCenter onPackProgress={setPackProgress} />
          </div>
          <div className={`${section === 'collaboration' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1`}>
            <CollaborationPanel />
          </div>
          {section !== 'resources' && section !== 'collaboration' && (
            <div key={section} className="launcher-content-enter flex min-h-0 min-w-0 flex-1">
              <If cond={section === 'launch'} then={registry.instances.length === 0 ? <InstanceWizard /> : <InstanceManager key={launchRequest} onGoDownloads={() => { setSection('resources') }} />} else={section === 'settings' ? <PersonalizationPanel /> : <MorePanel key={moreRequest} />} />
            </div>
          )}
        </div>
      </If>
    </div>
  )
}
