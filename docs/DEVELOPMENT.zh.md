# 开发

DeepSeek Harness Desktop 是 **Tauri 2 + React 18** 应用：前端位于 `src/`，Rust 后端位于 `src-tauri/`。

## 环境要求

| 工具 | 版本 |
| --- | --- |
| Node.js | 20+ |
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

- 调试模式使用 **3081** 端口，正式版使用 **3080** —— 两者互不冲突，可以同时运行已安装版本与开发构建。