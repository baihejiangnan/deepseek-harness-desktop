# Development

DeepSeek Harness Desktop is a **Tauri 2 + React 18** app: the UI lives in `src/`, the Rust backend in `src-tauri/`.

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | 20+ |
| Rust | 1.77.2+ |
| pnpm | 9+ |

Plus the platform toolchain:

- **Windows** — MSVC build tools + WebView2
- **macOS** — Xcode Command Line Tools
- **Linux** — WebKit2GTK

## Commands

```bash
pnpm install      # install dependencies
pnpm dev          # frontend dev server (Vite)
pnpm typecheck    # frontend TypeScript check
pnpm tauri dev    # run the desktop app in debug mode
pnpm tauri build  # build installers
```

Backend checks (from `src-tauri/`):

```bash
cargo check
cargo test
```

## Tips

- Debug mode serves on port **3081**, release builds on **3080** — the two never clash, so you can run an installed copy and a dev build side by side.