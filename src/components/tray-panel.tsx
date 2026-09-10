import type { ReactNode } from 'react'
import type { DshInstance, InstanceRegistry } from '@/store/modules/launcher/types'
import { ArrowRotateRight, CircleStopFill, Gear, Play, Power, Rocket } from '@gravity-ui/icons'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { toast } from '@/utils'
import { errorBannerDetail, errorText } from '@/utils/error-codes'
import { ErrorBanner } from './launcher-ui'

interface Appearance {
  theme: string
}

export default function TrayPanel() {
  const { t } = useTranslation()
  const { loading, registry, runningInstanceIds, runningInstancePorts, busyInstanceId, installProgress } = useStore(store.launcher)
  const [appearance, setAppearance] = useState<Appearance>({ theme: 'mist-blue-sakura-pink' })
  const [error, setError] = useState('')
  const [errorDetail, setErrorDetail] = useState('')

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

  function fail(message: string, detail = '') {
    setError(message)
    setErrorDetail(detail)
    toast(message, { placement: 'top', variant: 'warning' })
  }

  async function openLauncher() {
    try {
      await emit('tray-open-launcher')
      await hidePanel()
    }
    catch (cause) {
      fail(String(cause))
    }
  }

  async function checkUpdate() {
    try {
      await emit('tray-check-dsh-update')
      await hidePanel()
    }
    catch (cause) {
      fail(String(cause))
    }
  }

  async function openSettings() {
    try {
      await emit('tray-open-settings')
      await hidePanel()
    }
    catch (cause) {
      fail(String(cause))
    }
  }

  async function quit() {
    // 后端在实例宿主模式会明确拒绝退出；这里只避免出现未处理的 rejection。
    await invoke('quit_app').catch((cause) => {
      console.warn('[Tray] quit refused:', cause)
    })
  }

  async function focusInstance(instance: DshInstance) {
    setError('')
    setErrorDetail('')
    try {
      await invoke('focus_instance_window', { id: instance.id })
      await hidePanel()
    }
    catch (cause) {
      fail(t('tray.focus_failed'), String(cause))
    }
  }

  async function launchInstance(instance: DshInstance) {
    if (busyInstanceId)
      return
    setError('')
    setErrorDetail('')
    // 选中实例只决定启动器主窗口概览显示谁；启动本身按 id 绑定，
    // 因此选中失败不得让一次本可成功的启动变成失败。
    await invoke('select_instance', { id: instance.id }).catch((cause) => {
      console.warn('[Tray] select_instance failed:', cause)
    })
    const started = await store.launcher.launchInstance(instance.id)
    if (started) {
      await hidePanel()
      return
    }
    // 读 store 本体而不是解构快照：await 之后的快照仍是启动前的值。
    const message = store.launcher.launchFailure?.message ?? store.launcher.error
    // 共享 Home 互斥由 store 内部弹 Toast 且不写 error，这里再报一次会重复；
    // 无 message 说明启动被前置条件拦下而非失败，不编造失败原因。
    if (message !== '')
      fail(errorText(message), errorBannerDetail(message) ?? '')
  }

  async function stopInstance(instance: DshInstance) {
    if (busyInstanceId)
      return
    setError('')
    setErrorDetail('')
    await store.launcher.stopInstance(instance.id)
    const message = store.launcher.error
    if (message !== '') {
      fail(t('tray.stop_failed'), message)
      return
    }
    await store.launcher.refreshRunning()
    // 停止后保留面板，让这一行从「正在运行」移到「可启动」的过程可见。
  }

  const launching = busyInstanceId != null && !runningInstanceIds.includes(busyInstanceId)

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
          <TrayAction icon={<Gear />} label={t('tray.settings')} onClick={() => { void openSettings() }} />
        </div>

        {launching && installProgress != null && (
          <div className="mt-2.5 rounded-md border border-[var(--launcher-border)] bg-white/60 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-medium">{installProgress.title}</span>
              {!installProgress.indeterminate && (
                <span className="flex-none tabular-nums text-[var(--launcher-brand-strong)]">
                  {Math.round(installProgress.percentage)}
                  %
                </span>
              )}
            </div>
            {installProgress.detail !== '' && <p className="m-0 mt-0.5 truncate text-xs leading-5 text-[var(--launcher-muted)]">{installProgress.detail}</p>}
            <div
              role="progressbar"
              aria-label={installProgress.title}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={installProgress.indeterminate ? undefined : Math.round(installProgress.percentage)}
              className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--launcher-selected)]"
            >
              {installProgress.indeterminate
                ? <div className="h-full w-2/5 animate-pulse rounded-full bg-[var(--launcher-brand)] motion-reduce:animate-none" aria-hidden="true" />
                : <div className="h-full rounded-full bg-[var(--launcher-brand)] transition-[width] motion-reduce:transition-none" style={{ width: `${Math.round(installProgress.percentage)}%` }} />}
            </div>
          </div>
        )}

        <TraySection title={t('tray.running_title')} count={running.length}>
          {loading && <TrayEmpty>{t('status.loading')}</TrayEmpty>}
          {!loading && running.length === 0 && <TrayEmpty>{t('tray.no_running')}</TrayEmpty>}
          {running.map((instance) => {
            const busy = busyInstanceId === instance.id
            return (
              <InstanceRow
                key={instance.id}
                instance={instance}
                running
                busy={busy}
                statusLabel={busy ? t('launcher.instance_status.stopping') : t('launcher.instance_status.running')}
                port={runningInstancePorts[instance.id]}
                actionLabel={t('tray.switch_to', { name: instance.name })}
                onAction={() => { void focusInstance(instance) }}
                stopLabel={t('tray.stop', { name: instance.name })}
                onStop={() => { void stopInstance(instance) }}
              />
            )
          })}
        </TraySection>

        <TraySection title={t('tray.available_title')} count={available.length}>
          {!loading && available.length === 0 && <TrayEmpty>{t('tray.no_available')}</TrayEmpty>}
          {available.map((instance) => {
            const busy = busyInstanceId === instance.id
            return (
              <InstanceRow
                key={instance.id}
                instance={instance}
                running={false}
                busy={busy}
                statusLabel={busy ? t('launcher.instance_status.booting') : undefined}
                actionLabel={t('tray.launch', { name: instance.name })}
                onAction={() => { void launchInstance(instance) }}
              />
            )
          })}
        </TraySection>

        {error !== '' && <ErrorBanner className="mt-2.5" message={error} detail={errorDetail === '' ? undefined : errorDetail} />}
      </div>

      <footer className="border-t border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-2.5">
        <button className="flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm text-[var(--launcher-danger)] transition-colors hover:bg-[var(--launcher-danger)]/10 motion-reduce:transition-none" type="button" onClick={() => { void quit() }}>
          <Power className="size-4" />
          <span>{t('tray.quit')}</span>
        </button>
      </footer>
    </div>
  )
}

