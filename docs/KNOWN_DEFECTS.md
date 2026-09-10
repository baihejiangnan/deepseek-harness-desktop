# 已知缺陷清单

核对日期：2026-09-10；代码基线：master `dd2f3a8`（v0.0.10 已发布）**加工作区未提交改动**。
来源：`master` 全量源码通读（约 29,000 行，前端 11,503 / Rust 17,425），高危路径逐条二次核实。

**本文只记录缺陷，不是修复方案。** 修复顺序、批次划分与授权在 [TODO](../TODO.md) 中跟踪。

> **2026-09-10 修复进度**：P0 六条中 **D-01 ~ D-05 已修复**（见 §7「本轮修复记录」），**D-06 顺延**——它的修法会改变正常启动路径的行为（拒绝启动 + 需要新增文案与绕过路径），须单独授权。
> 验证：`cargo check` 干净（仅 2 条既有 dead-code 警告）；`service::workflow::tests` 8/8、`config::instance` 15/15、`service::cli` 10/10；`pnpm typecheck` 通过；改动文件 ESLint 0 错；`git diff --check` 干净。
> **未验证**：P0 修复均**未做真机界面验收**。`cargo test` 完整跑有 3 条失败（`win_spawn::grandchildren_inherit_hidden_console` 与两条 `cmd.rs` 的 host 回收测试），原因见 §7 尾部的环境说明，与本次改动无关。

**证据标记**（每条都标明可信度，不要把三者混用）：

- **[亲验]** = 我在本次通读中亲自打开代码确认。
- **[待核]** = 由分项通读报出、给出了行号引用，但我未逐条打开确认。
- **[已排除]** = 曾被报为缺陷，经核实不成立，列在 §5 以免重复讨论。

---

## 1. P0 · 会破坏用户数据或用户会话

### D-01 ✅ 已修复

> **已修复。** 抽出纯函数 `port_owner_pid_in_netstat` 按**解析出的端口值**比较（原 `ends_with` 判据恒不匹配，且会把 `13080` 误认成 `3080`），并给 `netstat` 补上 `CREATE_NO_WINDOW`。回归测试 `netstat_port_owner_matches_the_exact_port_and_only_listening`、`netstat_local_port_handles_ipv4_and_ipv6_forms`。
 Windows 孤儿清扫是空操作，上一会话遗留的 DSH 进程永不回收

`src-tauri/src/service/workflow/mod.rs:513-532`（`port_owner_pid`），判据在 `:518` 与 `:525`：

```rust
let needle = format!(":{port} ");                        // :518 带尾部空格
let fields: Vec<&str> = line.split_whitespace().collect(); // :520
if !fields[1].ends_with(&needle) { continue; }           // :525
```

`split_whitespace()` 产出的字段**不可能以空格结尾**，所以该条件恒为 `true`（恒 `continue`），`port_owner_pid` 在 Windows 上**恒返回 `None`**。

**后果**：`sweep_orphan_harness` 的 `:500` 分支恒成立 → **`:504-506` 的"回收本应用残留、结束其进程树并清标记"分支不可达**。也就是说 `:320-330`、`:464-469`、`:509-512` 三处注释所描述的回收能力**在 Windows 上不存在**。残留 DSH 持续占用端口，端口漂移（3080→3081…）不断累积。

**附带**：同一函数 `:516` 的 `netstat` 是本批次里**唯一没有 `CREATE_NO_WINDOW`** 的 Windows 子进程 spawn，每次启动会闪一个控制台窗口。

**修复方向**：`needle` 去掉尾部空格（或改用 `fields[1].rsplit_once(':')` 比较端口），并给 `netstat` 加 `creation_flags(0x08000000)`。这是**全项目性价比最高的一处修复**——一个字符级的改动让整条回收链路从"不工作"变成"工作"。

### D-02 ✅ 已修复

> **已修复。** `register_path` 读取失败改为返回 `Err` 并中止（不再把失败当"PATH 为空"覆盖用户 PATH）；`unregister_path` 读取失败不再谎报成功。
 读注册表失败会把用户整个用户级 PATH 覆盖成只剩 bin 目录

`src-tauri/src/service/cli/path.rs:143-168`（`register_path`），关键在 `:153`：

```rust
let current = read_user_path().unwrap_or_default();
```

`read_user_path()` 在 `RegOpenKeyExW` / `RegQueryValueExW` 失败时**合法地返回 `None`**（`:222-225`、`:243-247`、`:260-263`）。`None` 被当成"PATH 为空"，于是 `:154-158` 把 `HKCU\Environment\Path` 写成**只有 bin 目录**，`:159` 落盘。

**后果**：用户丢失整个用户级 PATH。这是**数据破坏级别**，且触发条件（注册表读取偶发失败）完全不在用户控制内。

**对称的另一个方向**：`unregister_path`（`:171-187`）用 `if let Some(current)`，读失败时什么都不做但**返回 `Ok(())`**——报告成功、实际没删。两个方向都不对。

**修复方向**：读失败必须返回 `Err` 并中止写入，不得用空值兜底；`unregister_path` 读失败应报错而非静默成功。

### D-03 ✅ 已修复

