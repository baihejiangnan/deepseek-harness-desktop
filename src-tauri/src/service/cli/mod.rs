//! 命令行集成：安装后在用户 PATH 中注册 `dsh` / `pnpm` 命令。
//!
//! `dsh` 与捆绑的 `pnpm` 都是 Node 脚本（`lib/bin.js` / `bin/pnpm.cjs`），并非原生
//! 可执行文件，因此生成包装脚本（shim）并注册到用户 PATH：
//!
//! - Windows：`%LOCALAPPDATA%\deepseek-harness\bin\dsh.cmd` / `dsh.ps1` 与
//!   `pnpm.cmd` / `pnpm.ps1`，通过 `HKCU\Environment\Path` 注册并广播
//!   `WM_SETTINGCHANGE`；
//! - macOS/Linux：`~/.local/bin/dsh` 与 `~/.local/bin/pnpm`，必要时向
//!   `~/.zshrc` / `~/.bashrc` 幂等追加 PATH 导出（带标记块，可干净移除）。
//!
//! shim 运行时优先使用本地版本兼容的 node（校验规则与
//! [`crate::config::is_supported_node_version`] 一致），否则回退到捆绑运行时；
//! `pnpm` shim 还额外优先转发用户自己安装的 pnpm（PATH 中排除本 shim 目录）。
//! shim 不重定向 stdin/stdout、不修改工作目录，保证交互式命令可用，
//! 并透传全部参数与退出码。
//!
//! 模块划分（参考 `service/download/`）：
//! - [`shim`]：shim 脚本内容生成与落盘
//! - [`path`]：bin 目录定位、PATH 注册（注册表 / shell rc）、用户 pnpm 探测
//! - [`core`]：对外接口（状态 / 启用 / 清理）

mod core;
mod path;
mod shim;

pub use core::{ensure, ensure_shims, get_status, remove, CliLinkStatus};
pub use path::{find_user_pnpm, get_bin_dir};
