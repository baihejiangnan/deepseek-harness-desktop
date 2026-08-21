import { useWatch } from '@hairy/react-lib'
import { useRef } from 'react'
import { useStore } from 'valtio-define'
import { updater } from '../store/modules/updater'
/** 右下角"发现新版本"提示条：状态与操作直接来自 updater store */
export default function HarnessUpdater() {
  const { updateInfo, updating } = useStore(updater)
  const shownTagRef = useRef('')

  useWatch([updateInfo, updating], () => {
    if (!updateInfo) {
      shownTagRef.current = ''
      return
    }
    if (updating) {
      shownTagRef.current = ''
      return
    }
    if (shownTagRef.current === updateInfo.tag)
      return
    shownTagRef.current = updateInfo.tag
    updater.showToast()
  }, { immediate: true })

  return null
}
