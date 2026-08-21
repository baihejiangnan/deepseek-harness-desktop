import { Wrench } from '@gravity-ui/icons'
import { Button } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { setting } from '../store/modules/setting'
import { updater } from '../store/modules/updater'

/**
 * 右下角侧边栏展开按钮：显隐与位置都从 store 读取。
 * 用 HeroUI 图标按钮实现，lifted 时上移避免与提示条重叠。
 */
export default function SidebarToggle() {
  const { t } = useTranslation()
  const { sidebarOpen } = useStore(setting)
  const { updateInfo, updating } = useStore(updater)

  // 侧边栏已展开时隐藏，避免与抽屉重叠
  if (sidebarOpen) {
    return null
  }

  const lifted = updateInfo !== null && !updating

  return (
    <Button
      isIconOnly
      aria-label={t('app.expand_sidebar')}
      onPress={setting.toggleSidebar}
      className={`fixed right-4 z-20 flex size-9 rounded-full border border-line bg-panel/80 text-ink shadow-lg backdrop-blur-md hover:bg-panel-hover ${lifted ? 'bottom-[84px]' : 'bottom-4'}`}
    >
      <Wrench className="size-4" />
    </Button>
  )
}
