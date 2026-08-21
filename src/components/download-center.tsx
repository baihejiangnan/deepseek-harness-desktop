import type { UnlistenFn } from '@tauri-apps/api/event'
import type { DshInstance } from '@/store/modules/launcher/types'
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowRotateRight, ArrowUpRightFromSquare, ChevronDown, Copy, Power, TrashBin, Xmark } from '@gravity-ui/icons'
import { Button, Chip, ListBox, Modal, Select, useOverlayState } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { toast } from '@/utils'

const CATALOG_PAGE_SIZE = 6

interface InstalledPlugin {
  id: string
  name: string
  version: string
  description: string
  repoUrl: string
  bundled: boolean
}

function getInstalledPluginCategory(plugin: InstalledPlugin, catalog: PluginCatalog | null): string {
  const names = [plugin.id, plugin.name].map(value => value.toLocaleLowerCase())
  const entry = catalog?.plugins.find((item) => {
    const values = [item.name, item.npm ?? '', item.install].map(value => value.toLocaleLowerCase())
    return names.some(name => values.some(value => value === name || value.includes(name)))
  })
  return entry?.category ?? 'other'
}

interface PluginPackSectionProps {
  catalog: PluginPackCatalog | null
  loading: boolean
  detail: PluginPackDetail | null
  detailLoading: boolean
  target: DshInstance | null
  targetRunning: boolean
  installed: InstalledPlugin[]
  installing: boolean
  installingId: string
  cancelling: boolean
  onSelect: (packId: string) => Promise<void>
  onInstall: (packId: string) => Promise<PluginPackInstallResult>
  onCancel: () => Promise<void>
  onOpenRepo: (url: string) => Promise<void>
}

