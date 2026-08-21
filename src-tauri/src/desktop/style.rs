//! 注入到内嵌 dsh iframe 的自定义样式桥。
//!
//! 与 [`crate::desktop::nav::NAV_SHIM_JS`] / [`crate::desktop::notification::NOTIFICATION_SHIM_JS`]
//! 走同一套注入通道（Windows 在 FrameCreated → ContentLoading 时 ExecuteScript，
//! 其余平台 `initialization_script_for_all_frames`），因此 iframe 每次重新加载都会重建。
//!
//! 本脚本只负责把一段内置 CSS 以 `<style>` 元素注入 iframe 文档（幂等：按 id 去重）。
//! 具体样式写在下方的 `IFRAME_CSS` 模板字符串里（当前是占位，按需填写/替换即可）。

/// 注入 `<style>` 的脚本（带 `__dsh_iframe_styles__` 幂等守卫，重复注入安全）。
/// 样式直接写在 `css` 模板字符串里，改这里即可。
pub(crate) const IFRAME_STYLES_JS: &str = r#"(function () {
  if (window.__dsh_iframe_styles__) return;
  window.__dsh_iframe_styles__ = true;

  var STYLE_ID = 'dsh-desktop-injected-styles';

  // ══ 在这里按需填写注入到 dsh iframe 页面的自定义样式``` ════
  var css = `
    .nArs4W_toggleCluster {top:6px !important; right: 6px !important; gap: 2px !important;}
    .nArs4W_toggleButton {border-radius: 8px !important;}
  `;

  function apply() {
    if (document.getElementById(STYLE_ID)) return;
    var root = document.head || document.documentElement;
    if (!root) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.type = 'text/css';
    style.textContent = css;
    root.appendChild(style);
  }

  // 非 Windows 平台在 document-start 注入，head 可能尚未就绪，等 DOM ready 后再挂。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();"#;
