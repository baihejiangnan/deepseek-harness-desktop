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
import { errorBannerDetail, errorHasCode, errorText } from '@/utils/error-codes'
import { runViewTransition } from '@/utils/view-transition'
import InstanceSettings from './instance-settings'
import InstanceWizard, { SharingNotice } from './instance-wizard'
import { ErrorBanner, PageHeader, StatusBadge } from './launcher-ui'

interface InstanceManagerProps {
  onGoDownloads?: () => void
}

export default function InstanceManager({ onGoDownloads }: InstanceManagerProps) {
  const { t } = useTranslation()
  const { registry, error, sharing, runningInstanceIds, runningInstancePorts, busyInstanceId, launchFailure, installProgress } = useStore(store.launcher)
  const { updating: dshUpdating } = useStore(updater)
  const [creating, setCreating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [instanceSidebarOpen, setInstanceSidebarOpen] = useState(true)
  const [settingsSection, setSettingsSection] = useState<'environment' | 'export'>('environment')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [confirmBeforeRemoval, setConfirmBeforeRemoval] = useState(true)
  const [dshVersion, setDshVersion] = useState<string | null>(null)
  const [failureAction, setFailureAction] = useState<'disable' | 'remove' | null>(null)
  const [failureActionError, setFailureActionError] = useState('')
  const [repairCopyStatus, setRepairCopyStatus] = useState('')
  const [failureHandledPlugins, setFailureHandledPlugins] = useState<string[]>([])
  const [failureRemovedPlugins, setFailureRemovedPlugins] = useState<string[]>([])
  const active = registry.instances.find(item => item.id === registry.activeInstanceId) ?? null
  const activePort = active ? runningInstancePorts[active.id] : undefined
  const activeIsRunning = active != null && runningInstanceIds.includes(active.id)
  // 宿主进程已启动但 Harness 尚未监听端口时，保持明确的启动中反馈。
  const activeIsStarting = activeIsRunning && activePort == null
  const activeIsBusy = active != null && busyInstanceId === active.id
  // busyInstanceId 覆盖启动与停止两条路径：仍在运行清单里的是停止中，否则是宿主尚未登记的启动中。
  const activeIsStopping = activeIsBusy && activeIsRunning
  const activeIsBooting = !activeIsStopping && (activeIsStarting || activeIsBusy)
  const groups = groupInstances(registry.instances)
  const affectedInstances = active ? registry.instances.filter(item => item.dshHome === active.dshHome) : []
  const sameHome = affectedInstances.length
  const sameProfile = active ? registry.instances.filter(item => item.dshHome === active.dshHome && item.profile === active.profile).length : 0
  const level = sameProfile > 1 ? 'shared_profile' : sameHome > 1 ? 'shared_home' : 'isolated'
  const runningAffected = affectedInstances.filter(item => runningInstanceIds.includes(item.id))
  // 守卫在删除入口内拒绝时弹窗仍保持打开，错误必须落在弹窗里，否则用户看不到任何反馈。
  // INSTANCE_HOME_RUNNING 在删除路径的载荷是一句说明而不是 `<id>:<name>`，因此仍用删除场景专用文案。
  const removalError = error === ''
    ? ''
    : errorHasCode(error, 'INSTANCE_HOME_RUNNING')
      ? t('launcher.remove_instance_leftover_running')
      : errorText(error)
  const removeState = useOverlayState({
    isOpen: removeOpen,
    onOpenChange: setRemoveOpen,
  })
  const failureState = useOverlayState({
    isOpen: launchFailure != null,
    onOpenChange(open) {
      if (!open && failureAction == null) {
        setFailureActionError('')
        setFailureHandledPlugins([])
        setFailureRemovedPlugins([])
        store.launcher.clearLaunchFailure()
      }
    },
  })
  const [previousLaunchFailure, setPreviousLaunchFailure] = useState(launchFailure)
  if (previousLaunchFailure !== launchFailure) {
    setPreviousLaunchFailure(launchFailure)
    setFailureHandledPlugins([])
    setFailureRemovedPlugins([])
    setFailureActionError('')
  }
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

  async function removeInstanceRegistryOnly() {
    if (!active)
      return
    setRemoving(true)
    let removed = false
    await runViewTransition(async () => {
      removed = await store.launcher.removeRegistryOnly(active.id)
    })
    setRemoving(false)
    if (removed)
      setRemoveOpen(false)
  }

  function requestRemove() {
    if (!active)
      return
    if (confirmBeforeRemoval) {
      // 弹窗内的反馈只应来自本次删除尝试，不带入此前其他操作的残留错误
      store.launcher.error = ''
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

  async function handleFailedPlugins(action: 'disable' | 'remove') {
    if (!launchFailure || launchFailure.plugins.length === 0 || failureAction != null)
      return
    setFailureAction(action)
    setFailureActionError('')
    try {
      const handled: string[] = []
      const errors: string[] = []
      for (const pluginId of launchFailure.plugins) {
        if ((action === 'disable' ? failureHandledPlugins : failureRemovedPlugins).includes(pluginId))
          continue
        if (action === 'disable') {
          try {
            await invoke('set_plugin_enabled_for_instance', {
              instanceId: launchFailure.instanceId,
              pluginId,
              enabled: false,
            })
            handled.push(pluginId)
            setFailureHandledPlugins(current => [...new Set([...current, pluginId])])
          }
          catch (error) {
            errors.push(`${pluginId}: ${String(error)}`)
          }
        }
        else {
          try {
            await invoke('remove_plugin_for_instance', {
              instanceId: launchFailure.instanceId,
              pluginId,
            })
            handled.push(pluginId)
            setFailureHandledPlugins(current => [...new Set([...current, pluginId])])
            setFailureRemovedPlugins(current => [...new Set([...current, pluginId])])
          }
          catch (error) {
            errors.push(`${pluginId}: ${String(error)}`)
          }
        }
      }
      setFailureHandledPlugins(current => [...new Set([...current, ...handled])])
      setFailureActionError(errors.join('\n'))
    }
    finally {
      setFailureAction(null)
    }
  }

  async function copyFailureLog() {
    if (!launchFailure)
      return
    try {
      const log = launchFailure.log || await invoke<string>('read_instance_startup_log', { instanceId: launchFailure.instanceId })
      await navigator.clipboard.writeText(log || launchFailure.message)
      setFailureActionError('')
    }
    catch (error) {
      setFailureActionError(String(error))
    }
  }

  async function copyRepairPrompt() {
    try {
      await navigator.clipboard.writeText(t('repair.prompt'))
      setRepairCopyStatus(t('repair.copied'))
    }
    catch {
      setRepairCopyStatus(t('repair.copy_failed'))
    }
  }

  async function retryFailedInstance() {
    if (!launchFailure || failureAction != null)
      return
    const instanceId = launchFailure.instanceId
    setFailureActionError('')
    setFailureHandledPlugins([])
    setFailureRemovedPlugins([])
    store.launcher.clearLaunchFailure()
    await store.launcher.launchInstance(instanceId, true)
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
                  <span className="grid size-9 flex-none place-items-center rounded-md bg-[var(--launcher-brand)] font-semibold text-[var(--launcher-on-brand)]">{instance.name.slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{instance.name}</span>
                    <span className="block truncate text-xs opacity-70">{instance.profile}</span>
                  </span>
                  <If cond={runningInstanceIds.includes(instance.id)}>
                    <span className="flex flex-none items-center gap-1.5 text-xs text-[var(--launcher-brand-strong)]">
                      <span className="size-2 rounded-full bg-ok" aria-hidden="true" />
                      {t('launcher.instance_status.running')}
                    </span>
                  </If>
                </button>
              ))}
            </section>
          ))}
        </div>
        <button className="m-3 h-10 rounded-md border border-[var(--launcher-border)] bg-white text-sm text-[var(--launcher-ink)] transition-colors motion-reduce:transition-none hover:border-[var(--launcher-brand)] hover:text-[var(--launcher-brand-strong)] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={dshUpdating} onClick={() => setCreating(true)}>
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
                  <PageHeader
                    className="mb-7"
                    title={active!.name}
                    description={activeIsBooting ? t('launcher.starting_instance_detail') : t('launcher.ready_description')}
                    status={(
                      <StatusBadge tone={activeIsBooting || activeIsStopping ? 'accent' : activeIsRunning ? 'success' : 'neutral'}>
                        {activeIsBooting
                          ? t('launcher.instance_status.booting')
                          : activeIsStopping
                            ? t('launcher.instance_status.stopping')
                            : activeIsRunning
                              ? t('launcher.instance_status.running')
                              : t('launcher.instance_status.stopped')}
                      </StatusBadge>
                    )}
                    actions={(
                      <>
                        {activeIsBooting || activeIsStopping
                          ? (
                              <Button className="h-10 min-w-[148px] rounded-md border-[var(--launcher-border)] bg-white text-[var(--launcher-brand-strong)]" variant="outline" isDisabled>
                                <Spinner size="sm" color="current" />
                                {activeIsStopping ? t('launcher.instance_status.stopping') : t('launcher.starting_instance')}
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
                                <Button className="h-10 rounded-md bg-[var(--launcher-brand)] px-6 text-[var(--launcher-on-brand)]" isDisabled={busyInstanceId != null || dshUpdating} onPress={() => { void store.launcher.launch() }}>
                                  <Rocket />
                                  {t('launcher.launch_instance')}
                                </Button>
                              )}
                      </>
                    )}
                  />
                  {activeIsBooting && (
                    <section className="mb-6 overflow-hidden rounded-lg border border-[var(--launcher-brand)]/25 bg-[var(--launcher-selected)]/65 p-4 shadow-[0_4px_16px_color-mix(in_srgb,var(--launcher-brand)_9%,transparent)]" aria-live="polite">
                      <div className="flex items-start gap-3">
                        <div className="grid size-9 flex-none place-items-center rounded-md bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]">
                          <Spinner size="sm" color="current" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h2 className="m-0 text-sm font-semibold text-[var(--launcher-ink)]">{t('launcher.starting_instance')}</h2>
                            <span className="rounded-full bg-white/75 px-2 py-0.5 text-[11px] font-medium text-[var(--launcher-brand-strong)]">{active?.name}</span>
                          </div>
                          {installProgress
                            ? (
                                <div className="mt-1 space-y-0.5">
                                  <p className="m-0 truncate text-xs leading-5 font-medium">{installProgress.title}</p>
                                  <If cond={installProgress.detail !== ''}>
                                    <p className="m-0 truncate text-xs leading-5 text-[var(--launcher-muted)]">{installProgress.detail}</p>
                                  </If>
                                </div>
                              )
                            : <p className="m-0 mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.starting_instance_port')}</p>}
                        </div>
                      </div>
                      <div className="mt-4 flex items-center gap-3">
                        <div
                          className="h-1 flex-1 overflow-hidden rounded-full bg-white/70"
                          role="progressbar"
                          aria-label={installProgress ? installProgress.title : t('launcher.starting_instance')}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={installProgress && !installProgress.indeterminate ? Math.round(installProgress.percentage) : undefined}
                        >
                          {installProgress && !installProgress.indeterminate
                            ? <div className="h-full rounded-full bg-[var(--launcher-brand)] transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${Math.round(installProgress.percentage)}%` }} />
                            : <div className="h-full w-2/5 animate-pulse rounded-full bg-[var(--launcher-brand)] motion-reduce:animate-none" />}
                        </div>
                        <If cond={installProgress != null && !installProgress.indeterminate}>
                          <span className="min-w-[42px] flex-none text-right text-xs font-medium tabular-nums text-[var(--launcher-brand-strong)]">
                            {Math.round(installProgress?.percentage ?? 0)}
                            %
                          </span>
                        </If>
                      </div>
                    </section>
                  )}
                  <SharingNotice level={level} />
                  {active?.repairAssistant && (
                    <section className="mt-4 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="m-0 text-sm font-semibold">{t('repair.title')}</h2>
                        <Button className="rounded-md" variant="outline" onPress={() => { void copyRepairPrompt() }}>{t('repair.copy')}</Button>
                      </div>
                      <p className="mb-0 text-xs leading-6 text-[var(--launcher-muted)]">{t('repair.instructions')}</p>
                      <p role="status" className="mb-0 text-xs text-[var(--launcher-muted)]">{repairCopyStatus}</p>
                    </section>
                  )}
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
                  <If cond={error !== ''}><ErrorBanner className="mt-4" message={removalError} detail={errorBannerDetail(error)} /></If>
                </div>
              </If>
            </main>
          )}
      <Modal state={removeState}>
        <Modal.Backdrop isDismissable={!removing}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('launcher.remove_instance_title')}</Modal.Heading>
                <Modal.CloseTrigger isDisabled={removing} />
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <p className="m-0 text-sm text-danger">{t('launcher.remove_instance_description')}</p>
                <p className="m-0 text-sm text-[var(--launcher-muted)]">{t('launcher.remove_instance_export_prompt')}</p>
                <div className="rounded-md border border-[var(--launcher-brand)]/25 bg-[var(--launcher-selected)]/60 p-3 text-xs leading-5 text-[var(--launcher-ink)]">
                  <div className="font-semibold">{t('launcher.remove_instance_registry_only_title')}</div>
                  <div className="mt-1 text-[var(--launcher-muted)]">{t('launcher.remove_instance_registry_only_description')}</div>
                </div>
                <code className="block break-all rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-canvas)] p-3 text-xs text-[var(--launcher-ink)]">{active?.dshHome}</code>
                <If cond={sameHome > 1}>
                  <p className="m-0 text-xs text-danger">{t('launcher.remove_instance_shared')}</p>
                  <div className="rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-canvas)] px-3 py-2 text-xs text-[var(--launcher-muted)]">
                    <div className="font-medium text-[var(--launcher-ink)]">{t('launcher.remove_instance_affected')}</div>
                    <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
                      {affectedInstances.map(item => (
                        <li key={item.id} className="min-w-0 break-words">
                          {item.name}
                          <span className="text-[var(--launcher-muted)]">
                            {' · '}
                            {item.profile}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </If>
                <If cond={runningAffected.length > 0}>
                  <p className="m-0 text-xs text-danger">{t('launcher.remove_instance_running')}</p>
                </If>
                <If cond={removalError !== ''}>
                  <p className="m-0 text-xs text-danger">{removalError}</p>
                </If>
              </Modal.Body>
              <Modal.Footer>
                <Button className="rounded-md" variant="tertiary" isDisabled={removing} onPress={() => setRemoveOpen(false)}>{t('launcher.cancel')}</Button>
                <Button className="launcher-danger-action rounded-md text-danger" variant="ghost" isDisabled={removing || runningAffected.length > 0} onPress={removeInstance}>
                  {removing ? t('launcher.removing_instance') : t('launcher.remove_without_export')}
                </Button>
                <Button className="rounded-md" variant="outline" isDisabled={removing || runningAffected.length > 0} onPress={removeInstanceRegistryOnly}>
                  {removing ? t('launcher.removing_instance') : t('launcher.remove_registry_only')}
                </Button>
                <Button className="rounded-md bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]" isDisabled={removing} onPress={goToExport}>
                  {t('launcher.go_to_export')}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <Modal state={failureState}>
        <Modal.Backdrop isDismissable={failureAction == null}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>{t('launcher.launch_failure_title')}</Modal.Heading>
                <Modal.CloseTrigger isDisabled={failureAction != null} />
              </Modal.Header>
              <Modal.Body className="space-y-4">
                <p className="m-0 text-sm text-[var(--launcher-muted)]">{t('launcher.launch_failure_description')}</p>
                <div className="max-h-48 overflow-y-auto break-words rounded-md border border-danger/25 bg-danger/5 p-3 text-sm text-[var(--launcher-ink)]">
                  {launchFailure?.message}
                </div>
                {launchFailure && launchFailure.plugins.length > 0
                  ? (
                      <div className="min-w-0">
                        <div className="mb-2 text-xs font-semibold text-[var(--launcher-muted)]">{t('launcher.launch_failure_plugins')}</div>
                        <div className="flex flex-wrap gap-2">
                          {launchFailure.plugins.map(plugin => (
                            <code key={plugin} className="rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-canvas)] px-2.5 py-1.5 text-xs text-[var(--launcher-ink)]">
                              {plugin}
                              {failureHandledPlugins.includes(plugin) ? ` · ${t('launcher.launch_failure_handled')}` : ''}
                            </code>
                          ))}
                        </div>
                        <p className="my-3 text-xs text-[var(--launcher-muted)]">{t('launcher.launch_failure_repair_hint')}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button className="rounded-md border-[var(--launcher-border)] bg-[var(--launcher-surface)] text-[var(--launcher-ink)]" variant="outline" isDisabled={failureAction != null || failureHandledPlugins.length === launchFailure.plugins.length} onPress={() => { void handleFailedPlugins('disable') }}>
                            {failureAction === 'disable' ? t('launcher.processing') : t('launcher.launch_failure_disable')}
                          </Button>
                          <Button className="launcher-danger-action rounded-md text-danger" variant="ghost" isDisabled={failureAction != null || failureRemovedPlugins.length === launchFailure.plugins.length} onPress={() => { void handleFailedPlugins('remove') }}>
                            {failureAction === 'remove' ? t('launcher.processing') : t('launcher.launch_failure_remove')}
                          </Button>
                        </div>
                      </div>
                    )
                  : <p className="m-0 text-xs text-[var(--launcher-muted)]">{t('launcher.launch_failure_no_plugin')}</p>}
                <If cond={failureHandledPlugins.length > 0}><p className="m-0 text-xs text-success">{t('launcher.launch_failure_handled_count', { count: failureHandledPlugins.length })}</p></If>
                <If cond={failureActionError !== ''}><p className="m-0 whitespace-pre-wrap text-xs text-danger">{failureActionError}</p></If>
              </Modal.Body>
              <Modal.Footer className="flex-wrap gap-2">
                <Button className="rounded-md" variant="tertiary" isDisabled={failureAction != null} onPress={() => { void copyFailureLog() }}>{t('launcher.launch_failure_copy_log')}</Button>
                <Button className="rounded-md bg-[var(--launcher-brand)] text-[var(--launcher-on-brand)]" isDisabled={failureAction != null} onPress={() => { void retryFailedInstance() }}>{t('launcher.launch_failure_retry')}</Button>
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
          <div key={row.label} className={`group grid min-h-[54px] grid-cols-[160px_minmax(0,1fr)] items-center transition-colors motion-reduce:transition-none duration-150 hover:bg-[var(--launcher-selected)]/45 max-sm:grid-cols-1 max-sm:gap-1 max-sm:px-4 max-sm:py-3 ${index === rows.length - 1 ? '' : 'border-b border-[var(--launcher-border)]'}`}>
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