> **已修复。** 新增 `runStartedInstancesRef` 只登记**本次运行真正拉起**的实例；`finalizeRun` 只停这些实例，被"采用"的既有实例保持不动。
 自动流水线会杀掉它自己没启动的实例（用户会话被工作流关掉）

`src/components/collaboration-panel.tsx`：

- `:1079` `dispatchTask` 只用 `store.launcher.runningInstanceIds.includes(instance.id)` 判断是否要启动。**已经在运行的实例被"采用"**，没有任何"这是本次运行启动的"来源标记。
- `:1041-1047` `finalizeRun` 在自动流水线**全部成功**时，对所有节点实例执行 `stopInstance`。

**后果**：用户正在使用的个人会话所在实例，会因为**被一个工作流引用过**而被强制关闭。这违反 AGENTS.md 的协作生命周期规则，是本次通读中后果最重的一条。

**修复方向**：记录本次运行真正启动的实例集合，`finalizeRun` 只停止这个集合；对被"采用"的既有实例，结束运行时不停止。

### D-04 ✅ 已修复

> **已修复。** 在 `normalize_home` **之前**用 `symlink_metadata` 判定链接并拒绝，错误码 `INSTANCE_HOME_SYMLINK_UNSUPPORTED`（与 provider 模块的链接拒绝语义一致）。回归测试 `directory_link_home_is_refused_and_target_survives`。
 删除 Home 会跟随目录符号链接/junction 并递归删除目标

`src-tauri/src/config/instance.rs:475-493`（`remove_home_directory`）：

```rust
let normalized = normalize_home(home)?;      // :476 → dunce::canonicalize，会解析链接
...
if !normalized.is_dir() { ... }              // :489
fs::remove_dir_all(&normalized)              // :492
```

`normalize_home`（`:213-225`）用 `dunce::canonicalize`，**其语义就是解析符号链接**。全路径**没有 `symlink_metadata` / `is_symlink` 检查**。`:483` 的根目录守卫拦不住它——链接本身不是根。

**后果**：一个名为 DSH_HOME 的 junction 指向用户目录时，**那个目录会被递归删除**。仓库自己的 `docs/INSTANCE_CLEANUP_PLAN.md:15` 明确写着"清理不得跟随父目录链接"——**删除路径违反了仓库自定的安全规则**。

**修复方向**：删除前用 `symlink_metadata` 判定并拒绝链接（或在规范化之前判定）；与清理方案保持一致。

### D-05 ✅ 已修复

> **已修复。** `kill_pid_tree` 与 `terminate_owned_process` 改为返回"是否确认目标已退出"（Windows 轮询 `is_pid_alive`，Unix 分阶段 TERM→KILL 各自确认）；清扫、`stop()`、`stop_on_exit()`、`terminate_stale_harness_processes` 全部改为**只在确认后才删** `.harness.pid`，未确认时记 error 并保留标记。
 删除守卫的证据可被抹掉

`home_service_is_live`（`workflow/mod.rs:443-453`）只读 `$DSH_HOME/.harness.pid`，它是 Home 删除前**唯一**的守卫依据（调用点 `instance.rs:373`、`:477`）。以下路径在**未确认 kill 成功**的情况下删除该标记：

| 路径 | 位置 | 问题 |
|---|---|---|
| 清扫回收分支 | `mod.rs:504-506` | `kill_pid_tree` 的失败**只记日志**（`:281-283`，不返回结果），随后无条件删标记。taskkill 失败即留下一个仍在写 Home、但已无标记的 DSH 进程 |
| 标记不可解析 | `mod.rs:481-488` | `:461` 的 `fs::write` 非原子，可能留下半个标记，被当成"陈旧垃圾"清掉 |
| `stop()` | `mod.rs:951` | 未验证 kill 结果即删标记 |
| `stop_on_exit()` | `mod.rs:965-968` | 同上 |
| 启动器退出 | `lib.rs:28-33` | 先 `stop_instance_hosts_on_exit()` 再 `stop_on_exit()`，**即使本进程不持有任何进程**（`OWNED_PROCESS_ID == 0`）也会删掉活动 Home 的标记，包括上一会话遗留、DSH 仍存活的宿主 |

**后果**：守卫失去依据后，用户可以在 DSH 仍在使用该 Home 时删掉它。

**修复方向**：删除标记必须以"进程确认已死"为前置条件；`kill_pid_tree` 需要返回结果而不是只记日志。

### D-06 ⏸ 已确认，顺延修复

> **2026-09-10：确认成立但不在本轮修复。** 修法是让 `launch_instance_window` 在启动前也用 `home_service_is_live`（读目标 Home 的 `.harness.pid` + 进程活性）判定，而不只看本进程的 `INSTANCE_HOSTS`。
> **顺延理由**：这会改变**正常启动路径**的行为——被拒绝时用户需要新的文案、明确的绕过方式（清理孤儿后重试），还要求 `.harness.pid` 的写入时机确实在"服务已监听"之后，否则会引入误拒。这属于必须单独授权并做真机验收的改动，不能塞进本批。

