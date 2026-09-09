import type { ReactNode } from 'react'
import type { CatalogModel, CatalogProvider, CredentialMode, InstanceProviderView, PlanResponse, ProviderModelView, ProviderRouteView } from './provider-contracts'
import type { ProviderTemplate } from './provider-templates'
import { ChevronDown } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { providerErrorMessage } from '@/utils/provider-error'
import { useSaveStatus } from '@/utils/save-status'
import { ErrorBanner, Field, SearchInput, StatusBadge, StatusNotice, TextInput } from './launcher-ui'
import ProviderPlanView from './provider-plan-view'

const MODEL_PAGE_SIZE = 30

/** 默认模型的三种意图。不勾选不等于"清除"，因此三态都显式给出。 */
type DefaultAction = 'keep' | 'set' | 'clear'

/** 填过调整值的条目才算"有内容"：模式切换时只搬这些，不凭空造出一整份清单。 */
function hasTuning(entry: ProviderModelView) {
  return entry.contextWindow !== undefined || entry.maxTokens !== undefined || (entry.name !== undefined && entry.name !== '')
}

/** 可折叠的一层。高级字段不铺成超长表单，默认只展开基础配置。 */
function Layer(props: { title: string, description?: string, badge?: ReactNode, defaultOpen?: boolean, children: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  const panelId = useId()
  return (
    <section className="rounded-md border border-[var(--launcher-border)]">
      <h4 className="m-0 text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left transition-colors motion-reduce:transition-none hover:bg-[var(--launcher-selected)]"
          onClick={() => setOpen(value => !value)}
        >
          <ChevronDown aria-hidden="true" className={`mt-0.5 size-4 flex-none transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`} />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{props.title}</span>
            {props.description && <span className="mt-0.5 block text-xs leading-5 font-normal text-[var(--launcher-muted)]">{props.description}</span>}
          </span>
          {props.badge && <span className="mt-0.5 flex-none">{props.badge}</span>}
        </button>
      </h4>
      {open && <div id={panelId} className="space-y-4 border-t border-[var(--launcher-border)] p-3">{props.children}</div>}
    </section>
  )
}

/** 单个数值调整项。占位符是目录观测到的默认值，留空即不写、继续继承。 */
function NumberOption(props: { label: string, value?: number, fallback?: number, disabled: boolean, onChange: (value?: number) => void }) {
  return (
    <label className="min-w-0 flex-1 text-xs text-[var(--launcher-muted)]">
      {props.label}
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        className="mt-1 h-9 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-2 text-sm tabular-nums disabled:opacity-60"
        value={props.value ?? ''}
        placeholder={props.fallback !== undefined && props.fallback > 0 ? String(props.fallback) : undefined}
        disabled={props.disabled}
        onChange={(event) => {
          const raw = event.target.value.trim()
          if (raw === '') {
            props.onChange(undefined)
            return
          }
          const parsed = Number(raw)
          // 只接受正整数：写进 settings 的必须是 DSH 认得的形状，不能是 0 或 NaN。
          if (Number.isFinite(parsed) && parsed > 0)
            props.onChange(Math.floor(parsed))
        }}
      />
    </label>
  )
}

/**
 * 实例内编辑一条已存在的服务商路由（方案 §2.5）。
 *
 * 只有确认命中当前运行时目录、且门禁判定可配置的路由才允许写入：来源未确认的路由
 * 无法核对模型，写进去 DSH 也不校验，只能只读展示与移除。
 */
export default function ProviderEdit(props: {
  instanceId: string
  route: ProviderRouteView
  provider: CatalogProvider | undefined
  supportedProtocols: string[]
  view: InstanceProviderView
  disabled: boolean
  onApplied: () => void
  onClose: () => void
}) {
  const { instanceId, route, provider, supportedProtocols, view, disabled, onApplied, onClose } = props
  const { t } = useTranslation()
  const save = useSaveStatus({ holdMs: 0 })
  const formId = useId()

  const [name, setName] = useState(route.displayName || provider?.name || route.id)
  const [baseUrl, setBaseUrl] = useState(route.baseUrl)
  const [protocol, setProtocol] = useState(route.protocol)
  const [selection, setSelection] = useState<'all' | 'subset'>(route.selection)
  const [models, setModels] = useState<ProviderModelView[]>(route.models)
  const [overrides, setOverrides] = useState<ProviderModelView[]>(route.overrides)
  // 已声明引用的默认意图是"不动它"；本来就没有引用时只能是不使用密钥。
  const [credentialMode, setCredentialMode] = useState<CredentialMode>(route.credential.declared ? 'keep' : 'none')
  const [apiKey, setApiKey] = useState('')
  const [defaultAction, setDefaultAction] = useState<DefaultAction>('keep')
  const [defaultModelId, setDefaultModelId] = useState(view.defaultModel.provider === route.id ? view.defaultModel.model : '')
  const [defaultEffort, setDefaultEffort] = useState(view.defaultModel.provider === route.id ? view.defaultModel.reasoningEffort : '')

  const [catalogModels, setCatalogModels] = useState<CatalogModel[] | null>(null)
  const [modelsError, setModelsError] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const [modelPage, setModelPage] = useState(1)
  const [preview, setPreview] = useState<PlanResponse | null>(null)
  const [failure, setFailure] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean, message: string, modelId: string, signature: string, time: string } | null>(null)

  const editable = provider !== undefined && provider.configurable

  useEffect(() => {
    if (!editable)
      return
    let cancelled = false
    void invoke<{ models: CatalogModel[] }>('get_runtime_catalog_models', { providerId: route.id })
      .then((result) => {
        if (!cancelled) {
          setCatalogModels(result.models)
          setModelsError('')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCatalogModels([])
          setModelsError(providerErrorMessage(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [editable, route.id])

  const catalogById = new Map((catalogModels ?? []).map(item => [item.id, item]))
  // 当前模式下承载调整值的那一份清单：subset 写进 models，all 写进 modelOverrides。
  const tuning = selection === 'subset' ? models : overrides
  const setTuning = selection === 'subset' ? setModels : setOverrides

  const filtered = (catalogModels ?? []).filter(item => item.id.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()))
  const pages = Math.max(1, Math.ceil(filtered.length / MODEL_PAGE_SIZE))
  const page = Math.min(modelPage, pages)
  const slice = filtered.slice((page - 1) * MODEL_PAGE_SIZE, page * MODEL_PAGE_SIZE)

  // 协议下拉只列这条路由的模型实际观测到的取值：运行时说得出、目录里也真的有人用。
  const observedProtocols = [...new Set((catalogModels ?? []).map(item => item.api).filter(Boolean))].filter(item => supportedProtocols.includes(item))

  /** 任何改动都让旧预览失效，避免"预览的是 A、应用的却是 B"。 */
  function touch<T>(setter: (value: T) => void, value: T) {
    setPreview(null)
    setter(value)
  }

  function toggleModel(model: CatalogModel, checked: boolean) {
    setPreview(null)
    setTuning(checked ? [...tuning, { id: model.id }] : tuning.filter(item => item.id !== model.id))
  }

  function tuneEntry(id: string, patch: Partial<ProviderModelView>) {
    setPreview(null)
    setTuning(tuning.map((item) => {
      if (item.id !== id)
        return item
      const next: ProviderModelView = { ...item, ...patch }
      // 清空的键必须真的删掉，否则会把 undefined 当成"已声明"带进模板再落到 YAML 里。
      for (const key of ['name', 'contextWindow', 'maxTokens'] as const) {
        if (key in patch && next[key] === undefined)
          delete next[key]
      }
      return next
    }))
  }

  function switchSelection(next: 'all' | 'subset') {
    if (next === selection)
      return
    setPreview(null)
    // 两种模式的字段互斥：只把已经填过的调整值搬过去，剩下的交给目录。
    // 旧字段会被删除，这一点由预览如实展示，不在界面上偷偷迁移。
    const carried = tuning.filter(hasTuning).map(item => ({ ...item }))
    if (next === 'all') {
      setOverrides(carried)
      setModels([])
    }
    else {
      setModels(carried.length > 0 ? carried : [])
      setOverrides([])
    }
    setSelection(next)
  }

  function resetTuning(id: string) {
    tuneEntry(id, { contextWindow: undefined, maxTokens: undefined, name: undefined })
  }

  const buildTemplate = (): ProviderTemplate => ({
    // route id 写入实例后不可变；模板库也按同一个 key 定位，所以这里没有可改的余地。
    id: route.id,
    name,
    baseUrl,
    protocol,
    modelId: '',
    models: selection === 'subset' ? models : [],
    modelOverrides: selection === 'all' ? overrides : [],
    selection,
    defaultForNew: false,
    kind: 'catalog',
  })

  const defaultModel = defaultAction === 'set'
    ? { provider: route.id, model: defaultModelId, reasoningEffort: defaultEffort === '' ? undefined : defaultEffort }
    : defaultAction === 'clear'
      ? 'clear'
      : null

  // 已声明清单里、但当前运行时的目录认不出的模型：保存必然被拒，先说清楚。
  const unknownModels = catalogModels === null ? [] : tuning.map(item => item.id).filter(id => !catalogById.has(id))
  // 默认模型指向本路由、却不在即将声明的清单里：DSH 对这一段不校验，只能由这里提示。
  const orphanedDefault = view.defaultModel.declared
    && view.defaultModel.provider === route.id
    && defaultAction !== 'set'
    && selection === 'subset'
    && !models.some(item => item.id === view.defaultModel.model)
  const chosenDefaultModel = catalogById.get(defaultModelId)
  const efforts = chosenDefaultModel?.reasoningEfforts ?? []

  /**
   * 可选的连接测试：只测"运行时支持 ∩ 探测器已实现 ∩ 这份配置表达得出"的组合。
   * 保留现有密钥时启动器手里没有那个值（凭据只写不读），因此那一态测不了——如实说明，不假装测过。
   */
  const effectiveBaseUrl = baseUrl !== '' ? baseUrl : (provider?.baseUrl ?? '')
  const testModelId = (defaultAction === 'set' && defaultModelId !== '' ? defaultModelId : tuning[0]?.id)
    || (catalogModels ?? []).find(item => item.protocolSupported)?.id
    || ''
  const testModel = catalogById.get(testModelId)
  const testCandidate = credentialMode === 'replace' && apiKey.trim() !== '' && effectiveBaseUrl !== '' && testModel !== undefined && testModel.protocolSupported
    ? { modelId: testModel.id, baseUrl: effectiveBaseUrl, protocol: protocol !== '' ? protocol : testModel.api }
    : null
  const testSignature = testCandidate === null ? '' : `${testCandidate.baseUrl}|${testCandidate.protocol}|${testCandidate.modelId}|${apiKey}`
  const testStale = testResult !== null && testResult.signature !== testSignature

  async function testConnection() {
    if (testCandidate === null)
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

  const problems: string[] = []
  if (name.trim() === '')
    problems.push(t('providers.edit.need_name'))
  if (selection === 'subset' && models.length === 0)
    problems.push(t('providers.edit.need_models'))
  if (credentialMode === 'replace' && apiKey.trim() === '')
    problems.push(t('providers.edit.need_key'))
  if (defaultAction === 'set' && defaultModelId === '')
    problems.push(t('providers.edit.need_default_model'))
  if (defaultAction === 'set' && defaultEffort !== '' && !efforts.includes(defaultEffort))
    problems.push(t('providers.edit.need_default_effort'))
  if (unknownModels.length > 0)
    problems.push(t('providers.edit.unknown_models', { models: unknownModels.join(', ') }))

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
      // 三态显式声明：后端据此决定保留、替换还是摘除引用，不再从"密钥是否为空"反推意图。
      drafts: [{ template: buildTemplate(), apiKey: credentialMode === 'replace' ? apiKey : null, credentialMode }],
      routeIdsToRemove: [],
      defaultModel,
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
        onApplied()
        onClose()
      },
    )
  }

  if (provider === undefined) {
    return (
      <div className="space-y-3">
        <StatusNotice tone="neutral" message={t('providers.edit.source_unconfirmed')} />
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" className="h-8 rounded-md" onPress={onClose}>{t('launcher.close')}</Button>
        </div>
      </div>
    )
  }

  if (!provider.configurable) {
    return (
      <div className="space-y-3">
        <StatusNotice message={t(`providers.add.limitation.${provider.limitation}`)} />
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" className="h-8 rounded-md" onPress={onClose}>{t('launcher.close')}</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {disabled && <StatusNotice message={t('launcher.instance_providers.running_readonly')} />}
      {route.unknownFields.length > 0 && (
        <StatusNotice tone="neutral" message={t('launcher.instance_providers.foreign_fields', { fields: route.unknownFields.join(', ') })} />
      )}
      {modelsError !== '' && <ErrorBanner message={t('providers.add.models_failed')} detail={modelsError} />}

      <Layer title={t('providers.edit.layer_basic')} description={t('providers.edit.layer_basic_hint')} defaultOpen>
        <Field label={t('providers.edit.route_id')} labelFor={`${formId}-route`} hint={t('providers.edit.route_id_hint')}>
          <TextInput id={`${formId}-route`} value={route.id} disabled mono />
        </Field>

        <Field
          label={t('providers.add.display_name')}
          labelFor={`${formId}-name`}
          required
          error={name.trim() === '' ? t('providers.edit.need_name') : undefined}
        >
          <TextInput id={`${formId}-name`} value={name} disabled={disabled || save.pending} onChange={value => touch(setName, value)} />
        </Field>

        <Field
          label={t('providers.edit.endpoint')}
          labelFor={`${formId}-base-url`}
          hint={provider.baseUrl === '' ? t('providers.edit.endpoint_no_default') : t('providers.edit.inherited_value', { value: provider.baseUrl })}
        >
          <div className="flex items-center gap-2">
            <TextInput
              id={`${formId}-base-url`}
              value={baseUrl}
              mono
              placeholder={provider.baseUrl}
              disabled={disabled || save.pending}
              onChange={value => touch(setBaseUrl, value.trim())}
            />
            {baseUrl !== '' && (
              <Button size="sm" variant="outline" className="h-10 flex-none rounded-md" isDisabled={disabled || save.pending} onPress={() => touch(setBaseUrl, '')}>
                {t('providers.edit.restore_default')}
              </Button>
            )}
          </div>
        </Field>

        <Field
          label={t('providers.edit.protocol')}
          labelFor={`${formId}-protocol`}
          hint={route.protocol === ''
            ? t('providers.edit.protocol_inherited', { value: observedProtocols.join(', ') || t('providers.edit.protocol_unobserved') })
            : t('providers.edit.protocol_pinned')}
        >
          <div className="flex items-center gap-2">
            <select
              id={`${formId}-protocol`}
              className="h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-2 text-sm disabled:opacity-60"
              value={protocol}
              disabled={disabled || save.pending}
              onChange={event => touch(setProtocol, event.target.value)}
            >
              <option value="">{t('providers.edit.protocol_follow')}</option>
              {observedProtocols.map(item => <option key={item} value={item}>{item}</option>)}
              {/* 已钉死但当前目录里没人用的协议：保留为可见选项，否则下拉会显示成空白。 */}
              {protocol !== '' && !observedProtocols.includes(protocol) && <option value={protocol}>{protocol}</option>}
            </select>
            {protocol !== '' && (
              <Button size="sm" variant="outline" className="h-10 flex-none rounded-md" isDisabled={disabled || save.pending} onPress={() => touch(setProtocol, '')}>
                {t('providers.edit.restore_default')}
              </Button>
            )}
          </div>
        </Field>

        <fieldset className="m-0 min-w-0 border-0 p-0" disabled={disabled || save.pending}>
          <legend className="mb-1.5 text-xs font-medium">{t('providers.edit.credential')}</legend>
          <div className="space-y-2">
            {(['keep', 'replace', 'none'] as CredentialMode[]).map((mode) => {
              const unavailable = mode === 'keep' && !route.credential.declared
              return (
                <label key={mode} className={`flex items-start gap-2 text-sm ${unavailable ? 'opacity-60' : ''}`}>
                  <input
                    type="radio"
                    name={`${formId}-credential`}
                    className="mt-1 size-4 flex-none accent-[var(--launcher-brand)]"
                    checked={credentialMode === mode}
                    disabled={unavailable}
                    onChange={() => {
                      setPreview(null)
                      setCredentialMode(mode)
                      if (mode !== 'replace')
                        setApiKey('')
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block">{t(`providers.edit.credential_mode.${mode}`)}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--launcher-muted)]">
                      {t(`providers.edit.credential_mode.${mode}_hint`, { ref: route.credential.ref })}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          {credentialMode === 'replace' && (
            <div className="mt-3 max-w-[420px]">
              <TextInput
                id={`${formId}-key`}
                type="password"
                autoComplete="new-password"
                mono
                value={apiKey}
                invalid={apiKey.trim() === ''}
                disabled={disabled || save.pending}
                onChange={(value) => {
                  setPreview(null)
                  setApiKey(value)
                }}
              />
              <p className="m-0 mt-1.5 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.edit.credential_replace_hint_detail', { ref: route.credential.ref })}</p>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              className="h-8 flex-none rounded-md"
              isDisabled={testCandidate === null || testing}
              onPress={() => { void testConnection() }}
            >
              {t(testing ? 'launcher.processing' : 'providers.add.test')}
            </Button>
            <span className="min-w-0 flex-1 text-xs leading-5 text-[var(--launcher-muted)]">
              {testCandidate === null ? t('providers.edit.test_unavailable') : t('providers.add.test_hint')}
            </span>
            {testResult !== null && (
              <span role="status" className={`min-w-0 flex-1 text-xs break-words ${testStale ? 'text-[var(--launcher-muted)]' : testResult.ok ? 'text-[var(--launcher-brand-strong)]' : 'text-danger'}`}>
                {testStale
                  ? t('providers.add.test_stale', { model: testResult.modelId })
                  : t('providers.add.test_result', { model: testResult.modelId, time: testResult.time, message: testResult.message })}
              </span>
            )}
          </div>
        </fieldset>
      </Layer>

      <Layer
        title={t('providers.edit.layer_models')}
        description={t('providers.edit.layer_models_hint')}
        badge={<StatusBadge tone="neutral">{selection === 'subset' ? t('providers.edit.selection_subset', { count: models.length }) : t('providers.edit.selection_all', { count: provider.modelCount })}</StatusBadge>}
      >
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${formId}-selection`}
              className="accent-[var(--launcher-brand)]"
              checked={selection === 'all'}
              disabled={disabled || save.pending}
              onChange={() => switchSelection('all')}
            />
            {t('providers.add.follow_catalog', { count: provider.modelCount })}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${formId}-selection`}
              className="accent-[var(--launcher-brand)]"
              checked={selection === 'subset'}
              disabled={disabled || save.pending}
              onChange={() => switchSelection('subset')}
            />
            {t('providers.add.pick_subset', { count: models.length })}
          </label>
        </div>
        <p className="m-0 text-xs leading-5 text-[var(--launcher-muted)]">
          {selection === 'subset' ? t('providers.add.subset_warning') : t('providers.edit.all_mode_hint')}
        </p>
        <p className="m-0 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.edit.manual_models_unavailable')}</p>

        {catalogModels === null && modelsError === '' && (
          <p role="status" className="m-0 text-xs text-[var(--launcher-muted)]">{t('launcher.processing')}</p>
        )}
        {catalogModels !== null && (
          <div className="rounded-md border border-[var(--launcher-border)]">
            <div className="p-2">
              <SearchInput
                label={t('providers.add.search_models')}
                value={modelQuery}
                disabled={disabled || save.pending}
                onChange={(value) => {
                  setModelQuery(value)
                  // 换搜索词就回到第一页，否则会停在越界页码上看到空列表。
                  setModelPage(1)
                }}
              />
            </div>
            <div className="max-h-64 overflow-y-auto border-t border-[var(--launcher-border)]">
              {slice.length === 0 && <p className="m-0 p-3 text-xs text-[var(--launcher-muted)]">{t('providers.no_results')}</p>}
              {slice.map(model => (
                <label key={model.id} className="flex items-start gap-2 border-b border-[var(--launcher-border)] px-3 py-2 text-sm last:border-b-0">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 flex-none accent-[var(--launcher-brand)]"
                    checked={tuning.some(item => item.id === model.id)}
                    disabled={disabled || save.pending}
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
            {pages > 1 && (
              <div className="flex items-center justify-between gap-2 border-t border-[var(--launcher-border)] px-3 py-2 text-xs text-[var(--launcher-muted)]">
                <span className="tabular-nums">{t('providers.add.models_page', { current: page, total: pages, count: filtered.length })}</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" className="h-7 rounded-md" isDisabled={page <= 1} onPress={() => setModelPage(value => value - 1)}>{t('download.page_previous')}</Button>
                  <Button size="sm" variant="ghost" className="h-7 rounded-md" isDisabled={page >= pages} onPress={() => setModelPage(value => value + 1)}>{t('download.page_next')}</Button>
                </div>
              </div>
            )}
          </div>
        )}

        {orphanedDefault && (
          <StatusNotice message={t('providers.edit.orphaned_default', { model: view.defaultModel.model })} />
        )}
      </Layer>

      <Layer
        title={t('providers.edit.layer_tuning')}
        description={t('providers.edit.layer_tuning_hint')}
        badge={tuning.some(hasTuning) ? <StatusBadge tone="accent">{t('providers.edit.tuned_count', { count: tuning.filter(hasTuning).length })}</StatusBadge> : undefined}
      >
        {tuning.length === 0 && <p className="m-0 text-xs text-[var(--launcher-muted)]">{t('providers.edit.tuning_empty')}</p>}
        <ul className="m-0 list-none space-y-3 p-0">
          {tuning.map((entry) => {
            const catalogEntry = catalogById.get(entry.id)
            return (
              <li key={entry.id} className="rounded-md border border-[var(--launcher-border)] px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-all font-mono text-xs">{entry.id}</span>
                  <div className="flex flex-none items-center gap-2">
                    {catalogEntry === undefined && <StatusBadge tone="danger">{t('providers.edit.not_in_catalog')}</StatusBadge>}
                    {hasTuning(entry) && (
                      <Button size="sm" variant="ghost" className="h-7 rounded-md" isDisabled={disabled || save.pending} onPress={() => resetTuning(entry.id)}>
                        {t('providers.edit.restore_default')}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-3">
                  <NumberOption
                    label={t('providers.edit.context_window')}
                    value={entry.contextWindow}
                    fallback={catalogEntry?.contextWindow}
                    disabled={disabled || save.pending}
                    onChange={value => tuneEntry(entry.id, { contextWindow: value })}
                  />
                  <NumberOption
                    label={t('providers.edit.max_tokens')}
                    value={entry.maxTokens}
                    fallback={catalogEntry?.maxTokens}
                    disabled={disabled || save.pending}
                    onChange={value => tuneEntry(entry.id, { maxTokens: value })}
                  />
                </div>
              </li>
            )
          })}
        </ul>
        <p className="m-0 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.edit.tuning_limits')}</p>
      </Layer>

      <Layer
        title={t('providers.edit.layer_default')}
        description={t('providers.edit.layer_default_hint')}
        badge={view.defaultModel.declared
          ? <StatusBadge tone={view.defaultModel.provider === route.id ? 'accent' : 'neutral'}>{view.defaultModel.provider === route.id ? t('providers.edit.default_here', { model: view.defaultModel.model }) : t('providers.edit.default_elsewhere', { provider: view.defaultModel.provider })}</StatusBadge>
          : undefined}
      >
        <div className="space-y-2">
          {(['keep', 'set', 'clear'] as DefaultAction[]).map(action => (
            <label key={action} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${formId}-default`}
                className="mt-1 size-4 flex-none accent-[var(--launcher-brand)]"
                checked={defaultAction === action}
                disabled={disabled || save.pending || (action === 'clear' && !view.defaultModel.declared)}
                onChange={() => {
                  setPreview(null)
                  setDefaultAction(action)
                }}
              />
              <span className="min-w-0">
                <span className="block">{t(`providers.edit.default_action.${action}`)}</span>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--launcher-muted)]">{t(`providers.edit.default_action.${action}_hint`)}</span>
              </span>
            </label>
          ))}
        </div>

        {defaultAction === 'set' && (
          <div className="space-y-3">
            <Field
              label={t('providers.edit.default_model')}
              labelFor={`${formId}-default-model`}
              required
              error={defaultModelId === '' ? t('providers.edit.need_default_model') : undefined}
            >
              <select
                id={`${formId}-default-model`}
                className="h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-2 text-sm disabled:opacity-60"
                value={defaultModelId}
                disabled={disabled || save.pending}
                onChange={(event) => {
                  setPreview(null)
                  setDefaultModelId(event.target.value)
                  setDefaultEffort('')
                }}
              >
                <option value="">{t('providers.add.pick_default')}</option>
                {(selection === 'subset' ? models : (catalogModels ?? []).map(item => ({ id: item.id } as ProviderModelView))).map(item => (
                  <option key={item.id} value={item.id}>{item.id}</option>
                ))}
              </select>
            </Field>

            {/* 档位只列该模型实际观测到的取值：拿不到合法值就不做成自由文本。 */}
            {defaultModelId !== '' && (
              <Field
                label={t('providers.edit.default_effort')}
                labelFor={`${formId}-default-effort`}
                hint={efforts.length === 0 ? t('providers.edit.default_effort_unobserved') : t('providers.edit.default_effort_hint')}
              >
                {efforts.length === 0
                  ? <p className="m-0 text-xs text-[var(--launcher-muted)]">{t('providers.edit.default_effort_unobserved')}</p>
                  : (
                      <select
                        id={`${formId}-default-effort`}
                        className="h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-2 text-sm disabled:opacity-60"
                        value={defaultEffort}
                        disabled={disabled || save.pending}
                        onChange={event => touch(setDefaultEffort, event.target.value)}
                      >
                        <option value="">{t('providers.edit.default_effort_provider')}</option>
                        {efforts.map(item => <option key={item} value={item}>{item}</option>)}
                      </select>
                    )}
              </Field>
            )}
          </div>
        )}
      </Layer>

      {problems.length > 0 && (
        <ul className="m-0 list-disc space-y-1 rounded-md border border-[var(--launcher-border)] px-6 py-2.5 text-xs leading-5 text-[var(--launcher-muted)]">
          {problems.map(item => <li key={item} className="min-w-0 break-words">{item}</li>)}
        </ul>
      )}

      {preview !== null && (
        <ProviderPlanView preview={preview}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button size="sm" className="h-8 rounded-md bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]" isDisabled={disabled || save.pending} onPress={() => { void applyChanges() }}>
              {t(save.pending ? 'launcher.processing' : 'providers.apply')}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 rounded-md" isDisabled={save.pending} onPress={() => setPreview(null)}>{t('launcher.cancel')}</Button>
          </div>
        </ProviderPlanView>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {save.phase === 'saved' && preview === null && <span role="status" className="mr-auto text-xs text-[var(--launcher-brand-strong)]">{t('providers.applied')}</span>}
        <Button size="sm" variant="outline" className="h-8 rounded-md" isDisabled={!editable || disabled || save.pending || problems.length > 0 || preview !== null} onPress={() => { void previewChanges() }}>
          {t('providers.preview')}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 rounded-md" isDisabled={save.pending} onPress={onClose}>{t('launcher.cancel')}</Button>
      </div>

      {failure !== '' && <ErrorBanner message={t('providers.apply_failed')} detail={failure} />}
    </div>
  )
}
