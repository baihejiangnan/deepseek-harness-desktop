# Tauri 命令与事件契约

核对基线：v0.0.9 源码（P0/P1/P2 修复已提交）；已发布的 v0.0.8 二进制不含这些修复，对照时注意差异。本文是启动器前后端的关键接口说明，不是 DSH 原生 HTTP API 全集，也不是承诺长期不变的第三方 SDK。精确签名以 [cmd.rs](../src-tauri/src/bridge/cmd.rs) 和 [handler 注册表](../src-tauri/src/desktop/builder.rs) 为准。

## 调用与命名

前端使用 `invoke(command, args)`；Rust 的 `AppHandle` 由 Tauri 注入，不由前端传入。顶层参数使用前端 camelCase，例如 `instance_id` 对应 `instanceId`。嵌套结构和返回值是否 camelCase 取决于结构自身的 serde 标注，不要对全部结果统一转换；例如 RuntimeInfo 保留 `dsh_version`，实例记录使用 `dshHome`。

```ts
await invoke<number>('launch_instance_window', {
  id: instanceId,
  minimized: false,
})
await invoke('collab_poll_task', { instanceId, sessionId })
```

`id`、`instanceId`、`sessionId`、`pluginId`、工作流 ID 含义不同。跨异步边界先保存目标实例 ID；后续操作不得重新读取当前选中实例来决定写入目标。

## 关键命令

下表省略 AppHandle，`void` 表示 Rust `()`，错误通常以 rejected Promise 返回。未列出的管理命令应从源码注册表查找，不凭名称猜参数。

