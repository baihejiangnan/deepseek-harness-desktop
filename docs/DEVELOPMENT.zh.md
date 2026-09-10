# 开发

DSH Launcher 是 **Tauri 2 + React 19** 应用：启动器前端位于 `src/`，Rust 后端位于 `src-tauri/`；实例窗口直接承载 DSH 原生 Web。开始前阅读 [AGENTS.md](../AGENTS.md)、[架构](ARCHITECTURE.md) 和 [接口契约](IPC_CONTRACTS.md)。[English](DEVELOPMENT.md)。

## 环境要求

| 工具 | 版本 |
| --- | --- |
| Node.js | 开发建议 22.22.x，与管理运行时版本对齐；升级时检查锁定依赖的 engines |
| Rust | 使用能通过当前 Cargo.lock 的 stable 工具链；仓库没有声明已验证的最低 Rust 版本 |
| pnpm | 开发使用 10.x，与发布 CI 一致；不是运行时插件安装使用的 pnpm 版本 |

以及平台编译工具链：

- **Windows** — MSVC 构建工具 + WebView2
- **macOS** — Xcode Command Line Tools
- **Linux** — WebKit2GTK

## 常用命令

```bash
pnpm install      # 安装依赖
pnpm dev          # 前端开发服务器（Vite）
pnpm typecheck    # 前端 TypeScript 检查
pnpm lint         # 前端与配置 lint（src-tauri 内嵌 .mjs 与 .mimosa 已排除，前者由 pnpm test:provider 覆盖）；脏工作区优先对修改文件执行 eslint
pnpm build        # TypeScript + Vite 生产构建
pnpm test:provider # 服务商内嵌脚本的单元 + 集成测试（node --test）
pnpm tauri dev    # 调试模式运行桌面端
pnpm tauri build  # 构建安装包
```

后端检查（在 `src-tauri/` 下执行）：

```bash
cargo check
cargo test
```

## 小贴士

- Harness 默认起始端口：正式版 **3080**、调试版 **3081**；启动时会探测可用端口，实际监听端口以实例运行状态为准。
- 前端开发服务器是 Vite 的 **1420** 端口（`vite.config.ts`、`tauri.conf.json` 的 `devUrl`）；设置 `TAURI_DEV_HOST` 时 HMR 使用 **1421**。

## 接手与启动

先检查分支、HEAD、工作区和相关 diff。不要重置、批量格式化或清理别人的改动。普通搜索排除实例 Home、凭据、会话和无关 AppData。

`pnpm tauri dev` 会启动前端开发服务；不要额外再开一个占用 1420 的 Vite。终止旧服务前核对命令行确实属于本仓库，先结束父进程再核查子进程与端口，不能批量结束所有 Node。不要用失效客户端的 SYN_SENT 判断服务仍在监听。

前端可热更新；Rust command、进程、窗口、托盘或安装流程修改后，重新编译并重启 Tauri 再验收。不要把旧窗口行为当作新后端的测试结果。

## 按改动选择验证

| 改动 | 最少验证 |
| --- | --- |
| 纯文档 | 链接、示例命令/字段与源码一致性、git diff --check |
| 前端 | pnpm typecheck、修改文件 ESLint |
| 共享布局、构建配置 | 上述检查加 pnpm build，相关页面手动验收 |
| Rust | cargo check、受影响模块定向测试 |
| 高风险跨模块 | cargo test，以及涉及生命周期/数据写入的手动回归 |

示例（根目录执行前端检查；后端命令在 src-tauri 下执行）：

```bash
pnpm exec eslint src/components/instance-manager.tsx src/store/modules/launcher/store.ts
git diff --check
git diff --stat
```

在 src-tauri 目录运行定向测试：

```bash
cargo test service::download::core::tests
cargo test config::instance::tests
cargo test service::plugin::install::tests
```

前端侧的服务商测试用 `pnpm test:provider`。它会把 `provider-import.test.mjs` 与 `provider-probe.test.mjs` 一起跑，其中**集成与委托类用例需要一份可解析的真实 DSH 运行时**：脚本自行查找全局安装，找不到时这些用例会**自我 skip**，而 skip 仍然报告"成功"——与真的通过无法区分。因此结论必须连 skip 计数一起贴出，只有 `skipped 0` 才算那些用例确实跑过。显式指定用 `DSH_TEST_ENTRY=<dsh 包>/lib/bin.js`。探测类用例把请求发到 `127.0.0.1` 的本地网关，**不出网、不消耗真实用量**；真实用量只可能发生在你手动点界面里的"测试连接"时。

只格式化本次 Rust 文件，不因既有格式差异对整个工作区运行改写命令。测试报告注明运行环境、通过项和未验证项；编译成功不代表首次安装或跨平台窗口行为通过。

## 手动回归清单

- 首启：用隔离的测试环境验证没有 Node/DSH、已有兼容环境、网络中断、摘要/解压失败和直接重试。不得删除真实用户运行时或 Home 来制造场景。
- 多实例：不同 Home 并行、共享 Home 互斥；窗口/任务栏独立；关闭实例不退出启动器；启动器成功后最小化、失败保持可见。
- 插件：目标 Profile、逐项进度、取消与进程树、日志复制和截断说明；手动安装的本地路径规格被拒；pnpm 输出被污染时不写入非法 `allowBuilds` 键。
- 数据：临时 Home 上验证仅移除记录、删除共享 Home 的影响、导出目标在 Home 外、备份和失败反馈；启动器外遗留的 DSH 进程仍占用 Home 时删除被拒绝；重启启动器不会删掉仍存活进程的 `.harness.pid`（清扫只在进程确认已死时清理标记，否则守卫失去依据）；`instances.json` 损坏后能从 `.bak` 恢复；单条 Home 不可用时其余实例仍可加载。
- 服务商：只在**新建的一次性 Home** 上验证。必查四项 —— 预览按字段如实列出会改什么、被 DSH 并发改动过的文件必须在应用时中止而不是覆盖；非模板自有字段（尤其 `headers`）原样保留且只报名字；删除服务商**不删已存凭据**且仍被 settings/`.env` 引用的名字要列出来；共用同一 Home 的实例数与 Profile 数与实际一致。"测试连接"会真实调用接口并可能产生用量，验证前须先说明；内嵌脚本经 `include_str!` 编进二进制，改 `.mjs` 后必须重新编译并重启才生效。
- 更新：停止相关实例；切换失败可恢复；Home、凭据、会话不被更新流程覆盖。
- 协作：依赖顺序、实际产物、节点实例绑定、契约写入失败、部分启动失败、取消和主代理保留现场。
- UI：主题、窄窗口、中英文、禁用/错误/空态、键盘和 reduced-motion，见 [视觉规范](DESIGN.md)。

## 文档与发布

当前任务见 [TODO](../TODO.md)。长期规范进入项目文档；过程日志、截图和临时验收材料不默认提交。提交使用明确路径并检查暂存差异，不把 output、实例数据或构建缓存一起加入。

发布必须另按 [RELEASING.md](RELEASING.md) 操作。源码 push、tag、构建和资产发布分别核验；文档更新本身不触发版本升级或发布。
