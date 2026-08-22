import HarnessUpdater from './components/harness-updater'
import LauncherShell from './components/launcher-shell'
import TrayPanel from './components/tray-panel'
import { useDshTheme } from './hooks/use-dsh-theme'
import './i18n'
/**
 * 启动器进程的根组件。实例进程不加载这套前端，而是由 Rust 宿主
 * 直接打开 DSH 原生 Web 地址。
 */
export default function App() {
  useDshTheme()
  const isTrayView = new URLSearchParams(window.location.search).get('view') === 'tray'

  if (isTrayView) {
    return <TrayPanel />
  }

  return (
    <div className="flex h-screen w-screen">
      <LauncherShell />
      <HarnessUpdater />
    </div>
  )
}