| 命令 | 前端参数 | 成功结果 / 语义 |
| --- | --- | --- |
| `list_instances` | 无 | InstanceRegistry，包含 instances、activeInstanceId |
| `create_instance` | `{ input }` | 新 DshInstance；input 见 config/instance.rs |
| `update_instance` | `{ input }` | 更新后的实例；input.id 绑定目标 |
| `select_instance` | `{ id }` | 选择后的实例；不是后续写操作的授权标识 |
| `launch_instance_window` | `{ id, minimized?, port? }` | 宿主 PID；调用包含运行时准备和启动等待 |
| `stop_instance_window` | `{ id }` | void；停止指定宿主及其进程树（Windows 与非 Windows 均为整树终止） |
| `focus_instance_window` | `{ id }` | void；聚焦指定宿主窗口 |
| `list_running_instances` | 无 | 实例 ID 数组 |
| `get_running_instance_ports` | 无 | 实例 ID 到端口的映射 |
| `get_instance_removal_impact` | `{ instanceId }` | dshHome、受影响 instances、profiles |
| `remove_instance_registry_only` | `{ id }` | 新注册表；保留文件 |
| `remove_instance` | `{ id }` | 新注册表；删除整个 Home 并级联移除记录。若该 Home 下 `.harness.pid` 指向的进程仍存活（含上次启动器会话遗留），拒绝并返回 `INSTANCE_HOME_RUNNING:` |
| `quit_app` | 无 | void；仅启动器模式生效，实例模式返回错误而非静默退出 |
| `export_instance_home` | `{ instanceId }` | 导出结果字符串；目标选择在后端导出流程内处理 |
| `export_instance_profile` | `{ input }` | 导出结果字符串；结构见 service/export.rs |
| `list_dsh_runtimes` | 无 | 运行时候选数组 |
| `select_dsh_runtime` | `{ runtimeId }` | 选中的运行时；不是实例 ID |
| `runtime_ready` | 无 | 当前候选运行时入口和 Node 文件可用性判断，不代表实例健康 |
| `install_dependencies` | 无 | boolean 表示 DSH 是否真正更新；false 不等于安装失败。并发调用经安装互斥锁串行，不再因状态残留被误跳过 |
| `update_active_dsh_runtime` | 无 | boolean；按所选运行时来源执行更新。false 表示本次更新被推迟或不支持（例如需由 npm/pnpm 自行更新的外部安装），调用方不应把它当失败上报 |
| `get_dsh_plugins_for_instance` | `{ instanceId }` | 目标 Profile 插件数组 |
| `install_plugin_packages_for_instance` | `{ instanceId, input }` | void；解析手动规格并逐条安装。与目录/插件包安装共用同一 spec 策略：`file:`、`link:`、反斜杠路径、控制字符、以 `-` 开头一律拒绝 |
| `install_plugin_pack_for_instance` | `{ instanceId, packId }` | packId、requested、installed、skipped |
| `set_plugin_enabled_for_instance` | `{ instanceId, pluginId, enabled }` | void |
| `remove_plugin_for_instance` | `{ instanceId, pluginId }` | void |
| `cancel_plugin_install` | 无 | void；当前为全局安装取消，不支持按实例/请求取消。Windows 与非 Windows 都会终止安装子进程树，逐条安装循环在每条之前检查取消标志 |
| `list_provider_templates` | 无 | `ProviderTemplate[]`，全局可复用模板库；不是某个实例已写入的路由 |
| `save_provider_template` | `{ template, apiKey?, editing? }` | void；保存时即按当前运行时目录核对路由与模型是否存在（DSH 对 settings.yaml 不设校验，写错只在使用时才炸）。`editing` 为真时按 id 覆盖 |
| `remove_provider_template` | `{ id }` | void；只删模板库条目，不动任何实例配置，也不动凭据 |
| `rename_provider_template` | `{ from, to }` | void；改模板库条目的 route key，**密钥留在同一条记录上**不需要重录。目录型模板沿用保存那道的运行时目录核对。拒绝：源不存在 `PROVIDER_NOT_FOUND`、撞号 `PROVIDER_ID_CONFLICT`、格式不合 `PROVIDER_ID_INVALID`、占用保留 ID `PROVIDER_ID_RESERVED` —— 全部发生在写盘之前。**只动模板库**：已写进各实例的路由一字不改 |
| `get_provider_protocols` | 无 | 当前运行时的 `supportedProtocols()`。取不到即门禁降级为"不可配置"，**绝不回退到任何启动器内置清单** |
| `list_runtime_catalog` | 无 | `{ generatedAt, supportedProtocols, providers[] }`；按运行时入口在进程内缓存。协议事实**按模型细分**（`providers[].protocols`），不给服务商一个布尔 |
| `get_runtime_catalog_models` | `{ providerId }` | `{ models[], supportedProtocols, generatedAt }`；openrouter 有 333 个模型，必须按需取，不能塞进概览命令 |
| `read_instance_providers` | `{ instanceId }` | 当前可识别的服务商配置 + 无法解析或确认的引用。**只交形状不交凭据值**，非模板自有字段（如 `headers`）只报字段名。只读，因此不要求实例停机 |
| `plan_instance_provider_change` | `{ instanceId, templateIds, drafts, routeIdsToRemove, defaultModel }` | `{ plan: { changes, warnings, defaultModel, defaultModelAction, retainedCredentialRefs, sharing }, digest, fingerprint }`。提交的是**操作意图**；不接受前端拼的 diff。`plan.defaultModel` 单独**无法**区分"将清空"与"不改动"（两者都是 `null`），意图看 `plan.defaultModelAction` = `keep` \| `set` \| `clear`。`digest` 同时绑定凭据写入意图，但响应不含密钥值 |
| `apply_instance_provider_change` | 同上，外加 `{ digest, fingerprint }` | 写入后的计划。在实例锁 + 文件锁内重算计划，**操作意图摘要与文档内容指纹任一失配即中止**（`PROVIDER_SETTINGS_CHANGED`），必须重新预览而非重试同一计划 |
| `read_instance_credential_roles` | `{ instanceId }` | **机会性增强，不是写路径的依赖**。实例运行且端口确认存活时经 loopback `settings.describe` 拿"运行时声明为密钥的字段位置"；停机/拿不到端口/远端不支持/超时一律 `Ok({ source: "unavailable", reason, secretPaths: [] })` 而**不是 Err**——把正常停机报成故障会让界面显示出错，而 `unavailable` 也不得被渲染成"没有密钥字段"。只回传位置，不回传任何值 |
| `probe_provider_template` | `{ baseUrl, protocol, apiKey?, savedId?, operation, modelId? }` | `{ models?, elapsedMs }`；`operation` 为 `models` \| `test`。`test` 的请求**由运行时的 pi-ai 适配器构造**，启动器不拼 URL；`models` 仅 OpenAI 兼容协议可读，其余返回 `PROVIDER_DISCOVERY_UNSUPPORTED` |
| `collab_start_task` | `{ instanceId, task }` | `{ sessionId, workspaceId }` |
| `collab_poll_task` | `{ instanceId, sessionId }` | `{ done, result }`；result 是当前解析的文本产物 |
| `collab_cancel_task` | `{ instanceId, sessionId }` | void |

