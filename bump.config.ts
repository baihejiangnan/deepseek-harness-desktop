import { readFile, writeFile } from 'node:fs/promises'
import { defineConfig } from 'bumpp'

export default defineConfig({
  release: 'prompt',
  async execute() {
    const { version } = JSON.parse(await readFile('package.json', 'utf8'))
    for (const path of ['README.md', 'README.en.md']) {
      const content = await readFile(path, 'utf8')
      const updated = content.replace(/(DSH[.-]Launcher_)\d+\.\d+\.\d+(?:-[\w.-]+)?(_(?:windows_x64_portable|x64-setup)\.exe)/g, `$1${version}$2`)
      await writeFile(path, updated)
    }
  },
  files: [
    'package.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    // README 徽章与 Release 下载链接的版本必须与 tag 同步，否则每次发版都会漂移
    'README.md',
    'README.en.md',
  ],
})
