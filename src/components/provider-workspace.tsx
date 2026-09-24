import { Button, Modal, useOverlayState } from '@heroui/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { StatusNotice } from './launcher-ui'
import ProviderImport from './provider-import'
import ProviderSelect from './provider-select'
import ProviderTemplates from './provider-templates'

/** The target ID is local to this workspace; global instance selection never redirects writes. */
export default function ProviderWorkspace() {
  const { t } = useTranslation()
  const { registry, runningInstanceIds } = useStore(store.launcher)
  const [targetId, setTargetId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [applied, setApplied] = useState(false)
  const [busy, setBusy] = useState(false)
  const target = registry.instances.find(instance => instance.id === targetId)
  const homeUsers = target ? registry.instances.filter(instance => instance.dshHome === target.dshHome) : []
  const running = homeUsers.some(instance => runningInstanceIds.includes(instance.id))
  const applyDialog = useOverlayState({
    isOpen: templateId !== '',
    onOpenChange: (open) => {
      if (!open && !busy) {
        setTemplateId('')
        setTargetId('')
        setApplied(false)
      }
    },
  })

  return (
    <>
      <ProviderTemplates
        onApply={(id) => {
          setTemplateId(id)
          setTargetId('')
          setApplied(false)
        }}
      />

      <Modal state={applyDialog}>
        <Modal.Backdrop isDismissable={!busy}>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>
                  {t('providers.apply_instance')}
                  {' · '}
                  {templateId}
                </Modal.Heading>
                <Modal.CloseTrigger isDisabled={busy} />
              </Modal.Header>
              <Modal.Body className="max-h-[70vh] space-y-4 overflow-y-auto">
                <div className="space-y-2 text-sm font-medium">
                  <span>{t('providers.workspace_target')}</span>
                  <ProviderSelect
                    label={t('providers.workspace_target')}
                    value={target?.id ?? ''}
                    placeholder={t('providers.choose_instance')}
                    disabled={applied || busy}
                    options={registry.instances.map(instance => ({
                      value: instance.id,
                      label: `${instance.name} · ${instance.profile}`,
                    }))}
                    onChange={setTargetId}
                  />
                </div>
                {target && (applied
                  ? <StatusNotice message={t('providers.apply_complete')} />
                  : <ProviderImport key={`${target.id}:${templateId}`} instanceId={target.id} disabled={running} initialIds={[templateId]} allowManage={false} onBusy={setBusy} onApplied={() => setApplied(true)} />)}
              </Modal.Body>
              {applied && (
                <Modal.Footer>
                  <Button variant="primary" onPress={() => applyDialog.close()}>{t('launcher.close')}</Button>
                </Modal.Footer>
              )}
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  )
}
