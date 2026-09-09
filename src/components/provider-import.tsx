import type { PlanResponse } from './provider-contracts'
import type { ProviderTemplate } from './provider-templates'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { providerErrorMessage } from '@/utils/provider-error'
import { useSaveStatus } from '@/utils/save-status'
import { ErrorBanner, SectionCard, StatusBadge, StatusNotice } from './launcher-ui'
import ProviderPlanView from './provider-plan-view'

/**
 * 从模板应用到实例：先看变更预览，再决定应用。
 *
 * 这里没有"全量覆盖"开关：冲突以 `modify` 的形式在预览里逐字段摊开，
 * 点"应用"本身就是对那份预览的确认。预览过期时后端会以 PROVIDER_SETTINGS_CHANGED
 * 中止，必须重新预览而不是重试同一个计划。
 */
export default function ProviderImport({ instanceId, disabled, onApplied }: { instanceId: string, disabled: boolean, onApplied: () => void }) {
  const { t } = useTranslation()
  const save = useSaveStatus({ holdMs: 0 })
  const [items, setItems] = useState<ProviderTemplate[]>([])
  const [ids, setIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [preview, setPreview] = useState<PlanResponse | null>(null)
  const [failure, setFailure] = useState('')

  useEffect(() => {
    let cancelled = false
    void invoke<ProviderTemplate[]>('list_provider_templates')
      .then((templates) => {
        if (cancelled)
          return
        setItems(templates)
        setLoadError('')
      })
      .catch((error: unknown) => {
        if (cancelled)
          return
        setItems([])
        setLoadError(providerErrorMessage(error))
      })
      .finally(() => {
        if (!cancelled)
          setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 选择变化就让旧预览失效，避免"预览的是 A、应用的却是 B"。 */
  function toggle(id: string, checked: boolean) {
    setPreview(null)
    setFailure('')
    setIds(current => checked ? [...current, id] : current.filter(item => item !== id))
  }

  async function run<T>(task: () => Promise<T>, onDone: (value: T) => void) {
    setFailure('')
    try {
      await save.run(async () => {
        onDone(await task())
      })
    }
    catch (error) {
      setFailure(providerErrorMessage(error))
    }
  }

  function previewChanges() {
    return run(
      () => invoke<PlanResponse>('plan_instance_provider_change', { instanceId, templateIds: ids, drafts: [], routeIdsToRemove: [], defaultModel: null }),
      result => setPreview(result),
    )
  }

  function applyChanges() {
    if (!preview)
      return
    return run(
      () => invoke<PlanResponse>('apply_instance_provider_change', { instanceId, templateIds: ids, drafts: [], routeIdsToRemove: [], defaultModel: null, digest: preview.digest, fingerprint: preview.fingerprint }),
      () => {
        setPreview(null)
        setIds([])
        onApplied()
      },
    )
  }

  const selected = items.filter(item => ids.includes(item.id))
  const selectionBlocked = disabled || loading || save.pending
  const previewBlocked = selectionBlocked || ids.length === 0

  return (
    <SectionCard
      title={t('providers.import')}
      description={t('providers.home_scope')}
      className="mb-5"
      actions={(
        <Button size="sm" variant="outline" className="h-8 rounded-md" isDisabled={previewBlocked} onPress={() => { void previewChanges() }}>
          {t('providers.preview')}
        </Button>
      )}
    >
      {disabled && <StatusNotice className="mb-3" message={t('launcher.instance_providers.running_readonly')} />}
      {loading && <p role="status" className="m-0 text-xs text-[var(--launcher-muted)]">{t('launcher.processing')}</p>}
      {loadError !== '' && <ErrorBanner className="mb-3" message={t('providers.load_failed')} detail={loadError} />}
      {!loading && items.length === 0 && <p className="m-0 text-xs text-[var(--launcher-muted)]">{t('providers.empty')}</p>}

      <div className="flex flex-wrap gap-3">
        {items.map(item => (
          <label key={item.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--launcher-brand)]"
              disabled={selectionBlocked}
              checked={ids.includes(item.id)}
              onChange={event => toggle(item.id, event.target.checked)}
            />
            <span className="min-w-0 break-words">{item.name}</span>
            <StatusBadge tone={item.protocol ? 'neutral' : 'accent'}>{item.protocol || t('providers.catalog_route')}</StatusBadge>
          </label>
        ))}
      </div>

      {preview !== null && (
        <ProviderPlanView preview={preview}>
          <div className="flex flex-wrap items-center gap-2">
            <Button className="h-8 rounded-md bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]" isDisabled={save.pending || selected.length === 0} onPress={() => { void applyChanges() }}>
              {t(save.pending ? 'launcher.processing' : 'providers.apply')}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 rounded-md" isDisabled={save.pending} onPress={() => setPreview(null)}>{t('launcher.cancel')}</Button>
          </div>
        </ProviderPlanView>
      )}

      {preview === null && selected.length > 0 && !disabled && (
        <p className="m-0 mt-3 text-xs text-[var(--launcher-muted)]">{t('providers.preview_hint')}</p>
      )}
      {save.phase === 'saved' && preview === null && <p role="status" className="m-0 mt-3 text-xs text-[var(--launcher-brand-strong)]">{t('providers.applied')}</p>}
      {failure !== '' && <ErrorBanner className="mt-3" message={t('providers.apply_failed')} detail={failure} />}
    </SectionCard>
  )
}
