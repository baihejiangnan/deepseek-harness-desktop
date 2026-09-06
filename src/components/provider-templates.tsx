import type { ProviderModel } from './provider-models'
import { ArrowLeft, ArrowRight, ArrowRotateRight, PencilToSquare, Plus, TrashBin } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { providerErrorMessage } from '@/utils/provider-error'
import ProviderModels from './provider-models'

export interface ProviderTemplate {
  id: string
  name: string
  baseUrl: string
  protocol: string
  modelId?: string
  models: ProviderModel[]
  defaultForNew: boolean
}

const empty: ProviderTemplate = { id: '', name: '', baseUrl: '', protocol: '', models: [], defaultForNew: false }
const modelsOf = (item: ProviderTemplate) => item.models?.length ? item.models : item.modelId ? [{ id: item.modelId }] : []

export default function ProviderTemplates() {
  const { t } = useTranslation()
  const [items, setItems] = useState<ProviderTemplate[]>([])
  const [protocols, setProtocols] = useState<string[]>([])
  const [draft, setDraft] = useState<ProviderTemplate>({ ...empty })
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  function openEditor(item?: ProviderTemplate) {
    setDraft(item ? { ...item, modelId: '', models: modelsOf(item) } : { ...empty })
    setEditing(!!item)
    setApiKey('')
    setNotice('')
    setError('')
    setRemovingId(null)
    setEditorOpen(true)
  }

  async function reload() {
    setBusy(true)
    setError('')
    try {
      const [saved, supported] = await Promise.allSettled([
        invoke<ProviderTemplate[]>('list_provider_templates'),
        invoke<string[]>('get_provider_protocols'),
      ])
      if (saved.status === 'fulfilled')
        setItems(saved.value)
      else setItems([])
      if (supported.status === 'fulfilled')
        setProtocols(supported.value)
      else setProtocols([])
      const failed = [saved, supported].find(result => result.status === 'rejected')
      if (failed?.status === 'rejected')
        setError(providerErrorMessage(failed.reason))
    }
    catch (cause) {
      setError(providerErrorMessage(cause))
    }
    finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  async function save() {
    if (busy)
      return
    if (!editing && items.some(item => item.id === draft.id)) {
      setError(t('providers.duplicate'))
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await invoke('save_provider_template', { template: { ...draft, baseUrl: draft.baseUrl.trim(), modelId: '' }, apiKey: apiKey || null, editing })
      setApiKey('')
      setDraft({ ...empty })
      setEditing(false)
      setEditorOpen(false)
      await reload()
      setNotice(t('providers.saved'))
    }
    catch (cause) {
      setError(providerErrorMessage(cause))
    }
    finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (busy || removingId !== id)
      return
    setBusy(true)
    setError('')
    try {
      await invoke('remove_provider_template', { id })
      setRemovingId(null)
      if (draft.id === id) {
        setDraft({ ...empty })
        setApiKey('')
        setEditing(false)
      }
      await reload()
      setNotice(t('providers.removed'))
    }
    catch (cause) {
      setError(providerErrorMessage(cause))
    }
    finally {
      setBusy(false)
    }
  }

  const inputClass = 'mt-1 h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3 text-[var(--launcher-ink)] outline-none transition-colors focus:border-[var(--launcher-brand)] focus:ring-2 focus:ring-[var(--launcher-selected)] disabled:opacity-60 motion-reduce:transition-none'
  const filteredItems = items.filter(item => `${item.name} ${item.id} ${item.baseUrl}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const pageSize = 6
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedItems = filteredItems.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  return (
    <section className="space-y-4 [&_button]:rounded-md [&_button]:text-sm [&_input]:scroll-mb-24 [&_select]:scroll-mb-24">
      {!editorOpen && (
        <div className="grid gap-3 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(230px,0.8fr)]">
          <p className="m-0 min-w-0 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.security_note')}</p>
          <p className="m-0 min-w-0 border-t border-[var(--launcher-border)] pt-3 text-xs leading-5 text-[var(--launcher-muted)] sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
            <span className="font-medium text-[var(--launcher-ink)]">{t('providers.scope_label')}</span>
            <span className="ml-2">{t('providers.supported_scope_short')}</span>
          </p>
        </div>
      )}
      {!editorOpen && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-xs text-[var(--launcher-muted)]">
            {t('providers.search')}
            <input
              type="search"
              placeholder={t('providers.search')}
              className={inputClass}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
            />
          </label>
          <Button className="h-10 shrink-0" isDisabled={busy} variant="outline" onPress={() => { void reload() }}>
            <ArrowRotateRight className="size-4" />
            {t('providers.refresh')}
          </Button>
          <Button className="h-10 shrink-0 bg-[var(--launcher-brand)] text-white" isDisabled={busy} onPress={() => openEditor()}>
            <Plus className="size-4" />
            {t('providers.add')}
          </Button>
        </div>
      )}
      {busy && !editorOpen && <p role="status" className="text-sm text-[var(--launcher-muted)]">{t('launcher.processing')}</p>}
      {error && <p role="alert" className="rounded-md border border-danger/25 bg-danger/5 p-3 break-words text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="rounded-md bg-[var(--launcher-selected)] px-3 py-2 text-sm text-[var(--launcher-brand-strong)]">{notice}</p>}
      {!editorOpen && !busy && !error && filteredItems.length === 0 && <p className="rounded-md border border-dashed border-[var(--launcher-border)] p-8 text-center text-sm text-[var(--launcher-muted)]">{t(items.length ? 'providers.no_results' : 'providers.empty')}</p>}
      {!editorOpen && (
        <div className="max-h-[min(56vh,640px)] overflow-y-auto pr-1">
          <ul className="m-0 list-none space-y-3 p-0">
            {pagedItems.map(item => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-4 transition-colors hover:border-[var(--launcher-brand)] motion-reduce:transition-none">
                <div className="min-w-0 flex-1 break-words text-sm">
                  <strong className="text-base font-semibold">{item.name}</strong>
                  <div className="mt-1 font-mono text-xs text-[var(--launcher-muted)]">
                    {item.id}
                    {' '}
                    ·
                    {' '}
                    {item.protocol}
                  </div>
                  <div className="mt-2 text-xs tabular-nums text-[var(--launcher-muted)]">
                    {t('providers.models_selected', { count: modelsOf(item).length })}
                  </div>
                  <div className="mt-1 break-all text-xs text-[var(--launcher-muted)]">{item.baseUrl}</div>
                  {item.defaultForNew && <span className="mt-2 inline-block rounded border border-[var(--launcher-border)] bg-[var(--launcher-selected)] px-2 py-0.5 text-xs text-[var(--launcher-brand-strong)]">{t('providers.default')}</span>}
                </div>
                <Button
                  isDisabled={busy}
                  variant="outline"
                  onPress={() => openEditor(item)}
                >
                  {t('providers.edit')}
                  <PencilToSquare className="size-4" />
                </Button>
                <span title={t('providers.remove_named', { name: item.name })}><Button isDisabled={busy} variant="ghost" className="text-danger" aria-label={t('providers.remove_named', { name: item.name })} onPress={() => setRemovingId(item.id)}><TrashBin className="size-4" /></Button></span>
                {removingId === item.id && (
                  <div role="group" aria-label={t('providers.remove_confirm')} className="w-full border-t border-[var(--launcher-border)] pt-3">
                    <p className="m-0 mb-3 text-sm">{t('providers.remove_warning', { name: item.name })}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button isDisabled={busy} variant="outline" onPress={() => setRemovingId(null)}>{t('launcher.cancel')}</Button>
                      <Button isDisabled={busy} variant="outline" className="text-danger" onPress={() => { void remove(item.id) }}>{t('providers.remove_confirm')}</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!editorOpen && !busy && !error && filteredItems.length > 0 && totalPages > 1 && (
        <ProviderPaginationBar page={currentPage} totalPages={totalPages} onChange={setPage} />
      )}
      {editorOpen && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          className="launcher-content-enter rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-5"
        >
          <h2 className="mb-2 mt-0 text-base font-semibold">
            {t(editing ? 'providers.edit' : 'providers.add')}
            {editing ? ` · ${draft.name}` : ''}
          </h2>
          <p className="mb-5 mt-0 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.editor_hint')}</p>
          <div className="mb-5 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3 py-2 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.supported_scope')}</div>
          <fieldset disabled={busy} className="m-0 grid min-w-0 grid-cols-2 gap-4 border-0 p-0 max-lg:grid-cols-1">
            <h3 className="col-span-full m-0 text-sm font-semibold">{t('providers.identity_section')}</h3>
            {(['name', 'id'] as const).map(field => (
              <label key={field} className="min-w-0 text-sm">
                {t(`providers.${field}`)}
                <input required className={inputClass} value={draft[field]} readOnly={field === 'id' && editing} onChange={event => setDraft({ ...draft, [field]: event.target.value })} autoComplete="off" />
              </label>
            ))}
            <h3 className="col-span-full mb-0 mt-2 border-t border-[var(--launcher-border)] pt-4 text-sm font-semibold">{t('providers.connection_section')}</h3>
            <label className="col-span-full min-w-0 text-sm">
              {t('providers.baseUrl')}
              <input required type="url" className={inputClass} value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} autoComplete="off" />
            </label>
            <label className="min-w-0 text-sm">
              {t('providers.key')}
              <input required={!editing} type="password" autoComplete="new-password" className={inputClass} value={apiKey} onChange={event => setApiKey(event.target.value)} />
              {editing && <span className="text-xs text-[var(--launcher-muted)]">{t('providers.keep_key')}</span>}
            </label>
            <label className="min-w-0 text-sm">
              {t('providers.protocol')}
              <select required className={inputClass} value={draft.protocol} onChange={event => setDraft({ ...draft, protocol: event.target.value })}>
                <option value="">{t('providers.select_protocol')}</option>
                {protocols.map(protocol => <option key={protocol} value={protocol}>{protocol}</option>)}
              </select>
            </label>
            <ProviderModels models={draft.models} onChange={models => setDraft({ ...draft, models })} baseUrl={draft.baseUrl} protocol={draft.protocol} apiKey={apiKey} savedId={editing ? draft.id : undefined} disabled={busy} onBusy={setBusy} />
            <label className="col-span-full flex cursor-pointer items-start gap-3 border-t border-[var(--launcher-border)] pt-4 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--launcher-brand)]" checked={draft.defaultForNew} onChange={event => setDraft({ ...draft, defaultForNew: event.target.checked })} />
              <span>
                {t('providers.default')}
                <span className="mt-1 block text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.default_hint')}</span>
              </span>
            </label>
            <p className="col-span-full m-0 text-xs text-[var(--launcher-muted)]">{t('providers.id_hint')}</p>
            <div className="sticky bottom-0 z-10 col-span-full -mx-5 -mb-5 flex flex-wrap items-center justify-end gap-2 rounded-b-md border-t border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] px-5 py-3">
              <span className="mr-auto text-xs tabular-nums text-[var(--launcher-muted)]">{t('providers.models_selected', { count: draft.models.length })}</span>
              <Button
                variant="ghost"
                isDisabled={busy}
                onPress={() => {
                  setDraft({ ...empty })
                  setEditing(false)
                  setApiKey('')
                  setEditorOpen(false)
                  setError('')
                }}
              >
                {t('launcher.cancel')}
              </Button>
              <Button type="submit" className="rounded-md bg-[var(--launcher-brand)] text-white" isDisabled={busy || !draft.models.length || !draft.name.trim() || !draft.id || !draft.baseUrl || !draft.protocol || (!editing && !apiKey)}>{t(busy ? 'launcher.processing' : 'providers.save')}</Button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  )
}

function ProviderPaginationBar(props: { page: number, totalPages: number, onChange: (page: number) => void }) {
  const { t } = useTranslation()
  return (
    <div className="sticky bottom-0 z-10 flex items-center justify-between border-t border-[var(--launcher-border)] bg-[var(--launcher-surface)]/95 px-4 py-2.5 backdrop-blur-sm">
      <span className="text-xs text-[var(--launcher-muted)]">{t('download.page_status', { current: props.page, total: props.totalPages })}</span>
      <div className="flex items-center gap-1">
        <Button isIconOnly size="sm" variant="ghost" className="size-8 min-w-8 rounded-md" aria-label={t('download.page_previous')} isDisabled={props.page <= 1} onPress={() => props.onChange(props.page - 1)}>
          <ArrowLeft className="size-4" />
        </Button>
        <Button isIconOnly size="sm" variant="ghost" className="size-8 min-w-8 rounded-md" aria-label={t('download.page_next')} isDisabled={props.page >= props.totalPages} onPress={() => props.onChange(props.page + 1)}>
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
