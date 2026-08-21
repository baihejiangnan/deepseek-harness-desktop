import type { ReactNode } from 'react'
import type { DshInstance, InstanceRegistry } from '@/store/modules/launcher/types'
import { ArrowRotateRight, CircleInfo, Play, Power, Rocket } from '@gravity-ui/icons'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { toast } from '@/utils'

interface Appearance {
  theme: string
}

export default function TrayPanel() {
  const { t } = useTranslation()
  const { loading, registry, runningInstanceIds, runningInstancePorts } = useStore(store.launcher)
  const [appearance, setAppearance] = useState<Appearance>({ theme: 'mist-blue-sakura-pink' })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const body = document.body
    const html = document.documentElement
    const previousBodyBackground = body.style.background
    const previousHtmlBackground = html.style.background
    body.style.background = 'transparent'
    html.style.background = 'transparent'
    void invoke<{ launcher_theme?: string }>('get_app_config').then((config) => {
      setAppearance({ theme: config.launcher_theme ?? 'mist-blue-sakura-pink' })
    }).catch(() => {})
    void store.launcher.load()
    const refresh = async () => {
      void store.launcher.refreshRunning()
      try {
        store.launcher.registry = await invoke<InstanceRegistry>('list_instances')
      }
      catch {
        // Keep the last registry visible while the launcher is unavailable.
      }
    }
    const timer = window.setInterval(() => {
      void refresh()
    }, 3000)
    return () => {
      window.clearInterval(timer)
      body.style.background = previousBodyBackground
      html.style.background = previousHtmlBackground
    }
  }, [])

  const running = useMemo(
    () => registry.instances.filter(instance => runningInstanceIds.includes(instance.id)),
    [registry.instances, runningInstanceIds],
  )
  const available = useMemo(
    () => registry.instances.filter(instance => !runningInstanceIds.includes(instance.id)),
    [registry.instances, runningInstanceIds],
  )

  async function hidePanel() {
    await getCurrentWindow().hide()
  }

  async function openLauncher() {
    await emit('tray-open-launcher')
    await hidePanel()
  }

  async function checkUpdate() {
    await emit('tray-check-dsh-update')
    await hidePanel()
  }

  async function openAbout() {
    await emit('tray-open-about')
    await hidePanel()
  }

  async function quit() {
    await invoke('quit_app')
  }

  async function focusInstance(instance: DshInstance) {
    setError('')
    try {
      await invoke('focus_instance_window', { id: instance.id })
      await hidePanel()
    }
    catch {
      setError(t('tray.focus_failed'))
      toast(t('tray.focus_failed'), { placement: 'top', variant: 'warning' })
    }
  }

  async function launchInstance(instance: DshInstance) {
    if (busyId)
      return
    setBusyId(instance.id)
    setError('')
    try {
      await invoke('select_instance', { id: instance.id })
      await invoke<number>('launch_instance_window', { id: instance.id })
      await store.launcher.refreshRunning()
      await hidePanel()
    }
    catch (cause) {
      const message = String(cause)
      if (message.includes('INSTANCE_HOME_RUNNING')) {
        const runningName = message.split(':').slice(2).join(':')
        setError(t('launcher.same_home_running', { name: runningName }))
        toast(t('launcher.same_home_running', { name: runningName }), { placement: 'top', variant: 'warning' })
        await store.launcher.refreshRunning()
      }
      else {
        setError(message)
        toast(message, { placement: 'top', variant: 'warning' })
      }
    }
    finally {
      setBusyId(null)
    }
  }

  return (
    <div className={`tray-panel launcher-theme launcher-theme-${appearance.theme} flex h-full min-h-0 w-full flex-col overflow-hidden text-[var(--launcher-ink)]`}>
      <header className="flex items-center gap-2.5 border-b border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-4 py-3">
        <div className="grid size-8 flex-none place-items-center rounded-md bg-[var(--launcher-gradient)] text-white shadow-sm">
          <Rocket className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">DSH Launcher</div>
          <div className="mt-0.5 text-xs text-[var(--launcher-muted)]">{t('tray.subtitle')}</div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--launcher-surface)] px-2.5 py-2.5">
        <div className="grid grid-cols-3 gap-1.5">
          <TrayAction icon={<Rocket />} label={t('tray.open_launcher')} onClick={() => { void openLauncher() }} />
          <TrayAction icon={<ArrowRotateRight />} label={t('tray.check_update')} onClick={() => { void checkUpdate() }} />
          <TrayAction icon={<CircleInfo />} label={t('tray.about')} onClick={() => { void openAbout() }} />
        </div>

        <TraySection title={t('tray.running_title')} count={running.length}>
          {loading && <TrayEmpty>{t('status.loading')}</TrayEmpty>}
          {!loading && running.length === 0 && <TrayEmpty>{t('tray.no_running')}</TrayEmpty>}
          {running.map(instance => (
            <InstanceRow
              key={instance.id}
              instance={instance}
              running
              port={runningInstancePorts[instance.id]}
              actionLabel={t('tray.switch_to', { name: instance.name })}
              onClick={() => { void focusInstance(instance) }}
            />
          ))}
        </TraySection>

        <TraySection title={t('tray.available_title')} count={available.length}>
          {!loading && available.length === 0 && <TrayEmpty>{t('tray.no_available')}</TrayEmpty>}
          {available.map(instance => (
            <InstanceRow
              key={instance.id}
              instance={instance}
              running={false}
              busy={busyId === instance.id}
              actionLabel={t('tray.launch', { name: instance.name })}
              onClick={() => { void launchInstance(instance) }}
            />
          ))}
        </TraySection>

        {error && <div className="mt-2 rounded-lg border border-[#e7b9b9] bg-[#fff5f5] px-3 py-2 text-xs leading-5 text-[#a34444]">{error}</div>}
      </div>

      <footer className="border-t border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-2.5">
        <button className="flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm text-[var(--launcher-danger)] transition-colors hover:bg-[var(--launcher-danger)]/10" type="button" onClick={() => { void quit() }}>
          <Power className="size-4" />
          <span>{t('tray.quit')}</span>
        </button>
      </footer>
    </div>
  )
}

