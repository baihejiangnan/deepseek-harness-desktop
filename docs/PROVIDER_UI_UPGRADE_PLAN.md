# 模型服务商模块与界面升级方案

> **文档地位**：本文件是本轮改造的执行基线，不是现状说明。现状以代码与 [ARCHITECTURE](ARCHITECTURE.md) / [IPC_CONTRACTS](IPC_CONTRACTS.md) / [USER_GUIDE](USER_GUIDE.md) / [DESIGN](DESIGN.md) 为准。
> 执行不得脱离本方案。允许在本方案之上做更优改动，但必须在交付说明里明确指出改了什么、为什么偏离或超出本方案。
> 方案定稿日期：2026-09-08。§6 三项待决在落地前必须敲定。

## 0. 本轮要完成的三件事

1. 完善和优化「模型服务商」模块，对齐 DSH 本体的目录（catalog）设计。
2. 全面升级和优化项目整体的用户界面、界面布局与用户交互逻辑。
3. 进行全面的检查（类型、lint、构建、Rust 测试、真实桌面验证、文档与契约同步）。

三件事**都要做**，按 §4 的阶段排序执行。

## 1. 证据基线

本轮结论的可信度分三档，落地时按档处理：

- **[已验证]** = 本次在真实运行时和真实代码上直接测得或读到。
- **[待核实]** = 有来源但未复现，落地前必须验证（集中在 §1.4）。
- **[未验证]** = 明确没查，已排进 S0（任务 #10）。

### 1.1 DSH 运行时（已验证）

- 版本 `@deepseek-ai/dsh` **0.1.2-rc.1**，本机安装于 `C:\Users\ABD18\dev\nodejs\node_modules\@deepseek-ai\dsh`（npm 全局）。启动器托管目录 `%APPDATA%\io.github.baihejiangnan.dsh-launcher\dependencies` **不存在**。
- 内部依赖 `@earendil-works/pi-ai` **0.84.4**。
- `dsh-llm-pi-ai` 只发布单文件 `lib/index.js` + `lib/types/**/*.d.ts`；**包根运行时导出只有** `Config`、`PiAiAdapter`、`apply`、`inject`、`name`、`recordKeyFor`、`supportedProtocols`。
- `catalogProviderIds` / `catalogProvider` / `catalogModels` / `resolveRouteModels` / `resolveProfiles` / `assertServiceable` / `buildProvider` **都在包内，但未导出**。`Config` 运行时是 Cordis 配置描述（`typeof === 'function'`，键 `type,meta,toString,dict`），**不是 zod，没有 `safeParse`**。
- 因此目录能力必须走 pi-ai 的正规子路径：`@earendil-works/pi-ai/providers/all`，实测导出 `getBuiltinProviders()`（**39 个 id**）、`builtinProviders()`、`getBuiltinModels()`、`getBuiltinModelDataGeneratedAt()` = `1787954402569`。
- 目录 Provider 对象形状：`{id, name, baseUrl, headers, auth, getModels, refreshModels, filterModels, stream, streamSimple}`。注意是 **`baseUrl` 不是 `baseURL`**；**`api` 在模型上不在服务商上**；模型是惰性的，需逐个 `getModels()`。
- `auth` 形状：`{apiKey?: {name}, oauth?: {name, isSubscription?, loginLabel?}}`。
- `supportedProtocols()` = `["openai-completions","openai-responses","anthropic-messages"]`。
- `recordKeyFor('deepseek')` → `"llm-pi-ai/deepseek"`。
- 实测样本：deepseek 3 模型（`openai-completions`，contextWindow 1000000 / maxTokens 384000）、anthropic 13、openai 38、github-copilot 33（apiKey+oauth 双认证）、amazon-bedrock 118（`bedrock-converse-stream`，无 baseUrl，apiKey 名写着 "AWS credentials or bearer token"）、openai-codex 7（`openai-codex-responses`，**只有 oauth**）、openrouter 333。
- 无 `baseUrl` 的目录项：`amazon-bedrock`、`azure-openai-responses`、`cloudflare-ai-gateway`、`cloudflare-workers-ai`、`google-vertex`、`opencode`、`opencode-go`、`radius`。

### 1.2 DSH 配置契约（已验证，读类型声明与真实键名）

- 服务商路由在 `settings.yaml → llm-pi-ai.providers.<routeKey>`，**dict key 就是 route id**，自由命名。key 命中已安装目录则继承其端点/协议/模型并可逐字段覆盖；不命中即全手写，必须自带 `api` + `baseURL` + `models`。
- `PiAiProviderProfile` 字段：`apiKeyEnv`、`displayName`、`api`、`baseURL`、`models[]`、`modelOverrides{}`、`compat{}`、`defaultContextWindow`(262144)、`defaultMaxTokens`(32768)、`defaultInput`、`reasoning`、`thinkingBudgets`、`cacheRetention`、`transport`、`timeoutMs`、`websocketConnectTimeoutMs`、`streamIdleTimeoutMs`(300000)、`maxRequestImageBytes`、`requestImagePixelBudget`、`requestImageMaxBytes`、`retryPolicy`、`headers`。**没有 alias / extends / catalogRef 字段**。
- **`models` 与 `modelOverrides` 互斥**：`config.d.ts:73-81` 原文——override 只在"目录路由且无 `models` 列表"时有意义；与 `models` 并存、用于目录不提供该路由、或指向目录未描述的模型，**是被拒绝（refused）而非忽略**。
- 另有独立 settings 段 `llm-deepseek`，拥有单一路由 `deepseek-official`（`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`、`baseURL`、`thinking: enabled|disabled`、`reasoningEffort: off|low|high|max`、`maxTokens`、`models[]`）。
- `.credentials.yaml`：明文，`version: 1`，两个键空间 `refs:`（env 名 → key）与 `records:`（`<scope>/<id>` → `{kind:'api-key', key?, env?}`）。解析优先级：进程 env > `.credentials.yaml` > `cwd/.env` > `$DSH_HOME/.env`。未知顶层键或 `version != 1` 会被拒。
- 原生凭据派生引用为 `<ROUTE>_API_KEY`；**空密钥 = 走服务商原生环境认证**。原生 UI 密钥校验为可打印 ASCII `[\x21-\x7E]` 且拒绝粘贴 `NAME=value` 整行。
- `settings.yaml` 是 **Home 级、同 Home 所有 Profile 共享**，除非该 Profile 的 `cordis.patch.yml` 重定向 settings/credentials 路径。
- 顶层 `agent-default-model: {provider, model, reasoningEffort}` 在真实 Home 中存在。
- 原生写入走 `settings.mutate` 路径级操作 + `expectedRevision`（并发 → `settings/conflict`），保留注释的叶子 diff 写；`assertServiceable` 拒绝不可服务配置；已删除的 legacy 字段带指引报错。
- 原生 Web UI（`@deepseek-ai/dsh-client-ui-settings-models`）有"添加服务商"卡片（其目录选择器按 README 标注目前 **dormant 未启用**）与"添加自定义服务商"；Provider ID 标为 fixed forever；删除仅在用户层携带该行时允许；目录路由编辑只暴露 `id`/`name`/`contextWindow`/`maxTokens`；`headers` 故意只允许改文件。**DSH 原生没有"测试连接"**，只有 `llm/discoverModels`（服务端 GET `{baseURL}/models` + Bearer，仅 openai-completions/responses，4MiB）。**DSH 没有 CLI 服务商命令**。

### 1.3 启动器现状（已验证）

服务商后端：六个命令（`list_provider_templates`、`save_provider_template`、`remove_provider_template`、`get_provider_protocols`、`import_provider_templates`、`probe_provider_template`）在 `src-tauri/src/bridge/cmd.rs`，注册于 `desktop/builder.rs:396-401`。模板存 `provider-templates.bin`，Windows 走 DPAPI（`provider_store.rs:15-66`），**非 Windows 直接 `PROVIDER_SECURE_STORAGE_UNSUPPORTED`（`provider_store.rs:68-71`）**。导入用 `include_str!` 内嵌的 `service/provider-import.mjs`，经 stdin 传明文密钥，`withFileLock` + `writeFileAtomic` 写入，先凭据后 settings、失败回滚。

三处"现状比预想更好"，落地时**不要重复造**：

1. **注释保留已实现**：`provider-import.mjs:35,68,95-96,126` 用 `yaml.parseDocument` → Document 原地改 → `String(settings)`，settings.yaml 的注释与未知节点不会丢。
2. **`records` 已被容忍并保留**：`mjs:97-99` 允许顶层 `version/refs/records` 并校验为 Map；只是写侧仅用 `refs`。
3. **id 校验已兼容目录**：`providers.rs:37-48`（小写开头、仅小写/数字/`-`、不以 `-` 结尾、无 `--`、≤80）对全部 39 个目录 id 通过，最长 `qwen-token-plan-individual`(26)。

三处"现状表达不出目录型"，必须改结构：`base_url`/`protocol` 为必填（`providers.rs:24-25`），`profile()` 强制 `protocol ∈ supportedProtocols`（`:85-89`），`models` 空则回落 `[model_id]` 且空 id 直接 `PROVIDER_MODEL_INVALID`（`:68-73`）。

前端审计关键结论（判定见 §4）：

- 服务商模块无回读能力：没有任何命令读 Home 里的 `llm-pi-ai.providers`；`provider-import.tsx:75-78` 是常驻"全量覆盖"复选框。`provider-probe.mjs:2` 硬编码 3 个协议，与运行时动态发现会漂移。
- 导航实现不一致：`launcher-shell.tsx:183-188` 用 CSS `hidden` 保活 resources/collaboration，`:190` 用 `key={section}` 条件渲染 launch/settings/more → 后者切走即卸载、状态全丢。
- 无任何共享界面抽象：`primitives.ts` 仅 29 行一个 `button` tv()（只被 loadable/setup 用）。PageHeader/Toolbar/SectionCard/EmptyState/ErrorBanner/StatusBadge/ProgressBar/SearchInput/ConfirmInline/Pagination 全部缺失，8 个页面各写一遍近乎相同的 class 串。**分页标记实际有三份**：`download-center.tsx` 的 `PaginationBar` 函数、同文件社区目录区的内联副本、`provider-templates.tsx` 的 `ProviderPaginationBar`，后者还跨命名空间借用了 `download.page_*` 文案 key。

**#14 落地状态（2026-09-08）**：共享层已建于 `src/components/launcher-ui.tsx`（`PageHeader` / `SectionCard` / `Toolbar` / `SearchInput` / `EmptyState` / `ErrorBanner` / `StatusNotice` / `StatusBadge` / `Field` / `TextInput` / `ActionBar` / `ProgressBar` / `PaginationBar`），类名全部从既有手写标记原样提取，adopting 不产生视觉跳变；组件不内置任何文案，文本由调用方传入已翻译字符串，避免把页面命名空间 key 固化进共享层。已落地约束：字号不低于 `text-xs`；不改动 `main.css` 的 `body{font-size}`；`Field` 控件默认限制在 420px 阅读宽度；`StatusBadge` 文字恒在，颜色只作着色；仓库色板只有 `danger` 与 `ok`，未新增 `warning` 色值。**首批接入**：三份分页标记已收敛为一份实现，`personalization-panel` 页头改用 `PageHeader`（删除与标题重复的 eyebrow、标题 24px→20px）。剩余 4 处介绍区页头与其余原语的接入随 #22–#25 逐页完成；`launcher.personalization.eyebrow` 与 `download.page_*` 的 key 归属整理留待 #28。
- 无共享 save-state 抽象；store 六模块只有 `setting` 走 valtio persist，全仓唯一防抖是 `collaboration-panel.tsx:410-418` 的组件级 400ms。
- 任务状态有四种实现并存：组件 state（单插件安装 `download-center.tsx:310-315`、插件包 `:311-322`、导出 `instance-settings.tsx:297-301`、协作 `collaboration-panel.tsx:240-241`）与 Valtio（更新 `updater/store.ts:14-30`、实例启动 `launcher/store.ts:50-62`）。真实分项进度只有插件包有（`cmd.rs:1568-1592` 发 `{completed,total,plugin}`）。
- 取消语义：插件包**已完整**（`cancellingInstall` → "正在停止..."，后端 `taskkill /PID /T /F` 杀完整进程树 `plugin/cancel.rs:80`）——作为其他流程的样板。
- 失败驻留：启动失败 Modal `instance-manager.tsx:467-514` 是全仓标杆（原因 + 肇事插件 + 禁用/移除补救 + 复制日志 + 重试），应推广而非新造。

### 1.4 [待核实]（落地前必须验证）

- `agent-default-model` 是否有 per-agent / per-profile 变体（不能只当 Home 级单份）。
- `.credentials.yaml` / `.store.dat` 实际内容（本次被权限分类器拦截，格式取自类型声明与启动器测试）。
- `deepseek-modlens`（`~/.dsh/settings.yaml` 里的默认 provider）来源——不在 0.1.2-rc.1 目录也不在任何 `@deepseek-ai` 包内，推测为第三方插件注册的路由。
- DSH 原生 Web UI 的运行时行为（本次只读包 README 与实现源码，未实际运行）。
- 启动器记录的 core 版本（`.store.dat` 未读，版本号取自安装包清单）。

### 1.5 S0 契约结论（2026-09-08 已验证，DSH 0.1.2-rc.1）

以下均在运行时包源码上读到，路径根 `…\@deepseek-ai\`。**这几条改写了 §2 的原假设，必须按新结论落地。**

**A. 凭据解析链（VERIFIED）**

`apiKeyEnv` 的解析实现在 `dsh-credentials-local/lib/index.js:473-490`，顺序为：
1. 继承的进程 env（`:428-431`）——只读，且**会遮蔽文件写入**（`assertUnshadowed` `:636-638`）
2. `.credentials.yaml` 的 **`refs:`**（`:479`）——`resolve()` **只读 `refs:`，从不读 `records:`**
3. `cwd/.env` 然后 `$DSH_HOME/.env`（`:437-440`，信任序见 `dsh-launch-environment/lib/index.js:9-13`）

两种键语法互斥（`/` 被排除，`dsh-credentials/lib/index.js:13-15,37-58`），**`apiKeyEnv` 无法指向 `records:` 条目**。`records:`（`llm-pi-ai/<route>`）只归 llm-pi-ai 的登录/OAuth 流程所有（`dsh-llm-pi-ai/lib/index.js:1849-1857,1946-1978,2322-2355`）。

原生 Models 页保存密钥的真实行为（`dsh-client-ui-settings-models/lib/client.js:1177-1199` → `credentials.set` → `refs.<NAME>`）：**写 `refs:`，从不写 `records:`**，同时把 `apiKeyEnv` 写进 settings.yaml，值为 profile 已有的引用，否则派生 `<ROUTE>_API_KEY`（`client.js:919-921`）；**空密钥则写入无引用的 profile**。`apiKeyEnv` 设了但链上无值 → `LlmError MISSING_CREDENTIAL`（`:2479-2486`）。

→ **对方案的影响**：§2.6 的"保留 `DSH_LAUNCHER_*` 命名"**技术上完全成立**——`apiKeyEnv` 只是引用名，叫什么由我们定，interop 只要求写进 `refs:`。既不需要迁移，也不影响原生 UI 识别。**"对齐原生命名"这条建议撤销。** 唯一新增禁令：**绝不写 `records:`**，那是登录/OAuth 的地盘。

**B. `agent-default-model` 没有任何校验（VERIFIED，原为待核实）**

Schema 为 `{provider(必填), model(必填), reasoningEffort?}`（`dsh-agent-default-model/lib/index.js:11-17`），该段**没有 validate 钩子**。指向不存在的路由/模型会**静默保存成功**，直到使用时才以 `NO_ADAPTER` 失败（`dsh-llm/lib/index.js:1628`）。

读取优先级是**会话级在上**：session `modelSelection` → 会话头持久化 `config.{provider,model,reasoningEffort}` → Home 默认（`dsh-api-session-controller/lib/index.js:278-291`）。而 DSH 自己的模型选择器**每次变更都会重写 Home 默认**（同文件 `:600-620`，写点在 `:616`）。

→ **新增硬约束**：启动器写 `agent-default-model` 前**必须自行校验** route 与 model 真实存在（DSH 不会拦）。同时界面必须说明：该项是 Home 级、影响该 Home 全部 Profile，且**已被会话自选过模型的会话不受影响**。

**C. `deepseek-official` 是运行时注册的适配器，且与目录 `deepseek` 并存无遮蔽（VERIFIED）**

`llm-deepseek` 段字段与默认值：route `deepseek-official`（`dsh-llm-deepseek/lib/index.js:1825`）、`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`、`baseURL` ← 配置 → `$DEEPSEEK_BASE_URL` → `https://api.deepseek.com`、`thinking: enabled|disabled`、`reasoningEffort: off|low|high|max` 默认 `high`、`maxTokens` 默认 256000、三个默认模型。它通过 `ctx.llm.registerAdapter(["deepseek-official"], adapter)`（`:2043`）注册。

两段**没有任何优先级或去重代码**，是互不相干的 route key；但**若把名为 `deepseek-official` 的 profile 写进 `llm-pi-ai.providers`，DSH 启动会抛 `DUPLICATE_ADAPTER`**（`dsh-llm/lib/index.js:1272`）。

→ **新增校验规则**：启动器必须**禁止** `deepseek-official` 作为自定义 route id（`PROVIDER_ID_RESERVED`）。

**D. 凭据消费面远比 providers 段宽，且不可静态枚举（VERIFIED）**

一方包内除 `llm-pi-ai.providers.*.apiKeyEnv` 外，还有 `llm-deepseek.apiKeyEnv`、**`web-search-deepseek.{apiKey, apiKeyEnv}`（`apiKey` 是 `role("secret")` 明文）**、`webhook-github.secretEnv`。而 `tool-vision` **不在任何一方包内**——它是第三方插件，照抄了 web-search-deepseek 的形态。

→ **§2.6 的引用扫描方式升级**：不硬编码段名清单，改为**通过 `settings.describe` 的字段角色（`credential-ref` / `secret` 路径标记）动态发现**所有凭据字段，再叠加"整份 settings 文档文本扫描 + `$DSH_HOME/.env`"作兜底。这与"不新增本地硬编码清单"一致。

