# Resources

This directory is bundled into the installer as `resources/**`.

At runtime, the application downloads everything it needs into the OS user-data
directory (the Tauri app-data dir for identifier
`io.github.hairyf.deepseek-harness-desktop`, e.g. `%APPDATA%/io.github.hairyf.deepseek-harness-desktop/` on Windows):

- `runtime/` — the bundled Node.js runtime (downloaded on first run)
- `dependencies/dsh/` — the packaged DeepSeek Harness distribution (downloaded from the
  `hairyf/deepseek-harness-pkg` release feed)
- `data/dsh/` — the isolated `$DSH_HOME` used by the running `dsh` process
- `logs/` — application and `dsh` service logs
- `.store.dat` — desktop settings (port, auto-start, language, etc.)

No manual Node.js or pnpm installation is required.

## Plugin installation

The launcher does not ship or read a local plugin catalog. The Download view
accepts npm, Git, or local package specs and installs them into the selected
instance Profile. Existing Profile dependencies are discovered directly from
their `package.json` and are never removed by the launcher.
