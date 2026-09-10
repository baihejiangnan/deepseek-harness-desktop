import type { CatalogProvider, CatalogResponse, CredentialRoles, InstanceProviderView, ProviderRouteView } from './provider-contracts'
import type { DshInstance, InstanceSharing } from '@/store/modules/launcher/types'
import { ArrowRotateRight, PencilToSquare } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorBanner, PageHeader, SectionCard, StatusBadge, StatusNotice } from './launcher-ui'
import ProviderAdd from './provider-add'
import ProviderEdit from './provider-edit'
import ProviderImport from './provider-import'
import ProviderRemove from './provider-remove'

type CatalogState = { status: 'ready', providers: CatalogProvider[], supportedProtocols: string[] } | { status: 'unavailable', reason: string }

const unavailableCatalog: CatalogState = { status: 'unavailable', reason: '' }

/** 来源只按能拿到的证据下结论：命中当前运行时目录才叫目录路由，否则是"未确认"，不猜"插件"。 */
function routeSource(route: ProviderRouteView, catalog: CatalogState) {
  if (catalog.status !== 'ready')
    return 'unconfirmed' as const
  return catalog.providers.some(item => item.id === route.id) ? 'catalog' as const : 'unconfirmed' as const
}

/**
 * 运行时把该路由下的哪些字段声明为密钥。**只用于标注**，不参与任何写入判断。
 * 拿不到（实例停机、远端不支持、超时）时返回空，但界面必须靠 `roles.source` 把
 * "问过了、这个路由确实没有" 与 "没问到" 分开——把前者当成后者就是假结论。
 */
function secretPositions(roles: CredentialRoles | null, routeId: string) {
  if (roles === null || roles.source !== 'runtime')
    return []
  return roles.secretPaths
    .filter(entry => entry.ns === 'llm-pi-ai' && entry.path.length > 2 && entry.path[0] === 'providers' && entry.path[1] === routeId)
    .map(entry => entry.path.slice(2).join('.'))
}