**可达性已核实（2026-09-09，#30），且它推翻了这个升级的可行性前提**：机制真实存在且脱敏安全——`@deepseek-ai/dsh-api-settings-controller` 的 `describe()` 内部固定调 `settings.describe({ redactSecrets: true })`（"Every remote read uses redactSecrets: true, so a `role('secret')` field cannot ride a response"），返回 `{writable, hasDocument, namespaces:[{ns, schema, value, base?, user?, applies, secrets:[{path:[…], set}], revision}]}`，`secrets[].path` 正是我们要的字段角色；另有 `credentials.describe(refs)` 可按名解析引用。**但 `describe()` 要求命名空间已注册，注册发生在插件加载时**，而 DSH 的 CLI 只有 `--profile / --patch / --dump-config / --dump-default-config` 四个选项，`--dump-config` 打印的是**组装后的 profile 树**（只有 `id/name/disabled/config`，不含任何角色元数据），因此**没有 boot-free 路径**。唯一入口是运行中实例的 loopback RPC（`ctx.remote.settings`）。**而这份扫描的意义恰恰是"改配置与删服务商都要求实例已停机"**——需要它的那一刻，正是它必然不可用的那一刻。
→ **因此本条降级为机会性增强，而不是阻塞性依赖**：文本扫描仍是停机态下唯一的地板（已实现、已测），运行中且健康时额外拉一次 `settings.describe` 把角色发现补上，界面必须点明这次结论出自哪种模式；**绝不把"没连上运行中实例"渲染成"没有凭据字段"**。

**E. 插件在运行时注册的路由无法从 settings 枚举（VERIFIED）**

任何插件都可调 `ctx.llm.registerAdapter(routes, adapter)`；DSH 自己的 UI 也不靠读文件，而是把 `llm/listProviders`（`@Remote`）与 `listConfigurableProviders` 做 join（`dsh-llm/lib/index.js:1157-1173`；`client-ui-settings-models/lib/client.js:872-909`）。启动器要求实例停机才能改配置，因此拿不到 `llm/listProviders`。

→ §2.4 的收紧表述由"推测"升为**已证实**：回读只能给出"可识别的配置 + 无法确认的引用"，且**必须**在界面上说明存在运行时注册路由这一可能性。

**仍未查清**：`deepseek-modlens` 的确切来源（`C:\Users\ABD18\.dsh` 含 `plugin-manager-cache` 被权限系统拒绝访问，一方包树内无该字符串）；删除 route 时是否有任何代码迁移 `agent-default-model` 或会话头（搜遍未发现，判定为"没有"，属推断）；`llm-deepseek` 的 `off` 档位在线格式。

**#12 落地状态与必须解决的分叉（2026-09-08）**

`src-tauri/src/service/providers.rs` 的模板结构已改为判别式：新增 `kind: Custom|Catalog`（`#[serde(default)]`，旧记录原样按 Custom 读取，不需要迁移脚本）、`selection: All|Subset`、`modelOverrides`。`profile()` 在 Catalog 下**只输出用户显式设置的字段**，省略 `api`/`baseURL`/`models` 以保留目录继承；`plan_import()` 在改回继承时**删除**上次钉死的 `api`/`baseURL`/`models`/`modelOverrides`，同时保留 `headers` 等第三方字段与其他 provider。7 个契约测试全通过，`cargo test` 131/131 无回归。

> **2026-09-09 更正（#28 检查阶段）**：本段原先还写着"新增 `templateId`（与实例 route key 分离，旧记录缺省回退为 `id`）"和"`revision`（供 #21 并发校验）"。**两者都只有字段，没有实现**：`provider_store` 的 save/get/remove 全部按 `template.id`（即实例 route key）定位，`templateId` 在每个写入点恒为空串，`revision` 恒为 0 且没有任何自增点，唯一读方是预览载荷里一个没人取的 `templateRevision`。并发校验真正生效的是**计划摘要 + 内容指纹**——`provider-import.test.mjs` 用"模板在预览后被改动、settings 文件始终没动"这一条把它钉死了（`PROVIDER_SETTINGS_CHANGED`，且不写一个字节）。因此 `templateId` / `revision` / `handle()` / `templateRevision` 已一并删除；兼容性改由新断言保证：**旧记录里残留的 `templateId` / `revision` 作为未知字段被忽略**，仍不需要迁移脚本。
> 后果：§2.2 的"模板内部标识与实例 route ID 必须分离"**未按设计实现**；同日选定的出路是补 `rename_provider_template`（见本节末尾与 `TODO.md` `PROVIDER-05`），让改 ID 不再需要删除重建、也不再丢密钥。分离这个设计本身仍未做，且已被明确接受为不做。

**字段归属已单源化（#12 完成，2026-09-08）**：原先 Rust 的 `profile()`/`credential_ref()`/`plan_import()` 在非测试构建中全是死代码，真实字段映射由 `provider-import.mjs` 另建一份（旧 `mjs:106,109,110,118-120`），两侧改字段归属互不跟随，而只有 .mjs 那份落进用户 Home。现在的分工是：

- **Rust 定义归属**：`import_provider_templates` 先取 `get_provider_protocols` 的运行时协议白名单，再用 `ProviderTemplate::profile()` 算出要写入的 profile 与 `credential_ref()`，连同 `template.id` 一起经 stdin 下发。**前端不参与协议白名单，也不提交 diff。**
- **.mjs 只做合并**：按 profile 声明的 key 写入；profile 未声明的模板自有 key（`displayName`/`apiKeyEnv`/`api`/`baseURL`/`models`/`modelOverrides`）在 route 已存在时删除，以支持"改回目录继承"；`headers` 等外来字段与无关 provider、以及 YAML 注释一律原样保留。保留一道运行时守卫：`profile.api` 必须被当前运行时的 `supportedProtocols()` 认得，防 Rust 与运行时版本不一致时写出 DSH 拒绝的配置。
- **空密钥语义**：`api_key` 为空时 Rust 从 profile 中移除 `apiKeyEnv`，.mjs 也不写凭据条目——与原生"无引用即走服务商环境认证"一致。模板取消引用时**不删**已有凭据。

**测试入口已补**：新增 `pnpm test:provider`（`package.json`），把此前从不执行的 `provider-import.test.mjs` 与 `provider-probe.test.mjs` 接进可运行路径。`DSH_TEST_ENTRY` 指向本机真实 DSH 后 **11/11 通过、0 跳过、连跑两次稳定**，其中包含真实启动 DSH 到 Web 就绪的引导用例；不带该变量时 8 个 DSH 用例自跳过、3 个探测用例照常执行。新增用例覆盖"改回目录继承会取消钉死 `api`/`baseURL`/`models`，同时保住 `headers` 与注释"和"继承模式下单模型调整落在 `modelOverrides` 而非 `models`"。集成测试只使用系统临时目录下的一次性 Home，不触碰任何真实 Home，也不发出模型请求。

**仍待接活的三处**（都有明确归属，不留长期死代码）：`validate_against_catalog()` 随 #13 的目录命令使用；`plan_import()` 与 `handle()` 随 #21 的预览路径使用——#21 必须补一条对照测试，确认 `plan_import()` 的 JSON 合并语义与 .mjs 的 YAML 合并语义输出一致结果。

**#13 进度与实测纠正（2026-09-08）**

