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

export default function LauncherShell() {
  const { t } = useTranslation()
  const { loading, registry } = useStore(store.launcher)
  const { updating, progress, phaseTitle } = useStore(updater)
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

  return (
    <div className={`launcher-theme launcher-theme-${appearance.theme} ${appearance.blur ? 'launcher-blur' : ''} flex h-screen w-screen flex-col bg-[var(--launcher-canvas)] text-[var(--launcher-ink)]`}>
      <header className="launcher-header relative flex h-[57px] flex-none items-center bg-[var(--launcher-brand)] px-4 text-white shadow-[0_1px_0_rgba(24,54,106,0.12)] select-none">
        <div className="z-10 text-[19px] font-medium tracking-tight" data-tauri-drag-region>DSH Launcher</div>
        <nav className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
          {items.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                aria-current={section === item.id ? 'page' : undefined}
                className={`flex h-[38px] items-center gap-2 rounded-[7px] px-4 text-[15px] transition-all duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none active:scale-[0.97] ${section === item.id ? 'scale-[1.02] bg-white text-[var(--launcher-brand-strong)] shadow-[0_4px_12px_rgba(28,60,120,0.2)]' : 'text-white hover:-translate-y-0.5 hover:bg-white/14 hover:shadow-[0_3px_9px_rgba(28,60,120,0.14)]'}`}
                type="button"
                onClick={() => {
                  setSection(item.id)
                  if (item.id === 'launch')
                    setLaunchRequest(request => request + 1)
                }}
              >
                <Icon />
                {t(`launcher.nav.${item.id}`)}
              </button>
            )
          })}
        </nav>
        <div className="flex-1 self-stretch" data-tauri-drag-region />
        <button className="z-10 grid size-8 place-items-center rounded-[7px] text-base transition-colors hover:bg-white/10" type="button" aria-label={t('nav.minimize')} title={t('nav.minimize')} onClick={() => { void getCurrentWindow().minimize() }}>
          <Minus className="size-4" />
        </button>
        <button className="z-10 grid size-8 place-items-center rounded-[7px] text-base transition-colors hover:bg-white/10" type="button" aria-label={t('nav.maximize')} title={t('nav.maximize')} onClick={() => { void getCurrentWindow().toggleMaximize() }}>
          <Square className="size-3.5" />
        </button>
        <button className="z-10 grid size-8 place-items-center rounded-[7px] text-base transition-colors hover:bg-danger" type="button" aria-label={t('nav.close')} title={t('nav.close')} onClick={() => { void getCurrentWindow().hide() }}>
          <Xmark className="size-4" />
        </button>
      </header>
      {updating && (
        <div className="h-1 w-full flex-none bg-[var(--launcher-selected)]" role="progressbar" aria-label={t('update.dsh_updating')} aria-valuetext={phaseTitle || t('update.dsh_updating')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
          <div className="h-full bg-[var(--launcher-brand)] transition-[width] duration-200 ease-out" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}
      {!updating && packProgress && packProgress.total > 0 && (
        <div
          className="h-1 w-full flex-none overflow-hidden bg-[#d9eee8]"
          role="progressbar"
          aria-label={t('download.pack_install_progress', { current: packProgress.completed, total: packProgress.total, plugin: packProgress.plugin })}
          aria-valuetext={t('download.pack_install_progress', { current: packProgress.completed, total: packProgress.total, plugin: packProgress.plugin })}
          aria-valuemin={0}
          aria-valuemax={packProgress.total}
          aria-valuenow={packProgress.completed}
        >
          <div className="launcher-plugin-progress h-full transition-[width] duration-300 ease-out" style={{ width: `${Math.max(0, Math.min(100, (packProgress.completed / packProgress.total) * 100))}%` }} />
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
