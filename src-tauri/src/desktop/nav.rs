//! 壳层导航桥：宿主（ShellNavBar）→ iframe 的导航控制，以及 iframe → 宿主的
//! dsh 状态回报（侧边栏折叠 / 页面历史边界）。
//!
//! 导航栏左侧三个控件（侧边栏切换 / 后退 / 前进）位于 Tauri 宿主文档（`tauri://`），
//! 而目标页面是跨域的 dsh iframe（`http://127.0.0.1:<port>`），宿主无法直接访问
//! iframe 的应用内部状态，只能靠 postMessage + 注入脚本桥接。
//! 本脚本与 [`crate::desktop::notification::NOTIFICATION_SHIM_JS`] 走同一套注入通道
//! （Windows 在 FrameCreated → ContentLoading 时 ExecuteScript，其余平台
//! `initialization_script_for_all_frames`），因此 iframe 每次重新加载都会自动重建。
//!
//! 协议（与 dsh-tauri 插件完全一致）：
//! - 接收 `dsh://sidebar:toggle` / `dsh://page:prev` / `dsh://page:next` 命令；
//! - 回报 `dsh://sidebar:collapsed` / `dsh://page:firsted` / `dsh://page:lasted` 事件。
//! 插件加载后设置 `window.__dsh_tauri_bridge__`，本脚本检测到即让位
//! （命令与事件都停发，避免双重执行）；插件卸载后自动恢复接管。
//!
//! 页面模型：dsh 应用不产生浏览器历史，「页面」= 侧边栏当前选中的会话
//! （`[role="treeitem"][aria-selected="true"]`）。观察选中会话变化维护会话
//! 访问栈（纯内存）：用户点击会话 → 截断前进记录后追加新页并上报；后退/前进 →
//! 点击栈内对应会话行（行元素失效时按标题匹配兜底）。

