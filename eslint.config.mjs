// ESLint 扁平配置：基于 @antfu/eslint-config 预设
// 项目为 React + TypeScript + Vite 应用，显式开启 React 支持
// （React 插件依赖 @eslint-react/eslint-plugin 与 eslint-plugin-react-refresh）
import antfu from '@antfu/eslint-config'

export default antfu({
  react: true,
  ignores: [
    'AGENTS.md',
    // src-tauri 下的 .mjs 是经 `include_str!` 编进二进制、以所选 DSH 包目录为 cwd 用 Node 跑的
    // 内嵌脚本，通篇带分号是有意写法，与 antfu 预设整体冲突（HEAD 上即有数百条 style/semi）。
    // 它们不是没有覆盖 —— 由 `pnpm test:provider` 跑单元与集成用例，只是不走前端 lint 通道。
    'src-tauri/**',
    // `.mimosa/` 是会话工具往仓库根写的状态文件（未跟踪、单行 JSON），
    // 报出来的全是 jsonc/style 噪音，与本项目无关。大概也该顺手进 .gitignore。
    '.mimosa/**',
  ],
})