`cmd.rs:369-397`（`instance_host_is_running` / `instance_home_is_running`）只查本进程的 `INSTANCE_HOSTS` 表。**启动器重启或崩溃后遗留的宿主不可见**，于是 `launch_instance_window`（`:808-817`）与 `create/update_instance`（`:1276`、`:1302`）可以**在同一个 DSH_HOME 上启动第二个实例**。

**后果**：违反 AGENTS.md 的"共享同一 Home 的任何实例均不得并行运行"。会话日志提交序号交叉（`:806-807` 的注释正是描述这个后果）。

---

## 2. P1 · 功能不工作或状态永久卡死

### D-07 [亲验] 自动流水线的会话建在错误的 workspace

`src-tauri/src/service/collab/mod.rs:188-195`：

```rust
let host = rpc(port, "host.describe", json!({})).await?;
let cwd = host.get("cwd").and_then(Value::as_str)...;
let workspace_id = ensure_workspace(port, cwd).await?;
```

它取的是 **DSH 进程自身的 cwd**。而启动器 spawn DSH 时用的 `current_dir` 是 `config::get_dsh_working_dir()`（`runtime.rs:222-226`），其值是 `dsh_runtime.rs:187` 的 `working_dir: root.clone()`——**运行时包目录**，且启动器**不设置 `DSH_CWD`**。

**后果**：契约文件写在用户选的工作区（`mod.rs:296-317` 用 `input.workspace`），而**会话的 `workspaceId` 指向运行时包目录**。用户在 DSH 里看到的是错的工作区，节点产物不落在自己选的地方。主代理模式靠契约文件里的手写步骤（`:367-374`）能救回来，**自动流水线没有这层**。

### D-08 [亲验] 主代理模式下"停止"被在途启动静默覆盖

`collaboration-panel.tsx`：

- `:945` `await collab_allocate_ports(...)`、`:957` `await collab_write_contract(...)`
- `:970-973` 这两次 await **之后**才把节点置 `running` 并 `setRunState('running')`
- `:1011-1020` `stopRun` 没有 generation token / `runStateRef`

**后果**：用户在"分配端口/写契约"这两个 await 期间点停止，`stopRun` 的结果会被 `:973` 覆盖，**实例照旧被逐个拉起**。

### D-09 [待核] 启动失败后状态永不复位

`workflow/status.rs:5-12` 的 `Status` **没有 `Failed` 变体**。`start()` 在 `mod.rs:707-709` 置 `Starting`，而 `launch()` 的错误路径（`:763-766` PORT_EXHAUSTED、`:779`、`:782`、`:937-940` spawn 失败）**都不碰状态**。只有 `stop()`（`:957`）与 `record_process_exit`（`:316`）会置 `Stopped`，`tick_check` 只会置 `Running`。

**后果**：一次启动失败后状态**永久停在 `Starting`**；`RUNTIME_PORT`（`:767`）保留一个没人监听的端口（只在 `:307` 清除）。

### D-10 [亲验] 部分启动失败留下孤儿实例

`collaboration-panel.tsx:975-987` 逐个启动、失败只置 `launchFailed`；`:988-992` 直接 `return`，**已成功启动的实例不回收**，且 `runState='failed'` 后界面上没有任何指向它们的操作入口。

### D-11 [待核] 自动流在依赖失败后永久显示"运行中"

`computeReadyNodeIds`（`:190-227`）没有"依赖失败"这个态：父节点失败后，子节点永远停在 `idle`（`:211` 因父不是 `done` 而拒绝）。于是 `startReadyNodes` 拿到空 ready 列表 → `finalizeRun`（`:1024-1027`）→ `failed=true` 但 `allDone=false` → **`setRunState('running')`（`:1048`）**。

**后果**：顶部一直显示"编排运行中"、提供停止按钮、显示"已完成 k/N"，但**什么都不会推进**；同时挡住"清空画布"（`:1225-1227`）与"切换工作流"（`:1321-1324`）。

### D-12 [亲验] 编辑服务商时 all→subset 静默丢弃钉住的模型清单

`provider-edit.tsx:187-203`，关键在 `:193`：

```ts
const carried = tuning.filter(hasTuning).map(item => ({ ...item }))
...
setModels(carried.length > 0 ? carried : [])
```

`hasTuning`（`:20-22`）只对填过 `contextWindow`/`maxTokens`/`name` 的条目为真。**all→subset 时未调参的模型条目被丢弃**，且**不可恢复**（两个槽位各存一种，没有备份）。用户看到"模型变少了"，而预览里看不出——丢的是前端状态而非文档差异。

`provider-add.tsx:112-129` 只是**碰巧**没这个问题（`toggleModel` 会自动置 `selection='subset'`）。

### D-13 [亲验] 空密钥的目录型模板写出悬空 `apiKeyEnv`，直到发请求才失败

- `providers.rs:242` **无条件**写入 `apiKeyEnv`：`profile.insert("apiKeyEnv".into(), json!(self.credential_ref()))`——没有 `has_key` 判断。
- `provider_store.rs:140-143`：`PROVIDER_KEY_REQUIRED` **只在新建模板时**触发；覆盖已有条目时空密钥被接受（`.filter(|k| !k.is_empty()).or_else(|| existing…)`）。
- `provider-import.mjs:361` 的 `if (ref && key)` 不满足 → **从不写对应引用**。

