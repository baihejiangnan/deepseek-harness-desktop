# DSH Launcher V2 Architecture

## 目标

桌面应用启动后先进入实例管理器，由用户明确选择运行环境，再启动 DSH。启动器与每个 DSH 实例使用独立的 Tauri 进程和窗口；实例窗口直接加载 DSH 原生 Web 地址，启动器只负责注册表、依赖准备和生命周期管理。

## 进程模型

同一个可执行文件根据启动参数进入不同宿主模式：

```text
dsh-launcher.exe --mode launcher
dsh-launcher.exe --mode instance --instance-id <id>
```

`launcher` 进程拥有实例管理器窗口和启动器任务栏标识。每次启动实例时，启动器派生一个新的 `instance` 进程；实例进程只绑定自己的实例记录、端口和 Harness 进程，并创建独立窗口。

Windows 任务栏 AppUserModelID 约定为：

```text
io.github.baihejiangnan.dsh-launcher.launcher
io.github.baihejiangnan.dsh-launcher.instance.<instance-id>
```

启动实例后启动器调用 `minimize()`，保持进程和任务栏按钮存在。关闭实例窗口只停止对应 Harness，不退出启动器或其他实例。

## 实例模型

一个实例记录由以下内容组成：

```text
DSH version + DSH_HOME + Profile + runtime launch state
```

- `DSH version`：V1 固定为最新版开发预览版，但注册表保留 `channel` 与 `tag`，用于未来支持多版本。
- `DSH_HOME`：保存 API Key、会话、Agent 预设、设置及其他用户数据。
- `Profile`：保存插件、补丁及插件依赖。
- 运行状态：进程、PID 和端口仅属于本次运行，不写入实例记录。

## 共享与隔离

| 组合 | 用户数据 | 插件与依赖 |
| --- | --- | --- |
| 不同 DSH_HOME | 完全独立 | 完全独立 |
| 相同 DSH_HOME，不同 Profile | 共享 | 独立 |
| 相同 DSH_HOME，相同 Profile | 共享 | 共享 |

Profile 名称只在对应的 `DSH_HOME` 内有意义。因此，不同 Home 中同名 Profile 不发生关联。

创建实例只会初始化缺失的 Profile 文件，不覆盖已有文件。移除实例只删除启动器注册记录，不删除用户的 DSH_HOME 或 Profile 数据。

## 首次使用流程

1. 选择 DSH 版本。V1 的选择框只提供“最新开发预览版”。
2. 选择或输入 DSH_HOME。
3. 输入 Profile 名称。
4. 启动器实时说明该组合与现有实例共享哪些数据。
5. 创建后进入实例管理页，由用户决定是否启动 DSH。
6. DSH 自身的预安装插件流程在实例启动时继续执行。

## 端口策略

端口不属于实例配置。每次启动从推荐端口开始探测本机可用端口，并将实际端口仅保存在进程内运行状态。健康检查、WebView、浏览器打开和 URL 复制均读取这个运行时端口。停止实例后清空运行时端口。

每个实例宿主进程从推荐端口开始探测本机可用端口，端口只保存在该进程的运行时状态中，不写回实例配置。不同 DSH_HOME 的实例可以同时运行，互不覆盖 PID、端口或健康状态。共享同一 DSH_HOME 的实例必须依次运行，因为会话日志、API Key、设置和 Agent 预设位于 Home 内，并行写入会破坏会话日志的提交序号。

## 数据持久化

实例注册表保存在 Tauri AppData 下的 `instances.json`，包含实例列表与当前选中实例 ID。真实的 DSH 数据始终保存在用户选择的 DSH_HOME，不复制到注册表目录。

旧版没有实例注册表时显示首次使用向导。旧版默认数据目录仍可由用户在向导中主动选择，启动器不会自动合并或删除旧数据。

## V2 实施范围

本版本实现实例创建、选择、移除记录、共享关系提示、自动端口分配、独立窗口/任务栏标识、并行实例、启动器最小化、实例独立关闭/崩溃回收，以及启动器更新与 DSH 运行时更新的边界分离。资源、启动器设置与更多页面保留现有入口；多 DSH 版本下载、实例导入导出作为后续扩展。

## 数据边界

启动器注册表只保存实例元数据，不保存 API Key、会话、Agent 预设或插件内容。实例进程通过 `DSH_HOME` 和 Profile 环境变量直接使用用户目录；桌面封装端不复制、迁移或修改 DSH 原生数据，也不参与 DSH 自身的更新逻辑。

## 更新策略

二次开发阶段暂停桌面客户端自身跟随上游仓库的自动检查、提示和下载安装。相关实现保留为可恢复的策略开关。内置 DSH/Harness 使用独立的版本检查与安装流程，继续正常提供更新，不受桌面端暂停策略影响。
