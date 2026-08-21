import { Button, Description, Modal, ProgressBar, useOverlayState } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { desktopUpdate } from '../store/modules/desktop-update'

/**
 * 「检查更新」对话框：展示新版本信息 + 下载进度。
 * 已下载 → 「打开安装包」直接启动安装器；未下载 → 「立即更新」下载完成后自动打开。
 */
export default function DesktopUpdateDialog() {
  const { t } = useTranslation()
  const { updateInfo, downloading, downloadProgress, updateDialogOpen } = useStore(desktopUpdate)

  const state = useOverlayState({
    isOpen: updateDialogOpen,
    onOpenChange: (open) => {
      if (!open)
        desktopUpdate.closeUpdateDialog()
    },
  })

  return (
    <Modal state={state}>
      <Modal.Backdrop isDismissable={!downloading}>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{t('update.desktop_title')}</Modal.Heading>
              <Modal.CloseTrigger isDisabled={downloading} />
            </Modal.Header>
            <Modal.Body className="space-y-3">
              <If cond={updateInfo != null}>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted">{t('ui.current_version')}</span>
                    <span className="text-ink font-medium">{updateInfo?.currentVersion}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted">{t('update.new_version_label')}</span>
                    <span className="text-ink font-medium">{updateInfo?.version}</span>
                  </div>
                  <If cond={updateInfo?.downloaded}>
                    <Description className="text-xs">
                      {t('update.desktop_downloaded')}
                    </Description>
                  </If>
                </div>
              </If>

              <If cond={downloading}>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted">
                    <span>{t('update.desktop_downloading')}</span>
                    <span className="shrink-0">
                      {Math.round(downloadProgress)}
                      %
                    </span>
                  </div>
                  <ProgressBar value={downloadProgress} className="w-full">
                    <ProgressBar.Track>
                      <ProgressBar.Fill className="bg-accent" />
                    </ProgressBar.Track>
                  </ProgressBar>
                </div>
              </If>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="tertiary"
                className="rounded-md"
                isDisabled={downloading}
                onPress={desktopUpdate.closeUpdateDialog}
              >
                {t('update.later')}
              </Button>
              <Button
                variant="primary"
                className="rounded-md"
                isDisabled={downloading || updateInfo == null}
                onPress={() => desktopUpdate.downloadAndOpen()}
              >
                {updateInfo?.downloaded
                  ? t('update.open_installer')
                  : t('update.now')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
