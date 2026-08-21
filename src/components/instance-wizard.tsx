import { Folder } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { formatDshVersionLabel } from '@/utils/dsh-version'

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
  const { sharing, error, registry } = useStore(store.launcher)
  const [name, setName] = useState(() => t('launcher.default_instance_name'))
  const [dshHome, setDshHome] = useState('')
  const [profile, setProfile] = useState('tauri')
  const [nameFocused, setNameFocused] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [activeStep, setActiveStep] = useState(0)
  const [dshVersion, setDshVersion] = useState<string | null>(null)
  const steps = [
    { number: '01', label: t('launcher.version'), description: t('launcher.version_hint') },
    { number: '02', label: t('launcher.dsh_home'), description: t('launcher.dsh_home_hint') },
    { number: '03', label: t('launcher.profile'), description: t('launcher.profile_hint') },
  ]
  const duplicateName = name.trim().length > 0 && registry.instances.some(instance => instance.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase())

  useEffect(() => {
    void invoke<{ dsh_version: string | null }>('get_runtime_info')
      .then(runtime => setDshVersion(runtime.dsh_version))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveStep(current => (current + 1) % steps.length)
    }, 2800)
    return () => window.clearInterval(timer)
  }, [steps.length])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void store.launcher.inspectSharing(dshHome, profile)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [dshHome, profile])

  async function chooseHome() {
    const selected = await store.launcher.chooseHome()
    if (selected)
      setDshHome(selected)
  }

  async function createInstance() {
    setSubmitting(true)
    try {
      await store.launcher.create(name, dshHome, profile)
    }
    finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1240px] px-6 py-3 lg:px-10 lg:py-4">
      <div className="mb-3 grid grid-cols-[350px_minmax(0,1fr)] items-center gap-4 border-b border-[var(--launcher-border)] pb-2 max-lg:grid-cols-1 max-lg:gap-2">
        <div>
          <div className="mb-1.5 text-xs font-semibold text-[var(--launcher-brand)]">{t('launcher.onboarding.eyebrow')}</div>
          <h1 className="m-0 text-2xl font-semibold text-[var(--launcher-ink)]">{t('launcher.onboarding.title')}</h1>
        </div>
        <p className="m-0 justify-self-start text-[13px] leading-5 whitespace-nowrap text-[var(--launcher-muted)] max-lg:whitespace-normal">{t('launcher.onboarding.subtitle')}</p>
      </div>
      <div className="grid grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] max-md:grid-cols-1">
        <div className="flex flex-col border-r border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] p-6 max-md:border-b max-md:border-r-0">
          <ol className="m-0 space-y-2 p-0 text-sm text-[var(--launcher-muted)] max-md:grid max-md:grid-cols-3 max-md:space-y-0">
            {steps.map((step, index) => (
              <li
                key={step.number}
                aria-current={activeStep === index ? 'step' : undefined}
                className={`rounded-md border-l-2 px-4 py-3 transition-all duration-500 ease-out motion-reduce:transition-none ${activeStep === index ? 'translate-x-1 border-[var(--launcher-brand)] bg-[var(--launcher-selected)] text-[var(--launcher-ink)] shadow-[0_3px_10px_rgba(47,95,201,0.08)] motion-reduce:translate-x-0' : 'border-transparent'}`}
              >
                <span className={`mr-3 font-mono text-xs transition-colors duration-500 ${activeStep === index ? 'text-[var(--launcher-brand)]' : ''}`}>{step.number}</span>
                {step.label}
              </li>
            ))}
          </ol>
          <div className="mt-auto min-h-[106px] border-t border-[var(--launcher-border)] pt-5 text-xs leading-5 text-[var(--launcher-muted)] max-md:hidden" aria-live="polite">
            <p key={steps[activeStep].number} className="m-0 transition-all duration-500 starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none">
              <span className="mb-1 block font-medium text-[var(--launcher-ink)]">{steps[activeStep].label}</span>
              {steps[activeStep].description}
            </p>
          </div>
        </div>
        <div className="flex flex-col p-6 lg:p-8">
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 max-lg:grid-cols-1">
            <label className="block min-w-0">
              <span className="mb-2 block text-xs font-medium">{t('launcher.instance_name')}</span>
              <input className={`h-10 w-full rounded-md border bg-white px-3 text-[var(--launcher-ink)] outline-none transition-colors focus:border-[var(--launcher-brand)] ${duplicateName && nameFocused ? 'border-[#d9a441]' : 'border-[var(--launcher-border)]'}`} value={name} onChange={event => setName(event.target.value)} onFocus={() => setNameFocused(true)} onBlur={() => setNameFocused(false)} />
              <If cond={duplicateName && nameFocused}><span className="mt-1.5 block text-xs text-[#8a641f]">{t('launcher.duplicate_name_hint')}</span></If>
            </label>
            <label className="block min-w-0">
              <span className="mb-2 block text-xs font-medium">{t('launcher.version')}</span>
              <select className="h-10 w-full rounded-md border border-[var(--launcher-border)] bg-white px-3 text-[var(--launcher-ink)]">
                <option>{formatDshVersionLabel(t('launcher.latest_preview'), t('launcher.version_unavailable'), dshVersion)}</option>
              </select>
              <span className="mt-1.5 block text-xs text-[var(--launcher-muted)]">{t('launcher.version_hint')}</span>
            </label>
            <label className="col-span-2 block min-w-0 max-lg:col-span-1">
              <span className="mb-2 block text-xs font-medium">{t('launcher.dsh_home')}</span>
              <div className="flex gap-2">
                <input className="h-10 min-w-0 flex-1 rounded-md border border-[var(--launcher-border)] bg-white px-3 text-[var(--launcher-ink)] outline-none transition-colors focus:border-[var(--launcher-brand)]" placeholder={t('launcher.dsh_home_placeholder')} value={dshHome} onChange={event => setDshHome(event.target.value)} />
                <Button className="h-10 rounded-md border-[var(--launcher-border)] bg-white px-4 text-[var(--launcher-ink)]" variant="outline" onPress={chooseHome}>
                  <Folder />
                  {t('launcher.browse')}
                </Button>
              </div>
              <span className="mt-1.5 block text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.dsh_home_hint')}</span>
            </label>
            <label className="col-span-2 block min-w-0 max-lg:col-span-1">
              <span className="mb-2 block text-xs font-medium">{t('launcher.profile')}</span>
              <input className="h-10 w-full rounded-md border border-[var(--launcher-border)] bg-white px-3 text-[var(--launcher-ink)] outline-none transition-colors focus:border-[var(--launcher-brand)]" value={profile} onChange={event => setProfile(event.target.value)} />
              <span className="mt-1.5 block text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.profile_hint')}</span>
            </label>
            <div className="col-span-2 max-lg:col-span-1">
              <SharingNotice level={sharing?.level ?? null} />
              <If cond={error !== ''}><p className="mb-0 mt-3 text-xs text-danger">{error}</p></If>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2 border-t border-[var(--launcher-border)] pt-5">
            <If cond={props.onCancel != null}>
              <Button className="h-10 rounded-md text-[var(--launcher-muted)]" variant="ghost" onPress={props.onCancel}>{t('launcher.cancel')}</Button>
            </If>
            <Button className="h-10 rounded-md bg-[var(--launcher-brand)] px-6 text-white" isDisabled={submitting || !name.trim() || !dshHome || !profile} onPress={createInstance}>
              {submitting ? t('launcher.creating') : t('launcher.create')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
