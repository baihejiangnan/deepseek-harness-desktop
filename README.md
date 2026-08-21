# DeepSeek Harness Desktop

独立维护的 DSH Launcher 桌面应用，提供 DSH 实例管理、插件管理、插件包安装、运行时管理和独立窗口体验。

## 项目定位

启动器负责实例生命周期和本地运行环境；每个 DSH 实例运行在独立进程、窗口、任务栏入口、端口、`DSH_HOME` 和 Profile 中。桌面封装端与 DSH 是“运行管理集成、核心逻辑解耦”：封装端负责启动、停止、窗口、端口、环境变量和运行时更新，但不改写 DSH 核心、原生 Web、会话、API Key、Agent 预设或插件逻辑。

## 主要功能

- 多实例隔离与独立启动、停止、重启、关闭和移除；
- 社区插件目录、插件包市场，以及 npm、Git 和本地包规格；
- 插件包后台安装和主动停止；
- DSH Runtime 安装与更新，同时保留实例数据；
- API Key、会话、Profile、DSH Home、日志和设置仅保存在本机。

## 下载与运行

Windows 用户从 GitHub Releases 下载 `x64-setup.exe` 安装器，安装后从开始菜单或桌面快捷方式启动。首次运行需要网络准备 Node.js Runtime 和 DSH Runtime。当前主要构建目标为 Windows x64，macOS/Linux 发行包需在对应平台构建。

## 项目架构

```text
DeepSeek Harness Desktop
├─ 启动器进程：注册表、生命周期、插件、Runtime、IPC
├─ 实例宿主 × N：独立窗口、端口、DSH_HOME、Profile、DSH Web
├─ Tauri 2：React/Vite 前端、Rust 命令桥接、平台适配
└─ 本地数据：密钥、会话、Profile、插件、日志、导出与缓存
```

## 隐私与发布边界

API Key、Token、密码、会话、DSH Home、Profile、日志、缓存和本地设置不会进入仓库或发布包。`dist`、`src-tauri/target`、`node_modules` 等构建目录已忽略。源码仓库只包含项目代码、构建配置、文档、公开静态资源和发行包。

## 界面预览

完整图片位于 [`docs/images/preview/`](./docs/images/preview/)：

<p align="center"><img src="./docs/images/preview/plugin-pack-download.png" width="48%" alt="插件包下载" /><img src="./docs/images/preview/plugin-management.png" width="48%" alt="插件管理" /></p>
<p align="center"><img src="./docs/images/preview/theme-options.png" width="48%" alt="主题配色" /></p>

## 开发

```bash
pnpm install
pnpm tauri dev
pnpm tauri build --bundles nsis
```

Windows 安装包位于 `src-tauri/target/release/bundle/nsis/`。

## 许可证

[MIT License](./LICENSE)，补充条款见 [LICENSE.details](./LICENSE.details)。
