/* eslint-disable react/dom-no-unsafe-iframe-sandbox */
import { CircleExclamation } from '@gravity-ui/icons'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { useIframeShim } from '@/hooks/use-iframe-shim'
import { harness } from '../store/modules/harness'
import Loadable from './loadable'
import Navbar from './navbar'
import Setup from './setup'

/**
 * 主区域视图：壳层导航栏（Navbar）常驻顶部，
 * 安装/错误态渲染 Setup，就绪态渲染 iframe
 * （挂载后加载职责交给 dsh 应用内官方 boot 页，避免两套 loading 叠加）。
 * 状态与方法全部来自 harness store，不再接收 props。
 */
export default function HarnessWebview() {
  const { t } = useTranslation()
  const {
    status,
    serviceHealthy,
    iframeError,
    iframeKey,
    iframeSrc,
    serviceUrl,
  } = useStore(harness)

  const iframeRef = useRef<HTMLIFrameElement>(null)

  useIframeShim(iframeRef)

  if (status === 'error') {
    return (
      <main className="relative flex min-h-0 flex-1 flex-col bg-canvas">
        <Navbar />
        <div className="min-h-0 flex-1">
          <Setup />
        </div>
      </main>
    )
  }

  if (status !== 'ready') {
    return (
      <main className="relative flex min-h-0 w-full flex-col bg-canvas">
        <Navbar />
        <div className="min-h-0 flex-1">
          <Setup />
        </div>
      </main>
    )
  }

  return (
    <main className="relative flex min-h-0 flex-1 flex-col bg-canvas">
      <Navbar iframeRef={iframeRef} />

      {/* iframe 区域：加载失败时用覆盖层展示重试（iframe 保持挂载，重试复用） */}
      <div className="relative min-h-0 flex-1">
        {serviceHealthy
          ? (
              <iframe
                key={iframeKey}
                ref={iframeRef}
                className="block h-full w-full border-none bg-load-bg"
                src={iframeSrc}
                allow="clipboard-read; clipboard-write; fullscreen"
                sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-downloads allow-storage-access-by-user-activation"
                onLoad={harness.markIframeLoaded}
                onError={harness.markIframeError}
                title={t('app.open_editor')}
              />
            )
          : (
              <Loadable subtitle={t('status.loading')} />
            )}

        {serviceHealthy && iframeError && (
          <div className="absolute inset-0 z-[1]">
            <Loadable
              icon={CircleExclamation}
              title={t('ui.iframe_error')}
              errorMsg={t('ui.ensure_running', { url: serviceUrl })}
              onRetry={harness.refreshIframe}
            />
          </div>
        )}
      </div>
    </main>
  )
}
