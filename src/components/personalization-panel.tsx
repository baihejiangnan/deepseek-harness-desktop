import { Gear, Palette } from '@gravity-ui/icons'
import { Button, ListBox, Select } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { saveStatusLabel, useSaveStatus } from '@/utils/save-status'
import { ErrorBanner, PageHeader, StatusBadge } from './launcher-ui'
import ProviderTemplates from './provider-templates'

interface PersonalizationConfig {
  language: 'zh-CN' | 'en-US'
  launcher_opacity: number
  startup_mode: 'manager' | 'last_instance'
  launcher_theme: LauncherTheme
  launcher_blur: boolean
  confirm_before_instance_removal: boolean
}

type LauncherTheme
  = 'lake-blue-soft-pink' | 'turquoise-ice-blue' | 'rose-red-snow-white'
    | 'mint-orange-gold' | 'mint-peacock-green' | 'deep-blue-soft-pink'
    | 'mist-blue-sakura-pink' | 'mist-cyan-light-green' | 'sage-light-yellow'
    | 'pale-blue-mint' | 'aqua-green-almond' | 'neon-aqua-green' | 'deep-green-mist'
    | 'mist-blue' | 'forest-teal' | 'charcoal' | 'warm-clay' | 'rose-gray'

type SettingsSection = 'settings' | 'personalization' | 'providers'

const themeOptions: Array<{ id: LauncherTheme, nameKey: string, colors: [string, string, string] }> = [
  { id: 'lake-blue-soft-pink', nameKey: 'lake_blue_soft_pink', colors: ['#27a6cc', '#80bfd4', '#fcc5c5'] },
  { id: 'turquoise-ice-blue', nameKey: 'turquoise_ice_blue', colors: ['#18a271', '#66d4bd', '#b4fffa'] },
  { id: 'rose-red-snow-white', nameKey: 'rose_red_snow_white', colors: ['#ff3d58', '#ff9cab', '#ffffff'] },
  { id: 'mint-orange-gold', nameKey: 'mint_orange_gold', colors: ['#2ad4af', '#89d891', '#fcbd60'] },
  { id: 'mint-peacock-green', nameKey: 'mint_peacock_green', colors: ['#95ffc3', '#47dca7', '#00af83'] },
  { id: 'deep-blue-soft-pink', nameKey: 'deep_blue_soft_pink', colors: ['#303d67', '#79799a', '#fddfdc'] },
  { id: 'mist-blue-sakura-pink', nameKey: 'mist_blue_sakura_pink', colors: ['#5b83b8', '#9db4d8', '#ffd4e3'] },
  { id: 'mist-cyan-light-green', nameKey: 'mist_cyan_light_green', colors: ['#81bdb3', '#bdd9bd', '#ecf6ce'] },
  { id: 'sage-light-yellow', nameKey: 'sage_light_yellow', colors: ['#a8d5ba', '#d7e8bd', '#fff3c7'] },
  { id: 'pale-blue-mint', nameKey: 'pale_blue_mint', colors: ['#8ac4e2', '#b5dbe5', '#d3eed9'] },
  { id: 'aqua-green-almond', nameKey: 'aqua_green_almond', colors: ['#19beb8', '#88d3c6', '#fcdfc5'] },
  { id: 'neon-aqua-green', nameKey: 'neon_aqua_green', colors: ['#3afff2', '#31dcb9', '#26af84'] },
  { id: 'deep-green-mist', nameKey: 'deep_green_mist', colors: ['#047625', '#78bf77', '#e9ffe8'] },
]