**后果**：路由指向一个不存在的凭据引用，回读为 `credential.source: 'unverifiable'`，**直到真正发请求才以 `MISSING_CREDENTIAL` 失败**。这**绕过了** `cmd.rs:2134` 的 `declares_reference = has_key` 守卫。

### D-14 [亲验] `busyInstanceId` 缺少并发守卫，重叠操作的忙态互相覆盖

`launcher/store.ts:220` / `:303` 都**没有** `if (busyInstanceId) return`。`busyInstanceId` / `busyInstanceAction` 是**全局单值**，`finally` 只按"id 相同 + action 匹配"清除（`:285-288` / `:319-322`）。

**后果**：先启 A、再启 B、A 先完成时，A 的 `finally` 会**把 B 的"启动中"状态清掉**（此时 B 仍在启动）。反向：第二个操作的终态也会被丢弃，界面可能残留忙态。`collaboration-panel.tsx:1032-1033` 的 `for (const id of ready) void dispatchTask(id)` 与 `:1045-1046` 的并发 `stopInstance` 就是可达路径。

**修复方向**：改成按实例 id 的映射，或加在途计数。

### D-15 [待核] 取消插件安装杀不掉 lockfile 修复用的 pnpm 子进程

`cancel.rs:79-81` 的 Windows 取消靠 PowerShell CIM 查询匹配命令行（`Name='node.exe'` + 托管 dsh 入口 + `*plugin*--profile*<profile>*add*`），而 `install.rs:388-438` 的 lockfile 修复子进程**不匹配这个过滤条件**，因此取消杀不掉它。此外安装循环（`install.rs:238-290`）**不在起新进程前检查取消标志**（只在非零退出后 `:246-248` 检查），`ensure_pnpm` 的 pnpm 下载/解压（`:641-653`）与整个 `service/download`（零 `cancel` 匹配）都不可取消。

### D-16 [待核] 运行时更新没有锁住 launch / stop / 安装

`update_active_dsh_runtime`（`cmd.rs:658-672`）持有运行时写锁并停止所有宿主，但 `launch_harness`（`:729-733`）、`shutdown_harness`（`:1441-1443`）、`install_dependencies`（`:423`）**都不取 `RuntimeUseGuard` / `RuntimeMutationGuard`**。AGENTS.md 要求"更新或切换运行时前需停止所有受影响实例，操作期间锁定启动、停止、插件写入"。

**补充**：`RuntimeMutationGuard::acquire` 失败即快速返回（`:112-122`），不排队；而 `launch_instance_window` 在整个 100 秒启动等待循环期间持有读锁（`:766` → `:895`），期间任何运行时更新/切换都会直接以 `DSH_RUNTIME_BUSY` 失败。

### D-17 [待核] 就绪判定被简化：端口占用或 PID 存在即视为可用

- `workflow/mod.rs:694-699` 与 `:748-751`：`start()` / `launch()` 仅凭 **PID 存在**就短路成 `Running`。
- `cmd.rs:884-888`：**非 Windows** 上 `launch_instance_window` 仅凭 `is_port_in_use` 就返回成功（300ms 睡眠），不验证宿主窗口是否存在。
- `workflow/utils.rs:26-31`：`is_dsh_running` **接受 HTTP 401**。
- `cmd.rs:1020-1031`：`resolve_running_instance_port` 只要宿主表里有该项、且端口有监听就通过，**不校验监听者是不是这个实例的 DSH**。

**后果**：陈旧的 `.harness.pid` 加上被别的进程重新占用的端口，可以骗过所有检查。`collab_poll_task`（`:1096`）与 `collab_cancel_task`（`:1110`）只用这个较弱的解析器（不像 `start` 那样加 `is_dsh_running`），且 `get_running_instance_ports`（`:1055-1072`）同样是弱检查——而它正是前端 `waitForAllPorts`（`collaboration-panel.tsx:839-850`）轮询的对象，所以"端口全部就绪"可能在 DSH 尚未监听时就为真。

### D-18 [待核] 无 Content-Length 时进度出现 NaN / ∞

`download/core.rs:141-157`：`total_size == 0` 时 `received_total/0` 得 NaN/∞。`progress.rs:102-109` 的 `weighted_percentage` 被 `clamp(0..=100)` **不拦 NaN**（Rust 的 `clamp` 对 NaN 返回 NaN），`serde_json` 把非有限浮点序列化为 `null` → 前端收到 `percentage: null` / `progress: null`。

（`percentage` 本身在有限值下不会超过 100，有测试 `:117-121`；越界的是原始 `progress`。）

### D-19 [待核] 插件规格安全策略有缺口

`install.rs:106-117` 的 `spec_violation` 会拒绝空值 / 超 512 / 控制字符 / 以 `-` 开头 / `file:` / `link:` / 任何反斜杠，但：

- **没有 HTTP(S) 主机白名单**，而 AGENTS.md 写的是"受信任的 HTTP(S) 压缩包"。
- 不拒绝 `git+ssh:` / `git://`。
- 不拒绝正斜杠绝对路径（`/tmp/x.tgz`）与 `./rel`、`../rel` 这类 pnpm 会接受的本地路径规格。

