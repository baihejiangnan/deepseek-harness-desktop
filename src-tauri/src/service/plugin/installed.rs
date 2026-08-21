//! 已安装插件检测共享结构：强类型解析 Profile 的 `package.json`。

use crate::config;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

/// 用于强类型解析 profile 下 package.json 的辅助结构
/// （字段 pub(crate)：供 watch 模块解析已安装插件清单复用）
#[derive(Deserialize)]
pub(crate) struct ProfilePackageJson {
    #[serde(default)]
    pub(crate) dependencies: HashMap<String, String>,
    #[serde(default)]
    pub(crate) dsh: Option<ProfileDshSection>,
}

#[derive(Deserialize)]
pub(crate) struct ProfileDshSection {
    #[serde(default)]
    pub(crate) profile: Option<ProfileInner>,
}

#[derive(Deserialize)]
pub(crate) struct ProfileInner {
    #[serde(default)]
    pub(crate) bundles: Vec<String>,
}

/// 当前 profile 所在目录。
pub(crate) fn profile_dir(app_handle: &AppHandle) -> PathBuf {
    config::get_dsh_data_path(app_handle)
        .join("profiles")
        .join(config::get_active_profile())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn list_installed_parses_manifest() {
        let dir = std::env::temp_dir().join(format!("dsh-plugin-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest_json = serde_json::json!({
            "name": "dsh-profile-tauri",
            "private": true,
            "dependencies": {
                "dshmarket": "1.0.0",
                "@deepseek-ai/dsh-base": "1.0.0"
            },
            "dsh": {
                "profile": {
                    "bundles": ["@deepseek-ai/dsh-base", "dshmarket"]
                }
            }
        });
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_string(&manifest_json).unwrap(),
        )
        .unwrap();

        let content = std::fs::read_to_string(dir.join("package.json")).unwrap();
        let parsed: ProfilePackageJson = serde_json::from_str(&content).unwrap();

        let mut set: HashSet<String> = parsed.dependencies.into_keys().collect();
        if let Some(dsh) = parsed.dsh {
            if let Some(profile) = dsh.profile {
                set.extend(profile.bundles);
            }
        }

        assert!(set.contains("dshmarket"));
        assert!(set.contains("@deepseek-ai/dsh-base"));
        assert_eq!(set.len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }
}