服务商与运行时目录命令全部要求启动器模式（`ensure_launcher_update_context`），并共用 `RuntimeUseGuard`：运行时被占用时返回 `DSH_RUNTIME_BUSY`，不与运行时切换、更新并发。

数据定义：[实例类型](../src/store/modules/launcher/types.ts)、[运行时类型](../src-tauri/src/config/dsh_runtime.rs)、[协作类型](../src-tauri/src/service/collab/mod.rs)、[服务商契约类型](../src/components/provider-contracts.ts)。

常用嵌套结构：

```ts
interface InstanceRegistry {
  instances: DshInstance[]
  activeInstanceId: string | null
}
interface DshInstance {
  id: string
  name: string
  dshHome: string
  profile: string
  version: { channel: string, tag: string }
  favorite: boolean
  createdAt: number
  repairAssistant?: boolean
}
interface ProfileExportInput {
  instanceId: string
  includeProfile: boolean
  includePlugins: boolean
  includeSessions: boolean
}
/** 凭据意图必须显式声明："留空"不能同时表示"保留原密钥"和"改走环境认证"。 */
interface ProviderDraft {
  template: ProviderTemplate
  apiKey: string | null
  credentialMode?: 'keep' | 'replace' | 'none'
}
```

`credentialMode` 与 `apiKey` 必须自洽，后端只校验不自洽而不猜意图：`replace` 却空密钥 → `PROVIDER_KEY_REQUIRED`；`keep` / `none` 却带密钥 → `PROVIDER_CREDENTIAL_MODE_INVALID`。`keep` 由写入脚本从文档原地取回引用名（启动器不知道也不该猜那个名字）；`none` 只取消引用，**已存的凭据值不删除**。

`templateIds` 装的是 `template.id`，也就是实例 `llm-pi-ai.providers` 下的 route key：模板库本身没有独立于 route key 的内部标识（曾经的 `templateId` / `revision` 两个字段从无写入、从无读取，已于 2026-09-09 删除），`provider_store` 的 save/get/remove 全部按同一个 key 定位。所以 `save_provider_template` 的 `editing` 分支**不接受**改 key（对不上就 `PROVIDER_NOT_FOUND`，写盘之前），改 key 只有 `rename_provider_template` 这一个入口，它搬的是同一条记录、密钥跟着走。

实例 version 是兼容元数据，不代表每个实例独立选择核心运行时。启动成功结果的平台判定差异见 [架构说明](ARCHITECTURE.md)。

## 事件载荷与生命周期

监听必须在触发操作之前建立，在 finally 或组件卸载时解除。事件表示通知，不替代 command 的成功/失败结果；不要收到 done 就把实例标记为服务健康。

| 事件 | 当前载荷 | 用途与限制 |
| --- | --- | --- |
| `install-progress` | `{ title, detail, log, type, percentage, progress }` | main 窗口安装反馈；type 包含 download、extract、done。`percentage` 为阶段加权总进度，取值钳制在 0–100；`progress` 为当前阶段进度，`-1` 表示不可测量 |
| `plugin-install-log` | `{ line: string }` | 插件进程输出行 |
| `plugin-pack-install-progress` | `{ completed: number, total: number, plugin: string }` | 当前需要安装的条目进度，不包含已跳过项 |
| `dsh-plugins-updated` | DshPlugin 数组 | 既有活动 Profile 监控通知；目标实例读取优先用显式 command |
| `dsh-status-updated` | Initial / Installing / Starting / Running / Stopped 字符串 | 进程内 workflow 状态，不是所有实例状态表 |

载荷来源：[安装进度](../src-tauri/src/service/download/progress.rs)、[插件日志](../src-tauri/src/service/plugin/process.rs)、[插件监控](../src-tauri/src/service/plugin/watch.rs)、[状态枚举](../src-tauri/src/service/workflow/status.rs)。

当前安装事件没有 instanceId/requestId，消费者不能假定它能区分并发操作，见 [TODO](../TODO.md) 的 EVENTS-01。`progress: -1` 时前端必须展示不确定态（脉冲进度条、不写 `aria-valuenow`、不显示百分比数字），不得用估算值冒充真实进度。TGZ 解压阶段按已处理文件数上报文案，总量未知时同样发 `-1`。`Installing` 状态由 Drop 守卫在成功、失败和早返回路径统一复位，因此不能把状态残留当作“正在安装”的证据。

