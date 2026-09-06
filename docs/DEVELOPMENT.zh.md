# 开发

DeepSeek Harness Desktop 是 **Tauri 2 + React 19** 应用：前端位于 `src/`，Rust 后端位于 `src-tauri/`。

## 环境要求

| 工具 | 版本 |
| --- | --- |
| Node.js | 20.19+ 或 22.12+（Vite 7 engines 要求） |
| Rust | 1.77.2+ |
| pnpm | 9+ |

以及平台编译工具链：

- **Windows** — MSVC 构建工具 + WebView2
- **macOS** — Xcode Command Line Tools
- **Linux** — WebKit2GTK

## 常用命令

```bash
pnpm install      # 安装依赖
pnpm dev          # 前端开发服务器（Vite）
pnpm typecheck    # 前端 TypeScript 检查
pnpm tauri dev    # 调试模式运行桌面端
pnpm tauri build  # 构建安装包
```

后端检查（在 `src-tauri/` 下执行）：

```bash
cargo check
cargo test
```

## 小贴士

- Harness 服务端口：正式版 **3080**、调试版 **3081**（见 `src-tauri/src/config/constants.rs`），因此已安装版本与 `pnpm tauri dev` 可以同时运行而不争用端口。
- 前端开发服务器是 Vite 的 **1420** 端口（`vite.config.ts`、`tauri.conf.json` 的 `devUrl`）；设置 `TAURI_DEV_HOST` 时 HMR 使用 **1421**。