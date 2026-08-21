import type { IconComponent } from './loadable'
import { ArrowRotateRight, ArrowUpRightFromSquare, CircleInfo, Copy, FileText } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { updater } from '@/store/modules/updater'
import { toast } from '@/utils'

type MoreSection = 'updates' | 'logs' | 'links' | 'acknowledgements'

interface RuntimeInfo {
  app_version: string
  dsh_version: string | null
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
  const { updateInfo, checking, updating, checkError } = useStore(updater)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)

  useEffect(() => {
    void invoke<RuntimeInfo>('get_runtime_info').then(setRuntime).catch(() => {})
  }, [updating])

  const status = updating
    ? t('update.dsh_updating')
    : checking
      ? t('launcher.more_updates.checking')
      : updateInfo
        ? t('launcher.more_updates.available', { tag: updateInfo.tag })
        : checkError
          ? t('launcher.more_updates.failed')
          : t('update.up_to_date')

  return (
    <main className="p-8">
      <div className="mx-auto max-w-[900px]">
        <div className="mb-7">
          <div className="mb-2 text-xs font-semibold text-[var(--launcher-brand)]">{t('launcher.more_updates.eyebrow')}</div>
          <h1 className="m-0 text-2xl font-semibold">{t('launcher.more_updates.title')}</h1>
          <p className="mt-2 text-sm text-[var(--launcher-muted)]">{t('launcher.more_updates.description')}</p>
        </div>

        <section className="rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
          <div className="flex items-start justify-between gap-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="grid size-10 flex-none place-items-center rounded-md bg-[var(--launcher-selected)] text-[var(--launcher-brand)]"><CircleInfo className="size-5" /></div>
              <div className="min-w-0">
                <h2 className="m-0 text-base font-semibold">{t('launcher.more_updates.dsh_title')}</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.more_updates.dsh_description')}</p>
              </div>
            </div>
            <Button
              className="h-9 flex-none rounded-md bg-[var(--launcher-brand)] text-white"
              isDisabled={checking || updating}
              onPress={() => { void updater.checkManually() }}
            >
              <ArrowRotateRight className={checking ? 'animate-spin' : undefined} />
              {checking ? t('launcher.more_updates.checking') : t('launcher.more_updates.check_action')}
            </Button>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <VersionRow label={t('launcher.more_updates.current_dsh')} value={runtime?.dsh_version ?? t('launcher.version_unavailable')} />
            <VersionRow label={t('launcher.more_updates.status')} value={status} accent={Boolean(updateInfo)} />
          </div>

          {updateInfo && !updating && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--launcher-brand)]/25 bg-[var(--launcher-selected)] px-4 py-3 text-sm">
              <span>{t('launcher.more_updates.available_detail', { tag: updateInfo.tag, commit: updateInfo.commit.slice(0, 7) })}</span>
              <Button className="h-8 rounded-md" variant="secondary" onPress={() => { void updater.handleUpdate() }}>{t('update.now')}</Button>
            </div>
          )}

          {checkError && !checking && (
            <p className="mt-4 text-xs leading-5 text-danger">{t('launcher.more_updates.failed_hint')}</p>
          )}
        </section>

        <section className="mt-5 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
          <h2 className="m-0 text-sm font-semibold">{t('launcher.more_updates.launcher_title')}</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <VersionRow label={t('launcher.more_updates.launcher_version')} value={runtime?.app_version ?? '-'} />
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
  useEffect(() => {
    void invoke<string>('read_run_logs').then(setLogs).catch(() => {})
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
  return (
    <main className="p-8">
      <div className="mx-auto max-w-[900px]">
        <h1 className="m-0 text-2xl font-semibold">{t('launcher.more_logs.title')}</h1>
        <p className="mt-2 text-sm text-[var(--launcher-muted)]">{t('launcher.more_logs.description')}</p>
        <section className="mt-6 overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[#111820] text-[#d8e1e8]">
          <div className="flex h-10 items-center justify-between border-b border-white/10 px-4 text-xs text-white/70">
            <span>{t('launcher.more_logs.title')}</span>
            <Button isIconOnly size="sm" variant="ghost" className="size-7 min-w-7 rounded-md text-white disabled:opacity-40" aria-label={t('launcher.more_logs.copy')} isDisabled={!logs} onPress={() => { void copyLogs() }}>
              <Copy className="size-3.5" />
            </Button>
          </div>
          <pre className="m-0 max-h-[520px] overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-5">{logs || t('launcher.more_logs.empty')}</pre>
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
      id: 'hairyf-launcher',
      title: t('launcher.more_links.hairyf_launcher'),
      description: t('launcher.more_links.hairyf_launcher_description'),
      url: 'github.com/hairyf/deepseek-harness-desktop',
      href: 'https://github.com/hairyf/deepseek-harness-desktop',
      mark: 'ORIG',
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
  ]
  return (
    <main className="p-6 md:p-8">
      <div className="mx-auto max-w-[900px]">
        <div className="mb-7 flex items-end justify-between gap-6">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--launcher-brand)]">{t('launcher.more_links.eyebrow')}</div>
            <h1 className="m-0 text-2xl font-semibold">{t('launcher.more_links.title')}</h1>
            <p className="mt-2 max-w-[620px] text-sm leading-6 text-[var(--launcher-muted)]">{t('launcher.more_links.description')}</p>
          </div>
          <span className="hidden rounded-full border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3 py-1 text-xs text-[var(--launcher-muted)] sm:inline-flex">{t('launcher.more_links.count', { count: links.length })}</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-[var(--launcher-border)] bg-[var(--launcher-surface)]">
          {links.map((link, index) => (
            <div key={link.id} className={`flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--launcher-selected)]/45 ${index > 0 ? 'border-t border-[var(--launcher-border)]' : ''}`}>
              <div className="grid size-11 flex-none place-items-center rounded-md bg-[var(--launcher-brand)] text-[10px] font-bold tracking-[0.08em] text-white shadow-sm">{link.mark}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="m-0 text-sm font-semibold">{link.title}</h2>
                  <span className="truncate font-mono text-[11px] text-[var(--launcher-muted)]">{link.url}</span>
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
  ]

  const renderEntries = (entries: typeof projects) => (
    <div className="overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)]">
      {entries.map((entry, index) => (
        <div key={entry.id} className={`flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--launcher-selected)]/45 ${index > 0 ? 'border-t border-[var(--launcher-border)]' : ''}`}>
          <div className="grid size-11 flex-none place-items-center rounded-md bg-[var(--launcher-brand)] px-1 text-center text-[9px] font-bold text-white">{entry.mark}</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="m-0 text-sm font-semibold">{entry.name}</h3>
              <span className="truncate font-mono text-[11px] text-[var(--launcher-muted)]">{entry.url}</span>
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
        <div className="mb-7">
          <div className="mb-2 text-xs font-semibold text-[var(--launcher-brand)]">{t('launcher.acknowledgements.eyebrow')}</div>
          <h1 className="m-0 text-2xl font-semibold">{t('launcher.acknowledgements.title')}</h1>
          <p className="mt-2 max-w-[680px] text-sm leading-6 text-[var(--launcher-muted)]">{t('launcher.acknowledgements.description')}</p>
        </div>
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