### D-20 [待核] 锁中毒处理不一致，一处会静默杀死整个调度循环

`plugin/watch.rs:266` 用 `.lock().unwrap()`（对比 `status.rs:23`、`progress.rs:59-62` 是容错的）。1Hz 调度循环（`service/scheduler/mod.rs:16-24`）里任何一次 panic 都会**静默停止全部状态/主题/插件监控**。

### D-21 [待核] 存储读写有硬 panic，且解析失败静默回落默认值

- `config/setting.rs:98-107`：`expect("Failed to load store")`、`serde_json::to_value(...).unwrap()`、`expect("Failed to save store")`、`expect("Failed to emit event")`。可从调度器经 `workflow::refresh_web_capabilities`（`workflow/mod.rs:207-222`）到达——**磁盘满或文件被锁会 panic 掉正在跑的线程**。
- `config/runtime.rs:13-18`：`get_base_dir` 用 `.expect("Failed to resolve app data directory")`，而它是注册表、日志、运行时目录、webview 目录、shim 生成的根。
- `config/setting.rs:119-121`：反序列化失败**静默回落 `Setting::default()`**——看起来正常，实际把用户的 `port` / `language` / `installed` 一起换掉；且 `installed`/`port`/`auto_start`/`language`（`:9-11`、`:20`）**没有 `#[serde(default)]`**，所以一份"部分字段缺失"的旧文档就会触发这条路径。

---

## 3. P2 · 诚实性、一致性与死代码

### 3.1 用户可见的陈述与实际不符

| 编号 | 位置 | 问题 | 状态 |
|---|---|---|---|
| D-22 | `download-center.tsx:748-754` vs `zh-CN.json:866` / `en-US.json:866` | 缓冲保留**前** 5000 行、丢弃**之后**的行；文案却说"**更早的**内容未被保留" | **[亲验]** 文案已在本轮文档修正中改对 |
| D-23 | `docs/IPC_CONTRACTS.md:44-45` | 同一命令 `update_active_dsh_runtime` 重复两行、语义冲突（工作区改动的漏删） | **[亲验]** 已在本轮文档修正中合并 |
| D-24 | `docs/DESIGN.md:66` | 曾教人跑一条会失败的核对命令。**复核判定：命令本身正确**（输出 0），真正的问题是同行判据会漏掉跨行 `className` | **[亲验]** 已在本轮补上判据陷阱说明 |
| D-25 | 4 份文档抬头 + 大文档 5 处 | 版本基线停在 v0.0.9/v0.0.8（实际 v0.0.10 已发布）；i18n 键数文档写 923/925/926、实测 **952** | **[亲验]** 已在本轮文档修正中改对 |
| D-26 | `instance-settings.tsx:235-236` | 直接渲染**未映射的后端原始错误串**（携带 `PLUGIN_REMOVE_FAILED:` 等码） | [待核] |
| D-27 | `download-center.tsx:685+707+891` | 前端自造 `PLUGIN_PACK_TARGET_UNAVAILABLE`，Rust 里不存在该码、也不在 `MESSAGE_KEYS`，因此原样打印 | [待核] |
| D-28 | `utils/error-codes.ts:62-86` | `EXPORT_CANCELLED`（`export.rs:189,274` 发出）、`EXPORT_NOT_RUNNING`、`INSTANCE_HOST_STOP` 未登记 | [待核] |
| D-29 | `cmd.rs:679,703,709,716,719` | `DSH_RUNTIME_NOT_WRITABLE` / `DSH_RUNTIME_UPDATE_FAILED` 未进文档错误表 | **[亲验]** 已在本轮补齐 |
| D-30 | `debug-sidebar.tsx:207` | 硬编码"存在新版本"，绕过 i18n（AGENTS.md 禁止） | [待核] |
| D-31 | `instance-settings.tsx:437,445` | 用中文顿号 `、` 做列表分隔符，英文界面下仍是顿号 | [待核] |
| D-32 | `i18n/index.detector.ts:12-28` | 首次运行取 `navigator.language` 且**从不写回后端**；后端默认 `zh-CN`（`setting.rs:86`）。英文机器上启动器是英文、而新启动的实例是中文，与 `zh-CN.json:528` 的承诺相反 | [待核] |

### 3.2 服务商模块的契约缝隙

