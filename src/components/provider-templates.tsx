import type { CatalogProvider, CatalogResponse } from './provider-contracts'
import type { ProviderModel } from './provider-models'
import { ArrowRotateRight, PencilToSquare, Plus, TrashBin } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { providerErrorMessage } from '@/utils/provider-error'
import { useSurfaceScroll, useSurfaceState } from '@/utils/surface-state'
import { PaginationBar as SharedPaginationBar } from './launcher-ui'
import ProviderModels from './provider-models'
import ProviderSelect from './provider-select'

export interface ProviderTemplate {
  /**
   * 实例 `llm-pi-ai.providers` 下的 dict key，同时也是模板库条目的定位键：
   * 改它等于新建一条模板，因此后端在编辑模式下直接拒绝（`PROVIDER_NOT_FOUND`）。
   */
  id: string
  name: string
  baseUrl: string
  protocol: string
  modelId?: string
  models: ProviderModel[]
  defaultForNew: boolean
  /** catalog = 继承运行时目录，custom = 自带地址与协议。 */
  kind?: 'catalog' | 'custom'
  /** 目录型的模型来源，与 modelOverrides 互斥。 */
  selection?: 'all' | 'subset'
  modelOverrides?: ProviderModel[]
}

const empty: ProviderTemplate = { id: '', name: '', baseUrl: '', protocol: '', models: [], defaultForNew: false }
const modelsOf = (item: ProviderTemplate) => item.models?.length ? item.models : item.modelId ? [{ id: item.modelId }] : []

