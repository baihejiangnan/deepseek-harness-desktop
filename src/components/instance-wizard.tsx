import type { ProviderTemplate } from './provider-templates'
import type { InstanceSharing } from '@/store/modules/launcher/types'
import { Folder, Rocket, Wrench } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { formatDshVersionLabel } from '@/utils/dsh-version'
import { providerErrorMessage } from '@/utils/provider-error'

export function SharingNotice(props: { level: string | null }) {
  const { t } = useTranslation()
  if (!props.level)
    return null
  // Both sharing modes communicate the same caution and must stay visually identical.
  const tone = props.level === 'isolated'
    ? 'border-[#a9ddc1] bg-[#effaf4] text-[#245e41]'
    : 'border-[#ead39e] bg-[#fff8e8] text-[#72521b]'
  return (
    <div className={`rounded-md border px-3 py-2 text-xs leading-5 ${tone}`}>
      <span className="font-semibold">{t(`launcher.sharing.${props.level}.title`)}</span>
      <span className="ml-2 opacity-75">{t(`launcher.sharing.${props.level}.description`)}</span>
    </div>
  )
}

export default function InstanceWizard(props: { onCancel?: () => void }) {
  const { t } = useTranslation()
  const { error, registry } = useStore(store.launcher)
  const [sharingResult, setSharingResult] = useState<{ home: string, profile: string, value: InstanceSharing | null, failed: boolean } | null>(null)
  const [name, setName] = useState(() => t('launcher.default_instance_name'))
  const [dshHome, setDshHome] = useState('')
  const [homePickerFailed, setHomePickerFailed] = useState(false)
  const [profile, setProfile] = useState('tauri')
  const [repairAssistant, setRepairAssistant] = useState(false)
  const [providerTemplates, setProviderTemplates] = useState<ProviderTemplate[]>([])
  const [providerIds, setProviderIds] = useState<string[]>([])
  const [providerError, setProviderError] = useState('')
  const [providersLoading, setProvidersLoading] = useState(true)
  const [nameFocused, setNameFocused] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [dshVersion, setDshVersion] = useState<string | null>(null)
  const duplicateName = name.trim().length > 0 && registry.instances.some(instance => instance.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase())

  useEffect(() => {
    void invoke<ProviderTemplate[]>('list_provider_templates').then((items) => {
      setProviderTemplates(items)
      setProviderIds(items.filter(item => item.defaultForNew).map(item => item.id))
    }).catch(error => setProviderError(providerErrorMessage(error))).finally(() => setProvidersLoading(false))
    void invoke<{ dsh_version: string | null }>('get_runtime_info')
      .then(runtime => setDshVersion(runtime.dsh_version))
      .catch(() => {})
  }, [])

  useEffect(() => {
    let disposed = false
    if (!dshHome.trim() || !profile.trim())
      return
    const timer = window.setTimeout(() => {
      void invoke<InstanceSharing>('get_instance_sharing', { dshHome, profile }).then((value) => {
        if (!disposed)
          setSharingResult({ home: dshHome, profile, value, failed: false })
      }).catch(() => {
        if (!disposed)
          setSharingResult({ home: dshHome, profile, value: null, failed: true })
      })
    }, 250)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [dshHome, profile])

  const currentSharing = sharingResult?.home === dshHome && sharingResult.profile === profile ? sharingResult : null

  async function chooseHome() {
    setHomePickerFailed(false)
    try {
      const selected = await store.launcher.chooseHome()
      if (selected)
        setDshHome(selected)
    }
    catch {
      setHomePickerFailed(true)
    }
  }

  async function createInstance() {
    if (submitting || providersLoading || !name.trim() || !dshHome.trim() || !profile.trim())
      return
    setSubmitting(true)
    try {
      await store.launcher.create(name, dshHome, profile, repairAssistant, providerIds)
      props.onCancel?.()
    }
    catch {
      // Store exposes the failure without creating an unhandled rejection.
    }
    finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1240px] px-6 py-3 lg:px-10 lg:py-4">
      <div className="grid grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] max-md:grid-cols-1">
        <aside className="flex flex-col border-r border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] p-5 max-md:border-b max-md:border-r-0">
          <fieldset disabled={submitting} className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-3 text-xs font-semibold text-[var(--launcher-muted)]">{t('launcher.instance_type')}</legend>
            <div className="grid gap-2 max-md:grid-cols-2 max-sm:grid-cols-1">
              {[false, true].map((repair) => {
                const Icon = repair ? Wrench : Rocket
                return (
                  <label key={String(repair)} className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--launcher-brand)] motion-reduce:transition-none ${repairAssistant === repair ? 'border-[var(--launcher-brand)] bg-[var(--launcher-selected)] text-[var(--launcher-brand-strong)]' : 'border-transparent text-[var(--launcher-muted)] hover:bg-[var(--launcher-surface)]'} ${submitting ? 'pointer-events-none opacity-60' : ''}`}>
                    <Icon className="size-5 shrink-0" />
                    <span className="flex-1 font-medium">{t(repair ? 'launcher.type.repair' : 'launcher.type.normal')}</span>
                    <input type="radio" name="instance-type" value={repair ? 'repair' : 'normal'} checked={repairAssistant === repair} onChange={() => setRepairAssistant(repair)} className="size-4 shrink-0 accent-[var(--launcher-brand)]" />
                  </label>
                )
              })}
            </div>
          </fieldset>
          <div className="mt-5 border-t border-[var(--launcher-border)] pt-4 text-xs leading-6 text-[var(--launcher-muted)]" aria-live="polite">
            <p className="m-0">{t(repairAssistant ? 'launcher.type.repair_description' : 'launcher.type.normal_description')}</p>
            {repairAssistant && <p className="mb-0 mt-3 font-medium text-[var(--launcher-ink)]">{t('repair.independent')}</p>}
          </div>
        </aside>
        <div className="flex flex-col p-6 lg:p-8">
          <fieldset disabled={submitting} className="m-0 grid min-w-0 grid-cols-2 gap-x-6 gap-y-5 border-0 p-0 max-lg:grid-cols-1">
            <div className="col-span-2 text-sm max-lg:col-span-1">
              <p>{t('providers.choose_new')}</p>
              <div className="flex flex-wrap gap-3">
                {providerTemplates.map(item => (
                  <label key={item.id}>
                    <input type="checkbox" className="mr-2" disabled={submitting} checked={providerIds.includes(item.id)} onChange={event => setProviderIds(event.target.checked ? [...providerIds, item.id] : providerIds.filter(id => id !== item.id))} />
                    {item.name}
                  </label>
                ))}
              </div>
              {providerError && <p role="alert" className="text-xs text-danger">{providerError}</p>}
            </div>
            <label className="block min-w-0">
              <span className="mb-2 block text-xs font-medium">{t('launcher.instance_name')}</span>
              <input className={`h-10 w-full rounded-md border bg-[var(--field-background)] px-3 text-[var(--launcher-ink)] outline-none transition-colors motion-reduce:transition-none focus:border-[var(--launcher-brand)] ${duplicateName && nameFocused ? 'border-[#d9a441]' : 'border-[var(--launcher-border)]'}`} value={name} onChange={event => setName(event.target.value)} onFocus={() => setNameFocused(true)} onBlur={() => setNameFocused(false)} />
              <If cond={duplicateName && nameFocused}><span className="mt-1.5 block text-xs text-[#8a641f]">{t('launcher.duplicate_name_hint')}</span></If>
            </label>
            <div className="block min-w-0">
              <span className="mb-2 block text-xs font-medium">{t('launcher.version')}</span>
              <div className="flex min-h-10 items-center rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] px-3 py-2 text-sm text-[var(--launcher-ink)]">
                {formatDshVersionLabel(t('launcher.latest_preview'), t('launcher.version_unavailable'), dshVersion)}
              </div>
              <span className="mt-1.5 block text-xs text-[var(--launcher-muted)]">{t('launcher.version_hint')}</span>
            </div>
            <label className="col-span-2 block min-w-0 max-lg:col-span-1">
              <span className="mb-2 block text-xs font-medium">{t('launcher.dsh_home')}</span>
              <div className="flex gap-2">
                <input className="h-10 min-w-0 flex-1 rounded-md border border-[var(--launcher-border)] bg-[var(--field-background)] px-3 text-[var(--launcher-ink)] outline-none transition-colors motion-reduce:transition-none focus:border-[var(--launcher-brand)]" placeholder={t('launcher.dsh_home_placeholder')} value={dshHome} onChange={event => setDshHome(event.target.value)} />
                <Button isDisabled={submitting} className="h-10 shrink-0 rounded-md border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-4 text-[var(--launcher-ink)]" variant="outline" onPress={chooseHome}>
                  <Folder />
                  {t('launcher.browse')}
                </Button>
              </div>
              <span className="mt-1.5 block text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.dsh_home_hint')}</span>
              {homePickerFailed && <span role="alert" className="mt-1.5 block text-xs text-danger">{t('launcher.home_picker_failed')}</span>}
            </label>
            <label className="col-span-2 block min-w-0 max-lg:col-span-1">
              <span className="mb-2 block text-xs font-medium">{t('launcher.profile')}</span>
              <input className="h-10 w-full rounded-md border border-[var(--launcher-border)] bg-[var(--field-background)] px-3 text-[var(--launcher-ink)] outline-none transition-colors motion-reduce:transition-none focus:border-[var(--launcher-brand)]" value={profile} onChange={event => setProfile(event.target.value)} />
              <span className="mt-1.5 block text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.profile_hint')}</span>
            </label>
            <div className="col-span-2 max-lg:col-span-1">
              <SharingNotice level={currentSharing?.value?.level ?? null} />
              {currentSharing?.failed && <p role="alert" className="text-xs text-danger">{t('launcher.sharing.check_failed')}</p>}
              <If cond={error !== ''}><p className="mb-0 mt-3 text-xs text-danger">{error}</p></If>
            </div>
          </fieldset>
          <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-[var(--launcher-border)] pt-5">
            <If cond={props.onCancel != null}>
              <Button className="h-10 rounded-md text-[var(--launcher-muted)]" variant="ghost" isDisabled={submitting} onPress={props.onCancel}>{t('launcher.cancel')}</Button>
            </If>
            <Button className="h-10 rounded-md bg-[var(--launcher-brand)] px-6 text-white" isDisabled={submitting || providersLoading || !name.trim() || !dshHome || !profile} onPress={createInstance}>
              {submitting ? t('launcher.creating') : t('launcher.create')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
