import type { CatalogModel, CatalogModelsResponse, CatalogProvider, CatalogResponse, PlanResponse } from './provider-contracts'
import type { ProviderModel } from './provider-models'
import type { ProviderTemplate } from './provider-templates'
import { Plus } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { providerErrorMessage } from '@/utils/provider-error'
import { useSaveStatus } from '@/utils/save-status'
import { ErrorBanner, Field, SearchInput, SectionCard, StatusBadge, StatusNotice } from './launcher-ui'
import ProviderPlanView from './provider-plan-view'

const MODEL_PAGE_SIZE = 30

/** 草稿：字段与 Rust ProviderTemplate 一一对应。目录型刻意不填 baseURL/protocol。 */
function emptyDraft(): ProviderTemplate {
  return { id: '', name: '', baseUrl: '', protocol: '', modelId: '', models: [], modelOverrides: [], selection: 'all', defaultForNew: false, kind: 'catalog' } as ProviderTemplate
}

export default function ProviderAdd({ instanceId, disabled, onApplied, initialOpen = false, onBusy }: { instanceId: string, disabled: boolean, onApplied: () => void, initialOpen?: boolean, onBusy?: (busy: boolean) => void }) {
  const { t } = useTranslation()
  const save = useSaveStatus({ holdMs: 0 })
  const [open, setOpen] = useState(initialOpen)
  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [draft, setDraft] = useState<ProviderTemplate>(() => emptyDraft())
  const [apiKey, setApiKey] = useState('')
  const [alsoTemplate, setAlsoTemplate] = useState(false)
  const [useDefaultModel, setUseDefaultModel] = useState(false)
  const [defaultModelId, setDefaultModelId] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean, message: string, modelId: string, signature: string, time: string } | null>(null)
  const [models, setModels] = useState<CatalogModel[] | null>(null)
  const [modelsError, setModelsError] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const [modelPage, setModelPage] = useState(1)
  const [preview, setPreview] = useState<PlanResponse | null>(null)
  const [failure, setFailure] = useState('')
  const [templateSaveFailed, setTemplateSaveFailed] = useState(false)
  const modelRequestRef = useRef(0)

  useEffect(() => {
    if (!initialOpen)
      return
    let cancelled = false
    void invoke<CatalogResponse>('list_runtime_catalog').then((result) => {
      if (!cancelled)
        setCatalog(result.providers)
    }).catch((error: unknown) => {
      if (!cancelled) {
        setCatalogError(providerErrorMessage(error))
        setCatalog([])
      }
    })
    return () => {
      cancelled = true
    }
  }, [initialOpen])

  const catalogById = useMemo(() => new Map((catalog ?? []).map(item => [item.id, item])), [catalog])
  const chosen = catalogById.get(draft.id)
  const writable = chosen !== undefined && chosen.configurable
  const filteredModels = (models ?? []).filter(item => item.id.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()))
  const modelPages = Math.max(1, Math.ceil(filteredModels.length / MODEL_PAGE_SIZE))
  const modelSlice = filteredModels.slice((Math.min(modelPage, modelPages) - 1) * MODEL_PAGE_SIZE, modelPage * MODEL_PAGE_SIZE)

  async function openWizard() {
    setOpen(true)
    setFailure('')
    if (catalog !== null)
      return
    try {
      const result = await invoke<CatalogResponse>('list_runtime_catalog')
      setCatalog(result.providers)
    }
    catch (error) {
      setCatalogError(providerErrorMessage(error))
      setCatalog([])
    }
  }

  /** 换服务商就把模型相关状态清空，避免留下上一个服务商的选择。 */
  async function chooseRoute(id: string) {
    const request = ++modelRequestRef.current
    setDraft({ ...emptyDraft(), id, name: catalogById.get(id)?.name ?? '' })
    setPreview(null)
    setModels(null)
    setModelsError('')
    setModelQuery('')
    setModelPage(1)
    setApiKey('')
    setUseDefaultModel(false)
    setDefaultModelId('')
    setTestResult(null)
    if (!catalogById.get(id)?.configurable)
      return
    try {
      const result = await invoke<CatalogModelsResponse>('get_runtime_catalog_models', { providerId: id })
      if (request !== modelRequestRef.current || result.providerId !== id)
        return
      setModels(result.models)
    }
    catch (error) {
      if (request !== modelRequestRef.current)
        return
      setModelsError(providerErrorMessage(error))
      setModels([])
    }
  }

  function toggleModel(model: CatalogModel, checked: boolean) {
    setPreview(null)
    const next = checked ? [...draft.models, { id: model.id } as ProviderModel] : draft.models.filter(item => item.id !== model.id)
    setDraft({ ...draft, selection: 'subset', models: next, modelId: '' })
  }

  function followCatalog() {
    setPreview(null)
    setDraft({ ...draft, selection: 'all', models: [], modelId: '' })
  }

  function chooseSubset() {
    // 只在还没选过任何模型时重置搜索词，免得用户回头找刚才筛出的那批时落空。
    if (draft.models.length === 0)
      setModelQuery('')
    setPreview(null)
    setDraft({ ...draft, selection: 'subset' })
  }

  function rename(value: string) {
    setPreview(null)
    setDraft({ ...draft, name: value })
  }

  function enterKey(value: string) {
    setPreview(null)
    setApiKey(value)
  }

  function searchModels(value: string) {
    setModelQuery(value)
    // 换搜索词就回到第一页，否则会停在越界页码上看到空列表。
    setModelPage(1)
  }

  /** 默认模型只在用户明确勾选时提交；不勾选就完全不触碰 agent-default-model。 */
  const chosenDefault = useDefaultModel && defaultModelId !== '' ? { provider: draft.id, model: defaultModelId } : null

  /** 可选的连接测试：只测"运行时支持 ∩ 探测已实现 ∩ 这份配置表达得出"的组合。 */
  const testCandidate = useMemo(() => {
    const model = (models ?? []).find(item => item.id === (defaultModelId !== '' ? defaultModelId : draft.models[0]?.id))
    if (!chosen || !chosen.configurable || !model?.protocolSupported || chosen.baseUrl === '' || apiKey === '' || model === undefined)
      return null
    return { modelId: model.id, baseUrl: chosen.baseUrl, protocol: model.api }
  }, [chosen, models, defaultModelId, draft.models, apiKey])

  /**
   * 结果失效判据：一次测试的结论只对它当时那份输入负责。
   * 用派生比较而不是往每个输入处理里塞 reset——漏掉一处就是把缺陷放回去。
   */
  const testSignature = testCandidate === null ? '' : `${testCandidate.baseUrl}|${testCandidate.protocol}|${testCandidate.modelId}|${apiKey}`
  const testStale = testResult !== null && testResult.signature !== testSignature

  async function testConnection() {
    if (!testCandidate)
      return
    setTesting(true)
    setTestResult(null)
    const at = new Date().toLocaleTimeString()
    const { modelId } = testCandidate
    try {
      const result = await invoke<{ ok?: boolean, message?: string }>('probe_provider_template', {
        baseUrl: testCandidate.baseUrl,
        protocol: testCandidate.protocol,
        apiKey,
        operation: 'test',
        modelId: testCandidate.modelId,
      })
      setTestResult({ ok: result.ok !== false, message: result.message ?? t('providers.add.test_passed'), modelId, signature: testSignature, time: at })
    }
    catch (error) {
      setTestResult({ ok: false, message: providerErrorMessage(error), modelId, signature: testSignature, time: at })
    }
    finally {
      setTesting(false)
    }
  }

  function buildDraft(): ProviderTemplate {
    const isCatalog = writable
    return {
      ...draft,
      kind: isCatalog ? 'catalog' as const : 'custom' as const,
      baseUrl: isCatalog ? '' : draft.baseUrl,
      protocol: isCatalog ? '' : draft.protocol,
      models: isCatalog && draft.selection === 'all' ? [] : draft.models,
      modelId: '',
      defaultForNew: false,
    }
  }

  const ready = writable && draft.name.trim() !== '' && (draft.selection === 'all' || draft.models.length > 0) && !(useDefaultModel && defaultModelId === '')

  async function run<T>(task: () => Promise<T>, onDone: (value: T) => void | Promise<void>) {
    setFailure('')
    onBusy?.(true)
    try {
      await save.run(async () => {
        await onDone(await task())
      })
    }
    catch (error) {
      setFailure(providerErrorMessage(error))
    }
    finally {
      onBusy?.(false)
    }
  }

  function previewChanges() {
    return run(
      () => invoke<PlanResponse>('plan_instance_provider_change', { instanceId, templateIds: [], drafts: [{ template: buildDraft(), apiKey }], routeIdsToRemove: [], defaultModel: chosenDefault }),
      setPreview,
    )
  }

  function applyChanges() {
    if (!preview)
      return
    return run(
      () => invoke<PlanResponse>('apply_instance_provider_change', { instanceId, templateIds: [], drafts: [{ template: buildDraft(), apiKey }], routeIdsToRemove: [], defaultModel: chosenDefault, digest: preview.digest, fingerprint: preview.fingerprint }),
      async () => {
        setPreview(null)
        setOpen(false)
        setTemplateSaveFailed(false)
        if (alsoTemplate) {
          try {
            await invoke('save_provider_template', { template: buildDraft(), apiKey, editing: false })
          }
          catch {
            setTemplateSaveFailed(true)
            return
          }
        }
        onApplied()
      },
    )
  }

  function retryTemplateSave() {
    void run(() => invoke('save_provider_template', { template: buildDraft(), apiKey, editing: false }), onApplied)
  }

  if (disabled)
    return null

  if (preview) {
    return (
      <SectionCard title={t('providers.preview')} className="mb-5">
        <ProviderPlanView preview={preview}>
          <div className="flex justify-end gap-2">
            <Button isDisabled={save.pending} onPress={() => { void applyChanges() }}>{t(save.pending ? 'launcher.processing' : 'providers.apply')}</Button>
            <Button variant="outline" isDisabled={save.pending} onPress={() => setPreview(null)}>{t('launcher.cancel')}</Button>
          </div>
        </ProviderPlanView>
        {failure !== '' && <ErrorBanner message={t('providers.add.failed')} detail={failure} />}
      </SectionCard>
    )
  }

  return (
    <SectionCard
      title={t('providers.add.title')}
      description={t('providers.add.hint')}
      className="mb-5"
      actions={!open && (
        <Button size="sm" className="h-8 rounded-md bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]" onPress={() => { void openWizard() }}>
          <Plus className="size-4" />
          {t('providers.add.action')}
        </Button>
      )}
    >
      {templateSaveFailed && (
        <ErrorBanner
          message={t('providers.add.template_partial')}
          action={<Button size="sm" variant="outline" className="h-7 rounded-md" isDisabled={save.pending} onPress={retryTemplateSave}>{t('providers.add.retry_template')}</Button>}
        />
      )}

      {open && (
        <div className="mt-4 max-h-[52vh] space-y-4 overflow-y-auto pr-1">
          {catalogError !== '' && <ErrorBanner message={t('providers.add.catalog_unavailable')} detail={catalogError} />}
          {catalog !== null && catalog.length === 0 && catalogError === '' && <p className="m-0 text-xs text-[var(--launcher-muted)]">{t('providers.add.catalog_empty')}</p>}

          <Field label={t('providers.add.route')} labelFor="provider-add-route">
            <select
              id="provider-add-route"
              className="h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-2 text-sm"
              value={draft.id}
              disabled={save.pending}
              onChange={(event) => { void chooseRoute(event.target.value) }}
            >
              <option value="">{t('providers.add.route_placeholder')}</option>
              {(catalog ?? []).map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  （
                  {item.modelCount}
                  ）
                  {item.configurable ? '' : ` · ${t(`providers.add.limitation.${item.limitation}`)}`}
                </option>
              ))}
            </select>
          </Field>

          {chosen && !writable && (
            <StatusNotice message={t(`providers.add.limitation.${chosen.limitation}`)} />
          )}

          {chosen && writable && (
            <>
              <StatusNotice tone="neutral" message={t('providers.add.inheriting')} />
              <Field label={t('providers.add.display_name')} labelFor="provider-add-name">
                <input
                  id="provider-add-name"
                  className="h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3 text-sm"
                  value={draft.name}
                  onChange={event => rename(event.target.value)}
                />
              </Field>

              <Field label={t('providers.add.api_key')} hint={t('providers.add.api_key_hint')} labelFor="provider-add-key">
                <input
                  id="provider-add-key"
                  type="password"
                  autoComplete="new-password"
                  className="h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3 text-sm font-mono"
                  value={apiKey}
                  onChange={event => enterKey(event.target.value)}
                />
              </Field>

              <div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="provider-model-selection" className="accent-[var(--launcher-brand)]" checked={draft.selection === 'all'} onChange={followCatalog} />
                    {t('providers.add.follow_catalog', { count: chosen.modelCount })}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="provider-model-selection"
                      className="accent-[var(--launcher-brand)]"
                      checked={draft.selection === 'subset'}
                      onChange={chooseSubset}
                    />
                    {t('providers.add.pick_subset', { count: draft.models.length })}
                  </label>
                </div>
                {draft.selection === 'subset' && (
                  <p className="m-0 mt-1 text-xs text-[var(--launcher-muted)]">{t('providers.add.subset_warning')}</p>
                )}
              </div>

              {draft.selection === 'subset' && (
                <div className="rounded-md border border-[var(--launcher-border)]">
                  {modelsError !== '' && <ErrorBanner className="m-2" message={t('providers.add.models_failed')} detail={modelsError} />}
                  {models === null && modelsError === '' && <p role="status" className="m-0 p-3 text-xs text-[var(--launcher-muted)]">{t('launcher.processing')}</p>}
                  {models !== null && (
                    <>
                      <div className="p-2">
                        <SearchInput label={t('providers.add.search_models')} value={modelQuery} onChange={searchModels} />
                      </div>
                      <div className="max-h-64 overflow-y-auto border-t border-[var(--launcher-border)]">
                        {modelSlice.map(model => (
                          <label key={model.id} className="flex items-start gap-2 border-b border-[var(--launcher-border)] px-3 py-2 text-sm last:border-b-0">
                            <input
                              type="checkbox"
                              className="mt-1 size-4 accent-[var(--launcher-brand)]"
                              checked={draft.models.some(item => item.id === model.id)}
                              onChange={event => toggleModel(model, event.target.checked)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block min-w-0 break-all font-mono text-xs">{model.id}</span>
                              <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--launcher-muted)]">
                                <StatusBadge tone={model.protocolSupported ? 'neutral' : 'danger'}>{model.api}</StatusBadge>
                                {model.contextWindow > 0 && <span className="tabular-nums">{model.contextWindow}</span>}
                                {model.reasoning && <StatusBadge tone="accent">{t('providers.add.reasoning')}</StatusBadge>}
                                {model.input.some(item => item !== 'text') && <StatusBadge tone="neutral">{model.input.filter(item => item !== 'text').join(', ')}</StatusBadge>}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                      {modelPages > 1 && (
                        <div className="flex items-center justify-between gap-2 border-t border-[var(--launcher-border)] px-3 py-2 text-xs text-[var(--launcher-muted)]">
                          <span className="tabular-nums">{t('providers.add.models_page', { current: Math.min(modelPage, modelPages), total: modelPages, count: filteredModels.length })}</span>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-7 rounded-md" isDisabled={modelPage <= 1} onPress={() => setModelPage(page => page - 1)}>{t('download.page_previous')}</Button>
                            <Button size="sm" variant="ghost" className="h-7 rounded-md" isDisabled={modelPage >= modelPages} onPress={() => setModelPage(page => page + 1)}>{t('download.page_next')}</Button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1 size-4 accent-[var(--launcher-brand)]" checked={alsoTemplate} onChange={event => setAlsoTemplate(event.target.checked)} disabled={save.pending} />
                <span>
                  <span className="block">{t('providers.add.also_template')}</span>
                  <span className="mt-0.5 block text-xs text-[var(--launcher-muted)]">{t('providers.add.also_template_hint')}</span>
                </span>
              </label>

              <div className="rounded-md border border-[var(--launcher-border)] px-3 py-2">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-[var(--launcher-brand)]"
                    checked={useDefaultModel}
                    disabled={save.pending || (models ?? []).length === 0}
                    onChange={(event) => {
                      setPreview(null)
                      setUseDefaultModel(event.target.checked)
                      if (!event.target.checked)
                        setDefaultModelId('')
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block">{t('providers.add.set_default')}</span>
                    <span className="mt-0.5 block text-xs text-[var(--launcher-muted)]">{t('providers.add.set_default_hint')}</span>
                  </span>
                </label>
                {useDefaultModel && (
                  <select
                    className="mt-2 h-9 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-2 text-sm"
                    value={defaultModelId}
                    disabled={save.pending}
                    onChange={(event) => {
                      setPreview(null)
                      setTestResult(null)
                      setDefaultModelId(event.target.value)
                    }}
                  >
                    <option value="">{t('providers.add.pick_default')}</option>
                    {(draft.selection === 'subset' ? draft.models : (models ?? []).map(item => ({ id: item.id } as ProviderModel))).map(item => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-md"
                  isDisabled={testCandidate === null || save.pending || testing}
                  onPress={() => { void testConnection() }}
                >
                  {t(testing ? 'launcher.processing' : 'providers.add.test')}
                </Button>
                {testCandidate === null
                  ? (
                      <span className="min-w-0 flex-1 text-xs text-[var(--launcher-muted)]">{t('providers.add.test_unsupported')}</span>
                    )
                  : (
                      <span className="min-w-0 flex-1 text-xs text-[var(--launcher-muted)]">{t('providers.add.test_hint')}</span>
                    )}
                {testResult !== null && (
                  <span role="status" className={`min-w-0 flex-1 text-xs break-words ${testStale ? 'text-[var(--launcher-muted)]' : testResult.ok ? 'text-[var(--launcher-brand-strong)]' : 'text-danger'}`}>
                    {testStale
                      ? t('providers.add.test_stale', { model: testResult.modelId })
                      : t('providers.add.test_result', { model: testResult.modelId, time: testResult.time, message: testResult.message })}
                  </span>
                )}
              </div>

              <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--launcher-border)] bg-[var(--launcher-surface)] py-3">
                <Button size="sm" variant="outline" className="h-8 rounded-md" isDisabled={!ready || save.pending} onPress={() => { void previewChanges() }}>{t('providers.preview')}</Button>
                <Button size="sm" variant="ghost" className="h-8 rounded-md" isDisabled={save.pending} onPress={() => setOpen(false)}>{t('launcher.cancel')}</Button>
              </div>
            </>
          )}

          {failure !== '' && <ErrorBanner message={t('providers.add.failed')} detail={failure} />}
        </div>
      )}
    </SectionCard>
  )
}