## 错误与恢复

| 前缀 | 调用方处理 |
| --- | --- |
| `INSTANCE_NOT_FOUND:` | 刷新注册表，取消针对已消失目标的操作 |
| `INSTANCE_RUNNING:` / `INSTANCE_HOME_RUNNING:` | 展示受影响实例，先停止共享 Home 的运行实例。后者也可能来自磁盘 `.harness.pid` 活性门，指向本次启动器会话并未启动的实例（上次会话遗留进程） |
| `INSTANCE_REGISTRY_INVALID:` | 注册表文件损坏且无可用 `.bak` 回退；提示用户不要覆盖，先人工确认备份 |
| `INSTANCE_LAUNCH_FAILED:` | 后缀包含结构化启动失败信息；沿用 launcher store 的解析逻辑，解析失败回退文本 |
| `DSH_RUNTIME_BUSY:` | 等待当前冲突操作结束，不并发重试写入 |
| `DSH_RUNTIME_IN_USE:` | 停止相关实例后再切换或更新运行时 |
| `DSH_RUNTIME_NOT_FOUND:` / `DSH_RUNTIME_INVALID:` | 刷新候选并重新选择可验证运行时 |
| `DSH_INTEGRITY_UNAVAILABLE:` | 无法取得可信摘要；保留错误，不跳过完整性校验 |
| `DOWNLOAD_INTERRUPTED:` | 展示网络失败；考虑已执行的自动重试，避免无限递归重试 |
| `PLUGIN_INSTALL_INVALID_SPEC:` / `PLUGIN_CATALOG_INVALID_SPEC:` / `PLUGIN_PACK_SPEC_INVALID:` | 规格被安全策略拒绝（本地路径、以 `-` 开头、控制字符、超长）；提示用户改用 npm 名、`github:` 或受信任 HTTP(S) 压缩包。原 `PLUGIN_CATALOG_UNSUPPORTED_SPEC` 已不再产生 |
| `PLUGIN_INSTALL_CANCELLED:` | 用户主动取消，按取消而非失败展示，不再继续剩余条目 |
| `COLLAB_START_FAILED:` / `COLLAB_POLL_FAILED:` / `COLLAB_CANCEL_FAILED:` | 保留节点与实例绑定，区分下发、轮询、取消失败 |

错误可能携带路径或第三方输出；展示给本机用户时保留诊断意义，复制到公开渠道前脱敏。不要依赖完整自然语言文本匹配。并非所有历史命令都已统一前缀。

## 实现约束与变更检查

- command 表由 Launcher/Instance 共用；启动器专属写命令必须在后端检查运行模式，不能依赖前端隐藏按钮。当前已守卫：`collab_load_graph`、`collab_save_graph`、`collab_list_workflows`、`collab_save_workflow`、`collab_load_workflow`、`collab_delete_workflow`、`check_desktop_update`、`download_desktop_update`、`open_desktop_installer`、`update_app_config`、`quit_app`。`set_language` 保持 `()` 签名，实例模式下记录警告并忽略。新增启动器专属命令时同步加入此列表。
- 实例写操作检查目标及共享 Home 是否运行。删除 Home 的运行态守卫依据磁盘 `$DSH_HOME/.harness.pid` 的 PID 活性判定，并查两次：`config::instance::remove` 在写注册表前先失败，删除原语 `remove_home_directory` 自身再查一遍，因此任何调用方（含崩溃后重启的启动器）都无法绕过。
- 锁获取顺序固定为 `RuntimeUseGuard`/`RuntimeMutationGuard` → `instance_operation_lock` → `install_lock`；新代码不得反序获取，否则会与运行时更新路径形成死锁。
- 实例 RPC 通过后端确认的受托管端口调用；前端不要自行拼缓存端口来下发任务。
- 新增字段兼容旧配置；改 serde 命名时同时更新 TS 类型和消费者。新增 command 必须注册。
- 变更事件时检查所有 listen 调用，包括更新页、下载页、托盘和协作；同时验证断开监听、重复点击、失败、取消和晚到事件。
- 旧 `launch_harness`、`get_dsh_plugins` 等依赖活动上下文的接口仍存在；新多实例流程优先使用显式实例接口，不据此复制旧的单实例架构。
