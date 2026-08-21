//! 插件安装与运行时监控。
//!
//! 安装通过 `dsh plugin --profile tauri add <pkg>` 完成：该子命令是 pnpm 转发器，
//! 会在 `$DSH_HOME/profiles/tauri` 初始化 profile 并执行 `pnpm add`，随后把声明了
//! `dsh.bundle` 的依赖写入 profile 的 bundles 层，使插件在下次启动时加载。
//! 进程输出逐行通过 `plugin-install-log` 事件实时推送给前端日志面板。
//! 调用 dsh 前会先按需补齐捆绑 pnpm（老版本升级后可能缺失，安装流程内自愈）。
//!
//! 模块划分（参考 `service/cli/`、`service/download/`）：
//! - [`installed`]：profile 内已安装插件检测（解析 package.json 的依赖与 bundles）
//! - [`install`]：对外安装编排（校验选中项、环境准备、调用 dsh 子进程）
//! - [`process`]：dsh 子进程启动与输出流逐行转发
//! - [`cancel`]：Windows 下取消正在进行的安装
//! - [`watch`]：已安装插件文件监控（轮询指纹比对 + `dsh-plugins-updated` 事件推送）

mod cancel;
pub(crate) mod install;
mod installed;
pub mod pack;
mod process;
pub mod registry;
pub mod watch;

pub use cancel::{cancel, reset as reset_cancel, was_requested as install_was_cancelled};
pub use install::{install, remove};
pub use watch::DshPlugin;
