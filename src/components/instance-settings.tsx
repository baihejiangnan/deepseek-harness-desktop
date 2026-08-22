import type { DshInstance, InstanceRemovalImpact, InstanceSharing } from '../store/modules/launcher/types'
import { ArrowDownToLine, ArrowLeft, ArrowRotateRight, Folder, Power, TrashBin, Wrench } from '@gravity-ui/icons'
import { Button, Modal, useOverlayState } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { toast } from '@/utils'
import { formatDshVersionLabel } from '@/utils/dsh-version'
import { runViewTransition } from '@/utils/view-transition'
import { useDshPlugins } from '../hooks/use-dsh-plugins'
import { SharingNotice } from './instance-wizard'

type SettingsSection = 'environment' | 'plugins' | 'export'

interface InstanceSettingsProps {
  instance: DshInstance
  sharing: InstanceSharing | null
  isRunning: boolean
  dshVersion: string | null
  onBack: () => void
  onGoDownloads?: () => void
  initialSection?: SettingsSection
}

export default function InstanceSettings({ instance, sharing, isRunning, dshVersion, onBack, onGoDownloads, initialSection = 'environment' }: InstanceSettingsProps) {
  const { t } = useTranslation()
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const sections: Array<{ id: SettingsSection, icon: typeof Wrench }> = [
    { id: 'environment', icon: Wrench },
    { id: 'plugins', icon: ArrowRotateRight },
    { id: 'export', icon: ArrowDownToLine },
  ]

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-[var(--launcher-canvas)] text-[var(--launcher-ink)]">
      <aside className="w-[210px] flex-none border-r border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] p-3">
        <div className="px-3 pb-3 pt-2 text-xs font-semibold text-[var(--launcher-muted)]">{t('launcher.instance_settings')}</div>
        <nav aria-label={t('launcher.instance_settings')}>
          <button
            type="button"
            className="mb-1 flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm text-[var(--launcher-muted)] transition-[background-color,color,transform] duration-200 ease-out hover:translate-x-0.5 hover:bg-white motion-reduce:transition-none motion-reduce:hover:translate-x-0"
            onClick={onBack}
          >
            <ArrowLeft className="size-3.5" />
            {t('launcher.back_to_instance')}
          </button>
          {sections.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm transition-[background-color,color,transform] duration-200 ease-out motion-reduce:transition-none ${section === item.id ? 'translate-x-1 bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)] motion-reduce:translate-x-0' : 'text-[var(--launcher-muted)] hover:translate-x-0.5 hover:bg-white motion-reduce:hover:translate-x-0'}`}
                onClick={() => setSection(item.id)}
              >
                <Icon className="size-4" />
                {t(`launcher.instance_settings_nav.${item.id}`)}
              </button>
            )
          })}
        </nav>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <div key={`${instance.id}-${section}`} className="launcher-content-enter mx-auto max-w-[1080px]">
          {section === 'environment' && <EnvironmentSettings instance={instance} sharing={sharing} isRunning={isRunning} dshVersion={dshVersion} />}
          {section === 'plugins' && <PluginSettings instance={instance} isRunning={isRunning} onGoDownloads={onGoDownloads} />}
          {section === 'export' && <ExportSettings instance={instance} isRunning={isRunning} />}
        </div>
      </main>
    </div>
  )
}

function EnvironmentSettings({ instance, sharing, isRunning, dshVersion }: Omit<InstanceSettingsProps, 'onBack'>) {
  const { t } = useTranslation()
  const { error } = useStore(store.launcher)
  const [name, setName] = useState(instance.name)
  const [dshHome, setDshHome] = useState(instance.dshHome)
  const [profile, setProfile] = useState(instance.profile)
  const [saving, setSaving] = useState(false)

  async function chooseHome() {
    const selected = await store.launcher.chooseHome()
    if (selected)
      setDshHome(selected)
  }

  async function save() {
    setSaving(true)
    try {
      await runViewTransition(async () => {
        await store.launcher.update(instance.id, name, dshHome, profile)
      })
      toast(t('launcher.instance_saved'), { variant: 'accent' })
    }
    catch {
      // The launcher store keeps the detailed error for the page.
    }
    finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading title={t('launcher.instance_settings_nav.environment')} description={t('launcher.environment_description')} />
      <If cond={isRunning}><div className="rounded-md border border-[#ead39e] bg-[#fff8e8] px-3 py-2 text-xs text-[#72521b]">{t('launcher.settings_running_hint')}</div></If>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label={t('launcher.instance_name')} value={name} onChange={setName} disabled={isRunning} />
        <div>
          <label className="mb-2 block text-xs font-medium">{t('launcher.version')}</label>
          <select disabled className="h-10 w-full rounded-md border border-[var(--launcher-border)] bg-[#f8fbff] px-3 text-sm text-[var(--launcher-ink)]"><option>{formatDshVersionLabel(t('launcher.latest_preview'), t('launcher.version_unavailable'), dshVersion)}</option></select>
          <span className="mt-1.5 block text-xs text-[var(--launcher-muted)]">{t('launcher.version_hint')}</span>
        </div>
        <div className="md:col-span-2">
          <label className="mb-2 block text-xs font-medium">{t('launcher.dsh_home')}</label>
          <div className="flex gap-2">
            <input disabled={isRunning} className="h-10 min-w-0 flex-1 rounded-md border border-[var(--launcher-border)] bg-white px-3 font-mono text-xs text-[var(--launcher-ink)] outline-none focus:border-[var(--launcher-brand)]" value={dshHome} onChange={event => setDshHome(event.target.value)} />
            <Button isDisabled={isRunning} className="h-10 rounded-md border-[var(--launcher-border)] bg-white px-3 text-[var(--launcher-ink)]" variant="outline" onPress={chooseHome}>
              <Folder className="size-4" />
              {t('launcher.browse')}
            </Button>
          </div>
          <span className="mt-1.5 block text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.settings_home_hint')}</span>
        </div>
        <div className="md:col-span-2">
          <Field label={t('launcher.profile')} value={profile} onChange={setProfile} disabled={isRunning} hint={t('launcher.profile_hint')} />
        </div>
      </div>
      <SharingNotice level={sharing?.level ?? null} />
      <If cond={error !== ''}><p className="m-0 text-xs text-danger">{error}</p></If>
      <div className="flex justify-end border-t border-[var(--launcher-border)] pt-5">
        <Button className="rounded-md bg-[var(--launcher-brand)] px-5 text-white" isDisabled={isRunning || saving || !name.trim() || !dshHome.trim() || !profile.trim()} onPress={save}>{saving ? t('launcher.saving_instance') : t('launcher.save_instance')}</Button>
      </div>
    </div>
  )
}

function PluginSettings({ instance, isRunning, onGoDownloads }: { instance: DshInstance, isRunning: boolean, onGoDownloads?: () => void }) {
  const { t } = useTranslation()
  const { registry, runningInstanceIds } = useStore(store.launcher)
  const { serviceRunning } = useStore(store.harness)
  const { plugins, loading, error, refresh } = useDshPlugins(instance.id)
  const homeRunning = registry.instances.some(item => item.dshHome === instance.dshHome && runningInstanceIds.includes(item.id)) || (serviceRunning && registry.activeInstanceId === instance.id)
  const [pendingRemove, setPendingRemove] = useState<typeof plugins[number] | null>(null)
  const [busyPlugin, setBusyPlugin] = useState('')
  const [actionError, setActionError] = useState('')
  const removeState = useOverlayState({
    isOpen: pendingRemove != null,
    onOpenChange: (open) => {
      if (!open && !busyPlugin)
        setPendingRemove(null)
    },
  })

  async function togglePlugin(plugin: typeof plugins[number]) {
    if (homeRunning)
      return
    setBusyPlugin(plugin.id)
    setActionError('')
    try {
      await invoke('set_plugin_enabled_for_instance', { instanceId: instance.id, pluginId: plugin.id, enabled: !plugin.bundled })
      await refresh()
      toast(plugin.bundled ? t('launcher.plugin_disabled') : t('launcher.plugin_enabled'), { variant: 'accent' })
    }
    catch (err) {
      setActionError(String(err))
    }
    finally {
      setBusyPlugin('')
    }
  }

  async function removePlugin() {
    if (!pendingRemove || homeRunning)
      return
    setBusyPlugin(pendingRemove.id)
    setActionError('')
    try {
      await invoke('remove_plugin_for_instance', { instanceId: instance.id, pluginId: pendingRemove.id })
      setPendingRemove(null)
      await refresh()
      toast(t('launcher.plugin_removed'), { variant: 'accent' })
    }
    catch (err) {
      setActionError(String(err))
    }
    finally {
      setBusyPlugin('')
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading title={t('launcher.instance_settings_nav.plugins')} description={t('launcher.plugins_description')} />
      {homeRunning && <div className="rounded-md border border-[#ead39e] bg-[#fff8e8] px-3 py-2 text-xs text-[#72521b]">{isRunning ? t('download.stop_instance_first') : t('download.stop_home_first')}</div>}
      <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--launcher-border)] bg-white px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs text-[var(--launcher-muted)]">{t('launcher.profile')}</div>
          <code className="text-xs text-[var(--launcher-ink)]">{instance.profile}</code>
        </div>
        <div className="flex items-center gap-2">
          <Button
            className="rounded-md border-[var(--launcher-brand)] bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)] opacity-100 hover:bg-[var(--launcher-border)] data-[disabled=true]:border-[var(--launcher-border)] data-[disabled=true]:bg-[var(--launcher-selected)] data-[disabled=true]:text-[var(--launcher-brand-strong)] data-[disabled=true]:opacity-70"
            variant="outline"
            isDisabled={loading}
            onPress={() => { void refresh() }}
          >
            <ArrowRotateRight className="size-3.5" />
            {t('launcher.refresh_plugins')}
          </Button>
          <Button className="rounded-md bg-[var(--launcher-brand)] text-white" onPress={onGoDownloads}>
            <ArrowDownToLine className="size-3.5" />
            {t('launcher.go_to_download_plugins')}
          </Button>
        </div>
      </div>
      {loading && <p className="text-sm text-[var(--launcher-muted)]">{t('plugins.loading')}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
      {actionError && <p className="text-xs text-danger">{actionError}</p>}
      {!loading && !error && plugins.length === 0 && <p className="rounded-md border border-dashed border-[var(--launcher-border)] px-4 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('plugins.empty')}</p>}
      <div className="space-y-2">
        {plugins.map(plugin => (
          <div key={plugin.id} className="flex items-center gap-3 rounded-md border border-[var(--launcher-border)] bg-white px-4 py-3">
            <div className="grid size-8 flex-none place-items-center rounded-md bg-[var(--launcher-selected)] text-xs font-semibold text-[var(--launcher-brand-strong)]">P</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{plugin.name}</div>
              <div className="truncate text-xs text-[var(--launcher-muted)]">{plugin.description || plugin.id}</div>
            </div>
            <code className="text-[11px] text-[var(--launcher-muted)]">{plugin.version || '-'}</code>
            <span className={`hidden rounded-full px-2 py-1 text-[10px] font-medium sm:inline-flex ${plugin.bundled ? 'bg-[var(--launcher-selected)] text-[var(--launcher-brand-strong)]' : 'bg-[#f2f4f7] text-[#748095]'}`}>
              {plugin.bundled ? t('launcher.plugin_enabled_status') : t('launcher.plugin_disabled_status')}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-md border-[var(--launcher-border)] px-2 text-xs text-[var(--launcher-ink)]"
              isDisabled={busyPlugin !== '' || homeRunning}
              onPress={() => { void togglePlugin(plugin) }}
            >
              <Power className="size-3.5" />
              {plugin.bundled ? t('launcher.plugin_disable') : t('launcher.plugin_enable')}
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className="size-8 min-w-8 rounded-md text-danger"
              aria-label={t('launcher.plugin_remove')}
              isDisabled={busyPlugin !== '' || homeRunning}
              onPress={() => setPendingRemove(plugin)}
            >
              <TrashBin className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Modal state={removeState}>
        <Modal.Backdrop isDismissable={!busyPlugin}>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('launcher.plugin_remove_title')}</Modal.Heading>
                <Modal.CloseTrigger isDisabled={busyPlugin !== ''} />
              </Modal.Header>
              <Modal.Body>
                <p className="m-0 text-sm text-[var(--launcher-muted)]">{t('launcher.plugin_remove_description', { name: pendingRemove?.name ?? pendingRemove?.id ?? '' })}</p>
              </Modal.Body>
              <Modal.Footer>
                <Button className="rounded-md" variant="tertiary" isDisabled={busyPlugin !== ''} onPress={() => setPendingRemove(null)}>{t('launcher.cancel')}</Button>
                <Button className="rounded-md bg-danger text-white" isDisabled={busyPlugin !== ''} onPress={() => { void removePlugin() }}>{t('launcher.plugin_remove_confirm')}</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  )
}

function ExportSettings({ instance, isRunning }: { instance: DshInstance, isRunning: boolean }) {
  const { t } = useTranslation()
  const [includeProfile, setIncludeProfile] = useState(true)
  const [includePlugins, setIncludePlugins] = useState(true)
  const [includeSessions, setIncludeSessions] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [homeExporting, setHomeExporting] = useState(false)
  const [impact, setImpact] = useState<InstanceRemovalImpact | null>(null)
  const [impactError, setImpactError] = useState('')
  const [result, setResult] = useState('')

  useEffect(() => {
    let cancelled = false
    void invoke<InstanceRemovalImpact>('get_instance_removal_impact', { instanceId: instance.id })
      .then((value) => {
        if (!cancelled)
          setImpact(value)
      })
      .catch((error) => {
        if (!cancelled)
          setImpactError(String(error))
      })
    return () => {
      cancelled = true
    }
  }, [instance.id])

  async function exportData() {
    setExporting(true)
    setResult('')
    try {
      const path = await invoke<string>('export_instance_profile', { input: { instanceId: instance.id, includeProfile, includePlugins, includeSessions } })
      setResult(path)
      toast(t('launcher.export_complete'), { variant: 'accent' })
    }
    catch (error) {
      if (!String(error).includes('EXPORT_CANCELLED'))
        setResult(String(error))
    }
    finally {
      setExporting(false)
    }
  }

  async function exportHome() {
    setHomeExporting(true)
    setResult('')
    try {
      const path = await invoke<string>('export_instance_home', { instanceId: instance.id })
      setResult(path)
      toast(t('launcher.export_complete'), { variant: 'accent' })
    }
    catch (error) {
      if (!String(error).includes('EXPORT_CANCELLED'))
        setResult(String(error))
    }
    finally {
      setHomeExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading title={t('launcher.instance_settings_nav.export')} description={t('launcher.export_description')} />
      <section className="space-y-4 rounded-md border border-[var(--launcher-brand)] bg-[var(--launcher-selected)] px-4 py-4">
        <div>
          <h3 className="m-0 text-sm font-semibold">{t('launcher.export_home_title')}</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.export_home_description')}</p>
        </div>
        {impact && (
          <div className="space-y-2 text-xs text-[var(--launcher-ink)]">
            <div>
              <span className="font-medium">
                {t('launcher.export_affected_instances')}
                :
              </span>
              {' '}
              {impact.instances.map(item => item.name).join('、')}
            </div>
            <div>
              <span className="font-medium">
                {t('launcher.export_affected_profiles')}
                :
              </span>
              {' '}
              {impact.profiles.join('、')}
            </div>
          </div>
        )}
        {impactError && <p className="m-0 text-xs text-danger">{impactError}</p>}
        <Button className="rounded-md bg-[var(--launcher-brand)] px-5 text-white" isDisabled={isRunning || homeExporting || impact == null} onPress={exportHome}>
          <ArrowDownToLine className="size-4" />
          {homeExporting ? t('launcher.exporting') : t('launcher.export_home_action')}
        </Button>
      </section>
      <div className="space-y-2">
        <ExportOption label={t('launcher.export_profile')} description={t('launcher.export_profile_hint')} checked={includeProfile} onChange={setIncludeProfile} />
        <ExportOption label={t('launcher.export_plugins')} description={t('launcher.export_plugins_hint')} checked={includePlugins} onChange={setIncludePlugins} />
        <ExportOption label={t('launcher.export_sessions')} description={t('launcher.export_sessions_hint')} checked={includeSessions} onChange={setIncludeSessions} />
      </div>
      <div className="rounded-md border border-[#ead39e] bg-[#fff8e8] px-3 py-2 text-xs leading-5 text-[#72521b]">{t('launcher.export_security_hint')}</div>
      <Button className="rounded-md bg-[var(--launcher-brand)] px-5 text-white" isDisabled={isRunning || exporting || (!includeProfile && !includePlugins && !includeSessions)} onPress={exportData}>
        <ArrowDownToLine className="size-4" />
        {exporting ? t('launcher.exporting') : t('launcher.export_action')}
      </Button>
      <If cond={result !== ''}><p className="break-all rounded-md border border-[var(--launcher-border)] bg-white p-3 font-mono text-xs text-[var(--launcher-muted)]">{result}</p></If>
    </div>
  )
}

function SectionHeading(props: { title: string, description: string }) {
  return (
    <div>
      <h2 className="m-0 text-lg font-semibold">{props.title}</h2>
      <p className="mt-1.5 text-sm leading-5 text-[var(--launcher-muted)]">{props.description}</p>
    </div>
  )
}

function Field(props: { label: string, value: string, onChange: (value: string) => void, disabled?: boolean, hint?: string }) {
  return (
    <div>
      <label className="mb-2 block text-xs font-medium">{props.label}</label>
      <input disabled={props.disabled} className="h-10 w-full rounded-md border border-[var(--launcher-border)] bg-white px-3 text-sm text-[var(--launcher-ink)] outline-none focus:border-[var(--launcher-brand)] disabled:bg-[#f8fbff]" value={props.value} onChange={event => props.onChange(event.target.value)} />
      {props.hint && <span className="mt-1.5 block text-xs leading-5 text-[var(--launcher-muted)]">{props.hint}</span>}
    </div>
  )
}

function ExportOption(props: { label: string, description: string, checked: boolean, onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--launcher-border)] bg-white px-4 py-3 transition-colors hover:border-[var(--launcher-brand)]">
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--launcher-brand)]" checked={props.checked} onChange={event => props.onChange(event.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{props.label}</span>
        <span className="mt-1 block text-xs leading-5 text-[var(--launcher-muted)]">{props.description}</span>
      </span>
    </label>
  )
}