- 目录探测脚本 `src-tauri/src/service/provider-catalog.mjs` 已建成并在真实运行时上验证：概览 40 项、`generatedAt` 1787954402569、协议白名单三项、按服务商惰性取模型（openrouter 333 条）、未知 route 与非法入参分别返回 `PROVIDER_CATALOG_ROUTE_UNKNOWN` / `PROVIDER_CATALOG_INPUT_INVALID`。**纠正 §1.1 的"39"**：`getBuiltinProviders()` 是 39 个静态目录项，`builtinProviders()` 是 **40** 个（多出 0 模型的纯动态 `radius`）；门禁结果不受影响，仍是 **29 可配 / 11 不可配**，且混合协议项实测为 0。
- **两条被实测否证的解析路径**，实现时必须遵守：① `require.resolve('@earendil-works/pi-ai/providers/all')` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`——该子路径只有 `import` 条件；② `process.chdir()` **不影响** `node -e` 虚模块的裸标识符解析（其基准固定在启动时的 cwd）。因此 Rust 侧 `run_provider_catalog` 必须以 `current_dir = <DSH 包目录>`（入口 `<pkg>/lib/bin.js` 上溯两级）spawn，脚本内只用裸 `import()`。这也意味着目录提供方一旦改名或挪走就干净降级为 `PROVIDER_CATALOG_UNAVAILABLE`，不回退内置清单。
- 新命令 `list_runtime_catalog`（进程内缓存，键为所选运行时入口路径，切换即失效）与 `get_runtime_catalog_models` 已注册进 `builder.rs`，均限 Launcher 上下文；`cargo test` 131/131。
- **判定落点已定（#13 完成）**：`configurable` 只在 `providers.rs::judge_catalog_provider()` 一处计算，`list_runtime_catalog` 为每个服务商附 `configurable` + `limitation`，前端只显示结论。原因码按固定优先级取第一个失败项：`PROVIDER_CATALOG_AUTH_UNSUPPORTED`（无 apiKey 认证，如只有 oauth 的 openai-codex）→ `PROVIDER_CATALOG_ENDPOINT_REQUIRED`（无 baseUrl）→ `PROVIDER_CATALOG_PROTOCOL_UNSUPPORTED`（协议不在白名单，如 google/mistral）→ `PROVIDER_CATALOG_NO_MODELS`（0 模型，如动态 radius）。事实缺失时保守判为不可配置。模型级另有 `protocolSupported`（`mark_catalog_models`），因为协议按模型细分。规则测试 2 项覆盖四类原因、优先级与空事实。
- **目录型模板保存即核对**：`save_provider_template` 改异步，经 `verify_catalog_template()` 用当前运行时的目录模型清单跑 `validate_against_catalog()`——DSH 对 settings.yaml 里的错误路由/模型不设校验，只会在使用时才失败，所以这层必须在保存时做。`validate_against_catalog()` 由此转为活代码。
- **待办移交**：上述四个原因码 + `limitation` 的中文与英文文案需随 #20 一并补进 `providers.*` 命名空间；`configurable` 目前还没有消费方，因为它的首个使用者就是 #20 的目录优先添加向导。

## 2. 方案一 · 模型服务商

方向：**对齐 DSH 目录（catalog）模型**。核心判断是启动器目前把 DSH 的"目录路由 + 按需覆盖"实现成了"手写路由代笔"，导致约 40 家内置服务商全部退化为用户手填 baseURL/协议，并把目录默认值钉死进用户 Home，DSH 升级目录后实例不跟随。

### 2.1 产品结构：两个作用域

| 入口 | 职责 | 用户看到 |
|---|---|---|
| 实例设置 → 模型服务商 | 管理该实例实际使用的配置 | 已配置服务商、模型、默认模型、凭据状态 |
| 全局设置 → 模型服务商 | 管理可复用配置模板 | 模板、用于新实例的预选项、模板编辑 |

- 实例配置增加独立"模型服务商"子页（现有子页为 返回概览 / 环境设置 / 插件管理 / 导出），把目前插在环境设置标题前的导入卡片迁入。
- 保留模板库与"模板 → 导入实例"两段式，模板分**目录型**与**自定义型**。
- 实例内可直接添加服务商；可选择已有模板应用到实例；可显式勾选"同时保存为模板"（**默认不入模板库**）。
- 修改模板不自动同步已有实例。
- 从实例进入模板创建流程，完成后返回原实例并保留目标与选择。

### 2.2 三条硬约束（本方案的地基）

1. **`models` 与 `modelOverrides` 按模式互斥。** 跟随目录（无 `models`）→ 用 `modelOverrides`；限定模型列表（有 `models`）→ 覆盖写进对应 model 条目。后端与前端双重拦截（`PROVIDER_MODEL_OVERRIDES_CONFLICT`）。**切换模式时必须在预览中展示字段迁移与删除**（subset→all 需删 `models` 并把条目内覆盖迁入 `modelOverrides`），不能只拦"同时填写"。写错的后果是整个 `llm-pi-ai` 段被 DSH 拒绝、该 Home 下所有实例的模型层失效。
2. **已写入实例的 route ID 不可编辑。** DSH 无别名/extends 机制（已核实全字段）。改 ID 三重后果：失去目录继承、孤立凭据引用、破坏既有会话对该 route 的引用。同一服务商加账号 → 新建自定义路由，界面明说它不再自动继承目录。**模板内部标识与实例 route ID 必须分离**（新增 `templateId`），避免模板管理与配置身份绑死。→ **未按要求实现，改为另一种满足方式（2026-09-09，#28 + `PROVIDER-05`）**：模板库至今按 route key 定位，`templateId` 从未被写入非默认值，已连同 `revision` 作为死字段删除，详见 §7。用户选定不去做"标识分离"，而是补一个 `rename_provider_template`：在同一把锁内搬那条记录、密钥跟着走，改 ID 不再需要删除重建，也不改写任何已写入实例的路由。原设计的分离收益（重命名自由）由此达成，代价是"模板 ID 与 route key 仍绑在一起"这件事被明确接受。
3. **模板改为判别式结构。** 旧模板一律按自定义型读取，**不因 ID 命中目录而自动转换**。用户主动转换为目录型时先展示差异。

目录型模板的字段：`kind`、route `id`（须命中目录、写入后不可变，同时是模板库条目的定位键）、`name?`（缺省用目录 name）、`apiKeyEnv?`、`modelSelection: all | subset`、`models?`（仅 subset）、`modelOverrides?`（仅 all）、`overrides?`（displayName/baseURL/api 等显式覆盖，**未设即不写**）。自定义型维持现状必填。所有新字段提供 serde 默认值兼容旧配置。

### 2.3 能力门禁三判据（按模型细分）

| 能力 | 判据 |
|---|---|
| **可展示** | `getBuiltinProviders()` 成功，能读到目录信息 |
| **可配置** | `auth.apiKey` 存在 **且** `baseUrl` 存在 **且** 目标模型的 `api ∈ supportedProtocols()` |
| **可测试** | 可配置 **且** 探测器声明了该 `api` 的请求构造 **且** 配置未使用探测器表达不了的字段（`compat`/`headers`/特殊认证） |

- **全部按模型细分**，不给服务商一个布尔值（openrouter 333 个模型协议不统一）。
- `auth.apiKey` 只作线索，**不等同于"简单 API Key 认证可用"**（bedrock 的 auth 名是 "AWS credentials or bearer token"）。
- 能枚举目录 ≠ DSH 当前适配器、认证方式与启动器写入路径都支持它。**未验证的条目允许浏览并说明原因，先不开放写入。**
- **规则已在全部 39 个目录项上实测跑通（S0，2026-09-08）：29 家可配置、11 家不可配置。** 不可配置的三类原因：
  - 无 `baseUrl`：`amazon-bedrock`、`azure-openai-responses`、`cloudflare-ai-gateway`、`cloudflare-workers-ai`、`google-vertex`、`opencode`、`opencode-go`
  - 协议不在 `supportedProtocols()`：`google`（`google-generative-ai`）、`mistral`（`mistral-conversations`）——**这两家有 `baseUrl` 也有 `apiKey`，仅被协议分支排除**；另 `openai-codex`（`openai-codex-responses`）
  - 只有 oauth、无 `apiKey`：`openai-codex`
  - `radius` 是 0 模型的纯动态 provider，由规则的"存在可支持协议"分支自动排除
- 首版这 11 家**只可浏览不可写入**，界面必须给出具体原因（缺端点 / 协议不支持 / 需 DSH 内登录），不得伪装成填一个 API Key 就可用。
- **门禁必须是规则（可观测运行时事实的表达式），不是硬编码 id 清单。** 与 [AGENTS.md](../agents.md) "不新增本地硬编码清单"一致。S0 的职责是在五类样本上验证规则本身成立，不是逐一配通 39 家——避免调研范围无限扩大。
- 降级：pi-ai 子路径导入失败（DSH 升级换依赖）→ 稳定错误码 `PROVIDER_CATALOG_UNAVAILABLE`，界面显示"目录不可用，仍可使用自定义接口"，**不回退到任何内置静态清单**。缓存仅进程内，keyed by `generatedAt` + 运行时路径/版本，运行时切换即失效。
- 目录快照标识（`generatedAt` + pi-ai 版本）需在界面可见。

### 2.4 实例页：展示真实配置

回读边界必须收紧为：**"当前可识别的服务商配置，以及无法解析或确认的引用"**——不是"实例实际使用的全部服务商"。`--dump-config` 定位文件再读 settings 可以拿到用户配置，但枚举不到插件动态注册的全部路由。

四轴**独立**状态，不压成单一枚举（"配置已保存但目录不可用"这类组合必须能表达）：

- **配置轴**：未配置 / 已保存 / 已保存但字段不被当前运行时接受
- **凭据轴**：已配置（来源：凭据文件｜环境变量｜无法确认）/ 未配置（走服务商环境认证）/ 无法确认
- **目录轴**：可用（附 `generatedAt` + pi-ai 版本）/ 不可用（原因）/ 该 route 未命中目录
- **验证轴**：未测试 / 模型 X 通过（时间）/ 模型 X 失败（原因）/ 该配置不支持测试（原因）

规则：

- 配置是否保存、凭据状态、目录是否可用、模型测试结果**互不冒充**。不得因存在密钥引用就显示"连接正常"，不得因一个模型测试成功就标记全部模型可用。
- 凭据链的 env 与 `cwd/.env` 启动器读不到，因此**不得**把"链上找不到值"判定为凭据缺失，只能是"无法确认"。
- 来源证据不足时标"来源未确认"，**不根据未知 route ID 推断为"插件服务商"**。
- 默认模型指向未识别路由时显示"无法确认"，不是"引用失效"。
- "继承字段"一律标注为**当前目录参考值**，不声称是 DSH 最终解析结果（`resolveRouteModels` 未导出，拿不到）。
- **不返回未知配置的完整原始值**——其中可能包含请求头、令牌等敏感信息。未知/敏感字段只回传"存在 + 字段名 + 安全来源类别"。
- 不返回任何密钥值，也不返回长度形态。
- 共享 Home 时列出实际受影响的实例与 Profile（复用 `config/instance.rs:495-538`）。实例运行中整页只读。

### 2.5 编辑体验：分层展开

| 层级 | 内容 |
|---|---|
| 基础配置 | 名称、接口、协议、认证方式 |
| 模型配置 | 获取列表、搜索、多选、手动添加、默认模型 |
| 常用高级 | 上下文、输出上限、输入模态、推理档位、思考格式 |
| 专家配置 | 兼容选项、超时、重试、传输方式等运行时支持字段 |

- 服务商 ID 自动生成、允许修改、**写入实例后不可变**，约束说明放字段旁（现有正则已兼容全部目录 id，无需放宽）。
- 目录继承值显示"使用默认值"、支持"恢复默认"，**不把展示值全部写回**。
- 不把所有高级字段铺成超长表单。
- 密钥认证与环境变量认证明确区分；编辑时"留空保留密钥"不再兼任其他语义，拆为**保留现有 / 替换 / 不使用密钥（走环境认证）**三态。
- `headers` 等可能含敏感值的字段按敏感数据处理。
- 缺少必填项时就近解释，避免只有灰色保存按钮。
- **专家层的取值来源受限**：`MODALITIES` / `THINKING_LEVELS` / `SUPPORTED_THINKING_FORMATS` / `MAX_TOKENS_FIELDS` / `CACHE_CONTROL_FORMATS` 只存在于 `.d.ts`，运行时不可达，且无 `assertServiceable` 兜底。因此枚举值只能从**目录模型实例里实际观测到的取值**做成下拉；取不到合法值的字段**不做成自由文本**，留空即不写。

**#26 落地状态（2026-09-08）**

已落地：

- **凭据三态成为显式契约**，不再从"密钥是否为空"反推意图。`ProviderDraft` 新增 `credentialMode`（`keep|replace|none`，`bridge/cmd.rs`），`provider_planned_entry` 校验模式与是否带密钥自洽（`replace` 无密钥 → `PROVIDER_KEY_REQUIRED`；`keep`/`none` 带密钥 → `PROVIDER_CREDENTIAL_MODE_INVALID`），只有确实要声明引用时才把 `apiKeyEnv` 留在 profile 里。`keep` 由 `provider-import.mjs` 的 `effectiveProfile()` 从文档原地取回引用名——启动器不知道那个名字，也不该猜。
- **预览与写入同源**：`buildPlan` 也按 `effectiveProfile` 算差异，因此 `keep` 不会报出 `apiKeyEnv: <ref> → null` 的假差异；凭据动作由 `credentialChange()` 统一给出 `keep|replace|add|remove`，其中"没带密钥但文档里有引用"现在如实报 `remove`（此前报 `null`，正是 §2.5 指的过度加载语义）。
- **回读交出可编辑所需的真实值**：`readProviders` 的每条路由新增 `models` / `overrides`（`{id, name?, contextWindow?, maxTokens?}`）与 `defaultModel.reasoningEffort`。只交出白名单键——模型条目里的原生私有选项不回传，测试断言其值与键名都不出现在返回体里。`overrideCount` 由 `overrides` 取代。
- **实例内编辑与移除**：`provider-edit.tsx`（基础配置 / 模型配置 / 常用高级 / 默认模型四层折叠，默认只展开基础层）与 `provider-remove.tsx`。route ID 为禁用输入并在字段旁说明不可变原因；继承值以占位符与提示展示、`恢复默认` 只清空而不把展示值写回；缺少必填项时在操作区上方逐条列出原因，不再只有灰色按钮。
- **共享契约与共享预览**：`provider-contracts.ts` 收拢目录 / 回读 / 计划四组类型（此前三个组件各写一份），`provider-plan-view.tsx` 让模板导入、实例内添加、实例内编辑与移除共用同一份预览渲染。

方案之上的更优改动（点名）：

1. `agent-default-model.reasoningEffort` 写入与回读。已核实：`dsh-agent-default-model` 的 `AgentDefaultModelSettings` 声明 `reasoningEffort?: string`，`dsh-agent` 的 `ModelSelection` 同名消费。取值只列所选模型在目录里实际观测到的 `reasoningEfforts`，观测不到就不渲染输入。
2. `applyProviderOperations` 现在自行守住 `agent-default-model` 的形状（provider/model 必须是非空串，否则 `PROVIDER_DEFAULT_MODEL_INVALID` 且不留半写状态），因为 §1.5-B 已确认 DSH 对该段不做任何校验。
3. `retainedCredentialRefs` 的扫描扩到 `$DSH_HOME/.env`，并首次在界面上显示（此前三条路径都算了这个字段却没人渲染）。
4. 实例内添加路径的预览此前只显示 route id 与一个徽章，不显示字段差异与凭据动作——属诚实性缺口，已随共用渲染一并补齐。

明确没做，以及为什么：

- **专家配置层没有渲染**。§2.5 列的兼容选项 / 超时 / 重试 / 传输方式都不在模板自有的 6 个字段里，写它们等于写外部字段，与 §2.4"未知字段只保留、不写入"直接冲突；枚举源（`MODALITIES` 等）又只在 `.d.ts`、运行时不可达。按 §2.5"取不到合法值的字段不做成自由文本"，做法是不渲染该层，而不是渲染一排禁用输入假装支持。
- **输入模态与思考格式只展示不可写**：模型条目里启动器拥有的键只有 `name` / `contextWindow` / `maxTokens`，其余没有已核实的写入位。
- **实例内不提供手填模型 ID**：`verify_catalog_template` 会以 `PROVIDER_MODEL_OVERRIDES_CONFLICT` / `PROVIDER_CATALOG_MODEL_UNKNOWN` 拒绝目录里没有的 id，与 §2"未验证的目录项只可浏览不可写入"一致。界面就地说明原因。模板库编辑器仍保留手填（它走 custom 型，不经目录核对）。
- **编辑只对"命中当前目录且 `configurable`"的路由开放**；来源未确认的路由只读展示 + 可移除，界面明说启动器无法核对它的模型与协议。
- **保留现有密钥时无法测试连接**：凭据只写不读，启动器手里没有那个值。界面直接说明并指向"替换为新密钥"，不假装测过。
- **后端没有新增"钉死协议必须匹配该路由模型"的门禁**：DSH 内部路由级 `api` 与模型级 `api` 的优先级尚未核实，加这条断言就是过度承诺。改为把前端可选项限制为该路由模型实际观测到的 `api` ∩ `supportedProtocols()`。同时更正了 `providers.rs` 里 `validate_against_catalog` 的文档注释——原注释声称校验协议，代码实际只校验模型 id 存在。

仍未落地（转 #28，需要点名）：§1.5-D 与 §6 第 3 条要求的 **`settings.describe` 字段角色（`credential-ref` / `secret`）动态发现**至今没有实现，当前只有"整份 settings 文本 + `$DSH_HOME/.env`"这一层兜底扫描。这条约束原本挂在 #19/#21 名下，而那两项已标记完成——实际未做，此处更正归属。**2026-09-09 可达性核实完毕**（见 §1.5-D 末）：机制存在且脱敏安全，但没有 boot-free 路径，只在运行中实例的 loopback RPC 上可得——而删服务商与改配置恰恰要求停机。因此它**只能作为机会性增强**叠加在文本兜底之上（单列任务 #30），不构成写路径的阻塞依赖；兜底扫描已覆盖停机态，写路径不因缺它而失真。

检查结果（真实输出）：`cargo check` 通过（仅 `core/utils/mod.rs` 两条既有 dead-code 警告）；`cargo test provider` **8 passed / 0 failed**；`pnpm test:provider` **17 passed / 0 failed**（新增 3 条：凭据三态全链路、`keep` 在无引用路由上不凭空造引用、模型自有选项回读与 `reasoningEffort` 往返）；`pnpm typecheck` 0 错误；`npx eslint src` 0 错误 / 2 条既有警告（`download-center.tsx:366`、`use-scope.ts:5`）；`pnpm build` 通过（11.19s）；`git diff --check` 干净；中英文各 914 键、无单侧缺失。

顺带查实两处**既有**问题（不是本轮引入，留给 #28 决策）：`pnpm lint`（`eslint .`）在 HEAD 上就已经失败——`src-tauri/src/service/provider-import.mjs` 144 条、`provider-import.test.mjs` 204 条，几乎全是 `style/semi`；这两个文件通篇用分号，与 antfu 预设不一致，而 eslint 配置只 ignore 了 `AGENTS.md`。要么把 `src-tauri` 加进 ignore，要么单独授权格式化这两个文件，不宜顺手改。

**真实桌面验证仍未做**：本轮改了 `bridge/cmd.rs` 与内嵌脚本，按 §5 需重启 `pnpm tauri dev` 后手动走一遍"编辑 → 预览 → 应用 → 回读"和"移除 → 预览 → 应用"，只用新建的一次性 Home。

### 2.6 写入流程：读取 → 预览 → 应用 → 回读

移除常驻"全量覆盖"复选框，改为有依据的变更预览。

**接口接受明确操作意图**（不是模板 ID 列表，也不是前端 diff）：新增服务商 / 修改指定字段 / 从模板应用 / 移除服务商 / 设置或清除默认模型。

预览内容：新增项、无需变更项、同 ID 差异（字段级 current→next）、移除项、密钥只显示 `keep|replace|remove`（不显示值）、实际受影响的实例与 Profile、`credentialRefsToRemove`、默认模型影响、各项并发校验快照。

应用：**在 `withFileLock` 内重新读文件、重算计划、与提交的意图比对**，不一致即 `PROVIDER_SETTINGS_CHANGED` 并中止，要求重新预览。**不缓存 plan 句柄**（多一次读文件，换掉整个缓存生命周期与陈旧句柄问题）。前端永远拿不到也提交不了任意 diff。

并发校验覆盖六项：settings 文档哈希、凭据文档哈希、`--dump-config` 解析出的实际路径、选中运行时标识 + 目录 `generatedAt`、**模板内容**（apply 在锁内用当前模板重算计划再比对摘要，模板被改过则摘要必然不同——该路径已有测试：`a template that changed after the preview aborts the apply even if the file never moved`）、提交时实例运行与共享状态。**哈希只保护纳入检查的文件，不得声称与 DSH 的 revision 机制等价。**

凭据：

- 保留旧引用与现有 `DSH_LAUNCHER_<ID>_API_KEY` 命名策略，**不自动迁移**。支持读取原生凭据不要求新写入必须采用原生命名；只有明确需要时才增加原生写入形式。
- **默认不随删除服务商自动删除凭据。** `DSH_LAUNCHER_` 前缀本身即归属证据，该命名空间内的键可提供明确的清理选项。
- 引用扫描范围是**整份 settings 文档**（含 `llm-deepseek` 与插件自有段——真实 Home 里 `tool-vision` 段就把 `apiKey` 明文写在 settings 里，说明凭据不只走 `refs`）加 `$DSH_HOME/.env`。**只统计 `llm-pi-ai.providers` 不能证明没有其他使用者。**

其他：

- 保留无关字段、未知高级配置与其他凭据记录。未知/敏感字段的值**全程不经过前端**，由后端在 YAML Document 上原地保留（§1.3 已述，写入层不需要重写）。
- 删除默认服务商或模型时先处理默认模型引用；默认模型只在用户显式选择时写 `agent-default-model`，**不覆盖 Agent 预设**。默认模型选择放在应用预览里、**默认不勾选**，不强制用户保存后再走一遍。
- 写入成功后回读确认，不符则 `PROVIDER_VERIFY_MISMATCH` 并保留现场。结果区分三态：`not-written` / `rolled-back` / `rollback-failed`（后者给路径与人工处理指引，不报成功）。
- **部分成功必须显式表达**：实例配置与模板库是两个存储位置。实例保存成功、模板保存失败时显示部分成功并允许单独重试，不得提示整体失败导致用户重复添加。幂等由 `provider_store::save` 的 route key 冲突规则保证：新建撞号 → `PROVIDER_ID_CONFLICT`，编辑时目标不存在 → `PROVIDER_NOT_FOUND`，两者都在写盘之前返回，因此不产生重复条目。
- 保留全部现有护栏：停止相关实例、显式 `instance_id`、路径须在 Home 内、拒符号链接、`RuntimeUseGuard`、`instance_operation_lock`、先凭据后 settings 的回滚顺序。

### 2.7 连接测试

**允许测试的范围 = 运行时支持 ∩ 探测器已实现 ∩ 当前配置可准确表达。**

- "探测器已实现"从探测模块自己声明的"协议 → 请求构造"表推导，**不另维护清单**，否则必然漂移。因此**不能**只把 `provider-probe.mjs:2` 的硬编码三协议改成动态读 `supportedProtocols()`——运行时新增协议后探测器不会构造对应请求，界面却显示"可测"，是假能力信号。
- 优先方案：若 S0 验证通过，改用 pi-ai 真实调用路径（`./compat` 导出 `stream`/`complete`/`getApiProvider`，目录 Provider 对象自带 `stream`/`streamSimple`）跑测试，从根上消掉与 DSH 的语义分歧。待验证点是密钥如何按请求注入（类型注释："the key itself still arrives per request, never at construction"）。
- 若保留独立探测实现，必须补齐与真实运行时的对照测试：Anthropic 路径拼接（探测自行拼 `/v1`，DSH 的 `discoverModels` 不做同样拼接）、不同协议的请求字段、推理模型参数、环境变量认证、自定义兼容选项。**已知的路径拼接差异必须修复或禁用对应测试，二选一，不留现状。**
- 第一版若暂不重做：只对已验证的简单配置开放测试，超出能力（自定义 compat、特殊认证）明确显示暂不支持；**不把"目录请求测试成功"宣称为完整 DSH 配置验证成功**。
- 结果贴近按钮展示，含测试模型、时间与结果；修改相关连接参数后旧结果标记失效（现状只到输入级，需细化到每模型）；测试保持可选并保留可能产生用量的提示。

**#27 落地状态（2026-09-09）**

- **走了本节第 2 条的优先方案**：`test` 不再由启动器构造请求，而是 import 当前选中运行时的 `@earendil-works/pi-ai/compat`，用 `complete(model, context, options)` 发一次真实调用。第 2 条留的待验证点已核实——**密钥经 `ProviderRequestOptions.apiKey` 按请求注入**（pi-ai `types.d.ts:56`），`Context` 里根本没有认证字段，所以既不需要构造期注入、也不需要碰环境变量。
- **二选一选了"修复"**，修复方式是让启动器彻底失去拼 URL 的权力：baseURL 原样交给运行时，Anthropic 的 SDK 自己补 `/v1/messages`。于是把 baseURL 写成 `.../v1` 时得到 `/v1/v1/messages`——**与 DSH 完全相同的失败**。旧探测器会把它"纠正"成 `/v1/messages` 并报告测试通过，等于向用户保证一份 DSH 跑不通的配置是好的。
- **假能力信号按第 1 条消掉**：`test` 一侧不再有任何协议清单，可测集合在调用时现场问运行时（`supportedProtocols()` ∩ `getApiProvider(api)`）。只有 `models` 保留一份镜像清单 `LISTABLE_PROTOCOLS`，原因见下条；它由对照测试拿安装中的运行时源码逐字比对，漂移即失败。
- **更正本节自己的前提**：`discoverModels` 不在 DSH 核心（`dsh/lib` 里没有它），而在首方插件 `@deepseek-ai/dsh-llm-pi-ai`，且只通过 `ctx.llm.registerModelDiscovery(NS, …)` 注册——不启动插件宿主就调不到，探测进程不能加载用户 Profile 与插件，因此无法直接复用。核实到的真实语义是：**只有 OpenAI 兼容协议可读清单**（`LISTABLE_PROTOCOLS = {openai-completions, openai-responses}`），其余协议运行时明确抛 `DISCOVERY_UNSUPPORTED` 让用户手填；`listingUrl` 就是 `${base}/models`，**不做任何 `/v1` 补全**；目录已知服务商**直接返回目录、完全不发网络请求**。分段的真实形态是"DSH 根本不测 Anthropic 的模型清单"，不是"DSH 拼路径方式和探测不一样"。据此 Anthropic 的模型清单测试**被禁用**（判定拒绝且一个字节都不发出去），而不是把路径"修好"。
- 附带发现并修正一处自己的错：`onResponse` **只在成功路径触发**（适配器把 SDK 的错误咽下去、返回一条 `stopReason: 'error'` 的消息），所以状态码改从注入的 `fetch` 里取。用 `onResponse` 的话 401 会被误报成"响应无效"，丢掉"密钥被拒"这条最有用的信息——这条是测试跑出来的，不是推理出来的。同时固定 `maxRetries: 0`（探测要一次给结论，不静默重试）与 `redirect: 'manual'`（这一跳带着用户密钥）。
- **界面按第 5 条补齐**：结果含模型名与完成时刻；失效判据是"产生该结论的那份输入"的签名（端点│协议│模型│密钥），改任一即转灰并明说已失效，**每模型粒度天然满足**。第 4 条的诚实性也落了：通过文案改成"该模型已应答（不代表整份配置通过 DSH 校验）"。
- 原有两条测试**把错误行为锁住了**：`probeEndpoint(..., 'anthropic-messages', 'models')` 断言拼出 `/v1/models`，正是运行时拒绝做的事；Anthropic 的 `test` 只喂不带 `/v1` 的 baseURL，恰好绕开唯一会分叉的输入。两条都已改写。
- 顺带把"什么算一份运行时"的解析规则抽到 `runtime-under-test.mjs` 单一定义，两份服务商测试共用；测试进程与宿主用**同款调用方式**（`node --input-type=module -e <脚本> -- --launcher-provider-probe`，cwd = DSH 包目录），因此模块解析走的也是生产那条路。
- **当时没做、检查阶段补了一半**（2026-09-09 更正）：`openai-completions` 的 SSE 成功路径现在有用例了——本地网关伪造一条合法的完成流，钉住"判成成功、如实带出运行时看到的 200、成功后绝不重试、请求体里是用户选的那个模型、密钥不出现在结果里"，仍然**零出网、零真实用量**（`a valid completion stream reports success with the status the runtime actually saw`）。**仍然没做的两件**：① 另两种协议（`openai-responses` / `anthropic-messages`）各自的合法帧没造，一套一个格式，成本高且易碎；② 真实服务商是否接受我们构造的这份请求，只能在带 ⚠ 的界面步骤里验——伪造的响应只证明接线，不证明对端。本轮全部对照仍在 `127.0.0.1` 本地网关。
- **检查结果**：`pnpm test:provider` **25 passed / 0 failed / 0 skipped**（skip 计数为 0，说明委托类用例确实跑在真实运行时上，没有静默降级）；`pnpm typecheck` 0 错；改动文件 ESLint 0 错；中英文案 918 : 918 对齐、无单边 key；`git diff --check` 无空白错误。（这组是 #27 交付当时的数字；此后的最新数字以 §7.1 对账单与本节末尾记录为准。）
- **部署提示**：探测脚本经 `include_str!` 内嵌进二进制，**改 `.mjs` 必须重新编译并重启 `pnpm tauri dev` 才生效**，热更新不会带到已运行窗口。整批服务商改动至今仍未在真实界面里验证过。

### 2.8 DeepSeek 专用适配与旧数据

- `llm-deepseek` / `deepseek-official` 与通用目录里的 `deepseek` 路由**分别识别**，先核实能力与配置契约再决定呈现；**不自动互相转换，不覆盖原有配置**。
- 旧模板按原有自定义配置读取，不因 ID 命中目录而自动迁移；用户主动转换时先展示差异。
- 运行时切换后重新检查能力，**不静默丢弃不支持的字段**。
- Windows 继续使用 DPAPI。若要求完整支持 macOS/Linux，**另设系统凭据存储适配阶段，不以明文文件作为临时降级方案**。

**#19 落地状态（2026-09-08）**

- `readProviders()` 已实现并有集成测试，与导入共用**同一个** `openProviderDocuments()`：Profile 路径解析、Home 越界拒绝、符号链接拒绝、凭据文档形态校验、锁内读写、YAML 指纹都只有一处定义。**把路径解析复制进第二个脚本，等于把安全规则复制一份**——这是 refactor 的直接动机，也顺带消除了"两套合并语义"的分叉风险。
- 测试锁住的断言：返回体里不出现任何凭据值或未知字段里的令牌；`headers` 这类非模板自有字段只报字段名；未声明引用的路由判为"走环境认证"而不是"缺密钥"；无引用的凭据只报告、不删除；指纹随文档内容变化。
- 保守判法（§2.4 的四轴）已落到代码：引用在文件里查不到时判 `unverifiable` 而非 `missing`（看不到实例子进程的 env 与 `cwd/.env`）；默认模型指向文件里认不出的路由时判"未确认"而非"失效"（§1.5-E 证实插件可运行时注册路由）。
- 重构过程中测试立刻抓到一处我自己引入的回归：解构漏掉 `supportedProtocols` 导致 `ReferenceError`。若没有这条测试就会带病合入。
- **Rust 命令已补齐**：`read_instance_providers(instance_id)` 复用同一个内嵌脚本（不新增第二份实现），绑定 `instance_id`、走当前选中运行时、带超时与稳定错误码（`PROVIDER_READBACK_TIMEOUT` / `PROVIDER_READBACK_FAILED`，脚本给出的 `PROVIDER_*` 码原样透传）。回读是只读的，因此**不要求实例停机**；返回体按 `serde_json::Value` 交出，前端类型化随 #20 一并做。`cargo test` 133/133，`pnpm test:provider` 13/13。
- **仍待完成**：回读结果的前端类型与消费方都在 #20（实例"模型服务商"子页）；写路径与并发校验属 #21。

### 2.9 方案一验收

用户能在实例内完成 **添加 → 选择模型 → 可选测试 → 明确设置默认模型 → 保存并回读**，全程无需手改 YAML。模板复用、目录继承、共享影响、冲突处理、未知字段保留均需测试覆盖；测试通过的配置还要在真实 DSH 实例中验证。

## 3. 方案二 · 界面与交互优化

### 3.1 视觉方向：保留配色，重做信息层级

保留雾蓝樱粉主题、现有图标体系（Gravity）与克制圆角（`rounded-md` 已是事实约定，221 处）。重点调整文字、间距、边框与操作层级。

| 元素 | 要求 | 落地修正（已验证） |
|---|---|---|
| 页头 | 标题 + 必要状态 + 右侧操作，删除重复小标签 | 5 处同构 eyebrow+h1+描述段：`download-center.tsx:762-777`、`instance-manager.tsx:292-299`、`more-panel.tsx:118-124,300-306,371-376`、`personalization-panel.tsx:136-142`。`more-panel` 日志页还有 h1(`:235`) 与面板 header(`:239`) 重复渲染 `more_logs.title` |
| 页级标题 20–22px | 避免每页大幅介绍区 | 6 处 `text-2xl`(24px)：`download-center:767`、`instance-manager:298`、`more-panel:122,235,304,375`、`personalization-panel:140`。例外：`collaboration-panel:1407` 已是 20px、`tray-panel:158` 15px、`launcher-shell:126` 19px——**这三处已是目标形态，当参照实现用** |
| 正文与操作文字 13–14px | 为主 | **已是现状**：`main.css:486-500` 全局 `body{font-size:14px}`，`text-sm`(14px) 112 处 |
| 辅助文字 12px 为主 | 关键内容不使用 10px | 部分成立、范围比预想小：sub-12px 共 46 处（`text-[10px]`×19、`text-[9px]`×1、`text-[11px]`×26），绝大多数是徽章与等宽 meta。**唯一真正作用于可操作内容的是 `download-center.tsx:1028` 启用/禁用按钮用 `text-[10px]`**；最小值 `more-panel.tsx:354` 的 `text-[9px]` |
| 内容间距 | 统一间距尺度，缩减无效留白 | **表述需修正**：你举的极端值全仓不存在（无 `gap-8+`、无 `space-y-8/10`、无 `py-12`），实际由 `gap-3`(47)/`gap-2`(42) 主导。真问题是 `p-8`(10 处；早期记为 8，本轮重测更正)、`px-8 py-7`(3 处)、`mb-7`(4 处) 靠**复制粘贴**统一、没有 token。所以这条落地为"引入间距尺度 token 替换重复"，不是"缩减留白" **→ 2026-09-09 改判：不引入 token。** 实测重复为 `p-8` 10、`px-8 py-7` 3、`mb-7` 4 共 17 处；批量替换属纯视觉重构，必须靠眼睛复核布局没有跳动，而现在没有安全的验证窗口（用户机器上有实例在跑）。维持复制粘贴统一，本条**关闭**，不再作为待办被重新翻出。 |
| 表面与边框 | 减少卡片套卡片，普通区域优先分隔线 | 只有 **2 处真卡片套卡片**：`download-center.tsx:972→1001→1010`、`:144`。其余是图标 chip（`more-panel:309→312,354`、`instance-manager:325→327`），不算卡片套卡片。工作量远小于方案假设 |
| 强调色 | 主要用于主操作、选择状态与重要信息 | **已是现状**：11 个 `--launcher-*` + HeroUI token 重映射（`main.css:127-194`）+ 13 套主题（`:198-341`），未发现散布的新固定主色 |
| 设置表单 | 限制阅读宽度，避免简单下拉横跨整页 | **成立**：页面级 `max-w` 到处都有（900/1080/1240），但**列内控件一律 `w-full`**——`personalization-panel:213,238` 的 `launcher-select w-full` 横跨 900px 整列。正确写法已存在可抄：`download-center:786,827,986` 的 `min-w-[220px] flex-1` / `w-[190px]` / `w-[160px]` |

介绍区统一改紧凑页头，但**不机械删除所有解释**：普通知识放帮助或空状态；字段规则放字段旁；风险与作用域放动作附近；当前状态直接展示，不藏在介绍段落中。

**硬约束**：不得改动 `main.css:486-500` 的 `body{font-size:14px}`——它是全站 rem 基准，且协作画布永久挂载，动它等于改全站。字号只在组件层用 `text-*` 调整。

### 3.2 共用界面基础（阶段 1b）

现状只有 toast 系统（`utils/toast.ts` + `toast-provider.tsx`）、`loadable.tsx`（但只服务实例窗口的 setup/harness，**不服务启动器页面**）、`SharingNotice`（`instance-wizard.tsx:14`，被 manager/settings 复用）、`primitives.ts` 里一个只被 loadable/setup 用的 `button` tv()。

**PageHeader / Toolbar / SectionCard / EmptyState / ErrorBanner / StatusBadge / ProgressBar / SearchInput / ConfirmInline / Pagination 全部不存在**，8 个页面各自手写。所以这一阶段是**新建抽象（invention），不是整合现有抽象**——好消息是手写副本高度一致，收敛风险低。

要交付：上述 10 个组件 + `Field`（带内联错误，取代"只有灰色保存按钮"）+ `StickyActionBar`（从 `provider-templates.tsx:269-285` 的 `sticky bottom-0 z-10` 推广，现状只有它一处）。`Pagination` 需收敛全仓三份重复标记（`download-center` 的 `PaginationBar` 函数、其社区目录区的内联副本、`provider-templates` 的 `ProviderPaginationBar`）。`ErrorBanner` 需收敛 ≥6 处重复 div。`StatusBadge` 替换内联 `rounded-full px-2 py-1 text-[10px]` span。

### 3.3 逐页调整（含审计发现的代码真问题）

| 页面 | 方案要求的升级 | 代码里存在但方案未提的真问题 |
|---|---|---|
| 启动概览 | 实例名称、状态、启动/打开窗口操作集中；基础信息压缩；共享正常时简化、冲突时展开 | 无"停止中"标签（`busyInstanceId` 只禁用按钮 `:311`）；运行圆点 `:264` 只有颜色无文字；错误直接 dump 共享的 `launcher.error` 字符串 |
| 新建实例 | 常用字段优先，Home/Profile 给默认值与高级入口；模型配置可跳过也可直接添加 | 模板加载**没有 skeleton**；版本号在此页是 div、在环境设置是 disabled select，同一信息两种呈现 |
| 环境设置 | 标题在前、基础配置分组；服务商移到独立子页；持续展示当前实例 | **导出无进度无取消**；导出结果与错误共用一个 `<p>`(`:397`)；保存失败可能显示来自其他操作的**陈旧 store error** |
| 下载插件 | 压缩页头；安装目标、来源、搜索、分类形成紧凑工具区，提高第一屏列表可见面积 | **单个安装完全没有取消路径**（后端 `cmd.rs:1443-1446` 支持，前端 `:585-606`、`:608-630` 没接）；无页内分项进度；无重试 |
| 插件包 | 明确包内容、目标实例、安装条目与进度；保持逐条执行与取消 | 已完整实现（`cancellingInstall`→"正在停止..."、后端 `taskkill /T /F` 杀完整进程树 `plugin/cancel.rs:80`）——**作为其他流程的样板** |
| 已安装插件 | 目标实例与运行限制持续可见；操作后及时回读，反馈不只依赖 Toast | — |
| 导出 | 明确完整 Home 备份与选择性导出；目标、内容范围、敏感提示与执行结果集中 | 见环境设置行的导出问题 |
| 全局设置 | 改为紧凑设置行，说明与控件同行或相邻，减少单项大卡片 | 见 §3.4 的 personalization 冗余保存按钮 |
| 个性化 | 主题预览与真实选中状态清楚，统一保存反馈 | 空 catch 吞掉保存失败（`personalization-panel.tsx:77-79`） |
| 更新与运行时 | 桌面版本、DSH 版本、选中运行时分区展示；来源、可更新状态、失败恢复清楚 | `checkError` 存了**从不渲染**（`updater/store.ts:44` vs `more-panel.tsx:165-167` 只显示泛化提示）；更新进度只有全局 1px 条，页内无进度 |
| 日志 | 筛选、复制、刷新集中在工具栏；明确复制范围与清空含义 | 只在 mount 读一次，**无刷新无清空**（`more-panel.tsx:217-248`）；页标题与面板标题重复渲染同一 key |
| 项目链接、致谢 | 简洁列表，减少标题区与装饰容器 | — |
| 托盘 | 与主窗口状态用语一致，区分启动中、可打开、停止中及失败 | **绕过 launcher store**（`tray-panel.tsx:122-149` 直接调 `launch_instance_window`）→ 无 install-progress、无 launchFailure modal、**无前端 `updater.updating` 守卫**（复核后更正：`launch_instance_window` 会取 `RuntimeUseGuard`，更新/切换运行时期间后端直接回 `DSH_RUNTIME_BUSY:runtime is being switched or updated`，拦截一直存在；真实缺陷是托盘把这条原始码原样显示给用户，详见下方 #24 落地状态）；无"启动中"状态（启动中的实例留在"可启动"分组直到 3s 轮询）；**完全没有停止操作**；失败只有泛化 banner |
| 协作 | 本轮**不升级**，但共享 CSS 变化必须检查是否影响它 | `stopRun` 直接翻回 idle（`:1004-1013`），`cancelRemoteTask` 是 fire-and-forget，无 CANCELLING |

顶部导航名称本轮**保留**既定的"启动、下载、协作、设置、更多"，不引入导航迁移。

协作页暴露面（已定位）：它**不用 HeroUI**（纯 HTML + `@gravity-ui/icons` + `--launcher-*` 变量 + toast util + `store.launcher`），且永久挂载。因此 `main.css:358-459` 挂在 `.launcher-theme` 下的 HeroUI 覆盖（modal/select/danger/toast）**不直接命中它**。真正会波及的是 `:root`/light tokens、keyframes + view-transition 伪元素、`.tray-panel`、`.launcher-blur`（含 `.launcher-blur .bg-white`）和 `@layer base`。

**#15 落地状态（2026-09-08，部分完成）**

- **save-state 抽象已建**：`src/utils/save-status.ts` 提供 `idle/saving/saved/failed` 状态机与 `saveStatusLabel`；首个接入方是 `personalization-panel`（替换其自制 `saved` 布尔量与裸 `setTimeout`，并补上此前完全没有的"保存中"态，按钮在写入期间禁用）。新增通用文案 key `ui.saving`（两份 locale）。
- **字号下限已扫清 10px/9px**：全仓 21 处 `text-[10px]` / `text-[9px]` 归一到 `text-xs`(12px)，含 `download-center` 的启用/禁用按钮——那是全仓唯一用 10px 渲染**可操作内容**的地方。现在只剩 `launcher-ui.tsx` 注释里的一处提及（非样式）。
- **两处刻意延后**：① `text-[11px]` 仍有 28 处分布在 8 个文件，其中 13 处在协作页——本轮明确不升级协作页，且它的字号密度与画布布局需要单独判断，不跟着批量改；② 间距 token 没有单独落地：现状的 `p-8` / `px-8 py-7` / `mb-7` 是复制粘贴出来的统一，**先定义 token 再接入等于先造一段没人用的 CSS**，因此随 #22–#25 每页接入 `PageHeader` / `SectionCard` 时一并换成 token，改一处即全站生效。

**#22 落地状态（2026-09-08）**

- **启动概览**：介绍区换成 `PageHeader`（eyebrow `launcher.current_instance` 删除，两份 locale 同步移除；标题 24px→20px）；状态改为 `StatusBadge` 文字徽章，启动中／运行中／停止中／已停止四态可区分。**修正一处状态误报**：`busyInstanceId` 同时覆盖启动与停止两条路径，原 `activeIsBooting = activeIsStarting || busy` 会把「停止中」显示成「正在启动实例...」；现在 `activeIsStopping = busy && 仍在运行清单`，并从 booting 中排除。实例列表的运行圆点补文字（不再只靠颜色），概览底部失败反馈由裸 `<p>` 换成 `ErrorBanner`。
- **新建实例**：服务商块从表单最前移到 Profile 之后（常用字段优先），补齐加载骨架、无模板空状态与「可跳过 + 去哪里补」提示；版本号呈现与环境设置统一为只读框。
- **环境设置**：保存改用 `useSaveStatus`，失败只展示本次保存的原因——**不再渲染共享 `launcher.error`**（此前会展示来自启动/停止/删除等其他操作的陈旧错误串）；版本号的 disabled `<select>`（只有一个选项的假控件）换成只读框，背景从硬编码 `#f8fbff` 改回 `--launcher-sidebar`。
- **导出（偏离点：必须动后端）**：§3.3 要求的「进度与取消」无法只在前端完成。`service/export.rs` 新增导出槽位（同一时刻只允许一个导出，`EXPORT_ALREADY_RUNNING:<id>`）、按文件记账的进度上报（`export-progress`，节流 160ms，载荷只有 `instanceId/stage/files/bytes`——**不含任何路径或文件名**，避免把 Home 内部结构回传前端）、逐文件检查的取消（`EXPORT_CANCELLED_BY_USER`），失败与取消都删除半个压缩包；新命令 `cancel_instance_export` 必须命中正在导出的实例，否则回 `EXPORT_NOT_RUNNING` / `EXPORT_INSTANCE_MISMATCH:<id>`。前端拆分成功结果与失败原因（此前共用一个 `<p>`，失败路径会被当成「导出文件」展示），并区分「关掉文件对话框」与「用户主动取消」。总量在压缩前不可知，所以用不确定进度条 + 真实文件数与体积，不伪造百分比；顺带修掉 `ProgressBar` 不确定态是一根静止 1/3 色条（看起来像卡在 33%）的问题。
- **提前做掉 #28 的一项**：`pnpm test:provider` 此前在没有 `DSH_TEST_ENTRY` 时静默跳过 11 个集成用例，只剩 3 个单元测试通过，读起来像全绿。现在测试文件自行解析全局 DSH：按 `npm_config_prefix`/`PREFIX` 与 node 可执行文件位置推出候选全局根目录（Windows 与 nvm-windows/Volta 是同级 `node_modules`，POSIX 前缀布局是 `../lib/node_modules`），读取包清单的 `bin` 定位 CLI 入口。**不派生 npm**——Windows 下派生 `npm.cmd` 需要 `shell:true`，会触发 DEP0190（参数不被转义）。解析不到就明确警告这批用例是跳过而非通过。当前实跑 14/14 通过、0 跳过。
- **未验证**：以上只过了 `pnpm typecheck`、`npx eslint src`(0 error)、`pnpm build`、`cargo check`、`cargo test`(131 passed)、`git diff --check`，**没有真机 GUI 验证**（需重启 `pnpm tauri dev`）；导出进度与取消属后端改动，按 AGENTS.md 必须重启后手动验证。

