# DSH Launcher 开发规范

本仓库是 DSH Launcher（Deepseek Harness Desktop）的启动器开发分支。它管理多个 DSH 实例、DSH 运行时、插件生态、更新和 Windows 桌面集成；实例窗口直接承载 DSH 原生 Web。本文是仓库级开发约束，代码、产品行为与本文冲突时应先核实当前实现和最新用户决策，不得凭旧方案覆盖现状。

## 首要原则

- 保持启动器、实例宿主和 DSH 原生 Web 三层解耦。
- 启动器负责管理和适配 DSH 的外部运行契约，不修改 DSH 核心、Web 路由、会话、API Key、Agent 预设或原生页面逻辑。
- 实例宿主只负责进程、窗口、端口和生命周期，直接加载对应 DSH 本地 Web 地址；不要用启动器页面或 iframe 业务层替代 DSH 原生 Web。
- 只要 DSH 保持可启动的 CLI/Web 外部契约，原生 Web 内部更新不应要求封装层同步改造。若 CLI 参数、启动方式、认证或服务入口变化，由启动器适配层处理。
- 所有实例级操作必须显式绑定 `instance_id`。不要依赖“当前选中实例”跨异步边界执行写操作；临时切换 Rust 全局活动实例时必须在成功和失败路径恢复。
- 仓库通常包含大量未提交开发改动。禁止重置、回滚、格式化或清理无关文件；修改前先读取重叠代码并与现有改动协作。

## 进程与窗口模型

- `RunMode::Launcher`：启动器管理窗口、实例注册表、托盘面板、更新、下载、插件管理和实例宿主进程表。
- `RunMode::Instance { id }`：通过 `--mode instance --instance-id <id>` 启动，只运行该实例的 DSH 服务并创建独立窗口。
- 启动器与每个实例是独立 Tauri 进程，并使用独立 Windows AppUserModelID；任务栏应分别显示启动器、实例 1、实例 2 等入口。
- 启动实例后启动器最小化但保留任务栏和系统托盘入口。主窗口关闭按钮只隐藏到托盘；只有明确的“退出启动器”操作才退出应用。
- 托盘面板是独立的 `tray-menu` WebView（`index.html?view=tray`），失焦或关闭时隐藏，不应退出主进程。
- 不要用“同一 Tauri 进程多个普通窗口”代替实例宿主进程；进程级 PID、端口和活动配置会因此相互覆盖。
- 实例启动是异步状态机。必须区分宿主已创建、等待端口、DSH 健康检查通过、启动失败和进程退出，不能把 PID 存在等同于服务可用。
- 实例退出不得导致启动器退出；启动器需清理陈旧 PID、端口和宿主记录。启动器退出时应回收自己持有的 DSH 进程树。

## 实例与数据规则

- 实例元数据位于注册表，核心字段包括名称、`DSH_HOME`、Profile、共享模式、收藏和创建时间；原生数据仍由对应 Home 管理。
- 不同 `DSH_HOME` 可并行运行。任何共享同一 Home 的实例均不得并行运行，即使 Profile 不同，因为会话、设置、凭据等仍可能共享。
- 端口在每次启动时自动探测，只在运行时状态中记录。界面只能展示已确认监听的实际端口，停止或崩溃后必须清理。
- 修改实例名称、Home、Profile、插件或其他写入型配置前，必须阻止相关实例运行。
- **移除实例是破坏性 Home 级操作：会删除该实例对应的整个 `DSH_HOME`。** 这不是只删除注册表记录。
- 删除共享 Home 时，必须识别所有受影响实例和 Profile；任一相关实例运行时禁止删除。
- 默认在删除前询问是否前往“导出”页面创建完整 Home 备份。用户可在个性化设置中关闭该询问；关闭后删除应直接执行。
- “前往导出”只跳转到实例设置的导出导航，不自动删除；“无需导出”才继续删除。
- 导出完整 Home 可能包含 credentials、API Key、settings、会话等敏感数据。目标文件必须位于 Home 外部，且不得在未授权时上传或解析这些数据。
- 更改实例的 Home 路径不会迁移或删除旧路径数据；只有明确的移除实例流程执行 Home 删除。

## DSH 更新边界

- DSH 核心由启动器统一检查、下载、校验和更新；实例进程不得触发更新。
- 桌面封装端更新与 DSH 核心更新是两条独立链路。更新 DSH 不得删除实例注册表、Home、Profile、API Key、会话或 Agent 预设。
- 多实例共享同一套 DSH 核心。更新前需停止受影响实例，更新期间锁定启动、停止、插件写入和其他冲突操作。
- 下载必须使用可信来源校验、摘要校验、暂存目录和可恢复替换流程；不要直接覆盖正在使用的运行时目录。
- GitHub API 限流或不可用时可使用代码中已有的可信回退，不要绕过完整性校验。