function TrayAction({ icon, label, onClick }: { icon: ReactNode, label: string, onClick: () => void }) {
  return (
    <button className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-md border border-[var(--launcher-border)] bg-white/70 px-1.5 text-center text-[11px] text-[var(--launcher-ink)] transition-colors hover:border-[var(--launcher-brand)] hover:bg-[var(--launcher-selected)]" type="button" onClick={onClick}>
      <span className="text-[var(--launcher-brand-strong)]">{icon}</span>
      <span className="truncate max-w-full">{label}</span>
    </button>
  )
}

function TraySection({ title, count, children }: { title: string, count: number, children: ReactNode }) {
  return (
    <section className="mt-3 first:mt-2.5">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h2 className="m-0 text-xs font-semibold tracking-wide text-[var(--launcher-muted)]">{title}</h2>
        <span className="rounded-full bg-[var(--launcher-selected)] px-2 py-0.5 text-[11px] font-medium text-[var(--launcher-brand-strong)]">{count}</span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function TrayEmpty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-[var(--launcher-border)] px-3 py-2 text-center text-xs text-[var(--launcher-muted)]">{children}</div>
}

function InstanceRow({ instance, running, port, busy, actionLabel, onClick }: { instance: DshInstance, running: boolean, port?: number, busy?: boolean, actionLabel: string, onClick: () => void }) {
  return (
    <button className="group flex min-h-12 w-full items-center gap-2.5 rounded-md border border-transparent bg-white/55 px-2.5 py-1.5 text-left transition-colors hover:border-[var(--launcher-border)] hover:bg-[var(--launcher-selected)]" type="button" title={actionLabel} onClick={onClick} disabled={busy}>
      <span className={`grid size-7 flex-none place-items-center rounded-full ${running ? 'bg-[#e3f6e9] text-[#2e9a56]' : 'bg-[#eef1f4] text-[#7f8b97]'}`}>
        {running ? <span className="size-2.5 rounded-full bg-[#38ad60]" /> : <Play className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--launcher-ink)]">{instance.name}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[var(--launcher-muted)]">
          {instance.profile}
          {port != null ? ` · ${port}` : ''}
        </span>
      </span>
      <span className="text-[11px] text-[var(--launcher-muted)] opacity-0 transition-opacity group-hover:opacity-100">{busy ? '…' : running ? '›' : '+'}</span>
    </button>
  )
}