**#23 落地状态（2026-09-08）**

- **单个安装的取消路径已接通**：后端 `cancel_plugin_install` 与逐条取消检查对目录安装、手动规格安装同样有效（两个命令都先 `plugin::reset_cancel()`，手动循环在每条规格之间检查 `install_was_cancelled()`），只是前端从来没调用过。现在 `cancelPackInstall` 统一为 `cancelInstall`（三种安装共用），入口三处：目录卡片按钮在安装该项时变为「停止安装／正在停止...」、手动安装按钮同理、日志面板头部常驻停止按钮。取消不再被当成失败写进错误横幅，只提示「已停止安装」并保留日志。
- **重试**：真失败的那次安装记为 `InstallAttempt`（目录插件或手动规格），错误横幅上出现「重试安装」。手动安装成功后输入框会清空，重试会把原规格放回输入框再执行，用户能看见将要跑什么；取消不记入重试。
- **手动安装的真实分项进度（偏离点：动了后端）**：`install_plugin_packages_for_instance` 解析出的规格总数本来就已知，此前却只有日志。现在按条发 `plugin-install-progress`（`completed/total/spec`），解析完成先发 `0/total` 让分母立刻可见；日志面板头部显示「第 N/M 条」。`spec` 是用户自己填写的公开包规格，不含凭据。目录单插件安装只有一项、无法分项，其进度就是安装日志本身——**没有为它编造百分比**。
- **日志面板补齐三态**：安装一开始就出现（此前要等第一行输出），无输出时显示「等待安装输出...」，标题旁显示正在安装的插件名；安装期间禁用清空，避免清掉唯一一份日志副本（显示 120 行、复制保留 5000 行的既有语义不变）。
- **页头与工具区**：`PageHeader` 取代 eyebrow + 24px 标题（`download.eyebrow` 已删）；插件包页的提示词链接从副标题里的内联下划线 span 提升为操作区真实按钮，副标题结尾的冒号相应改成句号；三处重复的错误 div 收敛到 `ErrorBanner`；目标实例条改为吸顶，并把「同 Home 实例运行中」的限制提示并入其中——原来它是页面顶部独立 div，往下滚就看不见，而列表里的启用/删除按钮正是靠它解释为什么被禁用。
- **刻意留到 #28 的一项**：卡片套卡片（目录/已安装列表的外层 panel 里再放卡片网格）没改。外层 panel 同时承载工具行与分页，去掉外壳会让工具行悬空；这是纯视觉项、效果必须真机看，放到 #28 与其余视觉核对一起做。§3.1 记的另一处 `:144`（插件包详情的插件清单）复核后**不成立**：它是单个带边框的滚动容器 + 分隔线行，本来就是「普通区域优先分隔线」的目标形态。
- **未验证**：同样只过了 typecheck / eslint(0 error) / build / cargo check / cargo test / `git diff --check`；取消、重试、逐条进度与吸顶都要重启 `pnpm tauri dev` 后真机确认。安装会真实写入目标 Profile，验证必须用一次性 Home 的实例。

