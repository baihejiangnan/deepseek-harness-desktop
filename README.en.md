# DeepSeek Harness Desktop

An independently maintained DSH Launcher desktop application for instance management, plugins, plugin packs, runtime updates, and native windows.

## Overview

The launcher manages lifecycle and local runtime integration. Each DSH instance has its own process, window, taskbar entry, port, `DSH_HOME`, and Profile. The wrapper integrates with DSH for process and environment management while DSH core, native Web logic, sessions, keys, agent presets, and plugins remain decoupled.

## Features

- Isolated multi-instance start, stop, restart, close, export, and removal;
- Community plugin catalog, plugin packs, npm, Git, and local package specs;
- Background installation with explicit cancellation;
- Runtime installation and updates that preserve instance data;
- Local-only keys, sessions, Profiles, DSH Homes, logs, and settings.

## Download

Windows users should download the `x64-setup.exe` installer from GitHub Releases. Windows x64 is the primary build target; macOS and Linux bundles require native build environments.

## Architecture

```text
DeepSeek Harness Desktop
├─ Launcher: registry, lifecycle, plugins, runtime, IPC
├─ Instance hosts × N: window, port, DSH_HOME, Profile, DSH Web
├─ Tauri 2: React/Vite, Rust commands, platform integration
└─ Local data: keys, sessions, plugins, logs, exports, caches
```

## Privacy

Keys, tokens, passwords, sessions, DSH Homes, Profiles, logs, caches, and local settings are never part of the repository or release assets. Build directories such as `dist`, `src-tauri/target`, and `node_modules` are ignored.

## Screenshots

Browse [`docs/images/preview/`](./docs/images/preview/) for the complete collection.

<p align="center"><img src="./docs/images/preview/plugin-pack-download.png" width="48%" alt="Plugin pack download" /><img src="./docs/images/preview/plugin-management.png" width="48%" alt="Plugin management" /></p>
<p align="center"><img src="./docs/images/preview/theme-options.png" width="48%" alt="Theme options" /></p>

## Development

```bash
pnpm install
pnpm tauri dev
pnpm tauri build --bundles nsis
```

## License

[MIT License](./LICENSE) with additional terms in [LICENSE.details](./LICENSE.details).
