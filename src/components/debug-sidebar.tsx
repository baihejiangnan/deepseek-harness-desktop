import type { PropsWithChildren, ReactNode } from 'react'
import { ArrowRotateRight, ArrowUpRightFromSquare, ChevronRight, Copy, Folder, Power, TrashBin } from '@gravity-ui/icons'
import { Button, Chip, Description, Drawer, Input, Link, ListBox, Select, Spinner, Surface, Switch } from '@heroui/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { toast } from '@/utils'

export interface RuntimeInfo {
  app_version: string
  dsh_version: string | null
  node_version: string
  service_url: string
  data_dir: string
  log_path: string
  platform: string
  arch: string
}

export interface CliLinkStatus {
  enabled: boolean
  shim_exists: boolean
  path_registered: boolean
  user_dsh_preserved: boolean
  bin_dir: string
  shim_path: string
}
export interface AppConfig {
  port: number
  auto_start: boolean
  cli_link_enabled: boolean
}

export function DebugSidebar(props: PropsWithChildren) {
  const { t, i18n } = useTranslation()
  const { serviceRunning, busyAction } = useStore(store.harness)
  const { updateInfo } = useStore(store.updater)

  const [port, setPort] = useState<number>(3080)

  const { data: info } = useQuery({
    queryKey: ['info'],
    queryFn: () => invoke<RuntimeInfo>('get_runtime_info'),
  })

  const { refetch: refreshConfig } = useQuery({
    queryKey: ['config'],
    queryFn: async () => {
      const config = await invoke<AppConfig>('get_app_config')
      setPort(config.port)
      return config
    },
  })

  const { data: cliStatus, refetch: refreshCliStatus } = useQuery({
    queryKey: ['cli_status'],
    queryFn: () => invoke<CliLinkStatus>('get_cli_link_status'),
  })
  const { data: logs, refetch: refreshLogs } = useQuery({
    queryKey: ['logs'],
    queryFn: () => invoke<string>('read_service_logs'),
    refetchInterval: 5000,
  })

  const { mutate: onClearLogs } = useMutation({
    mutationFn: async () => {
      await invoke('clear_service_logs')
      await refreshLogs()
      toast(t('messages.logs_cleared'), {})
    },
  })

  const { mutate: onToggleCliLink } = useMutation({
    mutationFn: async (enabled: boolean) => {
      await invoke<AppConfig>('update_app_config', { cliLinkEnabled: enabled })
      await refreshCliStatus()
    },
  })

  const { mutate: onCopyServiceUrl } = useMutation({
    mutationFn: async () => {
      await invoke('copy_service_url')
      toast(t('messages.copy_success'), {})
    },
  })

  const { mutate: onSavePort } = useMutation({
    mutationFn: async (port: number) => {
      await invoke<AppConfig>('update_app_config', { port })
      await refreshConfig()
      toast(t('messages.port_changed'), {
        variant: 'accent',
        description: t('messages.port_restart_hint'),
        timeout: 10_000,
        actionProps: {
          children: t('app.restart'),
          onPress: () => store.harness.restart(),
        },
      })
    },
  })

  const { mutate: onRevealDataDir } = useMutation({
    mutationFn: () => invoke('reveal_data_dir'),
  })

  return (
    <Drawer>
      {props.children}
      <Drawer.Backdrop>
        <Drawer.Content placement="left">
          <Drawer.Dialog>
            <Drawer.Header className="-mt-2">
              <Drawer.Heading>{t('app.debug_sidebar_title')}</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                    {t('ui.connection_status')}
                  </span>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={serviceRunning ? 'success' : 'danger'}
                    className="font-medium"
                  >
                    {serviceRunning ? t('ui.running') : t('ui.stopped')}
                  </Chip>
                </div>
                <div className="space-y-1.5">
                  <div className="flex gap-1.5">
                    <Input
                      readOnly
                      variant="secondary"
                      value={info?.service_url ?? '-'}
                      aria-label={t('ui.service_url')}
                      className="font-mono text-xs flex-1 rounded-md"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      className="rounded-md"

                      onPress={() => onCopyServiceUrl()}
                      aria-label={t('buttons.copy')}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-md"
                      isIconOnly
                      onPress={store.harness.openBrowser}
                      isDisabled={busyAction !== null}
                      aria-label={t('app.open_browser')}
                    >
                      {busyAction === 'openBrowser' ? <Spinner size="sm" color="current" /> : <ArrowUpRightFromSquare className="size-3.5" />}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <If cond={serviceRunning}>
                  <Button
                    size="sm"
                    variant="tertiary"
                    className="flex-1 rounded-md"
                    onPress={store.harness.restart}
                    isDisabled={busyAction !== null}
                  >
                    {busyAction === 'restart' ? <Spinner size="sm" color="current" /> : <ArrowRotateRight className="size-3.5" />}
                    {t('app.restart')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    className="flex-1 rounded-md"
                    onPress={store.harness.shutdown}
                    isDisabled={busyAction !== null}
                  >
                    {busyAction === 'shutdown' ? <Spinner size="sm" color="current" /> : <Power className="size-3.5" />}
                    {t('app.shutdown')}
                  </Button>
                </If>
              </div>
              <div className="border-t border-line/30" />
              <div>
                <dl className="space-y-1">
                  <InfoRow term={t('ui.current_version')}>{info?.app_version ?? '-'}</InfoRow>
                  <InfoRow term={t('ui.dsh_version')}>
                    <span>{info?.dsh_version ?? '-'}</span>
                    <If cond={updateInfo}>
                      <Link className="ml-2 text-[10px] text-[rgb(65,118,230)]" onClick={store.updater.showToast}>
                        存在新版本
                        <ChevronRight className="scale-75" />
                      </Link>
                    </If>

                  </InfoRow>
                  <InfoRow term={t('ui.node_version')}>{info?.node_version ? `v${info.node_version}` : '-'}</InfoRow>
                  <InfoRow term="Platform">
                    {info ? `${info.platform} / ${info.arch}` : '-'}
                  </InfoRow>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <dt className="shrink-0 min-w-[30%] text-muted font-medium">{t('ui.data_dir')}</dt>
                    <dd className="min-w-0 flex items-center gap-1">
                      <span className="truncate font-mono text-[11px] text-muted/80" title={info?.data_dir ?? '-'}>
                        {info?.data_dir ?? '-'}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        className="size-6 min-w-6 rounded-md"
                        aria-label={t('app.reveal_dir')}
                        onPress={() => onRevealDataDir()}
                      >
                        <Folder className="size-3.5" />
                      </Button>
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="border-t border-line/30" />
              <div className="space-y-1.5">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-ink">{t('ui.cli_link_enabled')}</span>
                    <Switch
                      isSelected={cliStatus?.enabled ?? false}
                      onChange={onToggleCliLink}
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                      </Switch.Content>
                    </Switch>
                  </div>
                  {cliStatus && (
                    <div className="flex flex-col">
                      <If
                        cond={!cliStatus.user_dsh_preserved}
                        else={(
                          <Description className="text-[10px] text-muted/70">
                            {t('ui.cli_link_user_dsh_preserved')}
                          </Description>
                        )}
                      >
                        <Description className="text-[10px] text-muted/70">{cliStatus.bin_dir}</Description>
                        <Description className="text-[10px] text-muted/70">
                          {t('ui.cli_link_hint')}
                        </Description>
                      </If>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-ink">{t('ui.port')}</span>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      variant="secondary"
                      value={String(port)}
                      onChange={e => setPort(Number(e.target.value))}
                      className="w-24 h-8 rounded-md [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      aria-label={t('ui.port')}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      className="rounded-md h-8"
                      onPress={() => onSavePort(port)}
                    >
                      {t('buttons.save')}
                    </Button>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink">{t('ui.language')}</span>
                  <Select
                    variant="secondary"
                    selectedKey={i18n.language}
                    onSelectionChange={key => i18n.changeLanguage(String(key))}
                    className="w-[80px]"
                  >
                    <Select.Trigger className="rounded-md min-h-8! h-8 py-0 items-center">
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover className="rounded-md">
                      <ListBox>
                        <ListBox.Item className="rounded-md min-h-8!" id="zh-CN" textValue="中文">中文</ListBox.Item>
                        <ListBox.Item className="rounded-md min-h-8!" id="en-US" textValue="English">English</ListBox.Item>
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>
              </div>

              <div className="border-t border-line/30" />

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink">{t('ui.logs')}</span>
                  <div className="flex gap-1">
                    <Button
                      isIconOnly
                      size="sm"
                      className="rounded-md size-6"
                      variant="ghost"
                      onPress={async () => {
                        await navigator.clipboard.writeText(logs || '')
                        toast(t('messages.logs_copied'), {})
                      }}
                    >
                      <Copy className="scale-80" />
                    </Button>
                    <Button
                      isIconOnly
                      size="sm"
                      className="rounded-md size-6"
                      variant="ghost"
                      onPress={() => refreshLogs()}
                    >
                      <ArrowRotateRight className="scale-80" />
                    </Button>
                    <Button
                      isIconOnly
                      size="sm"
                      className="rounded-md size-6"
                      variant="ghost"
                      onPress={() => onClearLogs()}
                    >
                      <TrashBin className="scale-80" />
                    </Button>
                  </div>
                </div>
                <Surface className="bg-default rounded-md p-2 min-h-[140px] max-h-[180px] font-mono text-[11px] w-full leading-relaxed overflow-auto">
                  {logs || t('ui.no_logs')}
                </Surface>
              </div>

            </Drawer.Body>
            <Drawer.Footer>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  )
}

function InfoRow({ term, children }: { term: string, children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs py-0.5">
      <dt className="shrink-0 text-muted font-medium">{term}</dt>
      <dd className="min-w-0 break-all text-ink text-right font-mono">{children}</dd>
    </div>
  )
}
