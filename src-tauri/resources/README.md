# Resources

This directory is bundled into the installer as `resources/**`.

At runtime, the application downloads everything it needs into the OS user-data
directory (the Tauri app-data dir for identifier
`io.github.baihejiangnan.dsh-launcher`, e.g. `%APPDATA%/io.github.baihejiangnan.dsh-launcher/` on Windows):

- `runtime/` — the bundled Node.js runtime (downloaded on first run)
- `dependencies/dsh/` — the packaged DeepSeek Harness distribution (downloaded from the
  `hairyf/deepseek-harness-pkg` release feed)
- instance homes — each registered instance uses its explicitly configured `DSH_HOME`
- `logs/` — application and `dsh` service logs
- `.store.dat` — desktop settings (port, auto-start, language, etc.)

No manual Node.js or pnpm installation is required.

## Plugin installation

The launcher does not ship a hard-coded plugin catalog. The Download view reads
the user-selected community source and accepts validated npm, `github:`, and
trusted HTTP(S) archive specs. Local paths are rejected. Packages are installed
into the selected instance Profile; existing Profile dependencies are discovered
from `package.json` and are never removed implicitly.
