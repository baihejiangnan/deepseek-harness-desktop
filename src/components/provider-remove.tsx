import type { InstanceProviderView, PlanResponse, ProviderRouteView } from './provider-contracts'
import { TrashBin } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { providerErrorMessage } from '@/utils/provider-error'
import { useSaveStatus } from '@/utils/save-status'
import { ErrorBanner, StatusNotice } from './launcher-ui'
import ProviderPlanView from './provider-plan-view'

/**
 * 移除实例里的一条服务商路由。
 *
 * 移除只删 settings.yaml 里的那一段：凭据值一律保留（别的段落或插件可能正在用同一个引用），
 * 非模板自有字段随该段一起消失，因此必须先给预览。
 */
export default function ProviderRemove(props: {
  instanceId: string
  route: ProviderRouteView
  view: InstanceProviderView
  disabled: boolean
  onApplied: () => void
}) {
  const { instanceId, route, view, disabled, onApplied } = props
  const { t } = useTranslation()
  const save = useSaveStatus({ holdMs: 0 })
  const [open, setOpen] = useState(false)
  const [clearDefault, setClearDefault] = useState(false)
  const [preview, setPreview] = useState<PlanResponse | null>(null)
  const [failure, setFailure] = useState('')

  const holdsDefault = view.defaultModel.declared && view.defaultModel.provider === route.id

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

  function payload() {
    return {
      instanceId,
      templateIds: [],
      drafts: [],
      routeIdsToRemove: [route.id],
      // 只有用户明确要求时才动 Home 级的默认模型；否则这一段原样留着。
      defaultModel: holdsDefault && clearDefault ? 'clear' : null,
    }
  }

  function previewChanges() {
    return run(() => invoke<PlanResponse>('plan_instance_provider_change', payload()), setPreview)
  }

  function applyChanges() {
    if (preview === null)
      return
    return run(
      () => invoke<PlanResponse>('apply_instance_provider_change', { ...payload(), digest: preview.digest, fingerprint: preview.fingerprint }),
      () => {
        setPreview(null)
        setOpen(false)
        onApplied()
      },
    )
  }

  if (disabled)
    return null

  return (
    <div className="mt-4 border-t border-[var(--launcher-border)] pt-4">
      {!open && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-md text-danger"
          onPress={() => {
            setFailure('')
            setOpen(true)
          }}
        >
          <TrashBin className="size-4" />
          {t('providers.edit.remove_action')}
        </Button>
      )}

      {open && (
        <div className="space-y-3">
          <p className="m-0 text-sm font-medium">{t('providers.edit.remove_title', { name: route.displayName || route.id })}</p>
          <StatusNotice tone="neutral" message={t('providers.edit.remove_scope')} />
          {route.unknownFields.length > 0 && (
            <StatusNotice message={t('providers.edit.remove_foreign', { fields: route.unknownFields.join(', ') })} />
          )}
          {route.credential.declared && (
            <StatusNotice tone="neutral" message={t('providers.edit.remove_credential_kept', { ref: route.credential.ref })} />
          )}
          {holdsDefault && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4 flex-none accent-[var(--launcher-brand)]"
                checked={clearDefault}
                disabled={save.pending}
                onChange={(event) => {
                  setPreview(null)
                  setClearDefault(event.target.checked)
                }}
              />
              <span className="min-w-0">
                <span className="block">{t('providers.edit.remove_clear_default')}</span>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.edit.remove_clear_default_hint', { model: view.defaultModel.model })}</span>
              </span>
            </label>
          )}
          {holdsDefault && !clearDefault && (
            <StatusNotice message={t('providers.edit.remove_default_dangling', { model: view.defaultModel.model })} />
          )}

          {preview !== null && (
            <ProviderPlanView preview={preview}>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button size="sm" className="h-8 rounded-md bg-danger text-white" isDisabled={save.pending} onPress={() => { void applyChanges() }}>
                  {t(save.pending ? 'launcher.processing' : 'providers.edit.remove_confirm')}
                </Button>
                <Button size="sm" variant="ghost" className="h-8 rounded-md" isDisabled={save.pending} onPress={() => setPreview(null)}>{t('launcher.cancel')}</Button>
              </div>
            </ProviderPlanView>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {preview === null && (
              <>
                <Button size="sm" variant="outline" className="h-8 rounded-md" isDisabled={save.pending} onPress={() => { void previewChanges() }}>{t('providers.preview')}</Button>
                <Button size="sm" variant="ghost" className="h-8 rounded-md" isDisabled={save.pending} onPress={() => setOpen(false)}>{t('launcher.cancel')}</Button>
              </>
            )}
          </div>

          {failure !== '' && <ErrorBanner message={t('providers.apply_failed')} detail={failure} />}
        </div>
      )}
    </div>
  )
}