| 编号 | 位置 | 问题 | 状态 |
|---|---|---|---|
| D-33 | `provider-import.mjs:441-451` | `readPlanContext` 对凭据文档**宽松校验**（只看顶层键），而 `readProviders:160` / `importProviders:107-112` 还要求 `version===1` 且 `refs`/`records` 是 map → plan/apply 接受 readProviders 会拒绝的文档 | [待核] |
| D-34 | `cmd.rs:1866-1968` | 目录缓存以运行时**入口路径**为键且**无 TTL**；原地 npm/pnpm 更新后，进程生命周期内一直返回陈旧目录，而所有能力门禁结论都基于它 | [待核] |
| D-35 | `provider-import.mjs:508` vs `:421-431` | `plan` 只对 `defaultModel` 告警、`apply` 硬拒 → **预览能画出 apply 会拒绝的计划** | [待核] |
| D-36 | `provider-contracts.ts:112` / `provider-plan-view.tsx:37` / `provider-import.test.mjs:774` | `ProviderPlan.sharing` 在 TS 契约里是**必需**字段，脚本从不产出（只有 Rust 宿主注入，`cmd.rs:2221-2238`），测试还用 `filter(k => k !== 'sharing')` **显式排除**它 → 脚本的 plan 对象违反自己的类型声明 | **[亲验]** 已在文档中说明 |
| D-37 | `provider-error.ts:6-29` | 缺 `PROVIDER_CREDENTIAL_MODE_INVALID` / `PROVIDER_CATALOG_*` / `*_FAILED` 系列分组，全部落到 `generic`；locale 测试只核对"分组→文案"，从不核对"码→分组" | [待核] |
| D-38 | `cmd.rs:2166-2193` | `provider_planned_entries` 拼接 `ids` 与 `drafts` 时**不去重**；同一 route id 同时出现在两处会产生两条冲突变更，预览显示两条、写入以最后一条胜出 | [待核] |
| D-39 | `providers.rs:339-343` / `provider-edit.tsx:190-201,321` | 编辑目录型路由时，profile 省略 `api`/`baseURL`/`models` 就**删除**它们（含手工钉住路由的**纯改名**编辑）；界面无法区分"继承"与"未设"，而 `kind:'custom'` 逃生门在 UI 里**不可达**（表单本身以 `writable` 为门禁） | [待核] |
| D-40 | `provider-remove.tsx:62-73` | 组件内**没有任何地方渲染 `save.phase`**（对比 `provider-edit.tsx:739`），删除成功只有列表刷新、没有确认；`:67-70` 还在 `setOpen(false)` 前调 `onApplied()` 触发重挂载 | **[亲验]** |
| D-41 | `provider-import.mjs:364-368` | `planDigest` 只哈希 plan+entries，稳健性完全依赖"plan 包含每个意图字段"；`defaultModelAction==='clear'` 只带标志不带 route/model。**未发现活漏洞**，但构造脆弱，且不覆盖 `$DSH_HOME/.env` 与 Profile 的 `cordis.patch.yml` | [待核] |
| D-42 | 测试面 | `provider-import.test.mjs` **18 条里 17 条**是 `{skip: !runtime}`，找不到运行时时**自我 skip 却报告成功**；`test.mjs:429`「returning a route to catalog inheritance」走的是 `importProviders`，而**生产代码从不调用它**（`cmd.rs` 只发 plan/apply/read），所以"改回目录继承"这条高风险动作**没有真实覆盖**。`headers` 在**触及同一路由的 apply** 中是否原样保留，**没有任何断言** | [待核] |

### 3.3 死代码与未接线

| 编号 | 位置 | 问题 |
|---|---|---|
| D-43 | `desktop-updater.tsx` / `desktop-update-dialog.tsx` / `desktop-update/store.ts:178` | 桌面自更新整个子系统**零引用**（`DESKTOP_UPDATES_PAUSED = true` 是有意暂停，故"不可达"是设计结果；但这批代码与 `dismissedTag` 的 localStorage 读写全是死的） |
| D-44 | `harness-webview.tsx` / `harness/store.ts` | `harness.startup()` 无活调用方 → **`serviceRunning` 恒为 false** → `download-center.tsx:347` 与 `instance-settings.tsx:160` 里 `|| serviceRunning` 的分支永不成立；harness store 大半个 API 无人使用 |
| D-45 | `launcher-ui.tsx:56,83,183` | `Toolbar` / `EmptyState` / `ActionBar` **零引用**，而 `provider-templates.tsx:405-421` 与 `provider-add.tsx:484` 各自手写了 `ActionBar` 存在的理由 |
| D-46 | `utils/surface-state.ts` | 全仓**只有 1 个消费方**（`provider-templates.tsx:53-55`）。计划 §3.4 说其余页面"随 #22–#25 接入"，**实际一个都没接**。切换页面时搜索词、页码、章节选择、向导草稿静默丢失 |
| D-47 | `config/i18n.rs:36-85` | 25 条文案里 **15 条无调用方** |
| D-48 | `navbar.tsx` / `setup.tsx` / `loadable.tsx` / `debug-sidebar.tsx` / `download-toast.tsx` / `sidebar-toggle.tsx` | 全部零引用 |
| D-49 | `importProviders` / `commitProviderDocuments` | **只有测试能到达**的生产死路径；`openProviderDocuments` 里 `load('@deepseek-ai/dsh-llm-pi-ai')` 与 `supportedProtocols` 未被使用 |
| D-50 | `TEMPLATE_OWNED_FIELDS`(`:123`) / `OWNED_FIELDS`(`:221`) | 两个内容相同、顺序不同的常量；凭据形态校验写了**三遍**（`:107`/`:160`/`:447`）且严格程度不一致 |
| D-51 | `provider-catalog.mjs:9,99` | `PROVIDER_CATALOG_TIMEOUT` 从不发出（超时是宿主侧 `cmd.rs:1918-1920`）；`supportsSomeProtocol` 未被消费 |
| D-52 | `dsh_runtime.rs:42,179-182` | `update_supported` 计算了但**无人读取**（TS 侧 `more-panel.tsx:26` 声明 `updateSupported` 也从不渲染） |

