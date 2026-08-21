/* eslint-disable react/naming-convention-ref-name */
import { useWatch } from '@hairy/react-lib'
import { invoke } from '@tauri-apps/api/core'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { toast } from '@/utils'
import { download } from '../store/modules/download'

export default function DownloadToast() {
  const { t } = useTranslation()
  const { notice } = useStore(download)
  const toastKey = useRef<string | null>(null)

  useWatch([notice], () => {
    if (!notice)
      return null
    if (toastKey.current)
      toast.close(toastKey.current)
    const { success, path } = notice
    toastKey.current = toast(success ? t('download.saved') : t('download.failed'), {
      description: success && path
        ? (
            <div className="truncate max-w-[300px]">
              {`${t('download.saved_to')}: ${path}`}
            </div>
          )
        : undefined,
      placement: 'bottom end',
      actionProps: success && path
        ? {
            children: t('download.show_in_folder'),
            variant: 'tertiary',
            onPress: () => {
              const close = toast.close
              if (toastKey.current)
                close(toastKey.current)
              void invoke('reveal_in_folder', { path }).catch((err) => {
                console.error('[Harness] reveal_in_folder failed:', err)
              })
            },
          }
        : undefined,
      onClose: () => download.dismiss(),
    })
  })

  return null
}
