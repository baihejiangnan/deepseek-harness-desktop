# 当前待办

核对日期：2026-09-08；代码基线 v0.0.9 源码（P0/P1/P2 修复见 `a3cf1f8`，文档同步见 `3009d42`）；已发布的 v0.0.8 发行包不含这些修复。本文只跟踪仍需处理的项目工作，不记录会话流水账。优先级 P0 为数据安全，P1 为优先修复，P2 为后续完善，P3 为可延后清理；状态与验收证据分开。完成后链接提交或验证记录，再移出当前列表。

「已实现待验证」表示代码与单元测试已通过，但缺少真机或跨平台验证证据，不能视为完成。「已提交待发行」表示已取得 2026-09-08 Windows 真机证据并已提交，但对应发行包尚未构建上传，用户仍拿不到修复。「部分验证」表示验收条件里已逐项标注哪一条仍缺证据。

| ID | 优先级 / 状态 | 任务 | 验收条件 |
| --- | --- | --- | --- |
| REMOVAL-01 | P0 / 已提交待发行 | 删除 DSH_HOME 前的进程活性门（`.harness.pid`） | 上次会话遗留的 DSH 进程存活时删除被拒绝且给出可读错误；标记陈旧时不阻塞删除；三种调用入口均生效 |
| PLG-CMD-01 | P2 / 待决定 | 检查阶段做"注册命令 ↔ 前端 `invoke()`"对账（注册表 85 条，前端调用 80 条，**没有任何调用指向未注册命令**），反向查出 4 个已注册但前端从不调用的命令：`toggle_sidebar` 注释明写"保留该命令以对齐参考实现"（有意保留，不动）；`get_dsh_status` / `restart_harness` 是正常功能但无调用方；**`install_plugin_packages` 违反 `AGENTS.md`「所有实例级操作必须显式绑定 `instance_id`，不要依赖'当前选中实例'跨异步边界执行写操作」**——它写入 `config::instance::active()`，而界面早已改用 `install_plugin_packages_for_instance` | 就 `install_plugin_packages` 二选一：删除（连同 `builder.rs` 注册项）或改造为必须带 `instance_id`；`get_dsh_status` / `restart_harness` 决定"留作对外接口"还是删除。任何删除都要同步 `docs/IPC_CONTRACTS.md`，不得留下指向不存在命令的文档行 |
| I18N-01 | P3 / 待决定 | 检查阶段用保守扫描（键名作为字符串字面量出现即算引用，外加 25 个真实动态前缀）在 925 个键里找到约 **62 个前后端都没有任何引用**的文案，集中在 `app.*`、`status.*`（`preparing_engine` / `downloading_harness` 等安装阶段）、`plugins.*`、`update.verify_failed`、`errors.*`。它们早于本轮服务商重构，本轮只删掉了服务商自己遗留的 4 个（`providers.imported` / `description` / `remove` / `model`） | 逐个判定"即将接线"还是"该删"：删则中英两份同步删并复核键集合仍相同；留则在文案旁注明来源与计划。**不得凭扫描结果直接批删**——本仓库有 `t(\`providers.${field}\`)` 这类数据驱动拼 key，判据必须按前缀逐个确认，误删会让界面直接印出原始键名 |
| PROVIDER-01 | P0 / 已实现待验证 | 服务商模块全流程真机验收：复核曾发现共享预览结构错位、模板首项无法选择、模型内嵌外部值越界、凭据变更未绑定旧预览、模型自有参数无法清空、跨路由删除状态串项、编辑测试结果不过期和目录模型响应串项；均已修复，并新增模型清空/敏感字段与凭据预览回归测试。单条 预览→应用 写路径会改 `settings.yaml` 与凭据文档，且 Home 可能被多实例共用；目前仍缺真实界面证据 | 按 `docs/PROVIDER_UI_UPGRADE_PLAN.md` §7 的 12 步清单走完：添加→选模型→（可选）测试→明确设默认→保存回读→模板重命名→减少动效；并确认并发改动会中止而非覆盖、外部字段只报名字、删服务商不删凭据、共享 Home 计数与实际一致、七态与实际主题可读性（对比度已按 WCAG 复算修过 6 个主题） |
| PROVIDER-05 | P2 / 已实现待验证 | §2.2"模板内部标识与实例 route ID 分离"从未实施（检查阶段发现：`templateId`/`revision` 从无写入、从无读取，已删除）。用户选定不做分离，改为补 `rename_provider_template`：同一把 `STORE_LOCK` 内搬记录、密钥留在同一条 `StoredProvider` 上，新 ID 复用 `ProviderTemplate::validate` 与保存那道目录核对，四种拒绝均在写盘前 | 按 §7 清单**第 11 步**在真机走完一次重命名：改完立刻编辑应**不需要**重录密钥；撞号/保留 ID/格式/已删除四种失败各有独立文案；已写进实例的路由 ID 一字不改。本步骤不产生 API 用量 |
| PROVIDER-02 | P2 / 已实现待验证 | `read_instance_credential_roles` 的字段角色读取。已单测的只有 `secret_paths` 的形状处理；命令本身两个分支（运行中经 loopback RPC 拿 describe、停机/超时返回 `unavailable`）都需要应用上下文，**没有一条被测过** | 实例运行时子页显示"运行时声明的密钥字段"或"已询问：该路由无密钥字段"；停机时显示"未询问到"，**不得显示成"没有密钥字段"** |
| SWEEP-01 | P0 / 已提交待发行 | 启动清扫凭端口空闲删除 `.harness.pid`，抹掉删除守卫的证据 | 端口空闲但标记进程仍存活时保留标记；进程确认已死才清理；确实占用端口的残留仍被回收 |
| REGISTRY-01 | P0 / 已提交待发行 | `instances.json` 原子写、`.bak` 恢复与单条坏记录隔离 | 写入中断不产生空注册表；损坏时自动回退上一代；一条不可用 Home 不影响其余实例加载 |
| RUNTIME-01 | P1 / 已实现待验证 | install_dependencies 失败后 Installing 未复位 | 下载、摘要、解压失败后无需重启即可重试；并发调用不能误跳过安装；成功路径也释放状态 |
| SPEC-01 | P1 / 已实现待验证 | 手动安装与目录安装共用同一 spec 校验，allowBuilds 键来源收窄 | `file:`/`link:`/反斜杠/以 `-` 开头在所有入口一致拒绝；被污染输出不得写入 `allowBuilds`；git depPath 键仍可去重 |
| RELEASE-01 | P1 / 待加固 | 单一 Release ID 贯穿创建、各平台上传和最终发布 | 所有平台使用同一 ID；资产检查前不发布；重跑与手动构建不产生同 tag 资产分裂 |
| PROGRESS-01 | P2 / 部分验证 | 进度百分比越界与未知 TGZ 总量的不确定态 | 加权百分比不超过 100（已单测）；`progress: -1` 时前端显示不确定态而非估算数字（未验证）；done 原始值为 100；跳过任务、失败、晚到事件均正确 |
| INSTALL-01 | P2 / 已实现待验证 | 非 Windows 安装取消与完整进程树终止 | 取消在 macOS/Linux 真正终止子进程；安装循环内检查取消标志；pnpm shim 不残留 |
| NET-01 | P2 / 已实现待验证 | 协作 loopback RPC 绕过系统代理 | 配置了 HTTP 代理时 `POST /api/<method>` 仍直达 127.0.0.1，无凭据外泄 |
| ARTIFACT-01 | P2 / 待核验 | 仓库便携版与公开下载版不同 | 明确各自产物来源和摘要；对公开下载版单独启动验收，不用本地版测试替代 |
| PLATFORM-01 | P2 / 待验证 | macOS/Linux 启动与就绪判断 | 真机启动、停止、独立窗口验收；明确非 Windows 端口判定与健康检查差异并处理 |
| EVENTS-01 | P2 / 待设计 | 安装事件缺少实例/操作 ID，全局取消难区分任务 | 定义实例和请求关联、终态及晚到事件处理；兼容所有消费者；按操作取消不会终止另一任务 |
| LOGS-01 | P2 / 待完善 | 下载页只保留最近 120 行日志 | 实现完整日志可复制或明确截断范围；清空展示不误删持久日志 |
| CLEANUP-01 | P2 / 待实施 | WebView2 和实例日志附属清理 | 按现有清理方案实现路径、归属、共享 Home、运行状态、失败重试保护 |
| PORT-01 | P2 / 待修复 | `find_available_port` 绑定后释放的 TOCTOU 与并行测试抖动 | 端口探测结果可复现；`occupied_port_advances_to_a_free_port` 在并行 `cargo test` 下稳定通过 |
| HOME-01 | P2 / 待评估 | 无法规范化的 Home 路径按原值保留 | 明确此类实例的运行守卫、删除守卫与共享 Home 判定语义，不出现「守卫静默放行」 |
| LEGACY-01 | P3 / 待清理 | iframe 时代遗留代码与 CSP `frame-src` | 确认无消费者后删除死代码并收紧 CSP；不影响 DSH 原生 Web 直接加载 |

