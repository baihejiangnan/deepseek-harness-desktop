import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@/utils'
import { providerErrorMessage } from '@/utils/provider-error'

export interface ProviderModel { id: string, name?: string, contextWindow?: number, maxTokens?: number }

export default function ProviderModels({ models, onChange, baseUrl, protocol, apiKey, savedId, disabled, onBusy }: {
  models: ProviderModel[]
  onChange: (models: ProviderModel[]) => void
  baseUrl: string
  protocol: string
  apiKey: string
  savedId?: string
  disabled: boolean
  onBusy: (busy: boolean) => void
}) {
  const { t } = useTranslation()
  const [available, setAvailable] = useState<ProviderModel[]>([])
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')
  const [manualOpen, setManualOpen] = useState(models.length === 0)
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [testModel, setTestModel] = useState('')
  const [message, setMessage] = useState<{ key: string, count?: number, model?: string, ms?: number } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState('')
  const [testedInput, setTestedInput] = useState({ baseUrl, protocol, apiKey, savedId })
  const currentResult = testedInput.baseUrl === baseUrl && testedInput.protocol === protocol && testedInput.apiKey === apiKey && testedInput.savedId === savedId

  const selectedTest = models.some(model => model.id === testModel) ? testModel : models[0]?.id ?? ''
  const selectedIds = new Set(models.map(model => model.id))
  const candidates = [...new Map([...models, ...(currentResult ? available : [])].map(model => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id))
  const filtered = candidates.filter(model => (!selectedOnly || selectedIds.has(model.id)) && `${model.id} ${model.name ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const ready = !!baseUrl.trim() && !!protocol && (!!apiKey || !!savedId)
  const inputClass = 'h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3 text-sm text-[var(--launcher-ink)] outline-none transition-colors focus:border-[var(--launcher-brand)] focus:ring-2 focus:ring-[var(--launcher-selected)] disabled:opacity-60 motion-reduce:transition-none'

  async function probe(operation: 'models' | 'test') {
    if (disabled || pending || !ready)
      return
    setPending(operation)
    if (!currentResult)
      setAvailable([])
    setTestedInput({ baseUrl, protocol, apiKey, savedId })
    onBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await invoke<{ models: ProviderModel[], elapsedMs: number }>('probe_provider_template', {
        baseUrl: baseUrl.trim(),
        protocol,
        apiKey: apiKey || null,
        savedId: savedId ?? null,
        operation,
        modelId: selectedTest || null,
      })
      if (operation === 'models') {
        setAvailable(result.models)
        setSelectedOnly(false)
        setQuery('')
        setMessage({ key: result.models.length ? 'providers.models_fetched' : 'providers.models_empty', count: result.models.length })
      }
      else {
        setMessage({ key: 'providers.test_success', model: selectedTest, ms: result.elapsedMs })
        toast(t('providers.test_success', { model: selectedTest, ms: result.elapsedMs }), { placement: 'top', variant: 'accent' })
      }
    }
    catch (cause) {
      setError(cause)
      toast(providerErrorMessage(cause), { placement: 'top', variant: 'warning' })
    }
    finally {
      setPending('')
      onBusy(false)
    }
  }

  function addManual() {
    const ids = [...new Set(manual.split(/[\n,，]+/).map(id => id.trim()).filter(Boolean))]
    if (!ids.length)
      return
    if (!currentResult)
      setAvailable([])
    setTestedInput({ baseUrl, protocol, apiKey, savedId })
    if (ids.some(id => id.length > 512 || [...id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
      setError('PROVIDER_MODEL_INVALID')
      return
    }
    onChange([...models, ...ids.filter(id => !models.some(model => model.id === id)).map(id => ({ id }))])
    setManual('')
    setQuery('')
    setError(null)
  }

  return (
    <div className="col-span-full min-w-0 space-y-3 border-t border-[var(--launcher-border)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">{t('providers.models_selected', { count: models.length })}</strong>
        <Button type="button" variant="outline" isDisabled={disabled || !ready} onPress={() => { void probe('models') }}>{t(pending === 'models' ? 'launcher.processing' : 'providers.fetch_models')}</Button>
      </div>
      <p className="m-0 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.models_hint')}</p>
      {pending && <p role="status" className="text-sm">{t('providers.probing')}</p>}
      {currentResult && error != null && <p role="alert" className="rounded-md border border-danger/25 bg-danger/5 p-3 break-words text-sm text-danger">{providerErrorMessage(error)}</p>}
      {currentResult && message && <p role="status" className="rounded-md bg-[var(--launcher-selected)] px-3 py-2 text-xs leading-5 text-[var(--launcher-brand-strong)]">{t(message.key, { count: message.count, model: message.model, ms: message.ms })}</p>}
      {candidates.length > 0 && (
        <>
          <input
            aria-label={t('providers.search_models')}
            placeholder={t('providers.search_models')}
            type="search"
            className={inputClass}
            value={query}
            onKeyDown={(event) => {
              if (event.key === 'Enter')
                event.preventDefault()
            }}
            onChange={event => setQuery(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-[var(--launcher-muted)]">
              <input type="checkbox" className="size-4 accent-[var(--launcher-brand)]" checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)} />
              {t('providers.selected_only')}
            </label>
            <Button type="button" size="sm" variant="ghost" isDisabled={disabled || !filtered.some(model => !selectedIds.has(model.id))} onPress={() => onChange([...models, ...filtered.filter(item => !selectedIds.has(item.id))])}>{t('providers.select_results')}</Button>
            <Button type="button" size="sm" variant="ghost" isDisabled={disabled || !models.length} onPress={() => onChange([])}>{t('providers.clear_models')}</Button>
          </div>
          <div className="max-h-52 overflow-y-auto rounded-md border border-[var(--launcher-border)] p-2">
            {!filtered.length && <p className="text-sm">{t('providers.no_results')}</p>}
            {filtered.map(model => (
              <label key={model.id} className={`flex min-w-0 cursor-pointer items-start gap-3 rounded px-3 py-2 text-sm transition-colors hover:bg-[var(--launcher-selected)] motion-reduce:transition-none ${selectedIds.has(model.id) ? 'bg-[var(--launcher-selected)]' : ''}`}>
                <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--launcher-brand)]" checked={selectedIds.has(model.id)} onChange={event => onChange(event.target.checked ? [...models, model] : models.filter(item => item.id !== model.id))} />
                <span className="min-w-0 break-all">
                  {model.id}
                  {model.name && model.name !== model.id ? ` · ${model.name}` : ''}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      {!candidates.length && <p className="rounded-md border border-dashed border-[var(--launcher-border)] p-5 text-center text-sm leading-6 text-[var(--launcher-muted)]">{t('providers.catalog_empty')}</p>}
      <Button type="button" variant="ghost" isDisabled={disabled} aria-expanded={manualOpen} onPress={() => setManualOpen(!manualOpen)}>{t(manualOpen ? 'providers.hide_manual' : 'providers.show_manual')}</Button>
      {manualOpen && (
        <div className="space-y-2">
          <label className="block text-sm">
            {t('providers.manual_models')}
            <textarea rows={2} className={`${inputClass} mt-1 h-auto py-2`} value={manual} onChange={event => setManual(event.target.value)} />
          </label>
          <Button type="button" variant="outline" isDisabled={disabled || !manual.trim()} onPress={addManual}>{t('providers.add_models')}</Button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2 border-t border-[var(--launcher-border)] pt-3">
        <label className="min-w-0 flex-1 text-sm">
          {t('providers.test_model')}
          <select className={`${inputClass} mt-1`} value={selectedTest} onChange={event => setTestModel(event.target.value)}>
            {!models.length && <option value="">{t('providers.select_model_first')}</option>}
            {models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" isDisabled={disabled || !ready || !selectedTest} onPress={() => { void probe('test') }}>{t(pending === 'test' ? 'launcher.processing' : 'providers.test_connection')}</Button>
        <p className="m-0 w-full text-xs text-[var(--launcher-muted)]">{t('providers.test_hint')}</p>
      </div>
    </div>
  )
}
