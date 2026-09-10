import type { IconComponent } from './loadable'
import { ArrowRotateRight, ArrowUpRightFromSquare, CircleInfo, Copy, FileText } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { updater } from '@/store/modules/updater'
import { toast } from '@/utils'
import { ErrorBanner, PageHeader } from './launcher-ui'

type MoreSection = 'updates' | 'logs' | 'links' | 'acknowledgements'

interface RuntimeInfo {
  app_version: string
  dsh_version: string | null
}

interface DshRuntime {
  id: string
  source: 'launcher' | 'npm' | 'pnpm' | 'external'
  entryPath: string
  version: string | null
  status: 'ready' | 'missing_node' | 'incompatible_node' | 'invalid_package'
  writable: boolean
  updateSupported: boolean
  selected: boolean
}

export default function MorePanel() {
  const { t } = useTranslation()
  const [section, setSection] = useState<MoreSection>('updates')
  const items: Array<{ id: MoreSection, icon: IconComponent, label: string }> = [
    { id: 'updates', icon: ArrowRotateRight, label: t('launcher.more_nav.updates') },
    { id: 'logs', icon: FileText, label: t('launcher.more_nav.logs') },
    { id: 'links', icon: ArrowUpRightFromSquare, label: t('launcher.more_nav.links') },
    { id: 'acknowledgements', icon: CircleInfo, label: t('launcher.more_nav.acknowledgements') },
  ]

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--launcher-canvas)] text-[var(--launcher-ink)]">
      <nav className="w-[210px] flex-none border-r border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] p-3" aria-label={t('launcher.more_nav.label')}>
        <div className="px-3 pb-3 pt-2 text-xs font-semibold text-[var(--launcher-muted)]">{t('launcher.nav.more')}</div>
        {items.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm transition-[background-color,color,transform] duration-200 ease-out motion-reduce:transition-none ${section === item.id ? 'translate-x-1 bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)] motion-reduce:translate-x-0' : 'text-[var(--launcher-muted)] hover:translate-x-0.5 hover:bg-white motion-reduce:hover:translate-x-0'}`}
              onClick={() => setSection(item.id)}
            >
              <Icon className="size-4" />
              {item.label}
            </button>
          )
        })}
      </nav>
      <div key={section} className="launcher-content-enter min-w-0 flex-1 overflow-y-auto">
        {section === 'updates' && <UpdatesSection />}
        {section === 'logs' && <LogsSection />}
        {section === 'links' && <LinksSection />}
        {section === 'acknowledgements' && <AcknowledgementsSection />}
      </div>
    </div>
  )
}

function UpdatesSection() {
  const { t } = useTranslation()
  const { updateInfo, checking, updating, checkError, progress, phaseTitle, phaseDetail, indeterminate } = useStore(updater)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [runtimes, setRuntimes] = useState<DshRuntime[]>([])
  const [switchingRuntime, setSwitchingRuntime] = useState(false)

  useEffect(() => {
    void invoke<RuntimeInfo>('get_runtime_info').then(setRuntime).catch(() => {})
    void invoke<DshRuntime[]>('list_dsh_runtimes').then(setRuntimes).catch(() => {})
  }, [updating])

  async function selectRuntime(runtimeId: string) {
    setSwitchingRuntime(true)
    try {
      await invoke('select_dsh_runtime', { runtimeId })
      const [nextInfo, nextRuntimes] = await Promise.all([
        invoke<RuntimeInfo>('get_runtime_info'),
        invoke<DshRuntime[]>('list_dsh_runtimes'),
      ])
      setRuntime(nextInfo)
      setRuntimes(nextRuntimes)
      await updater.checkForUpdate()
      toast(t('launcher.more_updates.runtime_selected'), { variant: 'accent', placement: 'bottom end' })
    }
    catch (error) {
      toast(t('launcher.more_updates.runtime_select_failed'), { description: String(error), variant: 'danger', placement: 'bottom end' })
    }
    finally {
      setSwitchingRuntime(false)
    }
  }

  function openUpstreamRelease() {
    if (updateInfo?.releaseUrl)
      void invoke('open_external_url', { url: updateInfo.releaseUrl })
  }

  const status = updating
    ? t('update.dsh_updating')
    : checking
      ? t('launcher.more_updates.checking')
      : updateInfo
        ? t('launcher.more_updates.available', { tag: updateInfo.tag })
        : checkError
          ? t('launcher.more_updates.failed')
          : t('update.up_to_date')

  const percent = Math.round(progress)

  return (
    <main className="p-6 md:p-8">
      <div className="mx-auto max-w-[900px]">
        <PageHeader
          className="mb-7"
          title={t('launcher.more_updates.title')}
          description={t('launcher.more_updates.description')}
        />

        <section className="rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="grid size-10 flex-none place-items-center rounded-md bg-[var(--launcher-selected)] text-[var(--launcher-brand)]"><CircleInfo className="size-5" /></div>
              <div className="min-w-0">
                <h2 className="m-0 text-base font-semibold">{t('launcher.more_updates.dsh_title')}</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.more_updates.dsh_description')}</p>
              </div>
            </div>
            <Button
              className="h-9 flex-none rounded-md bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]"
              isDisabled={checking || updating}
              onPress={() => { void updater.checkManually() }}
            >
              <ArrowRotateRight className={checking ? 'animate-spin motion-reduce:animate-none' : undefined} />
              {checking ? t('launcher.more_updates.checking') : t('launcher.more_updates.check_action')}
            </Button>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <VersionRow label={t('launcher.more_updates.current_dsh')} value={runtime?.dsh_version ?? t('launcher.version_unavailable')} />
            <VersionRow label={t('launcher.more_updates.status')} value={status} accent={Boolean(updateInfo) || updating} />
          </div>

          {updating && (
            <div className="mt-5 rounded-md border border-[var(--launcher-brand)]/25 bg-[var(--launcher-selected)] px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 truncate text-sm font-medium text-[var(--launcher-brand-strong)]">{phaseTitle === '' ? t('update.dsh_updating') : phaseTitle}</span>
                {!indeterminate && (
                  <span className="flex-none text-xs tabular-nums text-[var(--launcher-brand-strong)]">
                    {percent}
                    %
                  </span>
                )}
              </div>
              {phaseDetail !== '' && <p className="m-0 mt-1 truncate text-xs leading-5 text-[var(--launcher-muted)]">{phaseDetail}</p>}
              <div
                role="progressbar"
                aria-label={phaseTitle === '' ? t('update.dsh_updating') : phaseTitle}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={indeterminate ? undefined : percent}
                className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-white/70"
              >
                {indeterminate
                  ? <div className="h-full w-2/5 animate-pulse rounded-full bg-[var(--launcher-brand)] motion-reduce:animate-none" aria-hidden="true" />
                  : <div className="h-full rounded-full bg-[var(--launcher-brand)] transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />}
              </div>
              <p className="m-0 mt-2 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.more_updates.updating_hint')}</p>
            </div>
          )}

          {updateInfo && !updating && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--launcher-brand)]/25 bg-[var(--launcher-selected)] px-4 py-3 text-sm">
              <span>
                {updateInfo.source === 'upstream'
                  ? t('launcher.more_updates.available_detail_upstream', { tag: updateInfo.tag })
                  : updateInfo.source === 'npm'
                    ? t('launcher.more_updates.available_detail_npm', { tag: updateInfo.tag })
                    : t('launcher.more_updates.available_detail', { tag: updateInfo.tag, commit: updateInfo.commit?.slice(0, 7) })}
              </span>
              {updateInfo.installable
                ? <Button className="h-8 rounded-md" variant="secondary" onPress={() => { void updater.handleUpdate() }}>{t('update.now')}</Button>
                : <Button className="h-8 rounded-md" variant="secondary" onPress={openUpstreamRelease}>{t('launcher.more_updates.view_release')}</Button>}
            </div>
          )}

          {checkError !== '' && !checking && !updating && (
            <ErrorBanner className="mt-5" message={t('launcher.more_updates.failed_hint')} detail={checkError} />
          )}
        </section>

        <section className="mt-5 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
          <h2 className="m-0 text-sm font-semibold">{t('launcher.more_updates.runtime_title')}</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.more_updates.runtime_description')}</p>
          <div className="mt-4 grid gap-2">
            {runtimes.map(item => (
              <button
                key={item.id}
                type="button"
                disabled={switchingRuntime || updating || item.selected || item.status !== 'ready'}
                onClick={() => { void selectRuntime(item.id) }}
                className={`flex min-w-0 items-center justify-between gap-4 rounded-md border px-4 py-3 text-left transition-colors motion-reduce:transition-none disabled:cursor-default ${item.selected ? 'border-[var(--launcher-brand)] bg-[var(--launcher-selected)]' : 'border-[var(--launcher-border)] bg-white/60 hover:bg-[var(--launcher-selected)]/40'}`}
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {t(`launcher.more_updates.runtime_source_${item.source}`)}
                    {item.selected && <span className="rounded border border-[var(--launcher-brand)]/25 bg-[var(--launcher-surface)] px-1.5 py-0.5 text-xs font-normal text-[var(--launcher-brand-strong)]">{t('launcher.more_updates.runtime_in_use')}</span>}
                  </span>
                  <span className="mt-1 block truncate text-xs text-[var(--launcher-muted)]" title={item.entryPath}>{item.entryPath}</span>
                </span>
                <span className="flex-none text-right text-xs text-[var(--launcher-muted)]">
                  <span className="block">{item.version ?? t('launcher.version_unavailable')}</span>
                  <span className="mt-1 block">{t(`launcher.more_updates.runtime_status_${item.status}`)}</span>
                </span>
              </button>
            ))}
            {runtimes.length === 0 && <p className="m-0 py-4 text-center text-sm text-[var(--launcher-muted)]">{t('launcher.more_updates.runtime_empty')}</p>}
          </div>
          {switchingRuntime && <p role="status" className="m-0 mt-3 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.more_updates.runtime_switching')}</p>}
        </section>

        <section className="mt-5 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
          <h2 className="m-0 text-sm font-semibold">{t('launcher.more_updates.launcher_title')}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <VersionRow label={t('launcher.more_updates.launcher_version')} value={runtime?.app_version ?? t('launcher.version_unavailable')} />
            <VersionRow label={t('launcher.more_updates.launcher_status')} value={t('launcher.more_updates.launcher_paused')} />
          </div>
        </section>
      </div>
    </main>
  )
}

function VersionRow(props: { label: string, value: string, accent?: boolean }) {
  return (
    <div className="rounded-md border border-[var(--launcher-border)] bg-white/60 px-4 py-3">
      <div className="text-xs text-[var(--launcher-muted)]">{props.label}</div>
      <div className={`mt-1 truncate text-sm font-medium ${props.accent ? 'text-[var(--launcher-brand-strong)]' : ''}`}>{props.value}</div>
    </div>
  )
}

function LogsSection() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // "清空"只清空显示，不删日志文件；完整内容仍留在 logs 里供复制与恢复。
  const [hidden, setHidden] = useState(false)

  async function load() {
    setLoading(true)
    setError('')
    try {
      setLogs(await invoke<string>('read_run_logs'))
      setHidden(false)
    }
    catch (cause) {
      setError(String(cause))
    }
    finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logs)
      toast(t('launcher.more_logs.copied'), { variant: 'accent' })
    }
    catch {
      toast(t('launcher.more_logs.copy_failed'), { variant: 'danger' })
    }
  }

  const lineCount = logs === '' ? 0 : logs.split('\n').length

  return (
    <main className="p-6 md:p-8">
      <div className="mx-auto max-w-[900px]">
        <PageHeader
          className="mb-6"
          title={t('launcher.more_logs.title')}
          description={t('launcher.more_logs.description')}
          actions={(
            <Button size="sm" variant="ghost" className="h-8 rounded-md" isDisabled={loading} onPress={() => { void load() }}>
              <ArrowRotateRight className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} />
              {loading ? t('launcher.more_logs.loading') : t('launcher.more_logs.refresh')}
            </Button>
          )}
        />

        {error !== '' && <ErrorBanner className="mb-4" message={t('launcher.more_logs.read_failed')} detail={error} />}

        <section className="overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[#111820] text-[#d8e1e8]">
          <div className="flex h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-white/10 px-4 text-xs text-white/70">
            <span className="min-w-0 truncate">
              {hidden
                ? t('launcher.more_logs.hidden_notice')
                : t('launcher.more_logs.scope', { lines: lineCount })}
            </span>
            <span className="flex flex-none items-center gap-1">
              {hidden && (
                <Button size="sm" variant="ghost" className="h-7 rounded-md text-xs text-white" onPress={() => setHidden(false)}>
                  {t('launcher.more_logs.show_again')}
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 rounded-md text-xs text-white disabled:opacity-40" isDisabled={logs === '' || hidden} onPress={() => setHidden(true)}>
                {t('launcher.more_logs.clear_view')}
              </Button>
              <Button isIconOnly size="sm" variant="ghost" className="size-7 min-w-7 rounded-md text-white disabled:opacity-40" aria-label={t('launcher.more_logs.copy_full')} isDisabled={logs === ''} onPress={() => { void copyLogs() }}>
                <Copy className="size-3.5" />
              </Button>
            </span>
          </div>
          {hidden
            ? <div className="p-6 text-center text-xs leading-5 text-white/60">{t('launcher.more_logs.hidden_body')}</div>
            : <pre className="m-0 max-h-[520px] overflow-auto p-4 text-xs leading-5 whitespace-pre-wrap break-words">{loading && logs === '' ? t('launcher.more_logs.loading') : logs || t('launcher.more_logs.empty')}</pre>}
        </section>
      </div>
    </main>
  )
}

function LinksSection() {
  const { t } = useTranslation()
  const open = (url: string) => {
    void invoke('open_external_url', { url })
  }
  const links = [
    {
      id: 'dsh',
      title: t('launcher.more_links.dsh'),
      description: t('launcher.more_links.dsh_description'),
      url: 'github.com/deepseek-ai/DeepSeek-Harness',
      href: 'https://github.com/deepseek-ai/DeepSeek-Harness',
      mark: 'DSH',
    },
    {
      id: 'launcher',
      title: t('launcher.more_links.launcher'),
      description: t('launcher.more_links.launcher_description'),
      url: 'github.com/baihejiangnan/deepseek-harness-desktop',
      href: 'https://github.com/baihejiangnan/deepseek-harness-desktop',
      mark: 'UI',
    },
    {
      id: 'marcogh-launcher',
      title: t('launcher.more_links.marcogh_launcher'),
      description: t('launcher.more_links.marcogh_launcher_description'),
      url: 'github.com/MarcoG-h/DSH-Launcher',
      href: 'https://github.com/MarcoG-h/DSH-Launcher',
      mark: 'DSHL',
    },
    {
      id: 'plugin-pack',
      title: t('launcher.more_links.plugin_pack'),
      description: t('launcher.more_links.plugin_pack_description'),
      url: 'github.com/baihejiangnan/dsh-plugin-pack',
      href: 'https://github.com/baihejiangnan/dsh-plugin-pack',
      mark: 'PACK',
    },
    {
      id: 'pcl',
      title: t('launcher.more_links.pcl'),
      description: t('launcher.more_links.pcl_description'),
      url: 'github.com/Meloong-Git/PCL',
      href: 'https://github.com/Meloong-Git/PCL',
      mark: 'PCL',
    },
  ]
  return (
    <main className="p-6 md:p-8">
      <div className="mx-auto max-w-[900px]">
        <PageHeader
          className="mb-7"
          title={t('launcher.more_links.title')}
          description={t('launcher.more_links.description')}
          actions={<span className="rounded-full border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3 py-1 text-xs text-[var(--launcher-muted)]">{t('launcher.more_links.count', { count: links.length })}</span>}
        />
        <div className="overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)]">
          {links.map((link, index) => (
            <div key={link.id} className={`flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--launcher-selected)]/45 motion-reduce:transition-none ${index > 0 ? 'border-t border-[var(--launcher-border)]' : ''}`}>
              <div className="grid size-8 flex-none place-items-center rounded-md bg-[var(--launcher-brand)] px-1 text-center text-xs font-bold tracking-[0.08em] text-[var(--launcher-on-brand)]">{link.mark}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="m-0 text-sm font-semibold">{link.title}</h2>
                  <span className="truncate font-mono text-xs text-[var(--launcher-muted)]">{link.url}</span>
                </div>
                <p className="m-0 mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{link.description}</p>
              </div>
              <Button className="size-9 flex-none rounded-md text-[var(--launcher-brand-strong)]" isIconOnly variant="ghost" aria-label={t('launcher.more_links.open', { name: link.title })} onPress={() => open(link.href)}>
                <ArrowUpRightFromSquare className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}

function AcknowledgementsSection() {
  const { t } = useTranslation()
  const open = (url: string) => {
    void invoke('open_external_url', { url })
  }
  const people = [
    { id: 'hairyf', name: 'hairyf', description: t('launcher.acknowledgements.hairyf'), url: 'github.com/hairyf', href: 'https://github.com/hairyf', mark: 'H' },
    { id: 'marcogh', name: 'MarcoG-h', description: t('launcher.acknowledgements.marcogh'), url: 'github.com/MarcoG-h', href: 'https://github.com/MarcoG-h', mark: 'M' },
  ]
  const projects = [
    { id: 'dsh', name: 'DeepSeek Harness', description: t('launcher.acknowledgements.dsh'), url: 'github.com/deepseek-ai/DeepSeek-Harness', href: 'https://github.com/deepseek-ai/DeepSeek-Harness', mark: 'DSH' },
    { id: 'tauri', name: 'Tauri', description: t('launcher.acknowledgements.tauri'), url: 'github.com/tauri-apps/tauri', href: 'https://github.com/tauri-apps/tauri', mark: 'T' },
    { id: 'react', name: 'React', description: t('launcher.acknowledgements.react'), url: 'github.com/facebook/react', href: 'https://github.com/facebook/react', mark: 'R' },
    { id: 'vite', name: 'Vite', description: t('launcher.acknowledgements.vite'), url: 'github.com/vitejs/vite', href: 'https://github.com/vitejs/vite', mark: 'V' },
    { id: 'heroui', name: 'HeroUI', description: t('launcher.acknowledgements.heroui'), url: 'github.com/heroui-inc/heroui', href: 'https://github.com/heroui-inc/heroui', mark: 'UI' },
    { id: 'i18next', name: 'i18next', description: t('launcher.acknowledgements.i18next'), url: 'github.com/i18next/i18next', href: 'https://github.com/i18next/i18next', mark: 'I18N' },
    { id: 'pcl', name: 'PCL', description: t('launcher.acknowledgements.pcl'), url: 'github.com/Meloong-Git/PCL', href: 'https://github.com/Meloong-Git/PCL', mark: 'PCL' },
  ]

  const renderEntries = (entries: typeof projects) => (
    <div className="overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)]">
      {entries.map((entry, index) => (
        <div key={entry.id} className={`flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--launcher-selected)]/45 motion-reduce:transition-none ${index > 0 ? 'border-t border-[var(--launcher-border)]' : ''}`}>
          <div className="grid size-8 flex-none place-items-center rounded-md bg-[var(--launcher-brand)] px-1 text-center text-xs font-bold text-[var(--launcher-on-brand)]">{entry.mark}</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="m-0 text-sm font-semibold">{entry.name}</h3>
              <span className="truncate font-mono text-xs text-[var(--launcher-muted)]">{entry.url}</span>
            </div>
            <p className="m-0 mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{entry.description}</p>
          </div>
          <Button className="size-9 flex-none rounded-md text-[var(--launcher-brand-strong)]" isIconOnly variant="ghost" aria-label={t('launcher.acknowledgements.open', { name: entry.name })} onPress={() => open(entry.href)}>
            <ArrowUpRightFromSquare className="size-4" />
          </Button>
        </div>
      ))}
    </div>
  )

  return (
    <main className="p-6 md:p-8">
      <div className="mx-auto max-w-[900px]">
        <PageHeader
          className="mb-7"
          title={t('launcher.acknowledgements.title')}
          description={t('launcher.acknowledgements.description')}
        />
        <section>
          <h2 className="mb-3 text-sm font-semibold">{t('launcher.acknowledgements.people_title')}</h2>
          {renderEntries(people)}
        </section>
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold">{t('launcher.acknowledgements.projects_title')}</h2>
          {renderEntries(projects)}
        </section>
      </div>
    </main>
  )
}
