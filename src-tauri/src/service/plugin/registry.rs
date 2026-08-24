//! 社区插件目录：从用户选择的可信目录源获取插件列表。
//!
//! 目录只用于发现与来源校验，不写入本地资源目录，也不作为离线快照保存。

use reqwest::header::USER_AGENT;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;

pub const DEFAULT_SOURCE: &str = "awesome";
const AWESOME_REGISTRY_URL: &str = "https://awesome-dsh-plugin.com/plugins.json";
const DSHFIND_REGISTRY_URL: &str = "https://api.dshfind.com/v1/catalog";
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PLUGINS: usize = 15_000;

struct CatalogCache {
    value: PluginCatalog,
    fetched_at: std::time::Instant,
}

static CACHE: OnceLock<Mutex<HashMap<String, CatalogCache>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalog {
    pub updated: String,
    pub count: usize,
    pub categories: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    pub plugins: Vec<CatalogPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub name: String,
    pub owner: String,
    pub url: String,
    pub page: Option<String>,
    pub category: String,
    pub description: std::collections::HashMap<String, String>,
    pub npm: Option<String>,
    pub stars: Option<u64>,
    pub downloads: Option<u64>,
    pub install: String,
    pub added: String,
}

#[derive(Debug, Deserialize)]
struct DshFindCatalog {
    #[serde(default)]
    data: Vec<DshFindPlugin>,
    #[serde(default)]
    generated_at: String,
}

#[derive(Debug, Deserialize)]
struct DshFindPlugin {
    name: String,
    owner: String,
    repository_url: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    stars: u64,
    #[serde(default)]
    archived: bool,
    is_plugin: Option<bool>,
    #[serde(default)]
    first_seen_at: String,
    install: Option<DshFindInstall>,
}

#[derive(Debug, Deserialize)]
struct DshFindInstall {
    cmd: Option<String>,
    pkg_name: Option<String>,
}

/// 读取当前社区目录；失败时返回可直接展示的错误。
pub async fn fetch(source: &str) -> Result<PluginCatalog, String> {
    fetch_with_cache(source, false).await
}

/// 强制刷新社区目录缓存。
pub async fn refresh(source: &str) -> Result<PluginCatalog, String> {
    fetch_with_cache(source, true).await
}

async fn fetch_with_cache(source: &str, force: bool) -> Result<PluginCatalog, String> {
    validate_source(source)?;
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut state = cache.lock().await;
    if !force {
        if let Some(entry) = state.get(source) {
            if entry.fetched_at.elapsed() < CACHE_TTL {
                return Ok(entry.value.clone());
            }
        }
    }

    let catalog = fetch_remote(source).await?;
    state.insert(
        source.to_string(),
        CatalogCache {
            value: catalog.clone(),
            fetched_at: std::time::Instant::now(),
        },
    );
    Ok(catalog)
}

fn validate_source(source: &str) -> Result<(), String> {
    if matches!(source, DEFAULT_SOURCE | "dshfind") {
        Ok(())
    } else {
        Err(format!("PLUGIN_CATALOG_SOURCE_UNSUPPORTED: {source}"))
    }
}

async fn fetch_remote(source: &str) -> Result<PluginCatalog, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("PLUGIN_CATALOG_CLIENT: {error}"))?;
    let url = match source {
        DEFAULT_SOURCE => AWESOME_REGISTRY_URL,
        "dshfind" => DSHFIND_REGISTRY_URL,
        _ => return Err(format!("PLUGIN_CATALOG_SOURCE_UNSUPPORTED: {source}")),
    };
    let response = client
        .get(url)
        .header(USER_AGENT, "deepseek-harness-desktop-plugin-catalog")
        .send()
        .await
        .map_err(|error| format!("PLUGIN_CATALOG_NETWORK: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("PLUGIN_CATALOG_HTTP: {}", response.status()));
    }
    let catalog = if source == DEFAULT_SOURCE {
        response
            .json::<PluginCatalog>()
            .await
            .map_err(|error| format!("PLUGIN_CATALOG_JSON: {error}"))?
    } else {
        let value = response
            .json::<DshFindCatalog>()
            .await
            .map_err(|error| format!("PLUGIN_CATALOG_JSON: {error}"))?;
        map_dshfind_catalog(value)
    };
    validate_catalog(&catalog)?;
    Ok(catalog)
}

fn map_dshfind_catalog(value: DshFindCatalog) -> PluginCatalog {
    let mut categories = HashMap::new();
    let plugins = value
        .data
        .into_iter()
        .filter(|plugin| !plugin.archived && plugin.is_plugin != Some(false))
        .filter_map(|plugin| {
            let install = plugin.install?;
            let command = install.cmd.unwrap_or_default();
            let npm = install.pkg_name.filter(|name| !name.trim().is_empty());
            if npm.is_none() && parse_install_command(&command).is_none() {
                return None;
            }
            let category = if plugin.category.trim().is_empty() {
                "other".to_string()
            } else {
                plugin.category.trim().to_string()
            };
            categories.entry(category.clone()).or_insert_with(|| {
                HashMap::from([
                    ("zh".to_string(), category.clone()),
                    ("en".to_string(), category.clone()),
                ])
            });
            let description = HashMap::from([
                ("zh".to_string(), plugin.description.clone()),
                ("en".to_string(), plugin.description),
            ]);
            Some(CatalogPlugin {
                name: plugin.name,
                owner: plugin.owner,
                url: plugin.repository_url,
                page: None,
                category,
                description,
                npm,
                stars: Some(plugin.stars),
                downloads: None,
                install: command,
                added: plugin.first_seen_at,
            })
        })
        .collect::<Vec<_>>();
    PluginCatalog {
        updated: value.generated_at,
        count: plugins.len(),
        categories,
        plugins,
    }
}