**#24 落地状态（2026-09-08）**

- **托盘不再绕过 store**：`launchInstance` 改为先尽力 `select_instance`（失败只 `console.warn`，不阻断——启动本身按 `id` 绑定，选中只决定主窗口概览显示谁），再走 `store.launcher.launchInstance(id)`。install-progress、`launchFailure`、`INSTANCE_HOME_RUNNING` 的既有 Toast 与 busy 语义因此全部复用主窗口那一套，托盘自己不再维护 `busyId`。失败按错误码映射成人话（`DSH_RUNTIME_BUSY`／`INSTANCE_ALREADY_STARTING_OR_RUNNING`／`INSTANCE_LAUNCH_TIMEOUT`，其余归「实例启动失败」），原始串放进 `ErrorBanner` 的 detail；`launchFailure` 与 `error` 都为空时**不编造失败原因**（共享 Home 互斥已由 store 弹过 Toast，再报一次就是重复）。
- **托盘补上停止与状态文字**：运行中的行有独立停止按钮（整行按钮里再嵌停止按钮是非法 HTML，行结构改为 div + 两个并列按钮），状态文字与启动概览共用 `launcher.instance_status.*`，由 `busyInstanceId` × `runningInstanceIds` 推导；启动期间显示后端上报的真实 install-progress，总量不可测量时走不确定态，不伪造百分比。**偏离点**：停止成功后不隐藏面板（启动/切换仍隐藏），让该行从「正在运行」移到「可启动」的过程可见。
- **更正 §3.3 托盘行的判定（原文是我写错的）**：原文称「无 `updater.updating` 守卫 → DSH 更新进行中从托盘启动实例不会被拦，这是行为缺陷不只是文案」。复核 `bridge/cmd.rs`：`launch_instance_window` 先取 `RuntimeUseGuard`，更新/切换运行时时 `RUNTIME_ACCESS == RUNTIME_WRITER`，后端直接回 `DSH_RUNTIME_BUSY:runtime is being switched or updated`。拦截一直存在，缺的只是把这条码翻译成人话（本次已补）。把 UX 缺口写成数据安全缺陷会误导排期，故就地更正而不是另起一段。
- **个性化**：删掉底部那个只重提交「透明度 + 启动方式」两项的冗余保存按钮——其余字段早就改动即写盘，它既不是「保存全部」也不是任何字段的唯一提交路径（已核实 `update_app_config` 全部参数是 `Option`，未传字段保持原值）。保存状态移到页头 `StatusBadge`（保存中／已保存／失败），失败原因改由页头下方 `ErrorBanner` 展示：原来那段靠右小字位于页面最底部，长页面下看不到。两份页面说明补「改动会立即保存」，`launcher.personalization.save` 成为死键已删。
- **主题选择器：预览与选中分离**：原来只把 `colors[0]` 画成实心圆点，另外两个颜色永远看不到，用户点之前无法预览整套配色，而「选中」又只靠这一个实心/空心差别。现在三色分段预览常驻（这是预览），选中态由外圈 ring + 名称加粗变色表达；顺手去掉 `role="radio"` 上多余的 `aria-pressed`（选中态由 `aria-checked` 表达）。
- **更新页**：`PageHeader` 取代 eyebrow（`more_updates.eyebrow`／`more_links.eyebrow`／`acknowledgements.eyebrow` 三个死键已删）；**页内更新进度落地**——直接读 `updater` 已有的 `progress/phaseTitle/phaseDetail/indeterminate`（此前只有 `launcher-shell` 顶部那根 1px 全局条），带百分比与阶段说明，并补一句「更新期间无法启动或停止实例」；`checkError` 从两段裸 `<p>` 换成 `ErrorBanner`（message 为可操作提示、detail 为原始错误），且更新中不再与进度块抢位。运行时列表补「使用中」徽章与「正在切换运行时...」反馈（此前切换期间只有按钮变灰，看不出在做什么）。
- **日志页（诚实性缺口）**：原来 `read_run_logs` 失败被 `.catch(() => {})` 吞掉，用户看到的是「暂无运行日志。」——把读取失败说成没有日志。现在区分加载／失败（`ErrorBanner` + `more_logs.read_failed`）／空三态，页头有刷新按钮，面板头明确「复制完整日志」「清空显示」「恢复显示」并显示真实行数。**清空只清前端显示，日志文件不删**（后端也没有删除日志的 command），清空后头部与正文都写明这一点，复制仍取完整内容。页标题与面板标题重复渲染同一 key 的问题一并修掉（面板头改为范围说明）。
- **链接与致谢**：`rounded-lg` 收敛到 `rounded-md`，装饰性 `size-11` 缩写色块缩到 `size-8` 并去掉阴影，`text-[11px]` 的 URL 提到 `text-xs`，四个 section 的 `p-8` / `p-6 md:p-8` 统一为后者；顺带删掉两条从未被引用的 `more_links.hairyf_launcher*`（hairyf 的封装端仓库在「致谢」已有人物条目，该 URL 本来也不可达，删除不损失任何现有入口）。
- **未验证**：本阶段只过了 `pnpm typecheck`(0)、`npx eslint src`(0 error / 2 warning，两处均为 HEAD 既有：`download-center` 的 `setTargetId`-in-effect、`use-scope` 的 `useContext`)、`pnpm build`(8.60s)、`git diff --check`(仅 export.rs 的 CRLF 既有提示)；**本阶段无 Rust 改动，因此未跑 cargo**。托盘是独立 WebView，改动必须重开托盘窗口才生效；更新进度、日志工具栏与主题预览都要重启 `pnpm tauri dev` 后真机确认。

**#25 落地状态（2026-09-08）**

- **全局任务入口**：`launcher-shell` 顶部原来那两条**不可交互**的 1px 进度条（DSH 更新、插件包安装）换成一条可点击的任务条：每行一个在途任务或待处理失败，显示对象与阶段、真实百分比（不可测量时走不确定动画），点击跳到任务所属页面（更新→更多、插件包→下载、实例启动/停止与启动失败→启动，并沿用 `launchRequest`/`moreRequest` 的 key 刷新语义）。任务来源覆盖 `updater.updating`、`packProgress`、`store.launcher.busyInstanceId`（用 `runningInstanceIds` 区分启动中与停止中，阶段文案优先用后端 `installProgress.title`）与 `launchFailure`。**失败因此有了跨页入口**：`launchFailure` 过去只有回到启动页才会重弹 Modal，现在任何页面都能看到并点回去。
- **导航徽章**：某个区有在途任务或待处理失败时，对应导航按钮里出现小圆点（失败用 `danger` 色）。圆点 `aria-hidden`——文本已由任务条承载，不靠颜色单独表意。
- **错误码映射统一到一处**：新增 `src/utils/error-codes.ts`（`parseBackendError` / `errorHasCode` / `errorHasCodePrefix` / `errorText` / `errorDetail` / `errorBannerDetail` / `isCancellation`），迁移 8 处 ad-hoc 解析：`launcher/store.ts` 的 `INSTANCE_RUNNING` 与 `INSTANCE_HOME_RUNNING:<id>:<name>`（名字提取不再靠对整串 `split(':').slice(2)`）、`tray-panel` 的启动失败映射、`instance-manager` 的移除失败、`download-center` 的市场网络判定与两处"取消不是失败"、`instance-settings` 的导出取消/`EXPORT_NOT_RUNNING`。三处错误横幅（下载页 ×3、导出、移除）从"直接显示后端原始串"改为"映射后的原因 + 原始码作为 detail"；`PROVIDER_*` 仍走 `provider-error` 的分组文案且**不回传原始载荷**（可能含 headers/token），detail 只给码名。未登记的码返回原始串——宁可显示生串，也不编一个看起来确定的原因。
- **核查中纠正的两处误判（都差点写成"死代码"）**：① `PLUGIN_PACK_MARKET_NETWORK` 在 Rust 里搜不到字面量，一度判为前端幻觉；实际由 `pack.rs:504` 的 `format!("{prefix}_NETWORK: {error}")` 动态拼出，是真的。② `provider-error.ts` 里 15 个码在 `.rs` 中搜不到，一度判为过期映射；实际其中 14 个由 `.mjs` 层（`provider-probe.mjs` / `provider-import.mjs`）经 stderr 回传，`cmd.rs:1889,2038` 原样透传。只有 `PROVIDER_SETTINGS_INVALID` 两边都找不到（存在的是 `PROVIDER_SETTINGS_CHANGED`）——**保留未删**，因为前两次静态检索都出现了假阴性，凭一次 grep 删映射不成立。
- **本轮明确没做**：① 协作页 `stopRun` 直接翻回 idle、无 CANCELLING——§3.3 已写明协作页本轮不升级；② DSH 更新无取消——取消一次事务替换要么完成要么回滚，属后端改动，不在前端批次里；③ 导出进度没进全局任务条——`export-progress` 的监听与状态仍在 `instance-settings` 内部，提到 store 才能全局可见，留给 #26/#28 判断是否值得。
- **未验证**：`pnpm typecheck`(0)、`npx eslint src`(0 error / 2 warning，均为 HEAD 既有)、`pnpm build`(7.79s)、两份 locale key 数 838:838 且无单边缺失、`git diff --check`。**没有 Rust 改动，未跑 cargo**。`error-codes.ts` 目前**没有单元测试**（仓库只有 `node --test` 跑两个 `.mjs`，无 TS 测试链路），解析与映射的正确性只靠人工核对错误码来源，已排入 #27。任务条、徽章与各页错误文案都要重启 `pnpm tauri dev` 后真机确认。

### 3.4 统一保存与页面切换

- 全局偏好采用自动保存，显示"保存中／已保存／保存失败"；实例配置与服务商编辑采用明确保存。
- 长表单使用固定底部操作区，显示未保存状态。
- 页面切换保留必要的搜索、分页和滚动位置。
- 编辑草稿未保存时提供保留草稿或明确离开处理。
- **网络或磁盘失败不能静默吞掉，让界面看起来已经成功。**

审计结论：

- "部分全局设置已修改即保存却仍有保存按钮"—— **成立，但只有一处**：`personalization-panel.tsx` 的 `:82-105` 全部 on-change 自动保存，`:266-271` 仍渲染保存按钮，且该按钮 payload 只含 opacity + startupMode（theme/blur/removal-confirm 不在内但同样自动保存）；"已保存"提示每次自动保存都亮（`:268`），等于挂在一个永远不需要的按钮旁边；失败空 catch（`:77-79`）。**不是全局现象。**
- 静默吞失败共三处：`personalization-panel.tsx:77-79` 空 catch、`debug-sidebar.tsx:77-82` `useMutation` 无 `onError`、`collaboration-panel.tsx:405-407` 画布自动保存。
- 脏状态与离开守卫**几乎不存在**：全仓唯一 dirty 跟踪是 `collaboration-panel.tsx:266` 的 `dirtyRef`（只用于防抖与卸载 flush，不上 UI）；没有任何保存按钮对比原值（只在输入不完整时禁用）；无"未保存"指示；**零 `beforeunload`**；实例设置与向导草稿是组件 `useState`，切页静默丢失。
- 页面切换保留的**根因是导航实现不一致**（§1.3），不是各页各自的问题：统一保活策略即可，比逐页修补便宜。
- **#16 落地方式（2026-09-08，对"统一保活"的点名偏离）**：没有改成"全部常驻"。`launcher-shell.tsx:191` 的 `key={launchRequest}` 与 `key={moreRequest}` 是有意用 key 变化强制刷新，常驻会破坏该语义，且会让隐藏页在启动时提前发 IPC。改为新增 `src/utils/surface-state.ts`：`useSurfaceState(surface, key, initial)` 与 `useSurfaceScroll(surface, key)` 把搜索词、页码、滚动位置提到组件之外按 `surface:key` 记忆，仅存内存、随会话失效（需要落盘的偏好仍走各自配置存储）。首批接入 `provider-templates`（搜索词 + 页码 + 列表滚动）。其余页面的接入随 #22–#25 逐页完成；实例设置与向导的**编辑草稿**属于表单状态，需在 #24 结合未保存守卫一起处理。
- i18n：`launcher.saving_instance`、`ui.save`/`ui.saved`、`buttons.save`、`messages.save_failed`、`providers.saved` 两份 locale 都有；缺通用"保存中"、缺自动保存场景的失败文案、缺 "autosaved"。且 **`messages.save_failed` 在所有 `.tsx` 里从未被引用**——已存在但未接线。
- **无共享 save-state 抽象可继承，需新建。**

### 3.5 统一长任务与失败反馈

要求：始终可见正在操作的对象与阶段；有真实进度才显示进度值（无法测量时用不确定状态）；切页后仍能返回任务详情；取消后先显示"取消中"、完成清理才显示"已取消"；Toast 只用于短暂提醒、持续失败在页面保留原因与下一步；日志、重试、诊断入口贴近失败位置。**不是叠加更多横幅，而是让同一任务的状态有一个稳定入口。**

审计结论：

- 任务状态有**四种实现并存**（§1.3），插件包进度还被 lift 到 `launcher-shell.tsx:30`。
- 真实分项进度**只有插件包有**；单插件安装、导出、协作都没有。
- 取消语义：插件包**已完成**；单插件安装无取消路径、实例停止无"停止中"标签、协作直接翻 idle、DSH 更新无取消。
- "切页后能返回任务详情"：状态存活**大多已解决**（Valtio + 两个永久挂载面板），缺的是**入口**——只有两条不可交互的 1px 进度条（`launcher-shell.tsx:161-180`），导航项无徽章，托盘无在途指示，无法点进详情。`launchFailure` 存在 Valtio、回到启动页会重弹 Modal，但从其他页看不见。
- Toast 约 75 处调用。纯 toast 或完全无反馈的流程：DSH 更新全部结果（`updater/store.ts:61-201`）、协作运行失败与校验、托盘启动失败、personalization 保存（连 toast 都没有）、插件包取消/完成。
- 失败驻留：**`instance-manager.tsx:467-514` 的启动失败 Modal 是全仓标杆**（原因 + 肇事插件 + 禁用/移除补救 + 复制日志 + 重试），应作为模板推广。对比插件安装 banner（`download-center.tsx:807-809`）只有原始字符串、无重试、无相邻诊断。
- 错误码映射是约 5 处 ad-hoc 的 `.includes()` 字符串解析（`launcher/store.ts:177,263`、`tray-panel.tsx:135`、`instance-manager.tsx:51-55`、`download-center.tsx:439`）+ `utils/provider-error.ts`，其余直接显示原始字符串。应统一到一处映射。

### 3.6 诚实性缺陷批次（插队，不等视觉重构）

这批不是视觉问题，是"界面看起来成功但实际失败或不完整"，改动小、风险低、不依赖任何新抽象：

1. 安装日志"复制完整日志"实际只复制**最后 120 行**（`download-center.tsx:594,618,645` 的 `slice(-120)`）——要么真给全量，要么改文案。
2. 两种"清空"语义必须在界面区分：`download-center.tsx:1073` 只清前端，`debug-sidebar.tsx:69-75` 的 `clear_service_logs` **真删持久文件**；标签都不说明这一点。
3. `checkError` 接上渲染（`updater/store.ts:44` 存、`more-panel.tsx:165-167` 从不显示）。
4. 修三处静默吞失败（`personalization-panel.tsx:77-79`、`debug-sidebar.tsx:77-82`、`collaboration-panel.tsx:405-407`）。
5. 托盘不再绕过 launcher store，补回 `updater.updating` 守卫、launchFailure 结构化反馈与启动中/停止中状态。
6. 接线 `messages.save_failed`（两份 locale 已有，全仓从未引用）。

### 3.7 删除与共享影响

保持现有两种删除语义与导出询问偏好不变：`remove_instance_registry_only` 仅移除记录并保留所有文件；`remove_instance` 删除整个 `DSH_HOME` 并级联移除共享该 Home 的记录。改善的是按钮命名、影响列表与错误呈现——"无需导出"这类文字必须同时说明后续会发生什么。共享关系展示**实际受影响对象**（实例名 + Profile），不给一段泛泛的"可能影响其他实例"。

**#18 审计结论（2026-09-09，只读）**

- **两种删除语义的实际文案**：`registry_only` 一侧准确——`launcher.remove_instance_registry_only_description` 明确"只删记录，Home/Profile/插件/API Key/会话/文件都留在磁盘，可用同路径重建"，与 `remove_instance_registry_only` 的实际行为一致。**但发现一处缺陷**：`launcher.remove_instance_description`（唯一陈述"会删除该路径下全部 API Key、会话、Agent 预设…且无法撤销"的文案）**中英文都齐备，却没有任何组件渲染它**（`grep -rn remove_instance_description src/ --include=*.tsx` 零命中）。于是弹窗标题问"永久移除实例？"，正文却只谈导出和"仅移除记录"，**从头到尾没有说明破坏范围**。属 §1c 同类诚实性缺陷，已修：把它作为首行 danger 文案渲染在 `instance-manager.tsx` 的 `Modal.Body`。
- **级联影响列表是否具体**：**要求已满足**——`affectedInstances = registry.instances.filter(item => item.dshHome === active.dshHome)`（`instance-manager.tsx:49`）取全部同 Home 实例（含被删者本身），渲染为 `name · profile`，且只在 `sameHome > 1` 时出现，不是"可能影响其他实例"那种泛泛话。**两处呈现缺陷已修**：整张列表原先被 `join('、')` 压成一行文本，读屏软件只会读到一长串，已改为真正的 `<ul>/<li>`；分隔符原先硬编码中文顿号，在英文界面下仍是顿号，改为locale中性的 `·`。
- **关闭导出询问后的行为**：**与文案一致，且安全规则不依赖弹窗**——`confirm_before_instance_removal` 确实持久化，`instance-manager.tsx:88` 读回，个性化页的提示"关闭后点击移除实例会直接删除该实例的 DSH Home 和实例记录"与实际相符。关闭后 `requestRemove` 直接调 `removeInstance()`（`:127`），连带跳过"受影响实例"清单和弹窗里的运行中禁用；但 `remove_instance` 在 `instance_operation_lock()` 内先用 `removal_impact()` 枚举同 Home 的**全部**实例，任一 `instance_host_is_running` 即返回 `INSTANCE_HOME_RUNNING:<id>:<name>`（`bridge/cmd.rs:1291-1305`）。**所以关掉询问只损失预警，不会把"运行中禁止删除"这条规则一起关掉。**
- **未实测**：个性化页与实例管理页各持一份 `useState(true)`，其中实例管理页靠挂载时读配置初始化；用户在个性化里改完后**已挂载的**实例管理页是否会实时同步，未做界面级验证（两页不常驻同一视图，推测会随重挂载刷新，但没有证据）。
- 可复用资产：`SharingNotice` 已是共享组件。