## 插件与插件包

- 社区插件目录来自 `https://awesome-dsh-plugin.com/plugins.json`，用于发现、展示和来源校验；缓存 15 分钟。不要新增本地硬编码“推荐插件”清单。
- 插件包市场来自 `baihejiangnan/dsh-plugin-pack` 的市场索引，支持结构化 JSON 清单和 README 中的社区命令：

```text
dsh plugin --profile web add <spec>
```

- README 命令必须按仓库顺序解析、校验并逐条通过 DSH 原生命令执行。保留社区提供的原始 `spec`，只把来源命令的 Profile 映射为当前目标实例 Profile；不要把所有规格合并成自创命令，也不要执行任意 shell 文本。
- 手动高级安装同时接受完整社区命令和每行一个包规格。无论用户命令中填写什么合法 Profile，实际安装都使用当前选中目标实例的 Profile，并在界面明确提示映射结果。
- 支持 npm 包、`github:` 规格和受信任的 HTTP(S) 压缩包规格。当前安全策略拒绝 `file:`、`link:`、反斜杠本地路径、控制字符和以 `-` 开头的参数。
- 插件安装优先复用满足最低版本的用户 pnpm，否则使用捆绑 pnpm。内部安装必须处理 Windows shim、PATH、引号和隐藏控制台。
- pnpm 10/11 的构建脚本策略通过目标 Profile 的 `pnpm-workspace.yaml` 管理。只允许 pnpm 本次错误明确报告的 Git depPath/包名；解析后写入 `allowBuilds` 并自动重试，不得宽泛放行所有构建脚本。
- 安装进程输出通过 `plugin-install-log` 实时上报。插件包逐条安装通过专用进度事件展示真实“已完成/总数”，支持取消，且取消时终止完整子进程树。
- 所有安装日志和运行日志界面都应提供一键复制完整日志的入口；清空只影响前端展示时需明确，不得误删持久日志。
- 已安装插件直接读取目标 Profile，支持分类、分页、启用/禁用、卸载与刷新。插件包市场当前没有分类字段，不得伪造分类；其搜索和分页使用现有统一控件。

## 前端导航与体验

- 顶部导航为“启动、下载、设置、更多”。进入实例配置后，点击顶部“启动”等同“返回概览”。
- 实例配置包含“返回概览、环境设置、插件管理、导出”。最左侧实例列表在配置页默认向左折叠，可通过窄角标覆盖式展开；展开不得挤压或重排配置内容。
- 下载页子导航为“下载插件、插件包、管理插件”。高级手动安装位于下载插件的社区目录内部；目标实例选择和运行状态提示由三个子页共享。
- 更多页包含 DSH 更新、运行日志和项目链接；运行日志必须可复制。
- 页面和实例切换使用轻量淡入/位移动画或原生 View Transition。优先使用 transform/opacity，并尊重 `prefers-reduced-motion`；性能优先，不为动画引入重型依赖。
- 长耗时操作必须有持续可见反馈。有真实分项进度时展示真实进度；无法测量时使用不确定状态，不得伪造百分比。
- 列表顺序动态变化应尽量平滑，但不得导致布局跳动、文字重叠或大规模重渲染。
- 页面需覆盖加载、错误、空状态、禁用、运行中、取消中和完成状态。按钮文字和颜色必须在所有主题下保持可读。

## 视觉与组件约定

- 技术栈：React 19、TypeScript、Vite、Tailwind CSS 4、HeroUI、Gravity UI Icons、Valtio Define。
- 优先复用 HeroUI、Gravity 图标和现有组件；不要手绘已有图标。陌生图标按钮需有 `aria-label`/tooltip。
- 页面布局优先 Tailwind 类；共享主题、动画和第三方组件覆盖放在 `src/style/main.css`。
- 使用 `--launcher-*` 主题变量，不在页面散布新的固定主色。默认主题 `mist-blue-sakura-pink` 的配置默认值、加载回退和前端初始值必须一致。
- 卡片圆角保持克制（通常 `rounded-md`）；不要卡片套卡片，不要用营销式大标题或装饰性渐变球。
- 固定工具栏、分页、角标和图标按钮应有稳定尺寸，动态文字不能推动布局。窄窗口下文字必须换行或截断，不得溢出重叠。
- 用户可见文本不得硬编码。同步修改 `src/i18n/locales/zh-CN.json` 与 `en-US.json`，key 使用扁平点号形式。
- 沿用所在文件的条件渲染风格；不要为了统一形式机械改写 `react-if-lite` 或 JSX 条件。
- React Compiler 已启用。不要例行添加 `useMemo`/`useCallback`；仅在派生列表、引用稳定性或已确认性能需求时使用。

