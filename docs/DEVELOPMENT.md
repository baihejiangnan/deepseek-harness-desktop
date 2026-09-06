# Development

DeepSeek Harness Desktop is a **Tauri 2 + React 19** app: the UI lives in `src/`, the Rust backend in `src-tauri/`.

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | 20.19+ or 22.12+ (Vite 7 engines) |
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

- The default starting port is **3080** for release builds and **3081** for debug. Startup probes for an available port; the instance runtime status shows the actual listening port.
- The frontend dev server is Vite on **1420** (`vite.config.ts`, `tauri.conf.json` → `devUrl`), with HMR on **1421** when `TAURI_DEV_HOST` is set.