/// iframe 内注入的导航桥脚本（dsh-tauri 插件缺席时的兜底实现）。
pub(crate) const NAV_SHIM_JS: &str = r#"(function () {
  if (window.__dsh_nav_bridge__) return;
  window.__dsh_nav_bridge__ = true;

  var SRC_BRIDGE = 'dsh-nav-bridge';
  // 侧边栏开关按钮的已知 aria-label（zh/en 两个内置语言），
  // 用于校验按位置命中的按钮确实是开关，避免误点品牌/新建会话按钮。
  var TOGGLE_LABELS = ['打开侧边栏', '收起侧边栏', 'Open sidebar', 'Collapse sidebar'];
  // 会话行菜单按钮的 aria-label 模板（zh/en），用于提取标题与按标题找行。
  var SESSION_LABEL_PATTERNS = [/^会话“(.+)”的操作$/, /^Session actions for (.+)$/];

  // dsh-tauri 插件已接管时让位：命令与事件都停发，避免双重执行
  function bridgeActive() {
    return !!window.__dsh_tauri_bridge__;
  }

  function post(message) {
    if (bridgeActive()) return;
    try {
      window.parent.postMessage(Object.assign({ source: SRC_BRIDGE }, message), '*');
    } catch (_) {}
  }

  // AppFrame：dsh 应用布局的根（shell.overlay 的父节点），
  // 与官方 layout 插件维护的 data-sidebar-collapsed 同源。
  function findFrame() {
    var overlay = document.querySelector('[data-shell-overlay]');
    return overlay && overlay.parentElement;
  }

  function isCollapsed() {
    var frame = findFrame();
    return !!(frame && frame.hasAttribute('data-sidebar-collapsed'));
  }

  // 定位侧边栏开关按钮：AppFrame 第一个子节点即侧边栏列。
  // 展开态 logoRow = 品牌按钮(新建会话) + 开关；折叠态品牌按钮隐藏，开关是第一个按钮。
  // 命中后校验 aria-label 是否属于已知开关文案，不属于则全列扫描兜底（新语言包时）。
  function findToggleButton() {
    var frame = findFrame();
    if (!frame) return null;
    var col = frame.firstElementChild;
    if (!col) return null;
    var buttons = col.querySelectorAll('button');
    if (buttons.length === 0) return null;

    var idx = isCollapsed() ? 0 : 1;
    var ordered = [];
    if (buttons[idx]) ordered.push(buttons[idx]);
    for (var i = 0; i < buttons.length; i++) ordered.push(buttons[i]);

    for (var j = 0; j < ordered.length; j++) {
      var label = (ordered[j].getAttribute('aria-label') || '').trim();
      if (TOGGLE_LABELS.indexOf(label) !== -1) return ordered[j];
    }
    return null;
  }

  // ── 会话访问栈（页面模型，纯内存）─────────────────────────────
  // dsh 应用不产生浏览器历史，「页面」= 侧边栏当前选中的会话。观察
  // aria-selected 变化维护访问栈：用户点击会话 → 截断前进记录后追加；
  // 后退/前进 → 点击栈内对应会话行让应用切回。
  var pages = [];       // [{ key, el }]
  var position = 0;
  var lastKey = null;
  var suppress = false; // 本桥导航落位中，观察器不应记录新页面

  function sidebarCol() {
    var frame = findFrame();
    return frame ? frame.firstElementChild : null;
  }

  // 当前选中的会话行
  function currentSelected() {
    var col = sidebarCol();
    if (!col) return null;
    return col.querySelector('[role="treeitem"][aria-selected="true"]');
  }

  // 行标题：从行内菜单按钮 aria-label 提取（zh/en），失败回退整行文本
  function rowTitle(row) {
    if (!row) return '';
    var btn = row.querySelector('button[aria-label]');
    var label = btn ? (btn.getAttribute('aria-label') || '') : '';
    for (var i = 0; i < SESSION_LABEL_PATTERNS.length; i++) {
      var m = SESSION_LABEL_PATTERNS[i].exec(label);
      if (m) return m[1].trim();
    }
    return label || (row.textContent || '').trim();
  }

  // 按标题找会话行（行元素被重建后的兜底）
  function findRowByTitle(title) {
    if (!title) return null;
    var col = sidebarCol();
    if (!col) return null;
    var rows = col.querySelectorAll('[role="treeitem"]');
    for (var i = 0; i < rows.length; i++) {
      if (rowTitle(rows[i]) === title) return rows[i];
    }
    return null;
  }

  function reportPage() {
    if (bridgeActive()) return;
    post({ type: 'dsh://page:firsted', firsted: position <= 0 });
    post({ type: 'dsh://page:lasted', lasted: position >= pages.length - 1 });
  }

  // 用户导航到新会话：截断前进记录后追加
  function pushPage(key, el) {
    pages = pages.slice(0, position + 1).concat([{ key: key, el: el }]);
    position = pages.length - 1;
    reportPage();
  }

  // 后退/前进：切到栈内目标页（点击对应会话行让应用落位）
  function navigateTo(index) {
    if (index < 0 || index >= pages.length) return;
    var page = pages[index];
    position = index;
    var target = page.el && page.el.isConnected ? page.el : findRowByTitle(page.key || '');
    if (target) {
      suppress = true;
      target.click();
    }
    reportPage();
  }

  function onDomChange() {
    if (bridgeActive()) return;
    var sel = currentSelected();
    var key = rowTitle(sel);
    if (key === lastKey) return;
    lastKey = key;
    if (suppress) {
      // 本桥导航落位：同步当前页记录（行元素可能被 React 重建）
      suppress = false;
      if (pages[position] !== undefined) {
        pages[position] = { key: key, el: sel };
      }
      return;
    }
    // 用户主动切换会话（无选中 = 欢迎/归档态，不入栈）
    if (key) pushPage(key, sel);
  }

  var pageObserver = new MutationObserver(onDomChange);

  // ── 侧边栏折叠观察 + 初始化 ──────────────────────────────────
  function reportSidebar() {
    if (bridgeActive()) return;
    post({ type: 'dsh://sidebar:collapsed', collapsed: isCollapsed() });
  }

  // 应用挂载前无会话树：轮询直到拿到 AppFrame 再初始化
  function startTrack() {
    var frame = findFrame();
    if (!frame) return false;

    new MutationObserver(reportSidebar)
      .observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
    reportSidebar();

    var sel = currentSelected();
    var key = rowTitle(sel);
    lastKey = key;
    // 根页：当前选中的会话（无选中时以「欢迎页」为根，首个会话打开即入栈）
    pages = [{ key: key || null, el: sel }];
    position = 0;
    pageObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected']
    });
    reportPage();
    return true;
  }
  (function () {
    if (startTrack()) return;
    var tries = 0;
    var timer = setInterval(function () {
      if (startTrack()) {
        clearInterval(timer);
      } else if (++tries > 30) {
        clearInterval(timer);
      }
    }, 500);
  })();

  // ── 宿主命令接收 ─────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    if (bridgeActive()) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'dsh-desktop') return;
    switch (data.type) {
      case 'dsh://sidebar:toggle': {
        var btn = findToggleButton();
        if (btn) btn.click();
        break;
      }
      case 'dsh://page:prev':
        navigateTo(position - 1);
        break;
      case 'dsh://page:next':
        navigateTo(position + 1);
        break;
    }
  });
})();"#;