export default function PersonalizationPanel() {
  const { t, i18n } = useTranslation()
  const [section, setSection] = useState<SettingsSection>('settings')
  const [opacity, setOpacity] = useState(100)
  const [startupMode, setStartupMode] = useState<PersonalizationConfig['startup_mode']>('manager')
  const [theme, setTheme] = useState<LauncherTheme>('mist-blue-sakura-pink')
  const [blur, setBlur] = useState(false)
  const [confirmBeforeRemoval, setConfirmBeforeRemoval] = useState(true)
  const [language, setLanguage] = useState<'zh-CN' | 'en-US'>('zh-CN')
  const save = useSaveStatus()

  const [configError, setConfigError] = useState('')

  async function load() {
    try {
      const config = await invoke<PersonalizationConfig>('get_app_config')
      setLanguage(config.language?.startsWith('en') ? 'en-US' : 'zh-CN')
      setOpacity(config.launcher_opacity ?? 100)
      setStartupMode(config.startup_mode ?? 'manager')
      setTheme(config.launcher_theme ?? 'mist-blue-sakura-pink')
      setBlur(config.launcher_blur ?? false)
      setConfirmBeforeRemoval(config.confirm_before_instance_removal ?? true)
      setConfigError('')
    }
    catch (cause) {
      // 读失败不能接着让人保存：update_app_config 一次带走全部字段，
      // 而此刻表单里是默认值，写下去会把用户真正的设置静默改回默认。
      setConfigError(String(cause))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  function saveConfig(values: Partial<PersonalizationConfig>) {
    if (configError !== '')
      return
    // 失败已由 save 在页面上驻留展示；这里的 catch 只是避免未处理的 Promise 拒绝，不是吞掉反馈。
    void save.run(async () => {
      await invoke('update_app_config', {
        launcherOpacity: values.launcher_opacity,
        startupMode: values.startup_mode,
        launcherTheme: values.launcher_theme,
        launcherBlur: values.launcher_blur,
        confirmBeforeInstanceRemoval: values.confirm_before_instance_removal,
      })
      window.dispatchEvent(new Event('launcher-appearance-updated'))
    }).catch(() => {})
  }

  function changeOpacity(value: number) {
    setOpacity(value)
    void saveConfig({ launcher_opacity: value })
  }

  function changeStartupMode(value: PersonalizationConfig['startup_mode']) {
    setStartupMode(value)
    void saveConfig({ startup_mode: value })
  }

  function changeTheme(value: LauncherTheme) {
    setTheme(value)
    void saveConfig({ launcher_theme: value })
  }

  function changeBlur(value: boolean) {
    setBlur(value)
    void saveConfig({ launcher_blur: value })
  }

  function changeConfirmBeforeRemoval(value: boolean) {
    setConfirmBeforeRemoval(value)
    void saveConfig({ confirm_before_instance_removal: value })
  }

  function changeLanguage(value: 'zh-CN' | 'en-US') {
    setLanguage(value)
    void i18n.changeLanguage(value)
  }

  // 本页所有字段都是改动即写盘，因此只汇报状态、不提供"保存"按钮。
  const saveLabel = saveStatusLabel(save, { saving: t('ui.saving'), saved: t('launcher.personalization.saved'), failed: t('messages.save_failed') })
  const saveTone = save.phase === 'failed' ? 'danger' : save.phase === 'saved' ? 'success' : 'neutral'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-[var(--launcher-canvas)] text-[var(--launcher-ink)]">
      <nav className="w-[210px] flex-none border-r border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] p-3" aria-label={t('launcher.nav.settings')}>
        <div className="px-3 pb-3 pt-2 text-xs font-semibold text-[var(--launcher-muted)]">{t('launcher.nav.settings')}</div>
        {([
          { id: 'settings' as const, icon: Gear },
          { id: 'personalization' as const, icon: Palette },
          { id: 'providers' as const, icon: Gear },
        ]).map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm transition-[background-color,color,transform] duration-200 ease-out motion-reduce:transition-none ${section === item.id ? 'translate-x-1 bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)] motion-reduce:translate-x-0' : 'text-[var(--launcher-muted)] hover:translate-x-0.5 hover:bg-white motion-reduce:hover:translate-x-0'}`}
              onClick={() => setSection(item.id)}
            >
              <Icon className="size-4" />
              {t(`launcher.personalization.nav.${item.id}`)}
            </button>
          )
        })}
      </nav>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <div key={section} className="launcher-content-enter mx-auto max-w-[900px]">
          <PageHeader
            title={t(`launcher.personalization.${section}_title`)}
            description={t(`launcher.personalization.${section}_description`)}
            status={section === 'providers' || saveLabel == null ? undefined : <StatusBadge tone={saveTone}>{saveLabel}</StatusBadge>}
          />
          {save.phase === 'failed' && section !== 'providers' && (
            <ErrorBanner className="mb-5" message={t('messages.save_failed')} detail={save.error} />
          )}
          {configError !== '' && section !== 'providers' && (
            <ErrorBanner
              className="mb-5"
              message={t('launcher.personalization.load_failed')}
              detail={configError}
              action={<Button size="sm" variant="outline" onPress={() => { void load() }}>{t('buttons.retry')}</Button>}
            />
          )}

          {section === 'providers' && <ProviderTemplates />}
          {configError === '' && section === 'personalization' && (
            <section className="rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
              <h2 className="m-0 text-sm font-semibold">{t('launcher.personalization.appearance')}</h2>
              <div className="mt-5">
                <div className="text-xs font-medium">{t('launcher.personalization.color_theme')}</div>
                <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3" role="radiogroup" aria-label={t('launcher.personalization.color_theme')}>
                  {themeOptions.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={theme === item.id}
                      className={`group inline-flex h-8 items-center gap-2 rounded px-1 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--launcher-brand)]/35 motion-reduce:transition-none ${theme === item.id ? 'font-semibold text-[var(--launcher-brand-strong)]' : 'font-normal text-[var(--launcher-ink)] hover:text-[var(--launcher-brand-strong)]'}`}
                      onClick={() => changeTheme(item.id)}
                    >
                      <span
                        className={`h-6 w-14 flex-none rounded-md ${theme === item.id ? 'ring-2 ring-[var(--launcher-brand)] ring-offset-2 ring-offset-[var(--launcher-surface)]' : 'ring-1 ring-[var(--launcher-border)]'}`}
                        style={{ background: `linear-gradient(110deg, ${item.colors[0]}, ${item.colors[1]} 54%, ${item.colors[2]})` }}
                      />
                      <span>{t(`launcher.personalization.theme.${item.nameKey}`)}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.personalization.color_hint')}</p>
              </div>
              <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-md border border-[var(--launcher-border)] bg-white/60 px-4 py-3">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--launcher-brand)]" checked={blur} onChange={event => changeBlur(event.target.checked)} />
                <span>
                  <span className="block text-sm font-medium">{t('launcher.personalization.blur')}</span>
                  <span className="mt-1 block text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.personalization.blur_hint')}</span>
                </span>
              </label>
              <div className="mt-5">
                <div className="flex items-center justify-between text-sm">
                  <label htmlFor="launcher-opacity" className="font-medium">{t('launcher.personalization.opacity')}</label>
                  <span className="font-mono text-xs text-[var(--launcher-muted)]">
                    {opacity}
                    %
                  </span>
                </div>
                <input
                  id="launcher-opacity"
                  className="mt-3 h-2 w-full accent-[var(--launcher-brand)]"
                  type="range"
                  min="20"
                  max="100"
                  step="5"
                  value={opacity}
                  onChange={event => changeOpacity(Number(event.target.value))}
                />
                <p className="mt-2 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.personalization.opacity_hint')}</p>
              </div>
            </section>
          )}

          {configError === '' && section === 'settings' && (
            <section className="rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
              <h2 className="m-0 text-sm font-semibold">{t('launcher.personalization.startup')}</h2>
              <p className="mt-2 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.personalization.startup_hint')}</p>
              <label className="mt-4 block text-sm">
                <span className="mb-2 block text-xs font-medium">{t('launcher.personalization.startup_mode')}</span>
                <Select
                  selectedKey={startupMode}
                  onSelectionChange={key => changeStartupMode(String(key) as PersonalizationConfig['startup_mode'])}
                  className="launcher-select w-full"
                >
                  <Select.Trigger className="h-10 rounded-md">
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover className="launcher-select-popover rounded-md">
                    <ListBox>
                      <ListBox.Item id="manager" textValue={t('launcher.personalization.startup_manager')} className="rounded-md">
                        {t('launcher.personalization.startup_manager')}
                      </ListBox.Item>
                      <ListBox.Item id="last_instance" textValue={t('launcher.personalization.startup_last_instance')} className="rounded-md">
                        {t('launcher.personalization.startup_last_instance')}
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              </label>
            </section>
          )}

          {section === 'settings' && (
            <section className="mt-5 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
              <h2 className="m-0 text-sm font-semibold">{t('launcher.personalization.language')}</h2>
              <p className="mt-2 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.personalization.language_hint')}</p>
              <Select selectedKey={language} onSelectionChange={key => changeLanguage(String(key) as 'zh-CN' | 'en-US')} className="launcher-select mt-4 w-full">
                <Select.Trigger className="h-10 rounded-md">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover className="launcher-select-popover rounded-md">
                  <ListBox>
                    <ListBox.Item id="zh-CN" textValue={t('launcher.personalization.language_zh')} className="rounded-md">{t('launcher.personalization.language_zh')}</ListBox.Item>
                    <ListBox.Item id="en-US" textValue={t('launcher.personalization.language_en')} className="rounded-md">{t('launcher.personalization.language_en')}</ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
            </section>
          )}

          {section === 'settings' && (
            <section className="mt-5 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] p-6">
              <h2 className="m-0 text-sm font-semibold">{t('launcher.personalization.removal')}</h2>
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-md border border-[var(--launcher-border)] bg-white/60 px-4 py-3">
                <input type="checkbox" className="mt-0.5 size-4 accent-[var(--launcher-brand)]" checked={confirmBeforeRemoval} onChange={event => changeConfirmBeforeRemoval(event.target.checked)} />
                <span>
                  <span className="block text-sm font-medium">{t('launcher.personalization.confirm_removal')}</span>
                  <span className="mt-1 block text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.personalization.confirm_removal_hint')}</span>
                </span>
              </label>
            </section>
          )}

        </div>
      </main>
    </div>
  )
}