export default function InstanceProviders({ instance, sharing, isRunning }: { instance: DshInstance, sharing: InstanceSharing | null, isRunning: boolean }) {
  const { t } = useTranslation()
  const [view, setView] = useState<InstanceProviderView | null>(null)
  const [catalog, setCatalog] = useState<CatalogState | null>(null)
  const [roles, setRoles] = useState<CredentialRoles | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [editing, setEditing] = useState('')
  const [mode, setMode] = useState<'list' | 'import' | 'add'>('list')
  const [query, setQuery] = useState('')
  const [operationBusy, setOperationBusy] = useState(false)

  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // 目录拿不到只影响"来源"这一列与编辑能力，不该让整页读不出真实配置，因此两个请求独立失败。
        const [providers, runtimeCatalog, credentialRoles] = await Promise.all([
          invoke<InstanceProviderView>('read_instance_providers', { instanceId: instance.id }),
          invoke<CatalogResponse>('list_runtime_catalog')
            .then(result => ({ status: 'ready', providers: result.providers, supportedProtocols: result.supportedProtocols }) as CatalogState)
            .catch(() => unavailableCatalog),
          // 机会性增强：拿不到就当成没问到，绝不影响本页读出真实配置。
          invoke<CredentialRoles>('read_instance_credential_roles', { instanceId: instance.id }).catch(() => null),
        ])
        if (cancelled)
          return
        setView(providers)
        setCatalog(runtimeCatalog)
        setRoles(credentialRoles)
        setError('')
        setLoading(false)
      }
      catch (reason: unknown) {
        if (cancelled)
          return
        setError(String(reason))
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [instance.id, reloadKey])

  function refresh() {
    setLoading(true)
    setReloadKey(key => key + 1)
  }

  const filteredRoutes = view?.routes.filter(item => `${item.id} ${item.displayName} ${item.baseUrl}`.toLowerCase().includes(query.toLowerCase())) ?? []
  const route = filteredRoutes.find(item => item.id === selected) ?? filteredRoutes[0]
  const routeProvider = catalog?.status === 'ready' ? catalog.providers.find(item => item.id === route?.id) : undefined
  const isEditing = route !== undefined && editing === route.id

  if (isEditing && view) {
    return (
      <>
        <PageHeader title={`${instance.name} · ${route.displayName || route.id}`} description={t('providers.edit.action')} />
        <ProviderEdit
          key={route.id}
          instanceId={instance.id}
          route={route}
          provider={routeProvider}
          supportedProtocols={catalog?.status === 'ready' ? catalog.supportedProtocols : []}
          view={view}
          disabled={isRunning}
          onApplied={() => {
            refresh()
            setEditing('')
          }}
          onClose={() => setEditing('')}
        />
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={`${instance.name} · ${t('launcher.instance_providers.title')}`}
        actions={(
          <Button
            size="sm"
            variant="outline"
            className="h-9 rounded-md"
            isDisabled={loading || operationBusy}
            onPress={refresh}
          >
            <ArrowRotateRight className={`size-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} />
            {t('launcher.instance_providers.refresh')}
          </Button>
        )}
      />
      <details className="mb-3 text-xs text-[var(--launcher-muted)]">
        <summary className="cursor-pointer">{t('providers.help')}</summary>
        <p>{t('launcher.instance_providers.scope_note')}</p>
      </details>

      {isRunning && <StatusNotice className="mb-4" message={t('launcher.instance_providers.running_readonly')} />}
      {sharing !== null && (
        <StatusNotice className="mb-4" tone="neutral" message={t('launcher.instance_providers.shared_home')} />
      )}
      {view !== null && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {mode === 'list' && <input aria-label={t('providers.search')} placeholder={t('providers.search')} className="h-9 min-w-0 flex-1 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3" value={query} onChange={event => setQuery(event.target.value)} />}
            <Button className="h-9 rounded-md" variant={mode === 'list' ? 'primary' : 'outline'} isDisabled={operationBusy} onPress={() => setMode(mode === 'list' ? 'import' : 'list')}>{t(mode === 'list' ? 'providers.add' : 'providers.back_list')}</Button>
            {mode !== 'list' && (
              <>
                <Button variant={mode === 'import' ? 'secondary' : 'ghost'} isDisabled={operationBusy} onPress={() => setMode('import')}>{t('providers.import')}</Button>
                <Button variant={mode === 'add' ? 'secondary' : 'ghost'} isDisabled={isRunning || operationBusy} onPress={() => setMode('add')}>{t('providers.new_configuration')}</Button>
              </>
            )}
          </div>
          {mode === 'import' && (
            <ProviderImport
              onBusy={setOperationBusy}
              instanceId={instance.id}
              disabled={isRunning}
              onApplied={() => {
                refresh()
                setMode('list')
              }}
            />
          )}
          {mode === 'add' && (
            <ProviderAdd
              onBusy={setOperationBusy}
              initialOpen
              instanceId={instance.id}
              disabled={isRunning}
              onApplied={() => {
                refresh()
                setMode('list')
              }}
            />
          )}
        </>
      )}

      {error !== '' && <ErrorBanner className="mb-4" message={t('launcher.instance_providers.load_failed')} detail={error} />}
      {loading && view === null && <p role="status" className="m-0 py-8 text-center text-sm text-[var(--launcher-muted)]">{t('launcher.processing')}</p>}

      {view !== null && mode === 'list' && (
        <>
          <div className="mb-3 border-b border-[var(--launcher-border)]">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 text-sm">
                <span className="text-xs text-[var(--launcher-muted)]">{t('launcher.instance_providers.default_model')}</span>
                {view.defaultModel.declared
                  ? (
                      <span className="ml-2 font-medium">
                        {view.defaultModel.provider}
                        {' · '}
                        {view.defaultModel.model}
                        {view.defaultModel.reasoningEffort !== '' && ` · ${view.defaultModel.reasoningEffort}`}
                      </span>
                    )
                  : <span className="text-[var(--launcher-muted)]">{t('launcher.instance_providers.default_model_unset')}</span>}
              </div>
              {view.defaultModel.declared && <StatusBadge tone={view.defaultModel.providerStatus === 'known' ? 'success' : 'neutral'}>{t(`launcher.instance_providers.default_status.${view.defaultModel.providerStatus}`)}</StatusBadge>}
            </div>
          </div>

          {catalog?.status === 'unavailable' && (
            <StatusNotice className="mb-4" tone="neutral" message={t('launcher.instance_providers.catalog_unavailable')} />
          )}

          {filteredRoutes.length === 0
            ? (
                <p className="m-0 rounded-md border border-dashed border-[var(--launcher-border)] p-8 text-center text-sm text-[var(--launcher-muted)]">{t(query ? 'providers.no_results' : 'launcher.instance_providers.empty')}</p>
              )
            : (
                <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
                  <ul className={`${selected ? 'hidden lg:block' : ''} m-0 max-h-[55vh] list-none space-y-2 overflow-y-auto p-0`}>
                    {filteredRoutes.map((item) => {
                      const source = routeSource(item, catalog ?? unavailableCatalog)
                      const active = item.id === route?.id
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            className={`w-full rounded-md px-3 py-3 text-left transition-colors motion-reduce:transition-none ${active ? 'bg-[var(--launcher-selected)]' : 'hover:bg-[var(--launcher-surface)]'}`}
                            onClick={() => {
                              // 换路由就收起上一条的编辑面板：表单初值来自回读，留着会变成陈旧状态。
                              if (selected !== item.id)
                                setEditing('')
                              setSelected(item.id)
                            }}
                          >
                            <span className="block min-w-0 truncate text-sm font-medium">{item.displayName || item.id}</span>
                            <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--launcher-muted)]">
                              <span>{t(`launcher.instance_providers.source.${source}`)}</span>
                              {item.credential.source === 'unverifiable' && <StatusBadge tone="danger">{t('launcher.instance_providers.credential.unverifiable')}</StatusBadge>}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>

                  {route && (
                    <SectionCard
                      className={selected ? 'min-w-0' : 'hidden min-w-0 lg:block'}
                      title={route.displayName || route.id}
                      description={route.id}
                      actions={!isEditing && !isRunning && (
                        <Button size="sm" variant="outline" className="h-8 rounded-md" onPress={() => setEditing(route.id)}>
                          <PencilToSquare className="size-4" />
                          {t('providers.edit.action')}
                        </Button>
                      )}
                    >
                      <Button className="mb-3 lg:hidden" variant="outline" onPress={() => setSelected('')}>{t('providers.back_list')}</Button>
                      <dl className="m-0 grid gap-2 text-sm">
                        <Row label={t('launcher.instance_providers.field_endpoint')} value={route.baseUrl || t(catalog?.status === 'ready' ? 'launcher.instance_providers.inherited_from_catalog' : 'launcher.instance_providers.not_pinned')} />
                        <Row label={t('launcher.instance_providers.field_protocol')} value={route.protocol || t(catalog?.status === 'ready' ? 'launcher.instance_providers.inherited_from_catalog' : 'launcher.instance_providers.not_pinned')} />
                        <Row label={t('launcher.instance_providers.field_models')} value={route.selection === 'subset' ? `${t('launcher.instance_providers.selection_subset')} · ${route.modelIds.length}` : t('launcher.instance_providers.selection_all')} />
                        {route.overrides.length > 0 && <Row label={t('launcher.instance_providers.field_overrides')} value={String(route.overrides.length)} />}
                        <Row label={t('launcher.instance_providers.field_credential_ref')} value={route.credential.declared ? route.credential.ref : t('launcher.instance_providers.credential.ambient')} />
                      </dl>
                      <details className="mt-4 text-xs text-[var(--launcher-muted)]">
                        <summary className="cursor-pointer">{t('providers.advanced_details')}</summary>
                        {route.unknownFields.length > 0 && (
                          <p className="m-0 mt-4 rounded-md border border-[var(--launcher-border)] p-3 text-xs leading-5 text-[var(--launcher-muted)]">
                            {t('launcher.instance_providers.foreign_fields', { fields: route.unknownFields.join(', ') })}
                          </p>
                        )}
                        {roles !== null && (
                          <p className="m-0 mt-2 text-xs leading-5 text-[var(--launcher-muted)]">
                            {roles.source === 'runtime'
                              ? t(secretPositions(roles, route.id).length > 0 ? 'launcher.instance_providers.roles_runtime' : 'launcher.instance_providers.roles_runtime_none', { fields: secretPositions(roles, route.id).join(', ') })
                              : t('launcher.instance_providers.roles_unavailable')}
                          </p>
                        )}
                      </details>
                      {route.selection === 'subset' && route.modelIds.length > 0 && (
                        <details className="mt-4 text-sm">
                          <summary className="cursor-pointer text-[var(--launcher-muted)]">{t('providers.models_selected', { count: route.modelIds.length })}</summary>
                          <div className="mt-2 flex max-h-52 flex-wrap gap-2 overflow-y-auto">
                            {route.modelIds.map(model => <code key={model} className="rounded border border-[var(--launcher-border)] px-2 py-0.5 text-xs break-all">{model}</code>)}
                          </div>
                        </details>
                      )}

                      <ProviderRemove key={route.id} instanceId={instance.id} route={route} view={view} disabled={isRunning} onApplied={refresh} />
                    </SectionCard>
                  )}
                </div>
              )}

          {view.unreferencedCredentialRefs.length > 0 && (
            <p className="m-0 mt-5 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.instance_providers.unreferenced_refs', { count: view.unreferencedCredentialRefs.length })}</p>
          )}
        </>
      )}
    </>
  )
}

function Row(props: { label: string, value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="min-w-[120px] text-xs text-[var(--launcher-muted)]">{props.label}</dt>
      <dd className="m-0 min-w-0 flex-1 break-all">{props.value}</dd>
    </div>
  )
}