### 3.4 过时注释（描述的行为已不存在）

`workflow/mod.rs:710` 指向不存在的路径 · `plugin/mod.rs:3-4` 说 profile 写死 `tauri`、`:13` 说取消仅 Windows · `install.rs:799` 注释写 `profiles/web` · `provider-edit.tsx:210-211` 说模板 key 不可改（实际 `rename_provider_template` 可改）· `provider-plan-view.tsx:7` 说"不含凭据"但 `apiKeyEnv` 确实会渲染 · `desktop/nav.rs:15` 声称插件卸载后自动恢复接管（无卸载检测）· `notification.rs:215-217,235-236` 的 HSTRING 生命周期论证是错的 · `launcher-shell.tsx:26-34` 说"有真实数值才给 percent"（`indeterminate: true` 是从未被读取的死字段，见 §5）· `harness/store.ts:132-135` 的分工描述已被 `launcher.store.installProgress` 取代。

---

## 4. 与 AGENTS.md 约束的偏离汇总

| 约束 | 偏离 |
|---|---|
| 所有实例级操作显式绑定 `instance_id` | `cancel_plugin_install`（`cmd.rs:1693`，全局标志 + 全局 profile，`cancel.rs:78`）、`install_plugin_packages`（`:1460`，走 `config::instance::active()`）、`get_dsh_plugins`、`proxy_health_check`、`launch_harness`/`shutdown_harness`/`restart_harness` 都作用于全局状态；实例级命令的实现方式是**临时替换进程级全局**（`:1492`、`:1577`、`:1639`、`:1735`）——恢复在所有路径上都正确，但正是这条规则警告的模式 |
| 后台不得依赖"当前选中实例" | 1Hz 调度器经 `theme.rs:22` 与 `plugin/watch.rs:158` → `plugin/installed.rs:32-36` 读全局活动实例，而写方靠 `INSTANCE_OPERATION_LOCK` 串行化——**调度器不取那把锁**。多秒级插件安装期间，tick 可能为**错误的实例**发 `dsh-plugins-updated`，并把错误指纹**持久化**进 `STATE` |
| 共享 Home 不得并行 | D-06（同 Home 互斥只在进程内）、D-16（运行时更新不锁启动） |
| 停止/取消须终止完整进程树 | D-05（kill 失败只记日志）、D-15（取消杀不掉 pnpm 子进程）、`workflow/mod.rs:175,182` 的 `probe_no_open_capability` 只 `child.kill()` 不杀后代 |
| Windows 子进程隐藏控制台 | `workflow/mod.rs:516` 的 `netstat`（见 D-01） |
| 新配置字段须有 serde 默认值 | D-21（`installed`/`port`/`auto_start`/`language` 无默认值，且失败静默回落默认值） |
| 错误须用稳定大写前缀 | `shim.rs:505,518`、`path.rs:152,287,318-320` 无前缀；`dsh_runtime.rs:277` 冒号后无空格；`instance.rs:478-481` 与 `cmd.rs:1357-1360` 的 `INSTANCE_HOME_RUNNING:` 载荷形状与其他调用点不一致 |
| 锁中毒须处理 | D-20（`watch.rs:266`/`theme.rs:66-69` 会 panic，其余容错） |
| 启动器只适配 DSH 外部契约、不改核心 | **无违规**。两处边界项（`win_inspector.rs` 写 profile 的 `cordis.patch.yml` 并创作含 `danger-full-access` 的用户 preset；`builder.rs:288-291` 注入覆盖 `navigator.language`）都是**有意且已文档化**的 Windows 权衡（见 `win_inspector.rs:24-33`），列此仅备记录 |

---

## 5. 已排除（曾被报为缺陷，核实不成立）

留着以免重复讨论：

| 曾报 | 核实结论 |
|---|---|
| `dsh.cmd` 会把启动器的 `DSH_HOME` 传染给用户自己的 dsh | **不成立**。模板插值顺序被读反了：`{user_dsh}`（含 `call "%USER_DSH%" %*`）在 `set "DSH_HOME=..."` **之前**执行，用户 dsh 拿到的是自己的环境。`shim.rs:628-637` 的测试只断言源码顺序、不验证该次序，所以真问题是**缺少断言**，不是现有缺陷 |
| 全局任务条对启动进度"说谎" | **不成立**。渲染只看 `percent`（`launcher-shell.tsx:236,245-247`）：有真实百分比时正常显示数值与宽度，不可测量时走脉冲条。`indeterminate: true`（`:170`）是**从未被读取的死字段** |
| 创建实例时写入服务商 = 第 5 条绕过预览的写路径 | **降级**。`launcher/store.ts:131-138` 确实调 plan+apply 且不经 `ProviderPlanView`，但由用户在向导里显式勾选的"默认加入新实例"驱动，失败有 `providers.created_import_failed` 反馈——是有意的产品行为，不是隐藏写入 |
| 桌面自更新不可达 = 缺陷 | **降级为死代码**。见 D-43 |
| `docs/DESIGN.md` 的减少动效核对命令会输出非零 | **不成立**（我的初次统计有误）。按文档的管道语义复跑输出 **0**；陷阱在于同行判据会漏掉跨行 `className`。已写入 DESIGN.md |
| `DEVELOPMENT.zh.md` 相对英文版缺两处用量提示 | **不成立**（我的初次比对有误）。中文版第 78、88 行都在 |