function TrayAction({ icon, label, onClick }: { icon: ReactNode, label: string, onClick: () => void }) {
  return (
    <button className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-md border border-[var(--launcher-border)] bg-white/70 px-1.5 text-center text-xs text-[var(--launcher-ink)] transition-colors hover:border-[var(--launcher-brand)] hover:bg-[var(--launcher-selected)] motion-reduce:transition-none" type="button" onClick={onClick}>
      <span className="text-[var(--launcher-brand-strong)]">{icon}</span>
      <span className="max-w-full truncate">{label}</span>
    </button>
  )
}

function TraySection({ title, count, children }: { title: string, count: number, children: ReactNode }) {
  return (
    <section className="mt-3 first:mt-2.5">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h2 className="m-0 text-xs font-semibold tracking-wide text-[var(--launcher-muted)]">{title}</h2>
        <span className="rounded-full bg-[var(--launcher-selected)] px-2 py-0.5 text-xs font-medium tabular-nums text-[var(--launcher-brand-strong)]">{count}</span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function TrayEmpty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-[var(--launcher-border)] px-3 py-2 text-center text-xs text-[var(--launcher-muted)]">{children}</div>
}

/**
 * 主操作与停止是两个并列按钮：整行按钮里再嵌停止按钮会产生非法的 button 嵌套。
 * 状态一律有文字，颜色只作辅助。
 */
function InstanceRow({ instance, running, busy, statusLabel, port, actionLabel, onAction, stopLabel, onStop }: { instance: DshInstance, running: boolean, busy: boolean, statusLabel?: string, port?: number, actionLabel: string, onAction: () => void, stopLabel?: string, onStop?: () => void }) {
  return (
    <div className="group flex min-h-12 w-full items-center gap-1.5 rounded-md border border-transparent bg-white/55 py-1.5 pr-1.5 pl-2.5 transition-colors hover:border-[var(--launcher-border)] hover:bg-[var(--launcher-selected)] motion-reduce:transition-none">
      <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" type="button" title={actionLabel} onClick={onAction} disabled={busy}>
        <span className={`grid size-7 flex-none place-items-center rounded-full ${running ? 'bg-[#e3f6e9] text-[#2e9a56]' : 'bg-[#eef1f4] text-[#7f8b97]'}`}>
          {busy
            ? <span className="size-2.5 animate-pulse rounded-full bg-[var(--launcher-brand)] motion-reduce:animate-none" />
            : running ? <span className="size-2.5 rounded-full bg-[#38ad60]" /> : <Play className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-[var(--launcher-ink)]">{instance.name}</span>
            {statusLabel != null && <span className="flex-none text-xs text-[var(--launcher-muted)]">{statusLabel}</span>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-[var(--launcher-muted)]">
            {instance.profile}
            {port != null ? ` · ${port}` : ''}
          </span>
        </span>
        <span className="flex-none text-xs text-[var(--launcher-muted)] opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none">{busy ? '…' : running ? '›' : '+'}</span>
      </button>
      {onStop != null && (
        <button
          className="grid size-7 flex-none place-items-center rounded-md text-[var(--launcher-muted)] transition-colors hover:bg-[var(--launcher-danger)]/10 hover:text-[var(--launcher-danger)] motion-reduce:transition-none disabled:opacity-40"
          type="button"
          title={stopLabel}
          aria-label={stopLabel}
          onClick={onStop}
          disabled={busy}
        >
          <CircleStopFill className="size-3.5" />
        </button>
      )}
    </div>
  )
}