export default function ProviderTemplates({ onSaved, onApply }: { onSaved?: (id: string) => void, onApply?: (id: string) => void } = {}) {
  const { t } = useTranslation()
  const [items, setItems] = useState<ProviderTemplate[]>([])
  const [protocols, setProtocols] = useState<string[]>([])
  const [catalog, setCatalog] = useState<CatalogProvider[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [draft, setDraft] = useState<ProviderTemplate>({ ...empty })
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useSurfaceState('providers', 'query', '')
  const [page, setPage] = useSurfaceState('providers', 'page', 1)
  const listScrollRef = useSurfaceScroll<HTMLDivElement>('providers', 'listScrollTop')

  function openEditor(item?: ProviderTemplate) {
    setDraft(item ? { ...item, modelId: '', models: modelsOf(item) } : { ...empty })
    setEditing(!!item)
    setApiKey('')
    setNotice('')
    setError('')
    setRemovingId(null)
    setRenamingId(null)
    setEditorOpen(true)
  }

  async function reload() {
    setBusy(true)
    setError('')
    try {
      const [saved, supported, directory] = await Promise.allSettled([
        invoke<ProviderTemplate[]>('list_provider_templates'),
        invoke<string[]>('get_provider_protocols'),
        invoke<CatalogResponse>('list_runtime_catalog'),
      ])
      setCatalog(directory.status === 'fulfilled' ? directory.value.providers : [])
      setCatalogError(directory.status === 'rejected' ? providerErrorMessage(directory.reason) : '')
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
      onSaved?.(draft.id)
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

  async function rename(from: string, to: string) {
    if (busy || to === from)
      return
    // 只是便利预检：字符集、保留 ID 和真正的撞号都由后端在库锁内判定。
    if (items.some(item => item.id === to)) {
      setError(t('providers.duplicate'))
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await invoke('rename_provider_template', { from, to })
      setRenamingId(null)
      await reload()
      setNotice(t('providers.renamed', { from, to }))
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
  const selectedItem = pagedItems.find(item => item.id === selectedId) ?? pagedItems[0]
  const catalogDraft = draft.kind === 'catalog'
  const directoryEntry = catalog.find(item => item.id === draft.id)
  return (
    <section className="space-y-4 [&_button]:rounded-md [&_button]:text-sm [&_input]:scroll-mb-24 [&_select]:scroll-mb-24">
      {!editorOpen && (
        <details className="text-xs text-[var(--launcher-muted)]">
          <summary className="cursor-pointer">{t('providers.help')}</summary>
          <p className="m-0 min-w-0 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.security_note')}</p>
          <p className="m-0 min-w-0 border-t border-[var(--launcher-border)] pt-3 text-xs leading-5 text-[var(--launcher-muted)] sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
            <span className="font-medium text-[var(--launcher-ink)]">{t('providers.scope_label')}</span>
            <span className="ml-2">{t('providers.supported_scope_short')}</span>
          </p>
        </details>
      )}
      {!editorOpen && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-xs text-[var(--launcher-muted)]">
            <input
              aria-label={t('providers.search')}
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
          <Button className="h-10 shrink-0 bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]" isDisabled={busy} onPress={() => openEditor()}>
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
        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <nav ref={listScrollRef} aria-label={t('providers.workspace_library')} className={`${selectedId ? 'hidden md:block' : ''} max-h-[52vh] overflow-y-auto rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] p-2`}>
            {pagedItems.map(item => (
              <button
                key={item.id}
                type="button"
                aria-current={selectedItem?.id === item.id ? 'true' : undefined}
                className={`mb-1 w-full rounded-md px-3 py-3 text-left ${selectedItem?.id === item.id ? 'bg-[var(--launcher-selected)] text-[var(--launcher-brand-strong)]' : 'text-[var(--launcher-ink)]'}`}
                onClick={() => {
                  setSelectedId(item.id)
                  setRemovingId(null)
                  setRenamingId(null)
                }}
              >
                <span className="block truncate font-medium">{item.name}</span>
                <span className="mt-1 block truncate text-xs text-[var(--launcher-muted)]">{item.id}</span>
              </button>
            ))}
          </nav>
          <ul className={`${selectedId ? '' : 'hidden md:block'} m-0 min-w-0 list-none space-y-3 p-0`}>
            <li className="md:hidden"><Button variant="outline" onPress={() => setSelectedId('')}>{t('providers.back_list')}</Button></li>
            {(selectedItem ? [selectedItem] : []).map(item => (
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
                {onApply && <Button className="bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]" isDisabled={busy} onPress={() => onApply(item.id)}>{t('providers.apply_instance')}</Button>}
                <details className="relative text-sm">
                  <summary className="cursor-pointer px-2 py-2 text-[var(--launcher-muted)]">{t('providers.more_actions')}</summary>
                  <div className="absolute right-0 z-10 flex min-w-40 gap-1 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-2 shadow-sm">
                    <Button
                      isDisabled={busy}
                      variant="outline"
                      onPress={() => {
                        setRemovingId(null)
                        setRenamingId(renamingId === item.id ? null : item.id)
                        setRenameValue(item.id)
                      }}
                    >
                      {t('providers.rename')}
                    </Button>
                    <span title={t('providers.remove_named', { name: item.name })}><Button isDisabled={busy} variant="ghost" className="text-danger" aria-label={t('providers.remove_named', { name: item.name })} onPress={() => setRemovingId(item.id)}><TrashBin className="size-4" /></Button></span>
                  </div>
                </details>
                <details className="w-full border-t border-[var(--launcher-border)] pt-3">
                  <summary className="cursor-pointer text-sm text-[var(--launcher-muted)]">{t('providers.models_selected', { count: modelsOf(item).length })}</summary>
                  <div className="max-h-56 overflow-y-auto pt-2">
                    {modelsOf(item).map(model => (
                      <div key={model.id} className="border-b border-[var(--launcher-border)] py-2 text-sm last:border-0">
                        <span className="break-all font-mono">{model.id}</span>
                        {model.name && <span className="ml-3 text-[var(--launcher-muted)]">{model.name}</span>}
                      </div>
                    ))}
                  </div>
                </details>
                {removingId === item.id && (
                  <div role="group" aria-label={t('providers.remove_confirm')} className="w-full border-t border-[var(--launcher-border)] pt-3">
                    <p className="m-0 mb-3 text-sm">{t('providers.remove_warning', { name: item.name })}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button isDisabled={busy} variant="outline" onPress={() => setRemovingId(null)}>{t('launcher.cancel')}</Button>
                      <Button isDisabled={busy} variant="outline" className="text-danger" onPress={() => { void remove(item.id) }}>{t('providers.remove_confirm')}</Button>
                    </div>
                  </div>
                )}
                {renamingId === item.id && (
                  <div role="group" aria-label={t('providers.rename_title')} className="w-full border-t border-[var(--launcher-border)] pt-3">
                    <p className="m-0 mb-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.rename_hint')}</p>
                    <label className="block min-w-0 text-xs text-[var(--launcher-muted)]">
                      {t('providers.id')}
                      <input className={`${inputClass} font-mono`} value={renameValue} placeholder={item.id} autoComplete="off" onChange={event => setRenameValue(event.target.value)} />
                    </label>
                    <p className="m-0 mt-2 break-all font-mono text-xs text-[var(--launcher-muted)]">
                      {item.id}
                      {' → '}
                      {renameValue.trim() || item.id}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button isDisabled={busy} variant="outline" onPress={() => setRenamingId(null)}>{t('launcher.cancel')}</Button>
                      <Button isDisabled={busy || renameValue.trim() === '' || renameValue.trim() === item.id} variant="outline" onPress={() => { void rename(item.id, renameValue.trim()) }}>{t('providers.rename_confirm')}</Button>
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
          <fieldset disabled={busy} className="m-0 grid max-h-[45vh] min-w-0 grid-cols-2 gap-4 overflow-y-auto border-0 p-1 max-lg:grid-cols-1">
            {!editing && (
              <div className="col-span-full space-y-2">
                <span className="text-sm">{t('providers.quick_pick')}</span>
                <ProviderSelect
                  label={t('providers.quick_pick')}
                  value={catalogDraft ? draft.id : 'custom'}
                  disabled={busy}
                  options={[
                    { value: 'custom', label: t('providers.manual_setup') },
                    ...catalog.map(item => ({ value: item.id, label: item.configurable ? item.name : `${item.name} · ${t(`providers.add.limitation.${item.limitation}`)}`, disabled: !item.configurable })),
                  ]}
                  onChange={(id) => {
                    const entry = catalog.find(item => item.id === id)
                    setApiKey('')
                    setDraft(entry ? { ...empty, id: entry.id, name: entry.name, kind: 'catalog', selection: 'all' } : { ...empty })
                  }}
                />
                {catalogError && <p role="status" className="text-xs text-[var(--launcher-muted)]">{catalogError}</p>}
              </div>
            )}
            <h3 className="col-span-full m-0 text-sm font-semibold">{t('providers.identity_section')}</h3>
            {(['name', 'id'] as const).map(field => (
              <label key={field} className="min-w-0 text-sm">
                {t(`providers.${field}`)}
                <input required className={inputClass} value={draft[field]} readOnly={field === 'id' && (editing || catalogDraft)} onChange={event => setDraft({ ...draft, [field]: event.target.value })} autoComplete="off" />
              </label>
            ))}
            <h3 className="col-span-full mb-0 mt-2 border-t border-[var(--launcher-border)] pt-4 text-sm font-semibold">{t('providers.connection_section')}</h3>
            <label className="col-span-full min-w-0 text-sm">
              {t('providers.baseUrl')}
              <input required={!catalogDraft} type="url" className={inputClass} value={draft.baseUrl} placeholder={catalogDraft ? directoryEntry?.baseUrl : undefined} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} autoComplete="off" />
              {catalogDraft && <span className="text-xs text-[var(--launcher-muted)]">{t('providers.catalog_defaults')}</span>}
            </label>
            <label className="min-w-0 text-sm">
              {t('providers.key')}
              <input required={!editing && !catalogDraft} type="password" autoComplete="new-password" className={inputClass} value={apiKey} onChange={event => setApiKey(event.target.value)} />
              {editing && <span className="text-xs text-[var(--launcher-muted)]">{t('providers.keep_key')}</span>}
              {!editing && catalogDraft && <span className="text-xs text-[var(--launcher-muted)]">{t('providers.catalog_key_hint')}</span>}
            </label>
            <label className="min-w-0 text-sm">
              {t('providers.protocol')}
              <ProviderSelect label={t('providers.protocol')} value={draft.protocol || (catalogDraft ? 'inherit' : '')} disabled={busy} placeholder={t('providers.select_protocol')} options={[...(catalogDraft ? [{ value: 'inherit', label: t('providers.catalog_defaults') }] : []), ...protocols.map(protocol => ({ value: protocol, label: protocol }))]} onChange={protocol => setDraft({ ...draft, protocol: protocol === 'inherit' ? '' : protocol })} />
            </label>
            {catalogDraft && draft.selection !== 'subset'
              ? <p className="col-span-full text-sm text-[var(--launcher-muted)]">{t('providers.catalog_models_auto', { count: directoryEntry?.modelCount ?? 0 })}</p>
              : <ProviderModels models={draft.models} onChange={models => setDraft({ ...draft, models })} baseUrl={draft.baseUrl} protocol={draft.protocol} apiKey={apiKey} savedId={editing ? draft.id : undefined} disabled={busy} onBusy={setBusy} />}
            <label className="col-span-full flex cursor-pointer items-start gap-3 border-t border-[var(--launcher-border)] pt-4 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--launcher-brand)]" checked={draft.defaultForNew} onChange={event => setDraft({ ...draft, defaultForNew: event.target.checked })} />
              <span>
                {t('providers.default')}
                <span className="mt-1 block text-xs leading-5 text-[var(--launcher-muted)]">{t('providers.default_hint')}</span>
              </span>
            </label>
            <p className="col-span-full m-0 text-xs text-[var(--launcher-muted)]">{t('providers.id_hint')}</p>
          </fieldset>
          <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--launcher-border)] bg-[var(--launcher-surface)] pt-3">
            <span className="mr-auto text-xs tabular-nums text-[var(--launcher-muted)]">{t(catalogDraft && draft.selection !== 'subset' ? 'providers.catalog_models_auto' : 'providers.models_selected', { count: catalogDraft && draft.selection !== 'subset' ? directoryEntry?.modelCount ?? 0 : draft.models.length })}</span>
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
            <Button type="submit" className="rounded-md bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]" isDisabled={busy || !draft.name.trim() || !draft.id || (catalogDraft ? !directoryEntry?.configurable : (!draft.models.length || !draft.baseUrl || !draft.protocol || (!editing && !apiKey)))}>{t(busy ? 'launcher.processing' : 'providers.save')}</Button>
          </div>
        </form>
      )}
    </section>
  )
}

function ProviderPaginationBar(props: { page: number, totalPages: number, onChange: (page: number) => void }) {
  const { t } = useTranslation()
  return (
    <SharedPaginationBar
      {...props}
      statusText={t('download.page_status', { current: props.page, total: props.totalPages })}
      previousLabel={t('download.page_previous')}
      nextLabel={t('download.page_next')}
    />
  )
}