---

## 6. 复核方式与限制

- **本文的 [待核] 条目带行号但未逐条亲验**，引用前请先打开对应位置确认。本次通读中分项报告的**严重度定级偏高**是系统性的（5 次纠正里有 3 次是"把死代码/死字段说成缺陷"、1 次是"把执行顺序读反"、1 次是"把设计决定说成违规"），**行号引用基本可信，定性判断不可直接采信**。
- 本次通读**未运行**任何构建、测试或界面验证；所有结论来自源码阅读。D-01、D-03、D-04、D-37 等可写出确定性测试的条目，建议修复时同步补回归断言。
- 仓库当前**没有**覆盖以下内容的自动化测试：Rust 宿主胶水层（`provider_planned_entry`、`attach_provider_plan_sharing`、目录缓存、`guard_provider_write`）、共享预览的端到端形状、`error-codes.ts` 的映射正确性（无前端 TS 测试运行器）。
- 本文描述的是 `master` `dd2f3a8` **加工作区未提交改动**的状态。工作区改动的行为以当前文件为准；已发布的 v0.0.10 二进制**不含**这些改动。

---

## 7. 本轮修复记录（2026-09-10）

只修了 §1 的 P0。**代码缺陷的修复范围仅限下面这些文件，未触碰工作区中无关的未提交改动。**

| 缺陷 | 改动文件 | 要点 |
|---|---|---|
| D-01 | `src-tauri/src/service/workflow/mod.rs` | `netstat` 解析抽成纯函数 + 按端口值精确比较 + 补 `CREATE_NO_WINDOW`；新增 2 条离线回归测试 |
| D-05 | `src-tauri/src/service/workflow/mod.rs`、`bridge/cmd.rs`、`service/plugin/cancel.rs` | `kill_pid_tree` / `terminate_owned_process` 返回"是否确认已退出"；四处删标记点改为只在确认后删；新增 `wait_pid_gone` 复用 `is_pid_alive`，不引入新的 Win32 导入 |
| D-02 | `src-tauri/src/service/cli/path.rs` | `register_path` 读失败即中止；`unregister_path` 读失败不再谎报成功 |
| D-04 | `src-tauri/src/config/instance.rs` | 删除前用 `symlink_metadata` 拒绝目录链接；新增 1 条回归测试 |
| D-03 | `src/components/collaboration-panel.tsx` | 新增 `runStartedInstancesRef`；`finalizeRun` 只停本次真正拉起的实例；主代理模式跳过已运行实例并只回收本次启动的实例（顺带修掉"引用已运行实例会导致主代理运行失败"与"部分启动失败留孤儿"两个相邻问题） |

### 验证结果（实跑）

- `cargo check`：**干净**（仅 `core/utils/mod.rs` 两条既有 dead-code 警告）
- `cargo test --lib service::workflow::tests`：**8 passed / 0 failed**
- `cargo test --lib config::instance`：**15 passed / 0 failed**
- `cargo test --lib service::cli`：**10 passed / 0 failed**
- `pnpm typecheck`：通过；改动文件 ESLint：0 错；`git diff --check`：exit 0
- 全部改动文件行尾为 **LF**、UTF-8

### 环境限制导致的既有测试失败（**与本次改动无关**）

完整 `cargo test` 有 3 条失败，均**不是本次改动引入**：

1. `service::workflow::win_spawn::tests::grandchildren_inherit_hidden_console` —— 该文件 `git status` 显示**未修改**；失败原因是它用 Node 的 `child_process.spawnSync` 捕获孙进程输出，而本沙箱**禁止 Node 通过管道派生子进程**（返回空串）。属环境边界。
2. `bridge::cmd::tests::stopping_owned_host_reaps_process_and_removes_tracking`
3. `bridge::cmd::tests::runtime_update_shutdown_reaps_every_owned_instance_host`

后两条断言的是 `stop_instance_window` 走 **Windows `taskkill` 直接路径**（不是本次改动的 `kill_pid_tree`），失败信息为 `taskkill exited with exit code: 1`。它们由工作区**未提交的改动**引入，本沙箱不允许 taskkill 结束进程。**建议在有正常权限的终端里复跑这两条确认。**

### 本轮明确未做

- **D-06 未修**（顺延，理由见其条目）。
- **P1 与 P2 一条未动**（D-07 ~ D-52）。
- **未做真机界面验收**：D-03 是界面行为改动，需要重启 `pnpm tauri dev` 后在一次性 Home 上按下述步骤验证——两个实例、其中一个先手动启动、然后跑一次全成功的自动流水线，确认**先启动的那个实例仍在运行**、另一个被停止。
- **未提交、未打 tag、未发布**。