### 3.8 可访问性与桌面细节

| 要求 | 判定 |
|---|---|
| 图标按钮有名称与提示 | **已做**：29 个 `isIconOnly` Button 全带 `aria-label`；`launcher-shell.tsx:151-157` 原生图标按钮有 aria-label + title。全仓无 Tooltip 组件，用原生 `title=`（32 处）——新增图标按钮沿用此约定 |
| 键盘焦点可见 | **部分**：select（`main.css:399-403`）、tray（`:471-474`）、`personalization-panel:158`、`instance-wizard:117` 有显式 focus-visible；但 **15 个 `outline-none` 文本输入只靠边框变色**（`instance-settings.tsx:412`、`instance-wizard.tsx:147,160,171`、`provider-templates.tsx:129`、`provider-models.tsx:38`） |
| 状态不只靠颜色 | **真问题 2 处**：`instance-manager.tsx:264` 与 `tray-panel.tsx:241` 的运行圆点无文字。`download-center.tsx:149`、`collaboration-panel.tsx:1695` 已有文字配对 |
| 窄窗口与长文本 | **已做**：truncate 41、min-w-0 70、break-all 9、break-words 7、line-clamp 3；长路径有处理（`debug-sidebar.tsx:214` mono truncate + title） |
| 动画与减少动效 | **已做**：`main.css:120`、`utils/view-transition.ts:3-7`、`motion-reduce:` 约 25 处跨 11 文件、View Transition 已用（`instance-manager.tsx:256,292` + `main.css:109-118`），动画基于 transform/opacity |
| 保留独立实例进程、任务栏与托盘行为；启动器样式不侵入 DSH 原生 Web | 现有行为保持，不在本轮改动范围 |

### 3.9 方案二验收

中英文、长路径、不同主题统一验收；`prefers-reduced-motion` 与减少动效一致；窄窗口无文字溢出重叠；固定工具栏/分页/角标/图标按钮有稳定尺寸且动态文字不推动布局；每个页面覆盖加载、错误、空、禁用、运行中、取消中、完成七态。

## 4. 阶段排序与任务表

依赖已落到会话任务列表（#10–#29），这里是执行顺序基线。

### 阶段 1（四线并行，无前置）

| ID | 任务 | 线 |
|---|---|---|
| #10 | S0 服务商只读能力核实 | 1a 后端契约 |
| #14 | 共享界面组件层 | 1b 视觉契约 |
| #15 | save-state 抽象 + 间距/字号 token | 1b |
| #16 | 导航保活策略统一 | 1b |
| #17 | 诚实性缺陷插队修复 | 1c 插队 |
| #18 | 补审 §3.7 删除与共享影响文案 | 调研 |

### 阶段 1a 续

| ID | 任务 | 前置 |
|---|---|---|
| #11 | 确认 §6 三项待决 | #10 |
| #12 | S1 模板判别式改造 | #10 #11 |
| #13 | S1 目录接入与能力门禁 | #10 #11 |

### 阶段 2 · 服务商核心闭环

| ID | 任务 | 前置 |
|---|---|---|
| #19 | S2 实例侧配置回读 | #12 #13 |
| #20 | S2 实例"模型服务商"子页 | #14 #15 #19 |
| #21 | S3 预览式写入与并发校验 | #11 #19 |

### 阶段 3 · 其他页面升级

| ID | 任务 | 前置 |
|---|---|---|
| #22 | 启动概览 / 新建实例 / 环境设置 | #14 #15 #16 |
| #23 | 下载三子页 / 导出 | #14 #15 #16 |
| #24 | 设置 / 个性化 / 更新 / 日志 / 链接 / 托盘 | #14 #15 #16 |
| #25 | 统一长任务入口与失败反馈 | #14 #15 |

### 阶段 4 · 服务商能力扩展

| ID | 任务 | 前置 |
|---|---|---|
| #26 | S4 分层编辑与高级字段 | #20 #21 |
| #27 | S5 测试链路对齐 | #10 #21 |

### 阶段 5

| ID | 任务 | 前置 |
|---|---|---|
| #28 | 全面检查与文档同步 | #20 #21 #22 #23 #24 #25 |
| #29 | 正式 spec 文档（延后，另行要求） | #11 |

**关键路径**：#10 → #11 → #12/#13 → #19 → #21 → #26/#27 → #28。视觉线 #14/#15/#16 → #20/#22–#25 → #28 与之并行，只在 #20 与 #28 汇合。

**与原方案排序的三处差异**：

1. 原阶段 1「契约与设计确认」拆成 **1a 后端契约**与 **1b 视觉契约**两条互不阻塞的线——S0/S1 是纯 Rust 与 Node，无 UI 依赖，不该等视觉基础。
2. 新增 **1c 诚实性缺陷插队**（#17）。
3. 原阶段 3「服务商核心闭环」提前为阶段 2；原阶段 4「服务商能力扩展」保持在后，因为 S4 的枚举值来源受限（§2.5）、S5 要改探测实现且涉及真实用量。

## 5. 执行纪律

- **不脱离本方案。** 在方案之上的更优改动允许，但交付时必须点名改了什么、为什么。
- **验证用新建的一次性 Home。** 绝不使用 `C:\Users\ABD18\.dsh`（`DSH_HOME` 未设时的默认 home，真实数据）或 `C:\Users\ABD18\dsh home\*`（注册表里的真实实例）。连接测试会产生真实用量，执行前说明。
- **不越权读写。** 通用搜索排除实例 Home、凭据、会话与无关 AppData；诊断需最小必要信息并脱敏；不在工具输出、截图、日志或交接中暴露密钥。
- **保护工作区。** 仓库通常含大量未提交改动；禁止重置、回滚、格式化或清理无关文件；提交用明确路径并检查暂存内容。
- **检查与方案评审分开**：写 spec、commit、push 均需单独授权，不随实现自动发生。
- **Rust 后端不会可靠热更新到已运行窗口**：涉及 command、窗口、托盘、进程或插件安装后端时，编译通过后需重启 `pnpm tauri dev` 再手动验证。
- 服务商专属边界：启动器只适配 DSH 外部契约，不改 DSH 核心、Web 路由或原生页面业务逻辑；所有实例级操作显式绑定 `instance_id`；共享同一 Home 的实例不得并行；更新或切换运行时前需停止所有受影响实例。
- 用户可见文本不硬编码，`zh-CN.json` 与 `en-US.json` 同步，key 用扁平点号形式。

## 6. 决策状态（原三项待决，已定案）

| # | 决策 | 结论 | 依据 |
|---|---|---|---|
| 1 | 能力门禁三判据（§2.3） | **采纳** | 规则已在全部 39 个目录项实测跑通（§2.3）。其"未验证的条目只可浏览不可写入、要展示限制"的后果，正是原方案 §2 明确要求的行为（"目录中可枚举的服务商不等于启动器都能配置……不能伪装成填一个 API Key 就可用"），不是新增限制 |
| 2 | apply 用"锁内重算计划并与意图比对" | **采纳重算，不用句柄** | 原方案 §5 给的就是"应使用后端计划标识，**或**重新构建并校验计划"两个选项；重算同时满足"不接受前端任意 diff"和"无陈旧句柄/无缓存生命周期"，代价只有一次额外读文件 |
| 3 | 诚实性缺陷批次插队到视觉重构之前 | **采纳，已执行** | 属方案之上的排序改动。该批 6 项中 5 项已完成（见 §3.6），其内容全部来自原方案 §3"失败不能静默吞掉"与 §4"持续失败保留原因与下一步"的要求，不是新增需求 |

凭据命名一项随 §1.5-A 一并定案：**保留 `DSH_LAUNCHER_*` 命名与 `refs:` 键空间，不迁移、不写 `records:`**。原方案 §3 的保守立场经运行时验证成立。

**S0 新增、原方案未覆盖的三条硬约束**（落地时并入 #12/#13/#19/#21）：

1. 写 `agent-default-model` 前必须自行校验 route 与 model 存在——DSH 对该段**没有任何校验**，写错会静默保存、直到使用时才以 `NO_ADAPTER` 失败（§1.5-B）。
2. 禁止 `deepseek-official` 作为自定义 route id——该 id 由 `llm-deepseek` 运行时注册，重复注册会让 DSH 启动即抛 `DUPLICATE_ADAPTER`（§1.5-C）。
3. 凭据引用扫描不得硬编码段名清单，须通过 `settings.describe` 的 `credential-ref` / `secret` 字段角色动态发现，再叠加整份 settings 文本与 `$DSH_HOME/.env` 兜底（§1.5-D）。

## 7. #28 阶段 5 检查进度（2026-09-09，进行中）

**契约文档扫描抓到的真实缺陷**：`docs/IPC_CONTRACTS.md` 曾登记 `import_provider_templates`——那条一次性导入命令连同注册项**已在 S3 收尾时删除**。文档在教调用方用一个不存在的命令。已删除该行，并把 10 条服务商/目录命令按 `bridge/cmd.rs` 实际签名补齐（`list/save/remove_provider_template`、`get_provider_protocols`、`list_runtime_catalog`、`get_runtime_catalog_models`、`read_instance_providers`、`plan/apply_instance_provider_change`、`probe_provider_template`），并写明调用方必须知道而命令表推不出的几条：plan/apply 接受的是操作意图不是 diff、digest 与内容指纹任一失配即中止、回读只交形状不交凭据值、凭据三态的自洽规则、探测请求由运行时构造。

**可重复的核对方式**（此前无人跑过，建议留在 #28 反复使用）：把 `desktop/builder.rs` 的 `generate_handler!` 注册表与 `docs/IPC_CONTRACTS.md` 里的反引号名做双向差集。本轮结果：注册 83 条，文档未列 31 条——**这不是缺陷**，该文档第 21 行自定契约就是"只列关键命令，其余从源码注册表查"；文档列出但未注册 13 条，逐条核对**全部为假阳性**（`instance_id`/`editing`/`headers`/`operation` 等参数名与 serde 字段名，以及 `remove_home_directory`、`instance_operation_lock` 这类确实存在的 Rust 内部函数）。

**更正一处此前记录过的数字**：Rust 测试是 **131 跑过 / 0 失败**，不是 "133/133"。仓库里声明了 133 个 `#[test]`，但 `same_path_normalizes_separators`（`#[cfg(not(windows))]`）与 `pick_asset_prefers_host_arch_dmg`（`#[cfg(target_os = "macos")]`）在本机不参与编译，`cargo test -- --list` 可复核。**把"声明数"当"跑过的数"报，是另一种过度承诺。**

**已同步的文档**：`AGENTS.md` 关键目录补上共享原语层与服务商前后端（含"内嵌 `.mjs` 改完必须重编译重启"与"安全规则只在 `provider-import.mjs` 定义一次"）；`docs/USER_GUIDE.md` 新增独立"模型服务商"一节并**删掉一处会误导的旧文案**——原文让用户"导入前核对共享 Home 和**覆盖选项**"，而那个常驻复选框早已移除，同时补上实例配置导航里缺失的"模型服务商"子页；`docs/DESIGN.md` 补上共享原语与"变更预览只有一份渲染实现"的约束。所加链接的 11 个路径逐一验证存在。

**第二轮漂移扫描（开发者文档与规则文件）**：`pnpm test:provider` 早在 S1 就进了 `package.json`，但 `DEVELOPMENT.md` / `DEVELOPMENT.zh.md` 的命令清单和定向测试清单**完全没提它**，`AGENTS.md` 的命令块同样漏了——照着仓库自己的文档走，没人会跑到守护 settings 与凭据写入路径的那套测试。两份 DEVELOPMENT 的**手动回归清单也没有服务商条目**，尽管该模块会在可能被共用的 Home 里写 `settings.yaml` 和凭据文档。已补齐：命令块加 `pnpm test:provider`；两处加"集成/委托用例会自我 skip 却仍报成功，结论必须连 `skipped` 计数一起贴"的警示，并写明 `DSH_TEST_ENTRY` 与"探测用例只打本地网关、不出网不耗用量"；两份手动回归清单各加一条服务商项，点名四件必查（并发改动必须中止而非覆盖、外部字段原样保留只报名字、删除不删凭据且列出仍被 `.env` 引用的名字、共享 Home 计数与实际一致）；`AGENTS.md` 另加一条"改 `--launcher-brand` 必须按 WCAG 重算 `--launcher-on-brand`"，因为这项可以用算术验证、不需要开界面。

**本轮又抓到并修掉三处共享预览里的诚实性缺口**（都在 `provider-plan-view.tsx` / `buildPlan`，四条写入路径同时受益）：
1. **`clear` 与 `keep` 塌成同一份计划**：`buildPlan` 返回的 `defaultModel` 对"将清空 Home 级默认模型"和"根本不碰它"都给出 `null`，预览于是画出完全相同的画面——而默认模型正是 §2.9 点名的验收项。计划新增显式 `defaultModelAction = keep | set | clear`（Rust 原样透传，无需改后端），预览在 set/clear 时陈述其后果。回归测试同时锁住"塌缩确实存在"（断言两者 `defaultModel` 同值）与"动作确实分开"，并验证计划里的动作与真正落盘结果一致——否则这个字段只是装饰。
2. **保留的凭据引用只报数量不报名字**，用户无法去核对到底是谁还占着它。改为列出引用名（引用名是标识符不是密钥值，路由上的凭据徽章本就显示它）。
3. 移除弹窗与本轮文案改动顺带修掉一处 i18next 占位符写坏（`{{detail}` 少一个闭括号）。

**"多主题一致"查出一条可量化的真实缺陷并已修**：主色按钮原先统一写 `text-white`。按 WCAG 相对亮度逐个主题实算，**18 个主题里有 6 个的白字对比度低于 3:1**——`neon-aqua-green` **2.07**、`sage-light-yellow` 2.37、`pale-blue-mint` 2.45、`mint-peacock-green` 2.50、`mint-orange-gold` 2.86、`aqua-green-almond` 2.89（另有 `mist-cyan-light-green` 3.07、`mist-blue-sakura-pink` 3.90 等虽过 3:1 但达不到 4.5）。这违反 AGENTS.md 的"按钮文字和颜色必须在所有主题下保持可读"，而协作页之外的多个页面都用这个写法。

没有单一文字色能同时满足所有主题（换深色会把 `deep-blue-soft-pink` 拉到 2.03），因此新增**逐主题取值**的 `--launcher-on-brand`，18 个主题各按"白 vs 近黑墨色取对比度更高者"算出，其中 **10 个主题的按钮文字由白转深**；随后把 **24 处** `bg-[var(--launcher-brand)] … text-white` 换成该变量。改完复算：全部 18 主题**最低对比度 4.19:1**，无一低于 3:1。核对方式：`--launcher-brand` 声明数 = `--launcher-on-brand` 声明数 = 18，`text-white` 与品牌底同现的残留为 0，`font-size: 14px` 基准行未出现在 diff 中（受保护项未被触碰）。

**点名一处偏离**：这次改动越出了服务商模块，动到 `collaboration-panel`、`instance-manager`、`instance-settings`、`more-panel`、`download-center`、`launcher-shell`、`instance-wizard` 等既有文件。理由是只改服务商文件会造出更糟的结果——同一个主题下服务商页按钮可读、其它页不可读，且 #22–#25 已经把这些页面收进同一套共享原语。改动是纯类名替换（固定子串，不做任何格式化），typecheck / build / eslint / `git diff --check` 全部 exit 0。`bg-danger text-white`（1 处，`provider-remove`）未纳入：danger 走 HeroUI 语义色、不随这 18 套主题重新取值，属另一条判断，留给 #28 复查。

**验收句"五件事均有测试覆盖"逐条对号**（本轮审计结果，不是推断）：

| 要求 | 覆盖它的测试 |
|---|---|
| 目录继承 | Rust `catalog_profile_writes_only_explicit_overrides`（只写显式设置过的字段）+ JS "returning a route to catalog inheritance unpins api, baseURL and models but preserves foreign fields"（反向：回到继承） |
| 冲突处理 | JS "DSH import preserves unrelated settings and credentials, rejects conflicts, and explicitly replaces a route"、"change preview reports diffs, apply honours them, and a stale plan aborts"；Rust `models_and_model_overrides_are_mutually_exclusive`、`reserved_and_unsafe_ids_are_rejected` |
| 未知字段保留 | JS "read-back exposes owned model options only…"、"read-back reports shape only, never leaks secrets…"，与继承那条里的 `preservedFields` 断言 |
| 共享影响 | **本轮之前是零覆盖。**`config::instance::sharing()` 只因为要多一个 `AppHandle` 去读注册表就从未被测，而服务商计划的 `sharing` 数字与移除弹窗的级联列表都出自它。已把纯计数逻辑拆成 `sharing_of()` 并补 `sharing_counts_exclude_the_target_and_rank_profile_above_home`：锁住"计数排除被查实例本身""共用 Profile 优先于共用 Home""同 Home 无同 Profile 必须降级、不得谎称共用 Profile""只剩自己即 isolated、因此不显示共享提示""空 Home 路径必须报错而不是退化成字面比较"。`cargo test` 131 → **132 passed**。 |
| 模板复用 | 存储层 `provider_store::tests::encrypted_store_roundtrip_edit_and_remove` + 应用层"import then read-back reflects exactly what the template owns"。**本轮补上专属用例**："one template entry applies to two Homes independently and survives the first import unchanged" —— 同一份模板条目先后导入两个 Home，断言两边都出现该路由且各自持有凭据、从第一个 Home 移除不影响第二个、删除仍不删凭据值。它**刻意复用同一个 `entries` 数组对象**，顺带锁住"导入不得就地改写调用方传入的 entry"（否则第二次导入拿到的是被第一次污染的 shape）——这条断言通过了，说明此前也没有隐式改写。 |

顺带在拆分时避开了一个自己差点引入的回归：第一版把 `normalize_home(home)?` 换成了 `unwrap_or_else`，那会让空 `DSH_HOME` 不再报 `INSTANCE_HOME_EMPTY`、而是退化成按字面比较把空路径当成可共享 Home。已改回在 `sharing()` 里用 `?` 传播错误，纯函数只接收规范化后的路径。

**§5 边界条款逐条回查（本轮，对着当前代码而不是记忆）**：
- *"模式切换必须在预览中展示字段迁移与删除"* —— **成立，已核到底**。编辑器的 `switchSelection`（`provider-edit.tsx:187-203`）只把 `hasTuning()` 的条目搬到另一侧、其余交给目录，并显式 `setPreview(null)` 逼出一次新预览；删除能出现在预览里，是因为 `mergeRoute` 会删掉"新 profile 里没有、但文档里有"的自有字段（`provider-import.mjs:264-268`），而 `buildPlan` 对每个自有字段比较 `from`/`to`，删除表达为 `to: null`，前端 `describe(null)` 渲染成 `—`。删除方向由既有用例"returning a route to catalog inheritance unpins api, baseURL and models but preserves foreign fields"钉住。**没有为 `modelOverrides` 方向另补测试**：`mergeRoute` 对这两个字段的处理各有专门分支，凭猜测写断言有把测试写成"记录我误解"的风险，故留给界面核对或后续按需补。
- *"route ID 不可编辑"* —— 界面是禁用输入，后端 `buildTemplate` 直接取 `route.id`，没有可改路径。
- 凭据不自动清理、引用扫描覆盖 settings + `.env`、不接受前端 diff、锁内重算比对、未知字段只保留不写入、目录门禁基于运行时事实且未验证项只读 —— 均仍由既有用例钉住（见上表）。
- **仅靠代码不能定论的**：七态渲染、长路径换行、多主题对比度实际观感、`settings.describe` 真实往返 —— 全部在界面核对清单里，不伪装成已验证。