## 依据与边界

- REMOVAL-01：守卫在 [实例注册表](src-tauri/src/config/instance.rs) 的 `remove()` 内，删除原语 `remove_home_directory` 再查一遍存活标记，任何调用方都无法绕过；活性判定见 [运行时服务](src-tauri/src/service/workflow/mod.rs) 的 `home_service_is_live`，不再只依赖进程内 `INSTANCE_HOSTS` 表。2026-09-08 Windows 真机：标记指向存活进程时连续 4 次「直接删除」全部被拒（后端 4 条 `refusing to remove DSH_HOME ...`，Home 与哨兵文件保留、注册表未变），确认弹窗内显示本地化拒绝文案；结束该进程后再点一次即删除成功，只删该 Home，同目录下其余真实 Home 未受影响。单测 `live_home_marker_blocks_removal` 以测试进程自身 PID 锁定拒绝语义与 Home 留存。
- SWEEP-01：`sweep_orphan_harness` 原先只凭端口空闲就删标记，而 `restore_active` 在 `setup()` 之前执行，清扫作用在持久化的活动 Home 上，等于每次启动先抹掉删除守卫的证据。改为仅在标记进程确认已死时清理，端口空闲但进程存活则保留。真机对照：存活 PID + 空闲端口 → 标记在 3 次启动后仍在；死亡 PID + 空闲端口 → 标记被清理，证明确实作用在同一 Home 上。
- REGISTRY-01：写入使用同目录 `.tmp` + `rename`，替换前把上一代复制为 `.bak`；解析改为逐条容错。2026-09-08 Windows 真机：真实注册表的选择与删除写入都刷新了 `.bak`（删除后 `.bak` 恰为删除前那一代）；把主文件截断成 29 字节非法 JSON 后重启，日志两次输出 `instances.json is corrupt (EOF while parsing a string at line 1 column 29); recovered the instance registry from instances.json.bak`，主文件不被就地改写，实例列表照常加载。
- RUNTIME-01：状态复位改由 Drop 守卫承担，并新增安装互斥锁；见 [安装入口](src-tauri/src/bridge/cmd.rs)。
- SPEC-01：策略实现在 [插件安装](src-tauri/src/service/plugin/install.rs) 的 `spec_violation`，目录与插件包校验均委托它；原 `PLUGIN_CATALOG_UNSUPPORTED_SPEC` 错误码已不再产生。
- PROGRESS-01：加权百分比抽成纯函数 `weighted_percentage` 并配 5 条单测（末阶段不超 100、越界收敛、`total_phases` 为 0 仍有限、`-1` 不可测量只保留已完成底数、跳过阶段推进底数）。`progress: -1` 的前端不确定态渲染仍未验证：制造首启下载需要移动真实运行时，已决定跳过。见 [进度计算](src-tauri/src/service/download/progress.rs)、[TGZ 解压](src-tauri/src/service/download/extractor.rs) 与 [前端消费](src/store/modules/launcher/store.ts)。
- CLEANUP-01：以 [清理方案](docs/INSTANCE_CLEANUP_PLAN.md) 为实现依据，不自动扩大删除授权。
- RELEASE-01：v0.0.8 CI 日志出现「已有非草稿 → 创建新草稿」；不能仅归因于同秒创建，提前发布操作者未确认。当前公开 Release 已合并为一个正式版本，但工作流加固未实施。
- BUILD-01 已核验并移出列表：本轮改动的 `service/workflow/mod.rs`、`config/instance.rs`、`service/download/progress.rs` 经 `rustfmt --check --edition 2021` 均为 0 差异，不需要批量格式化。

## 有意未改

以下项经审查后确认当前行为可接受，保留记录以免重复讨论；如判断有误请直接推翻。

- **协作轮询/取消前不额外做健康检查**：`service/collab/mod.rs` 的 `rpc()` 在缺少 `result.ok === true` 信封时返回错误，端口失效表现为失败而非静默成功，已属失败关闭。
- **`read_service_logs` 仍按尾部字节截断**：改为 char boundary 安全后不会截断出半个 UTF-8 字符；完整日志可复制归入 LOGS-01，不在此项重复实现。
- **`set_language` 保持 `()` 返回签名**：实例模式下改为记录警告并忽略，避免改动已注册 command 的前端契约。

## 文档维护

文档导航见 [AGENTS.md](AGENTS.md)。接口变化同步 IPC_CONTRACTS，行为变化同步 USER_GUIDE，数据流变化同步 ARCHITECTURE，开发命令变化同步两份 DEVELOPMENT。记录待办不代表授权发布或删除数据。
