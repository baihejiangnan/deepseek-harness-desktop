# Development

DSH Launcher is a **Tauri 2 + React 19** app: launcher UI lives in `src/`, Rust in `src-tauri/`; instance windows load native DSH Web. Start with [AGENTS.md](../AGENTS.md), [architecture](ARCHITECTURE.md), and [IPC contracts](IPC_CONTRACTS.md). [中文](DEVELOPMENT.zh.md).

## Requirements

| Tool | Version |
| --- | --- |
| Node.js | Prefer 22.22.x, matching the managed runtime; check locked dependency engines when upgrading |
| Rust | Stable toolchain compatible with Cargo.lock; no verified minimum Rust version is declared |
| pnpm | 10.x for development, matching CI; distinct from plugin-runtime pnpm |

Plus the platform toolchain:

- **Windows** — MSVC build tools + WebView2
- **macOS** — Xcode Command Line Tools
- **Linux** — WebKit2GTK

## Commands

```bash
pnpm install      # install dependencies
pnpm dev          # frontend dev server (Vite)
pnpm typecheck    # frontend TypeScript check
pnpm lint         # whole-repository lint; prefer scoped ESLint in a dirty checkout
pnpm build        # TypeScript + production Vite build
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

## Taking over and running locally

Inspect branch, HEAD, working tree and overlapping diffs first. Preserve unrelated changes; exclude instance Homes, credentials, sessions and unrelated AppData from general searches.

`pnpm tauri dev` starts the frontend server. Do not start a second Vite on 1420. Before stopping old processes, verify their command lines belong to this checkout; stop the parent, then inspect remaining children and listeners. Never terminate all Node processes. A client's SYN_SENT state does not indicate a listening server.

Frontend changes support hot reload. Rust commands, processes, windows, tray and installer changes require recompilation and a Tauri restart before manual verification.

## Verification by change

| Change | Minimum checks |
| --- | --- |
| Documentation only | Local links, commands/fields against source, git diff --check |
| Frontend | pnpm typecheck and ESLint on changed files |
| Shared layout or build configuration | Also pnpm build and relevant manual UI checks |
| Rust | cargo check and affected module tests |
| High-risk cross-module behavior | cargo test plus lifecycle/data regression checks |

Run frontend commands at the root and Cargo commands in src-tauri:

```bash
pnpm exec eslint src/components/instance-manager.tsx src/store/modules/launcher/store.ts
git diff --check
git diff --stat
```

Run the targeted backend test from src-tauri:

```bash
cargo test service::download::core::tests
cargo test config::instance::tests
cargo test service::plugin::install::tests
```

Format only changed Rust files. Do not rewrite unrelated files to resolve existing format differences. Report environment, passed checks and coverage gaps; compilation is not a clean-machine or cross-platform runtime test.

## Manual regression checklist

- First run: isolated test environment with missing and existing runtimes, network interruption, digest/extraction failures and immediate retry. Never delete real user Homes or runtimes to simulate these cases.
- Instances: independent Homes run together; shared Homes cannot. Verify separate windows/taskbar entries, independent close, minimize after success and visible failure.
- Plugins: target Profile, per-item progress, cancellation/process tree, log copying and truncation disclosure; manual install rejects local-path specs; polluted pnpm output never writes invalid `allowBuilds` keys.
- Data: temporary Homes for registry-only removal, shared-Home deletion impact, export outside Home, backup and error handling; deletion is refused while a DSH process left over from a previous launcher session still holds the Home; restarting the launcher does not delete the `.harness.pid` of a process that is still alive (the startup sweep clears the marker only once that process is confirmed dead, otherwise the guard loses its evidence); a corrupt `instances.json` recovers from `.bak`; one unusable Home record does not break loading the rest.
- Updates: stop affected instances, recover failed replacement, preserve Homes, credentials and sessions.
- Collaboration: dependency order, real outputs, explicit instance binding, failed contract writes, partial startup, cancellation and main-agent session retention.
- UI: themes, narrow windows, both languages, disabled/error/empty states, keyboard and reduced motion; see [design rules](DESIGN.md).

## Documentation and release

Track outstanding work in [TODO](../TODO.md). Keep durable specifications in project docs; do not commit temporary logs, screenshots, instance data or build caches by default. Stage explicit paths and inspect the staged diff.

Follow [RELEASING.md](RELEASING.md) separately. Source push, tag, build and asset publication are distinct checkpoints. Documentation changes alone do not require a version bump or release.
