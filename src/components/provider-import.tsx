import type { ProviderTemplate } from './provider-templates'
import { Button } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { providerErrorMessage } from '@/utils/provider-error'

export default function ProviderImport({ instanceId, disabled }: { instanceId: string, disabled: boolean }) {
  const { t } = useTranslation()
  const [items, setItems] = useState<ProviderTemplate[]>([])
  const [ids, setIds] = useState<string[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [message, setMessage] = useState('')
  async function reload() {
    setLoading(true)
    setFailed(false)
    setMessage('')
    try {
      const templates = await invoke<ProviderTemplate[]>('list_provider_templates')
      setItems(templates)
      setIds(current => current.filter(id => templates.some(item => item.id === id)))
    }
    catch (error) {
      setItems([])
      setIds([])
      setOverwrite(false)
      setFailed(true)
      setMessage(providerErrorMessage(error))
    }
    finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void reload()
  }, [])
  async function apply() {
    if (disabled || busy || loading || ids.length === 0)
      return
    setBusy(true)
    setFailed(false)
    setMessage('')
    try {
      await invoke('import_provider_templates', { instanceId, ids, overwrite })
      setMessage(t('providers.imported'))
      setIds([])
      setOverwrite(false)
    }
    catch (error) {
      setFailed(true)
      setMessage(providerErrorMessage(error))
    }
    finally {
      setBusy(false)
    }
  }
  return (
    <section className="rounded-md border border-[var(--launcher-border)] p-4">
      <h2 className="m-0 text-sm font-semibold">{t('providers.import')}</h2>
      <p className="text-xs text-[var(--launcher-muted)]">{t('providers.home_scope')}</p>
      <Button variant="outline" isDisabled={busy || loading} onPress={() => { void reload() }}>{t('providers.refresh')}</Button>
      {loading && <p role="status" className="text-xs">{t('launcher.processing')}</p>}
      {!loading && !failed && items.length === 0 && <p className="text-xs">{t('providers.empty')}</p>}
      <div className="flex flex-wrap gap-3">
        {items.map(item => (
          <label key={item.id} className="text-sm">
            <input type="checkbox" className="mr-2" disabled={disabled || busy || loading} checked={ids.includes(item.id)} onChange={event => setIds(event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} />
            {item.name}
          </label>
        ))}
      </div>
      <label className="my-3 block text-xs">
        <input type="checkbox" className="mr-2" disabled={disabled || busy || loading} checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />
        {t('providers.overwrite')}
      </label>
      <Button isDisabled={disabled || busy || loading || ids.length === 0} onPress={() => { void apply() }}>{t(busy ? 'launcher.processing' : 'providers.import')}</Button>
      <p role={failed ? 'alert' : 'status'} className={`break-words text-xs ${failed ? 'text-danger' : 'text-[var(--launcher-muted)]'}`}>{message}</p>
    </section>
  )
}
