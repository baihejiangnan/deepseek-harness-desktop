//! 社区插件目录：从 awesome-dsh-plugin.com 获取精选目录。
//!
//! 目录只用于发现与来源校验，不写入本地资源目录，也不作为离线快照保存。

use reqwest::header::USER_AGENT;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;

const REGISTRY_URL: &str = "https://awesome-dsh-plugin.com/plugins.json";
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PLUGINS: usize = 5000;

struct CatalogCache {
    value: PluginCatalog,
    fetched_at: std::time::Instant,
}

static CACHE: OnceLock<Mutex<Option<CatalogCache>>> = OnceLock::new();

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

/// 读取当前社区目录；失败时返回可直接展示的错误。
pub async fn fetch() -> Result<PluginCatalog, String> {
    fetch_with_cache(false).await
}

/// 强制刷新社区目录缓存。
pub async fn refresh() -> Result<PluginCatalog, String> {
    fetch_with_cache(true).await
}

async fn fetch_with_cache(force: bool) -> Result<PluginCatalog, String> {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut state = cache.lock().await;
    if !force {
        if let Some(entry) = state.as_ref() {
            if entry.fetched_at.elapsed() < CACHE_TTL {
                return Ok(entry.value.clone());
            }
        }
    }

    let catalog = fetch_remote().await?;
    *state = Some(CatalogCache {
        value: catalog.clone(),
        fetched_at: std::time::Instant::now(),
    });
    Ok(catalog)
}

async fn fetch_remote() -> Result<PluginCatalog, String> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("PLUGIN_CATALOG_CLIENT: {error}"))?;
    let response = client
        .get(REGISTRY_URL)
        .header(USER_AGENT, "deepseek-harness-desktop-plugin-catalog")
        .send()
        .await
        .map_err(|error| format!("PLUGIN_CATALOG_NETWORK: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("PLUGIN_CATALOG_HTTP: {}", response.status()));
    }
    let catalog = response
        .json::<PluginCatalog>()
        .await
        .map_err(|error| format!("PLUGIN_CATALOG_JSON: {error}"))?;
    validate_catalog(&catalog)?;
    Ok(catalog)
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
    use super::{install_spec, parse_install_command, CatalogPlugin};
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
}