/// 根据目录条目的唯一名称解析可安装的 npm/Git 规格。
pub fn install_spec(plugin: &CatalogPlugin) -> Result<String, String> {
    let spec = plugin
        .npm
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .map(ToOwned::to_owned)
        .or_else(|| parse_install_command(&plugin.install))
        .ok_or_else(|| {
            format!(
                "PLUGIN_CATALOG_SPEC: no supported source for {}",
                plugin.name
            )
        })?;
    validate_spec(&spec)?;
    Ok(spec)
}

fn validate_catalog(catalog: &PluginCatalog) -> Result<(), String> {
    if catalog.plugins.is_empty() {
        return Err("PLUGIN_CATALOG_EMPTY: community catalog contains no plugins".to_string());
    }
    if catalog.plugins.len() > MAX_PLUGINS {
        return Err(
            "PLUGIN_CATALOG_TOO_LARGE: community catalog is unexpectedly large".to_string(),
        );
    }
    for plugin in &catalog.plugins {
        if plugin.name.trim().is_empty() || plugin.url.trim().is_empty() {
            return Err(
                "PLUGIN_CATALOG_INVALID: catalog entry is missing name or repository".to_string(),
            );
        }
        install_spec(plugin)?;
    }
    Ok(())
}

fn parse_install_command(command: &str) -> Option<String> {
    let mut parts = command.split_whitespace();
    if parts.next()? != "dsh" || parts.next()? != "plugin" || parts.next()? != "--profile" {
        return None;
    }
    let _profile = parts.next()?;
    if parts.next()? != "add" {
        return None;
    }
    let spec = parts.next()?.to_string();
    if parts.next().is_some() {
        return None;
    }
    Some(spec)
}

fn validate_spec(spec: &str) -> Result<(), String> {
    if spec.is_empty()
        || spec.len() > 512
        || spec.starts_with('-')
        || spec.chars().any(char::is_control)
    {
        return Err("PLUGIN_CATALOG_INVALID_SPEC: catalog source is invalid".to_string());
    }
    if spec.starts_with("file:") || spec.starts_with("link:") || spec.contains('\\') {
        return Err("PLUGIN_CATALOG_UNSUPPORTED_SPEC: local paths are not allowed from the community catalog".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        install_spec, map_dshfind_catalog, parse_install_command, CatalogPlugin, DshFindCatalog,
        DshFindInstall, DshFindPlugin,
    };
    use std::collections::HashMap;

    fn plugin(install: &str, npm: Option<&str>) -> CatalogPlugin {
        CatalogPlugin {
            name: "example".to_string(),
            owner: "owner".to_string(),
            url: "https://github.com/owner/example".to_string(),
            page: None,
            category: "ui".to_string(),
            description: HashMap::new(),
            npm: npm.map(ToOwned::to_owned),
            stars: None,
            downloads: None,
            install: install.to_string(),
            added: "2026-01-01".to_string(),
        }
    }

    #[test]
    fn parses_dsh_install_command() {
        assert_eq!(
            parse_install_command("dsh plugin --profile web add github:owner/repo").as_deref(),
            Some("github:owner/repo")
        );
    }

    #[test]
    fn prefers_npm_source() {
        assert_eq!(
            install_spec(&plugin(
                "dsh plugin --profile web add github:owner/repo",
                Some("example")
            ))
            .unwrap(),
            "example"
        );
    }

    #[test]
    fn maps_only_installable_dshfind_entries() {
        let catalog = map_dshfind_catalog(DshFindCatalog {
            generated_at: "2026-08-24T00:00:00Z".to_string(),
            data: vec![
                DshFindPlugin {
                    name: "ready".to_string(),
                    owner: "owner".to_string(),
                    repository_url: "https://github.com/owner/ready".to_string(),
                    description: "Ready".to_string(),
                    category: "tools".to_string(),
                    stars: 10,
                    archived: false,
                    is_plugin: Some(true),
                    first_seen_at: "2026-08-01".to_string(),
                    install: Some(DshFindInstall {
                        cmd: Some("dsh plugin --profile web add github:owner/ready".to_string()),
                        pkg_name: None,
                    }),
                },
                DshFindPlugin {
                    name: "not-a-plugin".to_string(),
                    owner: "owner".to_string(),
                    repository_url: "https://github.com/owner/not-a-plugin".to_string(),
                    description: String::new(),
                    category: String::new(),
                    stars: 0,
                    archived: false,
                    is_plugin: Some(false),
                    first_seen_at: String::new(),
                    install: Some(DshFindInstall {
                        cmd: Some(
                            "dsh plugin --profile web add github:owner/not-a-plugin".to_string(),
                        ),
                        pkg_name: None,
                    }),
                },
            ],
        });
        assert_eq!(catalog.count, 1);
        assert_eq!(catalog.plugins[0].name, "ready");
        assert!(catalog.categories.contains_key("tools"));
    }
}
