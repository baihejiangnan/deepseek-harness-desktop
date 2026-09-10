import { Button } from '@heroui/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import InstanceProviders from './instance-providers'
import { StatusNotice } from './launcher-ui'
import ProviderImport from './provider-import'
import ProviderTemplates from './provider-templates'

/** The target ID is local to this workspace; global instance selection never redirects writes. */
export default function ProviderWorkspace() {
  const { t } = useTranslation()
  const { registry, runningInstanceIds } = useStore(store.launcher)
  const [targetId, setTargetId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [applied, setApplied] = useState(false)
  const [inspect, setInspect] = useState(false)
  const [busy, setBusy] = useState(false)
  const target = registry.instances.find(instance => instance.id === targetId)
  const homeUsers = target ? registry.instances.filter(instance => instance.dshHome === target.dshHome) : []
  const running = homeUsers.some(instance => runningInstanceIds.includes(instance.id))

  if (!templateId) {
    return (
      <>
        <ProviderTemplates onApply={(id) => {
          setTemplateId(id)
          setTargetId('')
          setApplied(false)
          setInspect(false)
        }}
        />
      </>
    )
  }

  return (
    <>
      <Button className="mb-4" variant="outline" isDisabled={busy} onPress={() => setTemplateId('')}>{t('providers.back_library')}</Button>
      <h2 className="mb-4 text-lg font-semibold">
        {t('providers.apply_instance')}
        {' '}
        ·
        {' '}
        {templateId}
      </h2>
      <label className="mb-4 block text-sm font-medium">
        {t('providers.workspace_target')}
        <select disabled={applied || busy} className="mt-2 block h-10 w-full rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3" value={target?.id ?? ''} onChange={event => setTargetId(event.target.value)}>
          <option value="">{t('providers.choose_instance')}</option>
          {registry.instances.map(instance => (
            <option key={instance.id} value={instance.id}>
              {instance.name}
              {' '}
              ·
              {' '}
              {instance.profile}
            </option>
          ))}
        </select>
      </label>
      {target && (inspect
        ? <InstanceProviders key={target.id} instance={target} sharing={homeUsers.length > 1 ? { homeUsers: homeUsers.length, profileUsers: homeUsers.filter(instance => instance.profile === target.profile).length, level: 'shared_home' } : null} isRunning={running} />
        : applied
          ? (
              <>
                <StatusNotice message={t('providers.apply_complete')} />
                <Button onPress={() => setInspect(true)}>{t('providers.view_instance')}</Button>
              </>
            )
          : <ProviderImport key={`${target.id}:${templateId}`} instanceId={target.id} disabled={running} initialIds={[templateId]} allowManage={false} onBusy={setBusy} onApplied={() => setApplied(true)} />)}
    </>
  )
}