function PluginPackSection(props: PluginPackSectionProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase()
    if (!props.catalog)
      return []
    if (!value)
      return props.catalog.packs
    return props.catalog.packs.filter(pack => `${pack.name} ${pack.id} ${pack.description} ${pack.profile ?? ''}`.toLocaleLowerCase().includes(value))
  }, [props.catalog, query])
  const totalPages = Math.max(1, Math.ceil(filtered.length / CATALOG_PAGE_SIZE))
  const visiblePacks = filtered.slice((page - 1) * CATALOG_PAGE_SIZE, page * CATALOG_PAGE_SIZE)
  const installedNames = useMemo(() => new Set(props.installed.flatMap(plugin => [plugin.id.toLocaleLowerCase(), plugin.name.toLocaleLowerCase()])), [props.installed])
  const selectedPack = props.detail?.listing ?? null
  const installedCount = props.detail?.plugins.filter(plugin => installedNames.has(plugin.id.toLocaleLowerCase()) || installedNames.has(plugin.name.toLocaleLowerCase())).length ?? 0

  async function installSelectedPack() {
    if (!selectedPack)
      return
    setStatus('')
    try {
      const result = await props.onInstall(selectedPack.id)
      setStatus(t('download.pack_install_result', { installed: result.installed, skipped: result.skipped }))
    }
    catch {
      // The parent surfaces the stable backend error in the shared error panel.
    }
  }

  return (
    <section className="rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)]">
      <div className="flex flex-wrap items-end gap-3 border-b border-[var(--launcher-border)] px-4 py-3">
        <div className="min-w-[220px] flex-1">
          <h2 className="m-0 text-sm font-semibold">{t('download.pack_catalog_title')}</h2>
          <p className="m-0 mt-1 text-xs text-[var(--launcher-muted)]">{props.catalog ? t('download.pack_catalog_updated', { count: props.catalog.packs.length }) : t('download.pack_catalog_hint')}</p>
        </div>
        <input
          className="h-9 min-w-[220px] flex-1 rounded-md border border-[var(--launcher-border)] bg-white px-3 text-sm outline-none focus:border-[var(--launcher-brand)]"
          placeholder={t('download.pack_search_placeholder')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
        />
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        {props.loading && !props.catalog && <p className="col-span-full m-0 px-2 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('download.pack_catalog_loading')}</p>}
        {!props.loading && filtered.length === 0 && <p className="col-span-full m-0 px-2 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('download.pack_catalog_empty')}</p>}
        {visiblePacks.map(pack => (
          <article key={pack.id} className={`flex min-h-[164px] flex-col rounded-md border bg-white p-4 ${selectedPack?.id === pack.id ? 'border-[var(--launcher-brand)] ring-1 ring-[var(--launcher-brand)]/20' : 'border-[var(--launcher-border)]'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="m-0 truncate text-sm font-semibold">{pack.name}</h3>
                <p className="m-0 mt-1 truncate font-mono text-[10px] text-[var(--launcher-muted)]">{pack.id}</p>
              </div>
              {pack.profile && <span className="rounded-full bg-[var(--launcher-selected)] px-2 py-1 text-[10px] text-[var(--launcher-brand-strong)]">{t('download.pack_profile_source', { profile: pack.profile })}</span>}
            </div>
            <p className="mt-3 line-clamp-3 text-xs leading-5 text-[var(--launcher-muted)]">{pack.description}</p>
            <div className="mt-auto flex items-center justify-between gap-2 pt-3">
              <span className="truncate text-[10px] text-[var(--launcher-muted)]">{pack.format}</span>
              <div className="flex items-center gap-1">
                <Button isIconOnly size="sm" variant="ghost" className="size-7 min-w-7 rounded-md" aria-label={t('download.open_pack_repo')} onPress={() => { void props.onOpenRepo(pack.repository) }}>
                  <ArrowUpRightFromSquare className="size-3.5" />
                </Button>
                <Button size="sm" className="h-7 rounded-md bg-[var(--launcher-brand)] px-3 text-xs text-white" variant={selectedPack?.id === pack.id ? 'primary' : 'outline'} onPress={() => { void props.onSelect(pack.id) }}>
                  {t('download.pack_details')}
                </Button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {!props.loading && filtered.length > 0 && (
        <PaginationBar page={Math.min(page, totalPages)} totalPages={totalPages} onChange={setPage} />
      )}

      {props.detailLoading && <p className="border-t border-[var(--launcher-border)] px-4 py-6 text-center text-sm text-[var(--launcher-muted)]">{t('download.pack_detail_loading')}</p>}
      {props.detail && !props.detailLoading && (
        <div className="border-t border-[var(--launcher-border)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[var(--launcher-brand)]">{t('download.pack_detail_eyebrow')}</div>
              <h3 className="m-0 mt-1 text-lg font-semibold">{props.detail.listing.name}</h3>
              <p className="m-0 mt-1 text-xs text-[var(--launcher-muted)]">{props.detail.listing.description}</p>
            </div>
            <div className="text-right text-xs text-[var(--launcher-muted)]">
              <div>{t('download.pack_plugin_count', { count: props.detail.plugins.length })}</div>
              <div className="mt-1">{t('download.pack_installed_count', { installed: installedCount, total: props.detail.plugins.length })}</div>
            </div>
          </div>
          <div className="mt-4 max-h-64 overflow-auto rounded-md border border-[var(--launcher-border)] bg-white">
            {props.detail.plugins.map((plugin) => {
              const installed = installedNames.has(plugin.id.toLocaleLowerCase()) || installedNames.has(plugin.name.toLocaleLowerCase())
              return (
                <div key={plugin.id} className="flex items-start gap-3 border-b border-[var(--launcher-border)] px-3 py-2 last:border-b-0">
                  <span className={`mt-0.5 size-2 flex-none rounded-full ${installed ? 'bg-[var(--launcher-brand)]' : 'bg-[var(--launcher-muted)]/40'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                      <span>{plugin.name}</span>
                      {plugin.kind !== 'plugin' && <span className="rounded bg-[var(--launcher-selected)] px-1.5 py-0.5 text-[10px] text-[var(--launcher-brand-strong)]">{plugin.kind}</span>}
                      {installed && <span className="text-[10px] text-[var(--launcher-brand-strong)]">{t('download.installed')}</span>}
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-[var(--launcher-muted)]">{plugin.spec}</div>
                    {plugin.requires.length > 0 && <div className="mt-1 text-[10px] text-[var(--launcher-muted)]">{t('download.pack_requires', { requires: plugin.requires.join(', ') })}</div>}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[var(--launcher-muted)]">
              {props.detail.listing.source ?? t('download.pack_source_community')}
              {' '}
              ·
              {' '}
              {props.detail.license ?? t('download.pack_license_unknown')}
            </div>
            <Button
              className={`rounded-md px-5 text-white ${props.installingId === props.detail.listing.id ? 'bg-danger' : 'bg-[var(--launcher-brand)]'}`}
              isDisabled={!props.target || props.targetRunning || props.cancelling || (props.installing && props.installingId !== props.detail.listing.id) || (!props.installing && installedCount === props.detail.plugins.length)}
              onPress={() => { void (props.installingId === props.detail?.listing.id ? props.onCancel() : installSelectedPack()) }}
            >
              {props.installingId === props.detail.listing.id
                ? props.cancelling ? t('download.stopping_install') : t('download.stop_install')
                : installedCount === props.detail.plugins.length ? t('download.pack_all_installed') : t('download.install_pack')}
            </Button>
          </div>
          {status && <p className="m-0 mt-3 text-xs text-[var(--launcher-brand-strong)]">{status}</p>}
        </div>
      )}
    </section>
  )
}

interface CatalogPlugin {
  name: string
  owner: string
  url: string
  page?: string
  category: string
  description: Record<string, string>
  npm?: string | null
  stars?: number | null
  downloads?: number | null
  install: string
  added: string
}

interface PluginCatalog {
  updated: string
  count: number
  categories: Record<string, Record<string, string>>
  plugins: CatalogPlugin[]
}

interface PluginPackListing {
  id: string
  name: string
  description: string
  repository: string
  topics: string[]
  format: string
  sourceFile: string
  sourceUrl: string
  profile?: string | null
  source?: string | null
}

interface PluginPackCatalog {
  schemaVersion: number
  packs: PluginPackListing[]
}

interface PluginPackPlugin {
  id: string
  name: string
  kind: string
  spec: string
  repository?: string | null
  description?: string | null
  requires: string[]
}

interface PluginPackDetail {
  listing: PluginPackListing
  version?: string | null
  license?: string | null
  plugins: PluginPackPlugin[]
  profile?: string | null
}

interface PluginPackInstallResult {
  packId: string
  requested: number
  installed: number
  skipped: number
}

interface InstallLog { line: string }
export interface PackInstallProgress { completed: number, total: number, plugin: string }

interface DownloadCenterProps {
  onPackProgress?: (progress: PackInstallProgress | null) => void
}

type ResourceView = 'plugins' | 'packs' | 'manage'

const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000

let catalogCache: { value: PluginCatalog, loadedAt: number } | null = null
let catalogRequest: Promise<PluginCatalog> | null = null

function getCatalog(force: boolean): Promise<PluginCatalog> {
  const now = Date.now()
  // 手动刷新也复用正在进行的请求，避免连续点击产生并发网络请求。
  if (catalogRequest)
    return catalogRequest
  if (!force && catalogCache && now - catalogCache.loadedAt < CATALOG_CACHE_TTL_MS)
    return Promise.resolve(catalogCache.value)

  const request = invoke<PluginCatalog>('get_plugin_catalog', { force })
  catalogRequest = request
  request.then((value) => {
    catalogCache = { value, loadedAt: Date.now() }
  }, () => {}).finally(() => {
    if (catalogRequest === request)
      catalogRequest = null
  })
  return request
}

export default function DownloadCenter({ onPackProgress }: DownloadCenterProps) {
  const { t, i18n } = useTranslation()
  const { registry, runningInstanceIds } = useStore(store.launcher)
  const [targetId, setTargetId] = useState<string | null>(registry.activeInstanceId)
  const [resourceView, setResourceView] = useState<ResourceView>('plugins')
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [catalogPage, setCatalogPage] = useState(1)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [specs, setSpecs] = useState('')
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [loading, setLoading] = useState(false)
  const [installedCategory, setInstalledCategory] = useState('all')
  const [installedPage, setInstalledPage] = useState(1)
  const [pluginActionBusy, setPluginActionBusy] = useState('')
  const [pendingPluginRemove, setPendingPluginRemove] = useState<InstalledPlugin | null>(null)
  const [installing, setInstalling] = useState(false)
  const [cancellingInstall, setCancellingInstall] = useState(false)
  const installCancelledRef = useRef(false)
  const [installingName, setInstallingName] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState('')
  const [packCatalog, setPackCatalog] = useState<PluginPackCatalog | null>(null)
  const [packCatalogLoading, setPackCatalogLoading] = useState(false)
  const [packCatalogError, setPackCatalogError] = useState('')
  const [packCatalogAttempted, setPackCatalogAttempted] = useState(false)
  const [packDetail, setPackDetail] = useState<PluginPackDetail | null>(null)
  const [packDetailLoading, setPackDetailLoading] = useState(false)
  const [packInstallingId, setPackInstallingId] = useState('')
  const catalogSectionRef = useRef<HTMLElement>(null)
  const categoryMenuRef = useRef<HTMLDivElement>(null)
  const resourceViewRef = useRef<ResourceView>(resourceView)
  const packRequestIdRef = useRef(0)
  const fallbackTargetId = registry.activeInstanceId ?? registry.instances[0]?.id ?? null
  const resolvedTargetId = targetId && registry.instances.some(instance => instance.id === targetId) ? targetId : fallbackTargetId
  const target = registry.instances.find(instance => instance.id === resolvedTargetId) ?? null
  const targetRunning = target != null && runningInstanceIds.includes(target.id)
  const language = i18n.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const pluginRemoveState = useOverlayState({
    isOpen: pendingPluginRemove != null,
    onOpenChange: (open) => {
      if (!open && !pluginActionBusy)
        setPendingPluginRemove(null)
    },
  })

  useEffect(() => {
    // Refresh after switching targets so a previous instance cannot leave stale locks.
    void store.launcher.refreshRunning()
  }, [resolvedTargetId])

  useEffect(() => {
    // The launch view is the source of truth for the default download target.
    // Returning from Launch after selecting another instance must follow it.
    if (registry.activeInstanceId && registry.activeInstanceId !== targetId)
      setTargetId(registry.activeInstanceId)
  }, [registry.activeInstanceId, targetId])

  async function loadCatalog(force = false) {
    // 缓存内容先展示，网络更新在后台进行，避免每次切换导航时出现空白加载态。
    if (catalogCache)
      setCatalog(catalogCache.value)
    setCatalogLoading(catalogCache == null)
    setCatalogError('')
    setCatalogPage(1)
    try {
      setCatalog(await getCatalog(force))
    }
    catch (err) {
      setCatalogError(String(err))
    }
    finally {
      setCatalogLoading(false)
    }
  }

  async function loadInstalled() {
    if (!target)
      return
    setLoading(true)
    try {
      setPlugins(await invoke<InstalledPlugin[]>('get_dsh_plugins_for_instance', { instanceId: target.id }))
    }
    catch (err) {
      setError(String(err))
    }
    finally {
      setLoading(false)
    }
  }

  async function toggleInstalledPlugin(plugin: InstalledPlugin) {
    if (!target || targetRunning || installing || pluginActionBusy)
      return
    setPluginActionBusy(plugin.id)
    setError('')
    try {
      await invoke('set_plugin_enabled_for_instance', { instanceId: target.id, pluginId: plugin.id, enabled: !plugin.bundled })
      await loadInstalled()
    }
    catch (err) {
      setError(String(err))
    }
    finally {
      setPluginActionBusy('')
    }
  }

  async function removeInstalledPlugin() {
    if (!target || !pendingPluginRemove || targetRunning || installing || pluginActionBusy)
      return
    setPluginActionBusy(pendingPluginRemove.id)
    setError('')
    try {
      await invoke('remove_plugin_for_instance', { instanceId: target.id, pluginId: pendingPluginRemove.id })
      setPendingPluginRemove(null)
      await loadInstalled()
    }
    catch (err) {
      setError(String(err))
    }
    finally {
      setPluginActionBusy('')
    }
  }

  async function loadPackCatalog(force = false) {
    const requestId = ++packRequestIdRef.current
    setPackCatalogAttempted(true)
    setPackCatalogLoading(true)
    setPackCatalogError('')
    try {
      const value = await invoke<PluginPackCatalog>('get_plugin_pack_catalog', { force })
      if (requestId === packRequestIdRef.current) {
        setPackCatalog(value)
        if (packDetail && !value.packs.some(pack => pack.id === packDetail.listing.id))
          setPackDetail(null)
      }
    }
    catch (err) {
      const message = String(err)
      if (requestId === packRequestIdRef.current && resourceViewRef.current === 'packs') {
        if (message.includes('PLUGIN_PACK_MARKET_NETWORK')) {
          toast(t('download.pack_market_network_title'), {
            actionProps: {
              children: t('download.pack_market_network_retry'),
              onPress: () => { void loadPackCatalog(true) },
              variant: 'tertiary',
            },
            description: t('download.pack_market_network_description'),
            placement: 'bottom end',
            timeout: 8000,
            variant: 'danger',
          })
        }
        else {
          setPackCatalogError(message)
        }
      }
    }
    finally {
      if (requestId === packRequestIdRef.current)
        setPackCatalogLoading(false)
    }
  }

  async function selectPack(packId: string) {
    setPackDetailLoading(true)
    setPackCatalogError('')
    try {
      setPackDetail(await invoke<PluginPackDetail>('get_plugin_pack_detail', { packId }))
    }
    catch (err) {
      setPackCatalogError(String(err))
    }
    finally {
      setPackDetailLoading(false)
    }
  }

  useEffect(() => {
    void loadCatalog()
  }, [])

  useEffect(() => {
    resourceViewRef.current = resourceView
  }, [resourceView])

  // The loader is intentionally recreated with the view state; invoking it here should not create a request loop.
  useEffect(() => {
    if (resourceView === 'packs' && !packCatalog && !packCatalogAttempted && !packCatalogLoading)
      void loadPackCatalog()
    // eslint-disable-next-line react/exhaustive-deps
  }, [resourceView, packCatalog, packCatalogAttempted, packCatalogLoading])

  useEffect(() => {
    void loadInstalled()
    // 目标实例变化时切换 Profile 数据，函数本身不作为依赖。
    // eslint-disable-next-line react/exhaustive-deps
  }, [target?.id])

  useEffect(() => {
    if (!categoryOpen)
      return
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!categoryMenuRef.current?.contains(event.target as Node))
        setCategoryOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [categoryOpen])

  const categories = useMemo(() => {
    if (!catalog)
      return []
    return Object.keys(catalog.categories).sort()
  }, [catalog])

  const filtered = useMemo(() => {
    if (!catalog)
      return []
    const value = query.trim().toLocaleLowerCase()
    return catalog.plugins.filter((plugin) => {
      if (category !== 'all' && plugin.category !== category)
        return false
      if (!value)
        return true
      const description = plugin.description.en ?? plugin.description.zh ?? ''
      return `${plugin.name} ${plugin.owner} ${description} ${plugin.npm ?? ''}`.toLocaleLowerCase().includes(value)
    })
  }, [catalog, category, query])

  const installedIds = useMemo(() => new Set(plugins.flatMap(plugin => [plugin.id, plugin.name])), [plugins])
  const installedCategories = useMemo(() => {
    const values = new Set(plugins.map(plugin => getInstalledPluginCategory(plugin, catalog)))
    return ['all', ...categories.filter(item => values.has(item)), ...(values.has('other') ? ['other'] : [])]
  }, [plugins, catalog, categories])
  const filteredInstalledPlugins = useMemo(() => {
    if (installedCategory === 'all')
      return plugins
    return plugins.filter(plugin => getInstalledPluginCategory(plugin, catalog) === installedCategory)
  }, [plugins, installedCategory, catalog])
  const totalInstalledPages = Math.max(1, Math.ceil(filteredInstalledPlugins.length / CATALOG_PAGE_SIZE))
  const currentInstalledPage = Math.min(installedPage, totalInstalledPages)
  const visibleInstalledPlugins = filteredInstalledPlugins.slice(
    (currentInstalledPage - 1) * CATALOG_PAGE_SIZE,
    currentInstalledPage * CATALOG_PAGE_SIZE,
  )
  const totalCatalogPages = Math.max(1, Math.ceil(filtered.length / CATALOG_PAGE_SIZE))
  const visibleCatalogPlugins = filtered.slice(
    (catalogPage - 1) * CATALOG_PAGE_SIZE,
    catalogPage * CATALOG_PAGE_SIZE,
  )

  async function openRepo(url: string) {
    try {
      await invoke('open_external_url', { url })
    }
    catch (err) {
      setError(String(err))
    }
  }

  async function installCatalogPlugin(plugin: CatalogPlugin) {
    if (!target || targetRunning || installing)
      return
    setInstalling(true)
    setInstallingName(plugin.name)
    setError('')
    setLogs([])
    let unlisten: UnlistenFn | undefined
    try {
      unlisten = await listen<InstallLog>('plugin-install-log', event => setLogs(previous => [...previous, event.payload.line].slice(-120)))
      await invoke('install_catalog_plugin_for_instance', { instanceId: target.id, pluginName: plugin.name })
      await loadInstalled()
    }
    catch (err) {
      setError(String(err))
    }
    finally {
      unlisten?.()
      setInstallingName('')
      setInstalling(false)
    }
  }

  async function installManualPackages() {
    if (!target || targetRunning || installing)
      return
    if (!specs.trim())
      return
    setInstalling(true)
    setError('')
    setLogs([])
    let unlisten: UnlistenFn | undefined
    try {
      unlisten = await listen<InstallLog>('plugin-install-log', event => setLogs(previous => [...previous, event.payload.line].slice(-120)))
      await invoke('install_plugin_packages_for_instance', { instanceId: target.id, input: specs })
      setSpecs('')
      await loadInstalled()
    }
    catch (err) {
      setError(String(err))
    }
    finally {
      unlisten?.()
      setInstalling(false)
    }
  }

  async function installPack(packId: string): Promise<PluginPackInstallResult> {
    if (!target || targetRunning || installing)
      throw new Error('PLUGIN_PACK_TARGET_UNAVAILABLE')
    setInstalling(true)
    setCancellingInstall(false)
    installCancelledRef.current = false
    setPackInstallingId(packId)
    setError('')
    setLogs([])
    onPackProgress?.(null)
    let unlistenLog: UnlistenFn | undefined
    let unlistenProgress: UnlistenFn | undefined
    try {
      unlistenLog = await listen<InstallLog>('plugin-install-log', event => setLogs(previous => [...previous, event.payload.line].slice(-120)))
      unlistenProgress = await listen<PackInstallProgress>('plugin-pack-install-progress', event => onPackProgress?.(event.payload))
      const result = await invoke<PluginPackInstallResult>('install_plugin_pack_for_instance', { instanceId: target.id, packId })
      await loadInstalled()
      toast(t('download.pack_install_complete', { count: result.installed }), { variant: 'accent', placement: 'bottom end' })
      return result
    }
    catch (err) {
      const message = String(err)
      const cancelled = installCancelledRef.current || message.includes('PLUGIN_INSTALL_CANCELLED')
      if (!cancelled)
        setError(message)
      toast(t(cancelled ? 'download.pack_install_cancelled' : 'download.pack_install_failed'), { variant: cancelled ? 'default' : 'danger', placement: 'bottom end' })
      throw err
    }
    finally {
      unlistenLog?.()
      unlistenProgress?.()
      setPackInstallingId('')
      setInstalling(false)
      setCancellingInstall(false)
      installCancelledRef.current = false
      onPackProgress?.(null)
    }
  }

  async function cancelPackInstall() {
    if (!packInstallingId || cancellingInstall)
      return
    installCancelledRef.current = true
    setCancellingInstall(true)
    try {
      await invoke('cancel_plugin_install')
    }
    catch (err) {
      installCancelledRef.current = false
      setCancellingInstall(false)
      setError(String(err))
      toast(t('download.stop_install_failed'), { variant: 'danger', placement: 'bottom end' })
    }
  }

  async function copyInstallLogs() {
    try {
      await navigator.clipboard.writeText(logs.join('\n'))
      toast(t('download.logs_copied'), { variant: 'accent' })
    }
    catch {
      toast(t('download.logs_copy_failed'), { variant: 'danger' })
    }
  }

  function changeCatalogQuery(value: string) {
    setQuery(value)
    setCatalogPage(1)
  }

  function changeCatalogCategory(value: string) {
    setCategory(value)
    setCatalogPage(1)
    setCategoryOpen(false)
  }

  function changeCatalogPage(nextPage: number) {
    const page = Math.min(totalCatalogPages, Math.max(1, nextPage))
    setCatalogPage(page)
    requestAnimationFrame(() => {
      catalogSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  function refreshCurrentView() {
    if (resourceView === 'plugins')
      return loadCatalog(true)
    if (resourceView === 'packs')
      return loadPackCatalog(true)
    return loadInstalled()
  }

  const navigation: Array<{ id: ResourceView, icon: typeof ArrowDownToLine }> = [
    { id: 'plugins', icon: ArrowDownToLine },
    { id: 'packs', icon: ArrowRotateRight },
    { id: 'manage', icon: Power },
  ]

  const pageCopy = resourceView === 'packs'
    ? { title: t('download.packs_title'), subtitle: t('download.packs_subtitle') }
    : resourceView === 'manage'
      ? { title: t('download.manage_title'), subtitle: t('download.manage_subtitle') }
      : { title: t('download.title'), subtitle: t('download.subtitle') }

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--launcher-canvas)] text-[var(--launcher-ink)]">
      <aside className="w-[210px] flex-none border-r border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] p-3">
        <div className="px-3 pb-3 pt-2 text-xs font-semibold text-[var(--launcher-muted)]">{t('download.navigation_title')}</div>
        <nav aria-label={t('download.navigation_title')}>
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                aria-current={resourceView === item.id ? 'page' : undefined}
                className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm transition-[background-color,color,transform] duration-200 ease-out motion-reduce:transition-none ${resourceView === item.id ? 'translate-x-1 bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)] motion-reduce:translate-x-0' : 'text-[var(--launcher-muted)] hover:translate-x-0.5 hover:bg-white motion-reduce:hover:translate-x-0'}`}
                onClick={() => {
                  setPackCatalogError('')
                  setPackDetailLoading(false)
                  setResourceView(item.id)
                }}
              >
                <Icon className="size-4" />
                {t(`download.navigation.${item.id}`)}
              </button>
            )
          })}
        </nav>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <div key={resourceView} className="launcher-content-enter mx-auto max-w-[1080px]">
          <header className="mb-5 flex items-end justify-between gap-4">
            <div>
              <div className="mb-1 text-xs font-semibold text-[var(--launcher-brand)]">{t('download.eyebrow')}</div>
              <h1 className="m-0 text-2xl font-semibold">{pageCopy.title}</h1>
              {resourceView === 'packs'
                ? (
                    <p className="mb-0 mt-3 inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border border-[var(--launcher-brand)]/30 bg-[var(--launcher-selected)] px-3 py-2 text-sm font-medium text-[var(--launcher-ink)]">
                      <span>{pageCopy.subtitle}</span>
                      <button type="button" className="font-semibold text-[var(--launcher-brand-strong)] underline decoration-2 underline-offset-2 transition-colors hover:text-[var(--launcher-brand)]" onClick={() => { void openRepo('https://github.com/baihejiangnan/dsh-plugin-pack-ai-share-template/blob/main/PROMPT.md') }}>{t('download.packs_prompt_link')}</button>
                      <ArrowUpRightFromSquare className="size-3.5 text-[var(--launcher-brand-strong)]" />
                    </p>
                  )
                : <p className="mb-0 mt-2 text-sm text-[var(--launcher-muted)]">{pageCopy.subtitle}</p>}
            </div>
            <Button className="h-9 rounded-md border-[var(--launcher-border)] bg-white text-[var(--launcher-ink)]" variant="outline" isDisabled={resourceView === 'plugins' ? catalogLoading || installing : resourceView === 'packs' ? packCatalogLoading || packDetailLoading || installing : loading || installing} onPress={() => { void refreshCurrentView() }}>
              <ArrowRotateRight />
              {t('download.refresh')}
            </Button>
          </header>

          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-4 py-3">
            <span className="flex-none text-xs font-medium">{t('download.target_label')}</span>
            <Select selectedKey={resolvedTargetId ?? undefined} onSelectionChange={key => setTargetId(String(key))} className="launcher-select min-w-[220px] flex-1">
              <Select.Trigger className="h-9 rounded-md">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover className="launcher-select-popover rounded-md">
                <ListBox>
                  {registry.instances.map(instance => (
                    <ListBox.Item key={instance.id} id={instance.id} textValue={instance.name} className="rounded-md">
                      {instance.name}
                      <span className="ml-2 text-xs text-[var(--launcher-muted)]">{instance.profile}</span>
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <span className="text-xs text-[var(--launcher-muted)]">{target ? t('download.target', { name: target.name, profile: target.profile }) : t('download.no_target')}</span>
          </div>

          {!target && <div className="mb-5 rounded-md border border-[#ead39e] bg-[#fff8e8] px-4 py-3 text-sm text-[#72521b]">{t('download.create_instance_first')}</div>}
          {targetRunning && <div className="mb-5 rounded-md border border-[#ead39e] bg-[#fff8e8] px-4 py-3 text-sm text-[#72521b]">{t('download.stop_instance_first')}</div>}
          {catalogError && <div className="mb-5 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-xs text-danger">{catalogError}</div>}
          {resourceView === 'packs' && packCatalogError && <div className="mb-5 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-xs text-danger">{packCatalogError}</div>}
          {error && <div className="mb-5 rounded-md border border-danger/30 bg-danger/5 px-4 py-3 text-xs text-danger">{error}</div>}

          {resourceView === 'plugins'
            ? (
                <>
                  <section ref={catalogSectionRef} className="scroll-mt-4 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)]">
                    <div className="flex flex-wrap items-end gap-3 border-b border-[var(--launcher-border)] px-4 py-3">
                      <div className="min-w-[220px] flex-1">
                        <h2 className="m-0 text-sm font-semibold">{t('download.catalog_title')}</h2>
                        <p className="m-0 mt-1 text-xs text-[var(--launcher-muted)]">{catalog ? t('download.catalog_updated', { date: catalog.updated, count: catalog.count }) : t('download.catalog_hint')}</p>
                      </div>
                      <input className="h-9 min-w-[220px] flex-1 rounded-md border border-[var(--launcher-border)] bg-white px-3 text-sm outline-none focus:border-[var(--launcher-brand)]" placeholder={t('download.search_placeholder')} value={query} onChange={event => changeCatalogQuery(event.target.value)} />
                      <div ref={categoryMenuRef} className="relative w-[190px]">
                        <button
                          type="button"
                          aria-expanded={categoryOpen}
                          aria-haspopup="listbox"
                          className={`flex h-9 w-full items-center justify-between rounded-md border px-3 text-left text-sm transition-colors ${categoryOpen ? 'border-[var(--launcher-brand)] bg-white' : 'border-[var(--launcher-border)] bg-white hover:border-[var(--launcher-brand)]'}`}
                          onClick={() => setCategoryOpen(open => !open)}
                        >
                          <span className="truncate">{category === 'all' ? t('download.all_categories') : catalog?.categories[category]?.[language] ?? category}</span>
                          <ChevronDown className={`ml-2 size-4 text-[var(--launcher-muted)] transition-transform duration-200 ${categoryOpen ? 'rotate-180' : ''}`} />
                        </button>
                        <div
                          role="listbox"
                          aria-label={t('download.all_categories')}
                          className={`absolute right-0 top-full z-30 mt-2 w-[min(430px,calc(100vw-2rem))] origin-top-right rounded-lg border border-[var(--launcher-border)] bg-[var(--launcher-surface)]/90 p-3 shadow-[0_14px_36px_rgba(25,45,64,0.18)] backdrop-blur-xl transition-all duration-200 ease-out ${categoryOpen ? 'visible scale-100 opacity-100' : 'pointer-events-none invisible scale-95 opacity-0'}`}
                        >
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            <button
                              type="button"
                              role="option"
                              aria-selected={category === 'all'}
                              className={`min-h-9 rounded-md border px-3 py-2 text-left text-xs transition-colors ${category === 'all' ? 'border-[var(--launcher-brand)] bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)]' : 'border-transparent text-[var(--launcher-ink)] hover:border-[var(--launcher-border)] hover:bg-white/70'}`}
                              onClick={() => changeCatalogCategory('all')}
                            >
                              {t('download.all_categories')}
                            </button>
                            {categories.map(item => (
                              <button
                                key={item}
                                type="button"
                                role="option"
                                aria-selected={category === item}
                                className={`min-h-9 rounded-md border px-3 py-2 text-left text-xs transition-colors ${category === item ? 'border-[var(--launcher-brand)] bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)]' : 'border-transparent text-[var(--launcher-ink)] hover:border-[var(--launcher-border)] hover:bg-white/70'}`}
                                onClick={() => changeCatalogCategory(item)}
                              >
                                {catalog?.categories[item]?.[language] ?? item}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
                      {catalogLoading && !catalog && <p className="col-span-full m-0 px-2 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('download.catalog_loading')}</p>}
                      {!catalogLoading && filtered.length === 0 && <p className="col-span-full m-0 px-2 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('download.catalog_empty')}</p>}
                      {(!catalogLoading || catalog != null) && visibleCatalogPlugins.map((plugin) => {
                        const installed = installedIds.has(plugin.name) || (plugin.npm != null && installedIds.has(plugin.npm))
                        const description = plugin.description[language] ?? plugin.description.en ?? plugin.description.zh ?? ''
                        return (
                          <article key={`${plugin.owner}/${plugin.name}`} className="flex min-h-[148px] flex-col rounded-md border border-[var(--launcher-border)] bg-white p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <h3 className="m-0 truncate text-sm font-semibold">{plugin.name}</h3>
                                <p className="m-0 mt-1 text-[10px] text-[var(--launcher-muted)]">{plugin.owner}</p>
                              </div>
                              <Chip size="sm" variant="soft" color="accent">{plugin.category}</Chip>
                            </div>
                            <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--launcher-muted)]">{description}</p>
                            <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                              <span className="truncate text-[10px] text-[var(--launcher-muted)]">{plugin.npm ?? plugin.install.split(' ').at(-1)}</span>
                              <div className="flex items-center gap-1">
                                {plugin.url && <Button isIconOnly size="sm" variant="ghost" className="size-7 min-w-7 rounded-md" aria-label={t('download.open_repo')} onPress={() => { void openRepo(plugin.url) }}><ArrowUpRightFromSquare className="size-3.5" /></Button>}
                                <Button size="sm" className="h-7 rounded-md bg-[var(--launcher-brand)] px-3 text-xs text-white" isDisabled={installed || installing || !target || targetRunning} onPress={() => { void installCatalogPlugin(plugin) }}>{installed ? t('download.installed') : installingName === plugin.name ? t('download.installing') : t('download.install')}</Button>
                              </div>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                    {!catalogLoading && filtered.length > 0 && (
                      <div className="sticky bottom-0 z-10 flex items-center justify-between border-t border-[var(--launcher-border)] bg-[var(--launcher-surface)]/95 px-4 py-2.5 backdrop-blur-sm">
                        <span className="text-xs text-[var(--launcher-muted)]">{t('download.page_status', { current: catalogPage, total: totalCatalogPages })}</span>
                        <div className="flex items-center gap-1">
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            className="size-8 min-w-8 rounded-md"
                            aria-label={t('download.page_previous')}
                            isDisabled={catalogPage <= 1}
                            onPress={() => changeCatalogPage(catalogPage - 1)}
                          >
                            <ArrowLeft className="size-4" />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            className="size-8 min-w-8 rounded-md"
                            aria-label={t('download.page_next')}
                            isDisabled={catalogPage >= totalCatalogPages}
                            onPress={() => changeCatalogPage(catalogPage + 1)}
                          >
                            <ArrowRight className="size-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                    <details className="border-t border-[var(--launcher-border)] px-5 py-4">
                      <summary className="cursor-pointer text-sm font-semibold">{t('download.advanced_title')}</summary>
                      <p className="m-0 mt-2 text-xs text-[var(--launcher-muted)]">{t('download.advanced_hint')}</p>
                      {target && (
                        <div className="mt-3 rounded-md border border-[var(--launcher-brand)]/30 bg-[var(--launcher-selected)] px-3 py-2 text-xs leading-5 text-[var(--launcher-brand-strong)]">
                          {t('download.advanced_profile_hint', { instance: target.name, profile: target.profile })}
                        </div>
                      )}
                      <textarea className="mt-3 min-h-20 w-full resize-y rounded-md border border-[var(--launcher-border)] bg-white px-3 py-2 font-mono text-xs outline-none focus:border-[var(--launcher-brand)]" placeholder={t('download.spec_placeholder')} value={specs} onChange={event => setSpecs(event.target.value)} disabled={!target || targetRunning || installing} />
                      <div className="mt-3 flex justify-end"><Button className="h-9 rounded-md bg-[var(--launcher-brand)] px-5 text-white" isDisabled={!specs.trim() || installing || !target || targetRunning} onPress={() => { void installManualPackages() }}>{installing ? t('download.installing') : t('download.install_selected')}</Button></div>
                    </details>
                  </section>
                </>
              )
            : resourceView === 'packs'
              ? (
                  <PluginPackSection
                    catalog={packCatalog}
                    loading={packCatalogLoading}
                    detail={packDetail}
                    detailLoading={packDetailLoading}
                    target={target}
                    targetRunning={targetRunning}
                    installed={plugins}
                    installing={installing}
                    installingId={packInstallingId}
                    cancelling={cancellingInstall}
                    onSelect={selectPack}
                    onInstall={installPack}
                    onCancel={cancelPackInstall}
                    onOpenRepo={openRepo}
                  />
                )
              : null}

          {resourceView === 'manage' && (
            <section className="overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)]">
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--launcher-border)] px-4 py-3">
                <div>
                  <h2 className="m-0 text-sm font-semibold">{t('download.installed_title')}</h2>
                  <p className="m-0 mt-1 text-xs text-[var(--launcher-muted)]">{t('download.installed_hint')}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--launcher-muted)]">{plugins.length}</span>
                  <Select
                    selectedKey={installedCategory}
                    onSelectionChange={(key) => {
                      setInstalledCategory(String(key))
                      setInstalledPage(1)
                    }}
                    className="launcher-select w-[160px]"
                  >
                    <Select.Trigger className="h-9 rounded-md"><Select.Value /></Select.Trigger>
                    <Select.Popover className="launcher-select-popover rounded-md">
                      <ListBox>
                        {installedCategories.map(item => (
                          <ListBox.Item key={item} id={item} textValue={item === 'all' ? t('download.all_categories') : item === 'other' ? t('download.other_category') : catalog?.categories[item]?.[language] ?? item} className="rounded-md">
                            {item === 'all' ? t('download.all_categories') : item === 'other' ? t('download.other_category') : catalog?.categories[item]?.[language] ?? item}
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>
              </div>
              <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
                {loading && <p className="col-span-full m-0 px-2 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('download.loading')}</p>}
                {!loading && plugins.length === 0 && <p className="col-span-full m-0 px-2 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('download.empty')}</p>}
                {!loading && plugins.length > 0 && filteredInstalledPlugins.length === 0 && <p className="col-span-full m-0 px-2 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('download.installed_category_empty')}</p>}
                {!loading && visibleInstalledPlugins.map((plugin) => {
                  const pluginCategory = getInstalledPluginCategory(plugin, catalog)
                  const categoryLabel = pluginCategory === 'other' ? t('download.other_category') : catalog?.categories[pluginCategory]?.[language] ?? pluginCategory
                  const busy = pluginActionBusy === plugin.id
                  return (
                    <article key={plugin.id} className="flex min-h-[190px] flex-col rounded-md border border-[var(--launcher-border)] bg-white p-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="m-0 truncate text-sm font-semibold">{plugin.name}</h3>
                          <p className="m-0 mt-1 truncate font-mono text-[10px] text-[var(--launcher-muted)]">{plugin.id}</p>
                        </div>
                        <Chip size="sm" variant="soft" color="accent">{categoryLabel}</Chip>
                      </div>
                      <p className="mt-3 line-clamp-3 text-xs leading-5 text-[var(--launcher-muted)]">{plugin.description || t('download.installed_no_description')}</p>
                      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`rounded-full px-2 py-1 text-[10px] font-medium ${plugin.bundled ? 'bg-[var(--launcher-selected)] text-[var(--launcher-brand-strong)]' : 'bg-[#f2f4f7] text-[#748095]'}`}>
                            {plugin.bundled ? t('launcher.plugin_enabled_status') : t('launcher.plugin_disabled_status')}
                          </span>
                          <code className="truncate text-[10px] text-[var(--launcher-muted)]">{plugin.version || '-'}</code>
                        </div>
                        <div className="flex items-center gap-1">
                          {plugin.repoUrl && <Button isIconOnly size="sm" variant="ghost" className="size-7 min-w-7 rounded-md" aria-label={t('download.open_repo')} onPress={() => { void openRepo(plugin.repoUrl) }}><ArrowUpRightFromSquare className="size-3.5" /></Button>}
                          <Button size="sm" variant="outline" className="h-7 rounded-md border-[var(--launcher-brand)] px-2 text-[10px] text-[var(--launcher-brand-strong)]" isDisabled={busy || pluginActionBusy !== '' || targetRunning || installing} onPress={() => { void toggleInstalledPlugin(plugin) }}>
                            <Power className="size-3" />
                            {plugin.bundled ? t('launcher.plugin_disable') : t('launcher.plugin_enable')}
                          </Button>
                          <Button isIconOnly size="sm" variant="ghost" className="size-7 min-w-7 rounded-md text-danger" aria-label={t('launcher.plugin_remove')} isDisabled={pluginActionBusy !== '' || targetRunning || installing} onPress={() => setPendingPluginRemove(plugin)}>
                            <TrashBin className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
              {!loading && filteredInstalledPlugins.length > 0 && (
                <PaginationBar page={currentInstalledPage} totalPages={totalInstalledPages} onChange={setInstalledPage} />
              )}
            </section>
          )}

          <Modal state={pluginRemoveState}>
            <Modal.Backdrop isDismissable={!pluginActionBusy}>
              <Modal.Container size="sm">
                <Modal.Dialog>
                  <Modal.Header>
                    <Modal.Heading>{t('launcher.plugin_remove_title')}</Modal.Heading>
                    <Modal.CloseTrigger isDisabled={pluginActionBusy !== ''} />
                  </Modal.Header>
                  <Modal.Body>
                    <p className="m-0 text-sm text-[var(--launcher-muted)]">{t('launcher.plugin_remove_description', { name: pendingPluginRemove?.name ?? pendingPluginRemove?.id ?? '' })}</p>
                  </Modal.Body>
                  <Modal.Footer>
                    <Button className="rounded-md" variant="tertiary" isDisabled={pluginActionBusy !== ''} onPress={() => setPendingPluginRemove(null)}>{t('launcher.cancel')}</Button>
                    <Button className="rounded-md bg-danger text-white" isDisabled={pluginActionBusy !== ''} onPress={() => { void removeInstalledPlugin() }}>{t('launcher.plugin_remove_confirm')}</Button>
                  </Modal.Footer>
                </Modal.Dialog>
              </Modal.Container>
            </Modal.Backdrop>
          </Modal>

          {logs.length > 0 && (
            <section className="mt-4 overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[#1b1f2a] text-white">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs">
                <span>{t('download.install_log')}</span>
                <div className="flex items-center gap-1">
                  <Button isIconOnly size="sm" variant="ghost" className="size-6 min-w-6 rounded-md text-white" aria-label={t('download.copy_logs')} onPress={() => { void copyInstallLogs() }}><Copy className="size-3.5" /></Button>
                  <Button isIconOnly size="sm" variant="ghost" className="size-6 min-w-6 rounded-md text-white" aria-label={t('download.clear_logs')} onPress={() => setLogs([])}><Xmark /></Button>
                </div>
              </div>
              <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-5 text-white/80">{logs.join('\n')}</pre>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

function PaginationBar(props: { page: number, totalPages: number, onChange: (page: number) => void }) {
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
