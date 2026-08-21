import type { LanguageDetectorModule } from 'i18next'
import { invoke } from '@tauri-apps/api/core'
import { store } from '../store'
import { resources } from './index.resource'

/** 语言偏好持久化 key，与 setting store 保持同步 */
export const LANGUAGE_STORAGE_KEY = 'deepseek-harness-desktop-language'

/** 同步语言探测：优先 localStorage 用户选择，其次浏览器语言 */
export const languageDetector: LanguageDetectorModule = {
  type: 'languageDetector',
  detect: () => {
    // TODO: check store loaded
    let selectedLanguage = store.setting.language
    if (selectedLanguage)
      return selectedLanguage

    // If no saved language, use device locale or fallback
    const deviceLocale = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'

    // try exact locale match first
    if (deviceLocale in resources)
      selectedLanguage = deviceLocale
    else
      selectedLanguage = 'zh-CN'

    return selectedLanguage
  },
  cacheUserLanguage: (language: string) => {
    invoke('set_language', { lang: language.startsWith('zh') ? 'zh' : 'en' })
    store.setting.language = language
  },
}