## Rust / Tauri 约定

- Tauri command 集中在 `src-tauri/src/bridge/cmd.rs`，必须在 `desktop/builder.rs` 的 handler 中注册。
- Launcher/Instance 共享 command 表。更新、安装、全局配置和退出等启动器专属命令必须验证 `RunMode::Launcher`。
- 错误使用稳定大写前缀，如 `INSTANCE_NOT_FOUND:`、`PLUGIN_INSTALL_FAILED:`，便于前端分类；不要只返回含糊自然语言。
- 新配置字段必须提供 serde 默认值并兼容旧配置。更新配置时保留未涉及字段。
- Windows 子进程隐藏控制台；停止和取消时终止完整进程树，避免 DLL、Profile 或更新目录残留锁定。
- 并发共享状态需处理中毒锁，异步流程需保证清理逻辑在错误和取消路径执行。
- 跨平台差异使用 `cfg`/`cfg_attr`。Windows 专属功能不得破坏非 Windows 编译。
- 模块说明可用 `//!`，公开/复杂函数用 `///`；注释解释约束和原因，不复述代码。
- 不要对整个 Rust 工作区运行会改写大量无关文件的格式化命令。脏工作区中只格式化本次修改文件，先用 diff 审查范围。

## 关键目录

- `src/components/launcher-shell.tsx`：顶部导航、启动器主题和全局更新反馈。
- `src/components/instance-manager.tsx`、`instance-settings.tsx`：实例概览、折叠列表、环境、插件和导出。
- `src/components/download-center.tsx`：社区插件、插件包、已安装插件、日志、进度和分页。
- `src/components/more-panel.tsx`、`tray-panel.tsx`：更多页面和托盘面板。
- `src/store/modules/launcher/`：实例注册、选择、启动、停止和运行时状态。
- `src/store/modules/updater/`：DSH 核心更新状态。
- `src-tauri/src/config/instance.rs`：实例注册表、共享关系、Home 删除影响分析。
- `src-tauri/src/desktop/`：运行模式、窗口、托盘、通知和 AppUserModelID。
- `src-tauri/src/service/workflow/`：DSH 启动、健康检查、端口、进程树和孤儿清理。
- `src-tauri/src/service/plugin/`：目录、清单、安装、取消、日志、`allowBuilds` 和已安装插件。
- `src-tauri/src/service/update/`、`download/`：DSH 更新、下载、摘要和事务替换。
- `src-tauri/src/service/export.rs`：Profile/会话选择性导出和完整 Home 备份。

## 开发与验证

仓库根目录：

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm build
pnpm tauri dev
```

`src-tauri/` 目录：

```bash
cargo check
cargo test
```

- 前端改动至少运行 `pnpm typecheck` 和修改文件的 ESLint；共享页面或构建配置改动再运行 `pnpm build`。
- Rust 改动至少运行 `cargo check`；业务模块需运行对应定向测试，高风险跨模块改动运行 `cargo test`。
- 提交前运行 `git diff --check`，并用 `git diff --stat`/定向 diff 确认未改写无关文件。
- `cargo fmt --all -- --check` 可能暴露仓库既有格式差异；不要因此批量格式化用户改动。优先检查和格式化本次文件。
- Rust 后端不会像前端一样可靠热更新到已运行窗口。涉及 command、窗口、托盘、进程或插件安装后端时，完成编译后应重启 `pnpm tauri dev` 再手动验证。
- 启动项目时只终止命令行明确属于本仓库的旧 Tauri/Vite/Node 进程，不要杀死其他 Node 程序。
- 手动验证按风险选择：多实例任务栏、启动器最小化/托盘、共享 Home 互斥、实例独立关闭、插件逐条安装/取消/日志复制、删除前导出、完整 Home 删除、DSH 更新数据保护。

## 完成前检查

- 是否维持 Launcher/Instance 独立进程和独立任务栏标识？
- 是否保持 DSH 原生 Web 透明封装，没有注入或复制其业务逻辑？
- 写操作是否绑定明确 `instance_id`，并保护运行实例与共享 Home？
- 删除实例是否按产品决策删除整个 Home，并正确处理导出提示和受影响实例？
- 插件是否使用社区原始 spec 和 DSH 原生命令，Profile 是否映射到目标实例？
- 是否提供真实进度、取消、错误状态和完整日志复制？
- 中英文文案、主题变量、空状态和 reduced-motion 是否同步处理？
- 新 command 是否注册、限制运行模式并在所有路径恢复临时状态？
- 是否执行与风险相称的 TypeScript、ESLint、构建、Rust 测试和手动验证？
- 是否保留了工作区中所有无关未提交改动？