**#30 已按可达性核实结论落地（2026-09-09）**：机会性增强成为一条命令 `read_instance_credential_roles`，复用协作层已有的 loopback RPC 封套（`collab::rpc` 由私有改成 `pub`，不再另起一条 HTTP 路径），端口走 `resolve_running_instance_port` 而非陈旧记录。四种不可用情形——停机、拿不到端口、远端不支持、8s 超时——一律返回 `source: "unavailable"` 而不是 `Err`。返回体**只有字段位置、没有任何值**：这一点刻意写成"不依赖远端已经 `redactSecrets: true`"，否则启动器自己的"密钥值不回传前端"就变成一个下游依赖。界面三态分开陈述（问到了有 / 问到了没有 / 没问到），`roles_unavailable` 的文案明确否认"没问到 = 没有密钥字段"这个假结论。
已单测：`secret_paths` 的形状处理（空路径、空片段、非字符串片段、缺 `path`、缺 `ns`、非对象条目全部跳过；`cargo test` 132 → **133 passed**）。
**未验证**：真实 `settings.describe` 往返——需要实例真的跑起来。已作为界面核对第 10 步交给用户。

**又一处预览不实（本轮，靠"跑一遍看真相"而不是推理找到的）**：上一轮我说过"不为 `modelOverrides` 方向补测试，因为不确定合并形状，怕把测试写成记录我的误解"——那个顾虑是对的，但结论错了：正确做法是**去问代码**。在一次性 Home 上跑真实的 `planProviderOperations` + `applyProviderOperations` 后当场暴露：写入按模型 id **并入** `modelOverrides`，没被提到的 `legacy` 会留下；而预览的 `to` 只报了递交进去那份，于是预览说"`{legacy}` → `{chat, coder}`"，落盘的却是"`{legacy, chat, coder}`"。用户看预览会以为**另一份调参会被清掉**——这是朝"夸大破坏"的方向说谎，正是 §2.5 禁止的那种不一致。而 `provider-import.mjs` 文件里本来就写着这条规矩："差异必须按 `effectiveProfile` 算，否则预览会与 mergeRoute 实际写入的不一致"，只是没人对 `modelOverrides`/`models` 这两个有专门合并分支的字段执行它。
修法是把两条合并规则抽成 `mergedModels` / `mergedOverrides`，再加一个 `mergedValue(field, from, to)`，**写入与预览共用同一定义**；`projected`（默认模型告警用它）也改成从同一批合并值构造。新增用例断言"预览说的"与"读回来的"一模一样，两个方向都锁。`pnpm test:provider` 27 → **28 passed / 0 failed / 0 skipped**，既有用例无一条被改动带坏。

**顺带补上了一条一直没人证明过的接缝**：整个凭据三态契约都压在 serde 的字段命名上，而 `ProviderDraft` **零测试调用点**。风险是静默的：`credentialMode` 哪天解析不出来，它会退化成 `None` = "添加"语义，于是"带密钥就声明引用、没带就不声明"重新生效——**正是 S4 当初要修的那个"留空被当成取消引用"**，而且不报错，只会在编辑路由时悄悄改掉引用。新增 `frontend_provider_draft_arrives_with_its_credential_intent`：拿 `provider-edit.tsx` 实际提交的那份 JSON 原样反序列化，断言三种意图各自的线上表示都被认、拼错的 `ambient` 必须被拒（`none` 是唯一改过名的变体，最容易被 `rename_all` 吃掉而不是被发现）、camelCase 集合与 `selection` 都到位、且缺省仍等于"添加"。**这条没找到缺陷，但它把一条假设变成了会被跑的断言** —— 价值在这里，不在"又绿了一项"。

**补上一条"前端类型 vs 后端产物"的一致性检查**：`provider-contracts.ts` 里那些接口是对 `.mjs`/Rust 产物的**手写断言** —— TS 运行时不存在，脚本改个键名不会有任何报错，界面只会安静地读到 `undefined`。新用例反过来**以 TS 文件为准**解析出每个接口的顶层必需字段，逐个核对真实产物是否带着它们（不在测试里另抄一份键名清单，那等于再造一个会漂移的真相来源）。它顺带把一条分工钉死：`plan.sharing` 由 Rust 依注册表注入、**不在脚本产物里**，用例显式断言它缺席，免得将来脚本与宿主各算一套"谁会被影响"。限制也写进注释：只核对顶层必需字段，不下钻内联嵌套对象。

**关掉一个静默失败面：悬空引用**。宿主侧 `provider_planned_entry` 保证"声明引用 ⇒ 必带密钥"，但那条保证**跨过一次键名边界**（Rust 写 `"api_key"` 蛇形、`"credentialRef"` 驼峰，脚本按键名读）。哪天命名漂了，Rust 仍会算出 `apiKeyEnv`，脚本却读到 `undefined` —— 于是 `settings.yaml` 里留下一个指向凭据文件里不存在的名字的配置，**导入显示成功**，直到真正发请求才以 `MISSING_CREDENTIAL` 失败。现在 `effectiveProfile` 在写入与预览的**共同入口**上拒绝这种组合（`PROVIDER_KEY_REQUIRED`），新用例同时断言：写入端拒、预览端也拒（预览能渲染出一份 apply 会拒的计划本身就是另一种不一致）、被拒后设置文档一字未动。
两点如实交代：**没有为它新增错误码与文案** —— 这条只在内部约束被破坏时触发，正常操作不可达，而为一个不可达分支编一句用户看得懂的话，反而制造假的确定性；沿用 `PROVIDER_KEY_REQUIRED` 时那句"请填写有效的 API Key"对此场景其实不准确，属于已知的、权衡后接受的粗糙。另外它**不会误伤合法的 `keep` / `none`** —— 前者本就不带密钥、后者由宿主把 `apiKeyEnv` 摘掉，三态那条全链路用例仍然通过。

**顺着自己的改动挖出一处不实结构（2026-09-09，#28）**：删掉预览载荷里那个没人读的 `templateRevision` 之后，`cargo check` 立刻报 `ProviderTemplate::handle` never used —— 一个死字段的 removal 把它的邻居也照出来了。追下去的结论是 `templateId` 与 `revision` **两个字段都只有声明、没有实现**：`provider_store` 的 save/get/remove 全按 `template.id`（实例 route key）定位，前端三处写入点恒传 `templateId: ''` / `revision: 0`，全仓库没有任何自增点。也就是说 §2.2 那条"模板内部标识与实例 route ID 必须分离"从来没被真正做到过，而 §7 的 #12 记录写着它做到了。三者与 `handle()` 一并删除，两处不实注释（`revision` 的"每次保存自增，供并发校验比对"、`provider-edit` 的"模板内部标识与它分离"）改为陈述实际行为。

过程中先排除一个更坏的猜测：我原以为"编辑模板时改 route key 会走 append 分支、留下一条孤立旧记录"。读了 `save()` 才确认不成立——`editing = true` 且 key 对不上时直接 `PROVIDER_NOT_FOUND` 返回，发生在任何写盘之前，所以现状是**安全拒绝**而非静默脏数据，缺的只是"重命名"这个能力本身。这个区分决定了改动幅度：不需要紧急修补数据路径，只需要把不实声明改掉并把能力登记成待决项（`TODO.md` `PROVIDER-05`，实现与否涉及那个存 API Key 的加密库文件，须单独授权）。

兼容性没有变差，反而多了一条真断言：原"旧记录"用例的注释声称记录里没有 `kind` / `template_id` / `revision`，可代码从未删过 `kind`、也从没塞进那两个字段，三条断言全在读自己写进去的值。现在改成手工拼一份改造前的线上记录（**真的**去掉 `kind`、**真的**带上残留的 `templateId` / `revision`），验证未知字段被忽略、缺省按 Custom 读取——这才是"不需要迁移脚本"这句话的证据。**本轮无用户可见行为变化**：删的都是恒为默认值且无人读取的字段，界面、写路径与错误码均未动。

**选定出路：补 `rename_provider_template`（同日，用户选定）**。上面那条缺口对用户的实际影响只有一个——改一条模板的 ID 必须删除重建，而删除会连带丢掉那条记录里存着的密钥。所以不去做"标识分离"，改为直接解决这件事：新命令在**同一把 `STORE_LOCK`** 内把整条记录搬过去，密钥留在同一条 `StoredProvider` 上，因此**不需要用户重录**；新 ID 复用 `ProviderTemplate::validate` 的全部规则（小写/数字/单连字符、长度、`deepseek-official` 保留）和 `save` 那一道 `verify_catalog_template` 目录核对，四种拒绝（源不存在 / 撞号 / 格式 / 保留 ID）全部发生在写盘之前。**语义边界要盯住**：它只动启动器模板库，已写进各实例的路由一字不改——这句同时写进了 `providers.rename_hint` 与 `providers.edit.route_id_hint`，因为后者原本就承诺过"模板可改名"，只是当时做不到。测试：`rename_moves_the_record_and_keeps_the_credential`（`cargo test` 135/135）。顺带补了一个既有缺口：`PROVIDER_ID_RESERVED` 此前没有错误码分组，只能落到那句泛化兜底文案，现在有独立的 `providers.error.reserved`。**仍未验证**：真实界面上走完一次重命名（按钮位置、`current → next` 预览、失败时的错误文案），见下面的清单第 11 步。

**动态拼 key 的文案此前从未被核对过（同日）**。全量扫描确认静态 `t('字面量')` 的 675 个键在中英两份 locale 里**全部存在**，但这类调用天生扫不到下一类：`t(`providers.error.${group}`)`。少一条文案不报错、不警告，直接把 `PROVIDER_CATALOG_AUTH_UNSUPPORTED` 这种原始码值印到用户脸上。于是反过来**从产码的一方抽值域**逐条核对，14 个命名空间实测干净：错误码分组 22、目录限制码 4（且无孤儿文案）、预览变更类型 5、凭据动作 4、默认模型状态 3、顶部导航 5、下载三页 3、实例设置四页 4、个性化三页及其 title/description 各 3、主题名 13、模板编辑器字段 2、共享级别三级及其 title/description 各 3。**服务商自己那四个命名空间已钉成测试**：`every dynamically composed provider label has copy in both locales`，不依赖运行时、永远不会被 skip，`pnpm test:provider` 33/33。反向断言也在（码值删了、文案还留着 → 失败）；核心判据 `has()` 做过反证：不存在的键确实被判为缺失，所以这条测试不是恒真。
两处**假缺陷**记在这里以免被当成发现：我第一版抽取把两个同名 `source` 字段（凭据来源 vs 运行时角色来源）合并成一个值域，因而报出 `credential.runtime`/`credential.unavailable` 两条"缺失"；又把 `routeSource()` 的三元返回只抽到一个值。都是读码澄清的，不是改测试迁就结果——判据是"抽取规则是否对应真实声明"，不是"能不能变绿"。**尚未钉住的部分**：导航、主题、共享级别这些不属于服务商模块的命名空间只是**这一轮手工查过**，仓库里没有前端 TS 测试运行器可挂载它们；要长期钉住需要新增一个检查脚本，属工具扩张，未擅自添加。

**§3.9 里另一条被我错误推给"界面验收"的项：减少动效一致**（同日）。这条其实可以机器核对，做完发现是**真缺陷**：全应用带 `className` 且含 `transition-*` 的 76 行里，24 行没有任何 `motion-reduce` 兜底，而仓库本来的惯例就是逐元素加兜底（7 处骨架脉冲、5 处进度条宽度都已带）。最集中的是 `collaboration-panel.tsx`——**整页 13 处零兜底**，包括那个可折叠侧栏的 `transition-[width]`；共享加载原语 `loadable.tsx:104` 的进度条宽度过渡也漏了，而 DESIGN.md 恰好点名"进度宽度过渡…要关闭或降级"。补齐后：**60 行全部有兜底，未兜底 0 行**，命令 `grep -rn className src --include=*.tsx | grep transition- | grep -vc motion-reduce` 应输出 0。**刻意保留一个例外**：spinner 旋转（`.animate-load-spin` / `animate-spin`）不加降级——那是该控件"处理中"的唯一可见反馈，关掉等于让按钮看起来失效，属于"降级"里该保留的一类；这个取舍连同理由写进了 DESIGN.md。
两个探测工具自身的错也记下来：第一版按"同一行窗口内是否出现 motion-reduce"判定，把守卫写在**邻行**的多行 className 误报成缺失（虚报 29→实际 24）；第二版又按"兜底必须紧跟 transition 工具类"判定，把 `transition-x duration-y motion-reduce:transition-none` 这种完全合法的写法报成 29 条"畸形"——**Tailwind 不关心类序**，那条断言是我自己发明的规矩。两次都不是改代码迁就工具，而是改工具的判据。

**规则文件同步（`AGENTS.md`）**：`模型服务商与修复助手` 一节原本只有一句"模板支持多模型；导入绑定实例"，是重构前的描述，现在换成实际生效的约束（单一 预览→应用、只提交意图、锁内比对摘要与内容指纹、目录继承只写显式字段、route ID 不可变、凭据三态、删服务商不删密钥、外部字段值不回传、门禁只对运行时事实求值、测试请求由运行时构造）；`完成前检查` 此前**对服务商这条最危险的写路径一个问题都没有**，补了 4 问。核对方式是与 HEAD 比 diff：只有 1 行删除（就是我重写的那句旧约束），其余原有 bullets 全部在场。

**一个差点让我误报"检查通过"的坑**：我第一次用 `git diff -- agents.md`（小写）做完整性核对，Windows 文件名大小写不敏感所以文件确实改了，但 git 跟踪的是 **`AGENTS.md`**，pathspec 匹配不到任何路径 → diff 为空 → 看起来"没有删除任何行，干净"。真实情况是我一度把"插件是否使用社区原始 spec"那条问题整个替换掉了。**"git 说没变化"不等于"没变化"**，大小写不敏感的文件系统上尤其如此；核对必须用 `git ls-files` 里的确切拼写。

**§3.9 有两条其实可以机器核对，此前被我一起推给"界面验收"——补做后抓到一个真缺陷**：

- **减少动效**：`main.css` 的 reduced-motion 块原先只关掉 `.launcher-content-enter`，而页面/实例切换走的原生 `::view-transition-group(*)` 仍带 240ms 时长 —— root 新旧层虽然已是 `animation: none`，分组照样动。这违反 DESIGN.md/AGENTS.md 自己写的"切换动效尊重 `prefers-reduced-motion`"。在一个媒体块里把分组时长归零，而不是去各调用点撒 `motion-reduce:`：视图过渡的伪元素分组不在任何组件上，散着加根本覆盖不到。
- **写死文案**：对 8 个新组件扫非注释行的中文字面量，命中项全是 `/** */` 与 `{/* */}` 注释，用户可见文本一律走 i18n。顺带说明我的第一版过滤为什么不算数：没排掉块注释，把 64 处注释当成可疑项 —— 又是一次"过滤条件不对时的假信号"。

**如实限制**：另外还查到 3 个文件有 `transition-*` 却无本地 `motion-reduce:`（`navbar` 一处 `transition-colors`、`collaboration-panel` 颜色/透明度淡入淡出、`loadable` 的 `.animate-load-spin`）。前两个是纯颜色/透明度变化、不涉及位移，**第三个刻意不改** —— `loadable` 的 spinner 是按官方 DSH 启动页逐项复刻（文件注释明说，且不用 `animate-spin` 是为绕开 WebView2 下 `var()` 不旋转），动它等于破坏与原生 boot 页的视觉一致性；加载状态另有相邻 hint 文字承载，不是"只有动效传达信息"。这几处是否算违例需要人的判断，不冒充已修。

§3.9 其余条款（窄窗口无溢出重叠、固定尺寸控件不被动态文字推动、七态实际渲染）仍只能真机看。

**新查到并锁住一条此前无人验证的性质：回读 → 原样应用必须是逐字节的空操作**。这是最坏一类静默数据丢失的入口 —— 用户只是打开编辑器又点了应用。做法同样是**先跑真实代码看真相**：在一次性 Home 里造一条带注释、外部段落、`headers`、路由外字段、以及模型条目内原生选项（`temperature`）的配置，回读后**只凭回读能交出的白名单键**重建 profile（因此是刻意欠指定的：只有 `id`，没有 `contextWindow`/`temperature`），再预览并应用。结果：**预览报 0 项变更、文件逐字节不变**，`temperature`、`X-Tenant`、`unknownNativeOption` 与首行注释全部在原位。这条依赖的正是"`mergeRoute` 按 id 并入既有条目"而不是整体替换 —— 若哪天改成替换，用户没碰过的原生选项会静默消失，而预览还会谎称什么都没变。它同时反证了上一轮的 `mergedValue` 修复：预览与写入对同一份欠指定输入给出同一个合并结果，才会两边都判"无变化"。回归用例 `reading back and re-applying unchanged config is a byte-identical no-op`。

**检查结果（本轮真实输出）**：`pnpm test:provider` **31 passed / 0 failed / 0 skipped**（上一条记录的是 30，本轮新增这 1 条）；`pnpm lint` / `typecheck` / `build` / `cargo check` 各 exit 0；`cargo test` **134 passed / 0 failed**；`git diff --check` exit 0；中英文 **923 : 923**。

**尚未完成（本阶段不能收口）**：
- **真实界面验证 —— 由用户明确决定"暂时跳过，先收口别的"**（记为 `TODO.md` 的 `PROVIDER-01`，P0/已实现待验证）。这不等于该验收句已满足：§2.9/§3.9 的"用户能在实例内完成添加→选模型→测试→设默认→保存回读"以及七态渲染、窄窗口无重叠、主题观感，**仍是未验证项**，只是不再挡本轮收口。机器侧能查的两条已查掉（减少动效、写死文案），纯算术的一条也修了（6 个主题白字对比度）。
- **`pnpm lint` 已解决**：`src-tauri/**`（内嵌脚本，由 `pnpm test:provider` 覆盖）与 `.mimosa/**`（会话工具往仓库根写的状态文件，与本项目无关）加入 eslint ignore。`pnpm lint` 现 **exit 0**，且正向对照确认它仍实际检查 **72 个源文件** —— 不是靠排除一切换来的绿。两处 DEVELOPMENT 的 `pnpm lint` 注释同步改成真实范围。
- **间距 token 已关闭**：按用户决定**不引入 token**，§3.1"内容间距"一行已就地改判并写明理由（17 处复制粘贴的重复保留原样；纯视觉重构需眼睛复核，而当前无安全验证窗口）。不再作为待办翻出。
- **card-in-card 复查已做，结果为干净**：`SectionCard` 嵌套深度扫描零违例。**限制**：只认这一对组件，看不到 `Surface` 等非卡片容器套卡片、也看不到 portal 浮层，所以是"没发现违例"而非"证明全站合规"。
- `.env` 与 retained refs 的呈现已补到"列出引用名 + 说明扫了设置文档与 `.env`"，但和其他界面改动一样，**未在真实界面里看过**。
- 建议（未擅自改）：`.mimosa/` 未跟踪也不在 `.gitignore` 里，会污染 `git status`；是否加入忽略由你定。

