import { ArrowUpRightFromSquare } from '@gravity-ui/icons'
import { Button, Description, Modal, useOverlayState } from '@heroui/react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { desktopUpdate } from '../store/modules/desktop-update'

/**
 * 「关于 Desktop」对话框：展示 Powered by、版本号、发布时间与版权信息。
 */
export default function DesktopAboutDialog() {
  const { t } = useTranslation()
  const { about, aboutDialogOpen } = useStore(desktopUpdate)

  const state = useOverlayState({
    isOpen: aboutDialogOpen,
    onOpenChange: (open) => {
      if (!open)
        desktopUpdate.closeAbout()
    },
  })

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container size="xs">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Body className="space-y-3">
              <div className="flex flex-col items-center gap-2 pt-1 text-center">
                <img src="/favicon.svg" alt={t('about.title')} className="w-12 h-12 rounded-md" />

                <div className="text-base font-semibold text-ink">
                  {about?.powered_by ?? 'DeepSeek Harness Desktop'}
                </div>
                <Description className="text-xs">
                  {t('about.powered_by', { name: about?.powered_by ?? 'Hairy & DeepSeek' })}
                </Description>
              </div>
              <div className="space-y-1.5 border-t border-line/40 pt-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted">{t('ui.current_version')}</span>
                  <span className="text-ink font-medium">{about?.version ?? '-'}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted">{t('about.release_date')}</span>
                  <span className="text-ink">
                    {about?.published_at ? formatDate(about.published_at) : '-'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm border-t border-line/40 pt-2 ">
                  <span className="text-muted">{t('about.source_code')}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-md h-8"
                    onPress={() => {
                      if (about?.repo)
                        void invoke('open_external_url', { url: about.repo })
                    }}
                  >
                    {t('about.github')}
                    <ArrowUpRightFromSquare />
                  </Button>
                </div>
                <Description className="text-xs pt-2 flex justify-center text-center">
                  {about?.copyright ?? '-'}
                </Description>
              </div>

            </Modal.Body>

          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime()))
      return iso
    return d.toLocaleDateString()
  }
  catch {
    return iso
  }
}
