import type { DshInstance } from '../store/modules/launcher/types'
import { ChevronLeft, ChevronRight, Power, Rocket, TrashBin, Wrench } from '@gravity-ui/icons'
import { Button, Modal, Spinner, useOverlayState } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { updater } from '@/store/modules/updater'
import { formatDshVersionLabel } from '@/utils/dsh-version'
import { runViewTransition } from '@/utils/view-transition'
import InstanceSettings from './instance-settings'
import InstanceWizard, { SharingNotice } from './instance-wizard'

interface InstanceManagerProps {
  onGoDownloads?: () => void
}

export default function InstanceManager({ onGoDownloads }: InstanceManagerProps) {
  const { t } = useTranslation()
  const { registry, error, sharing, runningInstanceIds, runningInstancePorts, busyInstanceId } = useStore(store.launcher)
  const { updating: dshUpdating } = useStore(updater)
  const [creating, setCreating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [instanceSidebarOpen, setInstanceSidebarOpen] = useState(true)
  const [settingsSection, setSettingsSection] = useState<'environment' | 'export'>('environment')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [confirmBeforeRemoval, setConfirmBeforeRemoval] = useState(true)
  const [dshVersion, setDshVersion] = useState<string | null>(null)
  const active = registry.instances.find(item => item.id === registry.activeInstanceId) ?? null
  const activePort = active ? runningInstancePorts[active.id] : undefined
  const activeIsRunning = active != null && runningInstanceIds.includes(active.id)
  // 宿主进程已启动但 Harness 尚未监听端口时，保持明确的启动中反馈。
  const activeIsStarting = activeIsRunning && activePort == null
  const activeLaunchRequested = active != null && busyInstanceId === active.id
  const activeIsBooting = activeIsStarting || activeLaunchRequested
  const groups = groupInstances(registry.instances)
  const affectedInstances = active ? registry.instances.filter(item => item.dshHome === active.dshHome) : []
  const sameHome = affectedInstances.length
  const sameProfile = active ? registry.instances.filter(item => item.dshHome === active.dshHome && item.profile === active.profile).length : 0
  const level = sameProfile > 1 ? 'shared_profile' : sameHome > 1 ? 'shared_home' : 'isolated'
  const runningAffected = affectedInstances.filter(item => runningInstanceIds.includes(item.id))
  const removeState = useOverlayState({
    isOpen: removeOpen,
    onOpenChange: setRemoveOpen,
  })
  useEffect(() => {
    void Promise.all([
      invoke<{ confirm_before_instance_removal?: boolean }>('get_app_config'),
      invoke<{ dsh_version: string | null }>('get_runtime_info'),
    ]).then(([config, runtime]) => {
      setConfirmBeforeRemoval(config.confirm_before_instance_removal ?? true)
      setDshVersion(runtime.dsh_version)
    }).catch(() => {})
  }, [])
  async function removeInstance() {
    if (!active)
      return
    setRemoving(true)
    let removed = false
    await runViewTransition(async () => {
      removed = await store.launcher.remove(active.id)
    })
    setRemoving(false)
    if (removed)
      setRemoveOpen(false)
  }

  function requestRemove() {
    if (!active)
      return
    if (confirmBeforeRemoval) {
      setRemoveOpen(true)
      return
    }
    void removeInstance()
  }

  function goToExport() {
    setRemoveOpen(false)
    setSettingsSection('export')
    setInstanceSidebarOpen(false)
    setSettingsOpen(true)
  }

  function openSettings() {
    setSettingsSection('environment')
    setInstanceSidebarOpen(false)
    setSettingsOpen(true)
  }

  function closeSettings() {
    setSettingsOpen(false)
    setInstanceSidebarOpen(true)
  }

  async function selectInstance(id: string) {
    if (id === active?.id)
      return
    await store.launcher.select(id)
    if (store.launcher.registry.activeInstanceId === id) {
      if (settingsOpen)
        setInstanceSidebarOpen(false)
      else
        setSettingsOpen(false)
    }
  }

  const versionLabel = formatDshVersionLabel(t('launcher.latest_preview'), t('launcher.version_unavailable'), dshVersion)

  if (creating)
    return <InstanceWizard onCancel={() => setCreating(false)} />

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <aside className={`flex w-[210px] flex-none flex-col border-r border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] transition-transform duration-250 ease-out motion-reduce:transition-none ${settingsOpen ? `absolute inset-y-0 left-0 z-30 shadow-[8px_0_24px_rgba(35,55,75,0.14)] ${instanceSidebarOpen ? 'translate-x-0' : '-translate-x-full'}` : 'relative translate-x-0'}`}>
        <div className="border-b border-[var(--launcher-border)] px-5 py-4 text-xs font-semibold text-[var(--launcher-muted)]">{t('launcher.instances')}</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {groups.map(group => (
            <section key={group.id} className="mb-3 last:mb-0">
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--launcher-muted)]">{t(`launcher.instance_group.${group.id}`)}</div>
              {group.instances.map(instance => (
                <button
                  key={instance.id}
                  className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-3 text-left transition-[background-color,color,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none ${instance.id === active?.id ? 'translate-x-1 bg-[var(--launcher-selected)] text-[var(--launcher-ink)] shadow-[0_2px_8px_color-mix(in_srgb,var(--launcher-brand)_10%,transparent)] motion-reduce:translate-x-0' : 'text-[var(--launcher-muted)] hover:translate-x-0.5 hover:bg-white motion-reduce:hover:translate-x-0'}`}
                  type="button"
                  disabled={dshUpdating}
                  style={{ viewTransitionName: `launcher-${instance.id}` }}
                  onClick={() => selectInstance(instance.id)}
                >
                  <span className="grid size-9 flex-none place-items-center rounded-md bg-[var(--launcher-brand)] font-semibold text-white">{instance.name.slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{instance.name}</span>
                    <span className="block truncate text-xs opacity-70">{instance.profile}</span>
                  </span>
                  <If cond={runningInstanceIds.includes(instance.id)}><span className="size-2 rounded-full bg-ok" /></If>
                </button>
              ))}
            </section>
          ))}
        </div>
        <button className="m-3 h-10 rounded-md border border-[var(--launcher-border)] bg-white text-sm text-[var(--launcher-ink)] transition-colors hover:border-[var(--launcher-brand)] hover:text-[var(--launcher-brand-strong)] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={dshUpdating} onClick={() => setCreating(true)}>
          +
          {' '}
          {t('launcher.new_instance')}
        </button>
      </aside>

      {settingsOpen && (
        <button
          type="button"
          className={`absolute top-1/2 z-40 grid h-12 w-5 -translate-y-1/2 place-items-center rounded-r-md border border-l-0 border-[var(--launcher-border)] bg-[var(--launcher-surface)] text-[var(--launcher-brand-strong)] shadow-[3px_0_10px_rgba(35,55,75,0.12)] transition-[left,background-color] duration-250 ease-out hover:bg-[var(--launcher-selected)] motion-reduce:transition-none ${instanceSidebarOpen ? 'left-[210px]' : 'left-0'}`}
          aria-label={instanceSidebarOpen ? t('launcher.collapse_instances') : t('launcher.expand_instances')}
          aria-expanded={instanceSidebarOpen}
          onClick={() => setInstanceSidebarOpen(open => !open)}
        >
          {instanceSidebarOpen ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      )}

      {settingsOpen && active
        ? <InstanceSettings key={active.id} instance={active} sharing={sharing} isRunning={runningInstanceIds.includes(active.id)} dshVersion={dshVersion} initialSection={settingsSection} onBack={closeSettings} onGoDownloads={onGoDownloads} />
        : (
            <main key={`overview-${active?.id ?? 'empty'}`} className="launcher-content-enter min-w-0 flex-1 overflow-y-auto bg-[var(--launcher-canvas)] p-8 text-[var(--launcher-ink)]" style={{ viewTransitionName: 'launcher-instance-content' }}>
              <If cond={active != null}>
                <div className="mx-auto max-w-[900px]">
                  <div className="mb-7 flex items-start justify-between gap-6">
                    <div>
                      <div className="mb-2 text-xs font-semibold text-[var(--launcher-brand)]">{t('launcher.current_instance')}</div>
                      <h1 className="m-0 text-2xl font-semibold">{active?.name}</h1>
                      <p className="mt-2 text-sm text-[var(--launcher-muted)]">{activeIsBooting ? t('launcher.starting_instance_detail') : t('launcher.ready_description')}</p>
                    </div>
                    <div className="flex gap-2">
                      {activeIsBooting
                        ? (
                            <Button className="h-10 min-w-[148px] rounded-md border-[var(--launcher-border)] bg-white text-[var(--launcher-brand-strong)]" variant="outline" isDisabled>
                              <Spinner size="sm" color="current" />
                              {t('launcher.starting_instance')}
                            </Button>
                          )
                        : activeIsRunning
                          ? (
                              <Button className="h-10 rounded-md border-[var(--launcher-border)] bg-white text-danger" variant="outline" isDisabled={busyInstanceId != null || dshUpdating} onPress={() => { void store.launcher.stopInstance(active!.id) }}>
                                <Power />
                                {t('app.shutdown')}
                              </Button>
                            )
                          : (
                              <Button className="h-10 rounded-md bg-[var(--launcher-brand)] px-6 text-white" isDisabled={busyInstanceId != null || dshUpdating} onPress={() => { void store.launcher.launch() }}>
                                <Rocket />
                                {t('launcher.launch_instance')}
                              </Button>
                            )}
                    </div>
                  </div>
                  {activeIsBooting && (
                    <section className="mb-6 overflow-hidden rounded-lg border border-[var(--launcher-brand)]/25 bg-[var(--launcher-selected)]/65 p-4 shadow-[0_4px_16px_color-mix(in_srgb,var(--launcher-brand)_9%,transparent)]" aria-live="polite">
                      <div className="flex items-start gap-3">
                        <div className="grid size-9 flex-none place-items-center rounded-md bg-[var(--launcher-brand)] text-white">
                          <Spinner size="sm" color="current" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h2 className="m-0 text-sm font-semibold text-[var(--launcher-ink)]">{t('launcher.starting_instance')}</h2>
                            <span className="rounded-full bg-white/75 px-2 py-0.5 text-[11px] font-medium text-[var(--launcher-brand-strong)]">{active?.name}</span>
                          </div>
                          <p className="m-0 mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.starting_instance_port')}</p>
                        </div>
                      </div>
                      <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/70" role="progressbar" aria-label={t('launcher.starting_instance')}>
                        <div className="h-full w-2/5 animate-pulse rounded-full bg-[var(--launcher-brand)]" />
                      </div>
                    </section>
                  )}
                  <SharingNotice level={level} />
                  <OverviewTable
                    rows={[
                      { label: t('launcher.version'), value: versionLabel, accent: true },
                      { label: t('launcher.dsh_home'), value: active?.dshHome ?? '', mono: true },
                      { label: t('launcher.profile'), value: active?.profile ?? '', mono: true },
                      {
                        label: t('launcher.port'),
                        value: activeIsBooting
                          ? t('launcher.port_starting')
                          : activeIsRunning && activePort
                            ? t('launcher.port_running', { port: activePort })
                            : t('launcher.port_auto'),
                        accent: activeIsRunning && activePort != null,
                        mono: activeIsRunning && activePort != null,
                      },
                    ]}
                  />
                  <div className="mt-6 flex justify-between">
                    <Button
                      className="h-9 rounded-md border-[var(--launcher-border)] bg-white text-[var(--launcher-ink)]"
                      variant="outline"
                      isDisabled={runningInstanceIds.includes(active?.id ?? '') || busyInstanceId != null || dshUpdating}
                      onPress={openSettings}
                    >
                      <Wrench />
                      {t('launcher.instance_settings')}
                    </Button>
                    <Button
                      className="launcher-danger-action h-9 rounded-md text-danger"
                      variant="ghost"
                      isDisabled={runningInstanceIds.includes(active?.id ?? '') || busyInstanceId != null || dshUpdating}
                      onPress={requestRemove}
                    >
                      <TrashBin />
                      {t('launcher.remove_instance')}
                    </Button>
                  </div>
                  <If cond={error !== ''}><p className="mt-4 text-xs text-danger">{error}</p></If>
                </div>
              </If>
            </main>
          )}
      <Modal state={removeState}>
        <Modal.Backdrop isDismissable={!removing}>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('launcher.remove_instance_title')}</Modal.Heading>
                <Modal.CloseTrigger isDisabled={removing} />
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <p className="m-0 text-sm text-[var(--launcher-muted)]">{t('launcher.remove_instance_export_prompt')}</p>
                <code className="block break-all rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-canvas)] p-3 text-xs text-[var(--launcher-ink)]">{active?.dshHome}</code>
                <If cond={sameHome > 1}>
                  <p className="m-0 text-xs text-danger">{t('launcher.remove_instance_shared')}</p>
                  <div className="rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-canvas)] px-3 py-2 text-xs text-[var(--launcher-muted)]">
                    <div className="font-medium text-[var(--launcher-ink)]">{t('launcher.remove_instance_affected')}</div>
                    <div className="mt-1">{affectedInstances.map(item => `${item.name} (${item.profile})`).join('、')}</div>
                  </div>
                </If>
                <If cond={runningAffected.length > 0}>
                  <p className="m-0 text-xs text-danger">{t('launcher.remove_instance_running')}</p>
                </If>
              </Modal.Body>
              <Modal.Footer>
                <Button className="rounded-md" variant="tertiary" isDisabled={removing} onPress={() => setRemoveOpen(false)}>{t('launcher.cancel')}</Button>
                <Button className="launcher-danger-action rounded-md text-danger" variant="ghost" isDisabled={removing || runningAffected.length > 0} onPress={removeInstance}>
                  {removing ? t('launcher.removing_instance') : t('launcher.remove_without_export')}
                </Button>
                <Button className="rounded-md bg-[var(--launcher-brand)] text-white" isDisabled={removing} onPress={goToExport}>
                  {t('launcher.go_to_export')}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  )
}

interface OverviewRow {
  label: string
  value: string
  mono?: boolean
  accent?: boolean
}

function OverviewTable({ rows }: { rows: OverviewRow[] }) {
  return (
    <section className="mt-6 overflow-hidden rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] shadow-[0_1px_2px_color-mix(in_srgb,var(--launcher-ink)_5%,transparent)]">
      <dl className="m-0">
        {rows.map((row, index) => (
          <div key={row.label} className={`group grid min-h-[54px] grid-cols-[160px_minmax(0,1fr)] items-center transition-colors duration-150 hover:bg-[var(--launcher-selected)]/45 max-sm:grid-cols-1 max-sm:gap-1 max-sm:px-4 max-sm:py-3 ${index === rows.length - 1 ? '' : 'border-b border-[var(--launcher-border)]'}`}>
            <dt className="self-stretch bg-[var(--launcher-sidebar)]/55 px-5 py-[18px] text-xs font-medium text-[var(--launcher-muted)] max-sm:bg-transparent max-sm:p-0">{row.label}</dt>
            <dd className={`${row.mono ? 'font-mono text-xs' : 'text-sm'} m-0 min-w-0 break-all px-5 py-4 text-[var(--launcher-ink)] max-sm:p-0`}>
              <If cond={row.accent === true} then={<span className="inline-flex rounded-full bg-[var(--launcher-selected)] px-2.5 py-1 text-xs font-medium text-[var(--launcher-brand-strong)]">{row.value}</span>} else={row.value} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

type InstanceGroupId = 'isolated' | 'shared_home' | 'shared_profile'

function groupInstances(instances: readonly DshInstance[]): Array<{ id: InstanceGroupId, instances: DshInstance[] }> {
  const groups: Record<InstanceGroupId, DshInstance[]> = {
    isolated: [],
    shared_home: [],
    shared_profile: [],
  }
  for (const instance of instances) {
    const sameHome = instances.some(other => other.id !== instance.id && other.dshHome === instance.dshHome)
    const sameProfile = instances.some(other => other.id !== instance.id && other.dshHome === instance.dshHome && other.profile === instance.profile)
    groups[sameProfile ? 'shared_profile' : sameHome ? 'shared_home' : 'isolated'].push(instance)
  }
  return (['isolated', 'shared_home', 'shared_profile'] as const)
    .map(id => ({ id, instances: groups[id] }))
    .filter(group => group.instances.length > 0)
}