**七态覆盖无法机器核验（更正一条容易被误用的"证据"）**：本轮曾用关键词计数扫六个服务商界面文件来近似"加载/错误/空/禁用/运行中/取消中/完成"覆盖，结果不可用作结论——`provider-edit` / `provider-remove` 计数为"无加载态"只是因为它们从已回读的路由初始化、本身没有异步加载；"运行中"在这两个文件里为 0 是因为该态由父级子页持有并向它们传 `disabled`。**词频不是渲染状态。任何把这类计数当覆盖率的报告都应视为过度承诺。**

**一次可走完的界面核对（有界验证，约 20 分钟；第 11 步不产生任何 API 用量）**：

*准备*：`pnpm tauri dev` **必须重新编译后启动**（内嵌 `.mjs` 改动不带进已运行窗口）。新建实例，Home 指向**新建的一次性目录**（如 `C:\Users\ABD18\dsh-verify-s5`），**不要**用 `C:\Users\ABD18\.dsh` 或 `C:\Users\ABD18\dsh home\*`。带 ⚠ 的步骤会真实调用接口、可能产生用量，可整步跳过。

1. **实例配置 → 模型服务商（空态）**：新实例无服务商 → 应见空态说明而不是空白面板；实例**运行时**进入 → 应见"运行中只读"提示且写入入口禁用。
2. **添加（目录型）**：选一个目录项 → 检查目录模型惰性加载时**加载中**可见；搜索一个不存在的词 → 应见**空态**而非报错；点"获取模型"对 `anthropic-messages` 目录项 → 应报"没有可读取的模型清单，请手动填写"（**这条证明 #27 的禁用真的生效**）。
3. ⚠ **测试连接**：填一个可用密钥 → 测一次 → 结果旁应显示**模型名 + 时刻**；随后**只改密钥或只换模型** → 旧结果必须转灰并写明已失效（这是 §2.7 第 5 条，机器验不了）。
4. **默认模型**：勾选并选一个模型 → 预览应新增一行"Home 级默认模型将设为 …"；改为不勾选 → 该行消失且 `settings.yaml` 的 `agent-default-model` 不被触碰。
5. **预览→应用**：停在预览不改选择 → 用 DSH 或编辑器**同时改一下** `settings.yaml` → 点应用 → 必须**中止并要求重新预览**，不得静默盖掉。
6. **编辑（分层）**：route ID 输入框应为禁用且旁边说明不可改；凭据三态中"保留原密钥"应为**唯一默认**；把 `contextWindow` 清空 → 预览里该行应消失（回到继承），不是变成 0。
7. **移除**：预览应列出被删段落里的**外部字段名**（若该路由有 `headers`）、明确"不删除已存凭据"、并在默认模型正指向它时给出"清除默认模型"选项——不勾时应提示会留下悬空引用。
8. **共享 Home 影响**：造两个共用同一 Home 的实例 → 预览应显示"该 Home 由 N 个实例共用，其中 M 个使用同一 Profile，应用会影响它们全部"，数字与实际一致。
9. **长路径与主题**：把 Home 设到很深的路径 → 路径 `<code>` 与按钮文字应换行或截断、不重叠。切主题时**重点看这 10 套**（本轮按钮文字由白转深的全部主题）：`warm-clay`、`rose-gray`、`mint-orange-gold`、`mint-peacock-green`、`mist-blue-sakura-pink`、`mist-cyan-light-green`、`sage-light-yellow`、`pale-blue-mint`、`aqua-green-almond`、`neon-aqua-green`。它们的主色按钮文字现在应为深色；反过来看剩下 8 套（尤其 `deep-blue-soft-pink`、`charcoal`）文字应仍是白色。若出现"深底深字"或"浅底白字"，说明该主题取值算错，请把主题名告诉我。
10. **字段角色（#30 的运行时往返，唯一只能这样验的部分）**：**启动**该实例后进子页 → 每条路由下方应出现"当前运行时把该路由下的这些字段声明为密钥…"或"已询问当前运行时：该路由下没有被声明为密钥的字段"；**停止**后进同一页 → 应变为"未询问到运行时字段角色（需要实例正在运行）…这不代表该路由没有密钥字段"。三种文案若互相错串（尤其停机时显示成"没有密钥字段"），把看到的那句原文告诉我。

11. **模板重命名（`PROVIDER-05` 选定方案）**：入口在 **设置 → 个性化 → 模型服务商模板**。这一步**不产生任何 API 用量**（重命名只读写启动器自己的加密库；目录核对读的是本地运行时目录）。
    - 任选一条已存好密钥的模板 → 点"重命名" → 面板里应已预填当前 ID，并实时显示 `旧 → 新`；输入框留空或与原名相同时"应用改名"应为禁用。
    - 改一个新 ID 提交 → 成功提示应带上 `from` 与 `to`；**关键验证**：立刻对它点"编辑"，密钥那一栏应仍显示"留空则保留已保存的密钥"且**不要求**重新输入（保存一次不填密钥，应仍通过）。这条通过才说明密钥真的跟着记录走了。
    - 依次试四种失败，各自的文案必须分得开：填库里已有的 ID → 撞号那句；填 `deepseek-official` → "由当前运行时保留"那句（**不该**是格式那句）；填 `Bad Name!` 或 `-abc` → 格式那句；面板打开后该模板被另一处删掉 → "已不存在，请刷新"那句。
    - **改完确认没有波及实例**：回到之前用过的实例 → 模型服务商子页，那条已写入的路由 ID 应一字未改（重命名只动模板库）。若它跟着变了，立刻告诉我，这是最严重的一种不符。
    - 顺带看一眼窄窗口下这一行的三个按钮（编辑 / 重命名 / 删除）与展开面板是否重叠或挤压换行。

12. **减少动效（本轮补齐的那批兜底，只能真机确认）**：在 Windows「设置 → 辅助功能 → 视觉效果」里关掉**动画效果**，重启 `pnpm tauri dev` 后逐项看：
    - 协作页左侧工作流栏点折叠 → 应**直接跳到**目标宽度，不再有 200ms 滑动；节点卡片与按钮的 hover 背景变化也应瞬时完成。
    - 任一下载/启动进度条在数值跳变时不应有补间；顶部与托盘的骨架脉冲（`animate-pulse`）应停在静止态。
    - **反过来确认例外仍然成立**：加载中的 spinner 必须继续旋转。它若被冻住，说明我给 `.animate-load-spin` 误加了降级——那是错的（它承载"处理中"的唯一可见反馈），请告诉我。
    - 重新打开系统动画设置后，以上过渡应全部回来。

## 7.1 边界与验收对账单（2026-09-09，检查阶段产物）

目的：把"不可违反"和"验收"两句从**叙述**变成**可复跑的对应关系**。测试名取自 `cargo test -- --list` 的编译产物与 `pnpm test:provider` 的实际用例名，不是凭记忆写的。状态只有四种：**机器已证** / **代码已证、界面待真机** / **按用户决定改判** / **只能人工**。

| 条款 | 当前证据 | 状态 |
|---|---|---|
| 门禁只对可观测运行时事实求值，不得新增本地硬编码服务商清单 | `catalog_gate_is_a_rule_over_runtime_facts_not_an_id_list`、`unsupported protocols are rejected by the runtime answer, not by a launcher list`、`the mirrored LISTABLE_PROTOCOLS still matches the installed runtime source`、`the response-size ceiling still matches the runtime`；`grep` 前端源码 0 处服务商名字面量，Rust 侧命中只有测试夹具与应用自身标识 | 机器已证 |
| 未验证的目录项只可浏览不可写入 | `catalog_route_must_exist_in_the_runtime`、`reserved_and_unsafe_ids_are_rejected`；界面按 `configurable` + `limitation` 出原因 | 代码已证、界面待真机（清单 2） |
| `models` 与 `modelOverrides` 互斥，且模式切换要在预览里展示迁移与删除 | `models_and_model_overrides_are_mutually_exclusive`、`the preview reports the merged result, not the submitted value, when selection mode flips` | 机器已证 |
| 已写入实例的 route ID 不可编辑 | `rename_moves_the_record_and_keeps_the_credential`（改 key 的四条拒绝都在写盘前）+ `save(editing)` 分支 | 机器已证 |
| 模板内部标识与 route ID 分离 | 从未实现，死字段已删；用户选定改判为 `rename_provider_template` | **按用户决定改判**（`TODO.md` `PROVIDER-05`） |
| 未知/敏感字段的值不回传前端，写入在 YAML Document 上原地保留 | `read-back reports shape only, never leaks secrets, and refuses to over-claim state`、`returning a route to catalog inheritance unpins api, baseURL and models but preserves foreign fields`、`read-back exposes owned model options only…`、`secret_paths_keeps_positions_and_drops_values_and_malformed_entries` | 机器已证 |
| 应用不接受前端提交的 diff，须在锁内重算并与操作意图比对 | `change preview reports diffs, apply honours them, and a stale plan aborts`、`a template that changed after the preview aborts the apply even if the file never moved`、`reading back and re-applying unchanged config is a byte-identical no-op`；`apply_instance_provider_change` 的签名只收 `{digest, fingerprint}` | 机器已证 |
| 凭据默认不随删除自动清理；引用扫描覆盖 settings 与 `$DSH_HOME/.env` | `credential three-state keeps, replaces and detaches the reference without ever deleting a stored value`、`settings commit failure restores the exact previous credential document`、`credential keep on a route that never declared a reference invents nothing`；`provider-import.mjs:401,417-418` 读 `.env` 且从不改写 | 机器已证（扫描覆盖面）|
| 不改 `main.css` 的 `body{font-size:14px}` | 该行在 `main.css:504`；`git diff -U0` 无任何 hunk 触及它（该文件本轮只有 `--launcher-*` 变量改动） | 机器已证 |
| 诚实性缺陷批次不得延后于视觉重构 | #17 批次已完；检查阶段又修 3 处不实声明（`templateId`/`revision` 假字段、两处注释、一条用户文案） | 机器已证 |
| §2.9 模板复用 / 目录继承 / 共享影响 / 冲突处理 / 未知字段保留"均有测试覆盖" | 依次：`one template entry applies to two Homes independently and survives the first import unchanged`、`returning a route to catalog inheritance…`、`config::instance::tests::sharing_counts_exclude_the_target_and_rank_profile_above_home`、`DSH import preserves unrelated settings and credentials, rejects conflicts, and explicitly replaces a route`、同上 inheritance 用例 | 机器已证 |
| §2.9 "测试通过的配置还要在真实 DSH 实例中验证" | 同一条真机用例现在走完**验收链路的四段**：`planProviderOperations → applyProviderOperations`（带 digest/fingerprint 比对，不是直写文件）写路由 + 默认模型 → 用一次性 Home 真的启动 DSH 并通过 token 认证 → 问 DSH 自己的 `session/modelCatalog` RPC：该路由可路由且模型正是我们写入的两个 → 启动之后 `readProviders` 从磁盘解析回同一对 `provider/model`。边界仍写进注释：DSH 对 `agent-default-model` 不设校验，所以这证明的是"启动一轮后仍能解析回同一对值"，不是"DSH 认可该模型存在"。实测附带一条格式事实：写入器对**新建节点**输出流式 YAML（`agent-default-model: { provider: …, model: … }`），所以任何用正则钉缩进/花括号的断言都是把序列化风格当语义，风格一变就假失败。**目录继承也拿到了运行时证据**（同日追加）：同一条用例另写第二条路由，profile 里**只有** `displayName` + `apiKeyEnv`，启动后 DSH 自己的 `modelCatalog` 仍报得出它的模型清单，而磁盘上不含该服务商的内建端点（`doesNotMatch` 守住"没钉死"）。候选是哪条由**被安装运行时的目录答案现挑**（本机 40 个目录项，本次命中 `ant-ling`，3 个内建模型）——测试里没有本地服务商清单，DSH 换目录时它会自动改挑别的一条 | 机器已证（自动化那半）；用户实际点一遍仍是清单 1–10 |
| §3.9 中英文一致 | `pnpm test:provider` 的 `read-back and plan JSON carry exactly the keys the frontend types require` + `every dynamically composed provider label has copy in both locales`；两份 locale 各 925 键且集合相同 | 机器已证 |
| §3.9 减少动效一致 | `grep -rn className src --include=*.tsx \| grep transition- \| grep -vc motion-reduce` → **0**（60 行全部有兜底）；例外见 DESIGN.md 的 spinner 取舍 | 机器已证；效果确认走清单 12 |
| §3.9 多主题一致 | 18 主题的 `--launcher-on-brand` 按 WCAG 相对亮度逐主题取值，最低对比度 4.19:1 | 机器已证（算式）；肉眼确认走清单 9 |
| 图标按钮必须有可读名称（`AGENTS.md`「陌生图标按钮需有 `aria-label`/tooltip」） | 逐 `<Button>` 标签（含跨行与 `isIconOnly`）核对全应用 25 个纯图标按钮：**25/25 有 `aria-label`/`title`/Tooltip**。此前 `debug-sidebar.tsx` 日志面板的复制/刷新/**清空**三个没有名字（清空还是破坏性动作），已补齐——用的正是仓库里早已写好却从未被引用的 `buttons.copy` / `buttons.refresh_logs` / `buttons.clear_logs` | 机器已证（0 缺名）；修复效果走清单 12 之外另看 |
| 未被引用的文案 | 保守扫描（键名作为字符串字面量出现即算引用 + 25 个真实动态前缀）：929 个键里 **66 个无任何引用**。其中 4 个是本轮服务商重构遗留的旧标签（`providers.imported` / `providers.description` / `providers.remove` / `providers.model`），已连同中英两份一并删除（现 925:925 且集合相同）；其余 ~62 个（`app.*` / `status.*` / `plugins.*` 等）早于本轮，**只登记不擅删**，见 `TODO.md` `I18N-01` | 机器已证（删除的部分）；余量待决定 |
| IPC 命令面与前端调用是否一致 | 对账 `builder.rs` 的 `generate_handler![…]`（闭合于第 428 行，共 **85** 条）与 `src` 里全部 `invoke('name')`（**80** 条）：**没有任何一处前端调用指向未注册的命令**（这类错误只会在运行时炸，`tsc` 与 `cargo` 都看不见）。反向查出 4 条已注册但前端不调用的命令，其中 `install_plugin_packages` **违反 §2 边界的实例绑定要求**（写入 `config::instance::active()` 而非显式 `instance_id`），已登记 `TODO.md` `PLG-CMD-01` 待决定；`toggle_sidebar` 按其自带注释属有意保留。**抽取陷阱记此以免误读该结论**：`invoke<Record<string, number>>('…')` 这类泛型里带 `>` 的写法会让朴素正则漏判（曾因此把 `get_running_instance_ports` 误报成无调用方），而按固定行区间统计又会读到宏结束之后的代码（曾因此把注册数算成 92） | 机器已证（正向 0 处不一致）；反向余量待决定 |

**§3.1 / §3.3 逐条复验（同日）**。这两张表写于升级之前，里面的行号和"代码里仍存在"的说法现在都已过期，所以按当前源码逐条重测，不靠记忆。确认已修掉的：**页级标题** `text-2xl` 6 处 → **0 处**；**个性化保存失败被空 catch 吞掉** → 现在由 `save.run` 承接并驻留展示，剩下的那个 `.catch(() => {})` 旁边写明了它只挡未处理的 Promise 拒绝、不是吞反馈；**更新页 `checkError` 从不渲染** → 现在走 `ErrorBanner`；**日志页无刷新无清空** → 两者都在，且清空是 `more_logs.clear_view`"只清显示、不删日志文件"，与 DESIGN 的区分一致；**启动概览与托盘无"停止中"** → `launcher.instance_status.stopping` 两处都在；**托盘绕过 launcher store 直接 `launch_instance_window`** → 现在走 `store.launcher.stopInstance` 并把失败映射成可读文案（不再原样抛后端码）。

**复验时新发现并修掉一个真缺陷**（个性化页，非服务商模块）：读配置的 `.catch(() => {})` 让页面在**读取失败时**静默落到组件默认值，而 `update_app_config` 是**一次带走全部五个字段的整份写入**——用户在这种状态下拨动任意一个开关，就会把其余没读到的设置一起写回默认值，且界面上毫无提示。现在读取失败会显示原因（"保存已停用…保存会把没读到的项一起改回默认"）并拒绝保存，横幅带"重试"重新读取；`load()` 成功后自动解除。中英文各补一条 `launcher.personalization.load_failed`（两份 926:926、键集合相同）。**这条的验证只到代码级**：要复现得让一次 IPC 读取失败，不是点得出来的路径，所以没写进界面清单，也不声称做过真机确认。

**这张表也会过期。** 复核方式：`cargo test -- --list` 与 `node --test` 的用例名若与表中不符，或表里任一名字在输出中消失，就说明实现或文档已经移动，须重跑本节全部命令——不要把这张表当成"已验收"的替身。

### 7.2 独立复核后的修正（2026-09-09）

独立复核证明 §7.1 的自动化证据覆盖不足，不能据此断言界面闭环已经可用。已修正以下问题：宿主把 `sharing` 放在响应顶层而共享预览读取 `plan.sharing`；模板未选中时复选框自身也被禁用；模型条目内嵌的非自有字段会经预览 IPC 返回；凭据值变化没有绑定操作意图摘要；清空 `contextWindow` / `maxTokens` 时合并器又从旧对象带回；移除面板跨 route 保留隐藏的清除默认模型意图；编辑连接测试在输入变化后仍显示旧成功；目录模型请求乱序时会串到新选择。

修复后的契约为 `{ plan: { ..., sharing }, digest, fingerprint }`。计划展示只返回模型的 `id` / `name` / `contextWindow` / `maxTokens`，模型条目内其他键继续只在 YAML Document 内原地保留；明确清空自有模型参数会删除该键。摘要同时绑定凭据写入意图，旧预览不能应用另一份密钥。新增测试 `model options can be explicitly cleared while foreign nested fields stay private and preserved` 与 `an old preview cannot apply a different credential value`。本节只更正代码与自动化证据，真实界面仍须按后续清单验收。


