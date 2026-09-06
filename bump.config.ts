import { defineConfig } from 'bumpp'

export default defineConfig({
  release: 'prompt',
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
