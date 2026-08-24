//! DSH 插件包市场：读取市场索引、解析插件包清单并生成安装计划。
//!
//! 插件包只属于启动器侧的分发描述。解析完成后仍然交给现有的 DSH
//! `plugin add` 安装流程，实例宿主和原生 DSH Web 不感知插件包这个概念。

use super::watch::DshPlugin;
use reqwest::header::USER_AGENT;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;

const MARKET_INDEX_URL: &str =
    "https://raw.githubusercontent.com/baihejiangnan/dsh-plugin-pack/main/market/index.json";
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PACKS: usize = 500;
const MAX_PLUGINS_PER_PACK: usize = 500;

struct CatalogCache {
    value: PluginPackCatalog,
    fetched_at: std::time::Instant,
}

static CACHE: OnceLock<Mutex<Option<CatalogCache>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackCatalog {
    pub schema_version: u32,
    pub packs: Vec<PluginPackListing>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackListing {
    pub id: String,
    pub name: String,
    pub description: String,
    pub repository: String,
    #[serde(default)]
    pub topics: Vec<String>,
    pub format: String,
    pub source_file: String,
    pub source_url: String,
    /// Profile used by the publisher's source commands; informational only.
    pub profile: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackDetail {
    pub listing: PluginPackListing,
    pub version: Option<String>,
    pub license: Option<String>,
    pub plugins: Vec<PluginPackPlugin>,
    /// Profile used by the publisher's source commands; installation targets use the active instance.
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackPlugin {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub spec: String,
    pub repository: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub requires: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackInstallResult {
    pub pack_id: String,
    pub requested: usize,
    pub installed: usize,
    pub skipped: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonPackManifest {
    schema_version: u32,
    id: String,
    version: Option<String>,
    license: Option<String>,
    #[serde(default)]
    plugins: Vec<JsonPackPlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonPackPlugin {
    id: String,
    name: String,
    kind: String,
    spec: String,
    repository: Option<String>,
    description: Option<String>,
    #[serde(default)]
    requires: Vec<String>,
}

/// 读取插件包市场；普通请求复用 15 分钟缓存。
pub async fn fetch_catalog() -> Result<PluginPackCatalog, String> {
    fetch_catalog_with_cache(false).await
}

/// 强制刷新插件包市场。
pub async fn refresh_catalog() -> Result<PluginPackCatalog, String> {
    fetch_catalog_with_cache(true).await
}

async fn fetch_catalog_with_cache(force: bool) -> Result<PluginPackCatalog, String> {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut state = cache.lock().await;
    if !force {
        if let Some(entry) = state.as_ref() {
            if entry.fetched_at.elapsed() < CACHE_TTL {
                return Ok(entry.value.clone());
            }
        }
    }

    let catalog = fetch_catalog_remote().await?;
    *state = Some(CatalogCache {
        value: catalog.clone(),
        fetched_at: std::time::Instant::now(),
    });
    Ok(catalog)
}

async fn fetch_catalog_remote() -> Result<PluginPackCatalog, String> {
    let content = fetch_text(MARKET_INDEX_URL, "PLUGIN_PACK_MARKET").await?;
    let mut catalog = serde_json::from_str::<PluginPackCatalog>(&content)
        .map_err(|error| format!("PLUGIN_PACK_MARKET_JSON: {error}"))?;
    let featured = featured_packs();
    catalog.packs.retain(|pack| {
        !featured.iter().any(|item| {
            item.id == pack.id || item.repository.eq_ignore_ascii_case(&pack.repository)
        })
    });
    catalog.packs.splice(0..0, featured);
    validate_catalog(&catalog)?;
    Ok(catalog)
}

/// 读取并解析市场中的指定插件包。
pub async fn fetch_detail(pack_id: &str) -> Result<PluginPackDetail, String> {
    if !valid_id(pack_id) {
        return Err("PLUGIN_PACK_INVALID_ID: pack id is invalid".to_string());
    }
    if let Some(detail) = featured_pack_detail(pack_id) {
        validate_detail(&detail)?;
        return Ok(detail);
    }
    let catalog = fetch_catalog().await?;
    let listing = catalog
        .packs
        .into_iter()
        .find(|pack| pack.id == pack_id)
        .ok_or_else(|| format!("PLUGIN_PACK_NOT_FOUND: {pack_id}"))?;
    let content = fetch_text(&listing.source_url, "PLUGIN_PACK_SOURCE").await?;
    let detail = match listing.format.as_str() {
        "json-manifest" => parse_json_manifest(listing, &content)?,
        "readme-command-list" => parse_readme_manifest(listing, &content)?,
        _ => {
            return Err("PLUGIN_PACK_UNSUPPORTED_FORMAT: pack format is not supported".to_string())
        }
    };
    validate_detail(&detail)?;
    Ok(detail)
}

/// 启动器明确置顶的社区全家桶。它们仍按单个 DSH 插件规格安装，不是模板或
/// 启动器私有安装器；顺序必须保持在远程市场条目之前。
fn featured_packs() -> Vec<PluginPackListing> {
    vec![
        PluginPackListing {
            id: "featured-dsh-web-ui".to_string(),
            name: "dsh-web-ui 全家桶".to_string(),
            description: "DSH Web UI 插件与皮肤生态聚合包，可按需启停各功能插件。".to_string(),
            repository: "https://github.com/zhu1090093659/dsh-web".to_string(),
            topics: vec!["dsh-plugin-pack".to_string()],
            format: "json-manifest".to_string(),
            source_file: "package.json".to_string(),
            source_url: "https://raw.githubusercontent.com/zhu1090093659/dsh-web/main/package.json"
                .to_string(),
            profile: Some("web".to_string()),
            source: Some("featured-community".to_string()),
        },
        PluginPackListing {
            id: "featured-dsh-webui".to_string(),
            name: "dsh-webui 会话增强全家桶".to_string(),
            description: "会话、技能、记忆、浏览器、自动化、文件与用量等能力的单插件全家桶。"
                .to_string(),
            repository: "https://github.com/statem-li/dsh-webui".to_string(),
            topics: vec!["dsh-plugin-pack".to_string()],
            format: "json-manifest".to_string(),
            source_file: "package.json".to_string(),
            source_url: "https://raw.githubusercontent.com/statem-li/dsh-webui/main/package.json"
                .to_string(),
            profile: Some("web".to_string()),
            source: Some("featured-community".to_string()),
        },
    ]
}

fn featured_pack_detail(pack_id: &str) -> Option<PluginPackDetail> {
    let listing = featured_packs()
        .into_iter()
        .find(|pack| pack.id == pack_id)?;
    let (version, license, plugin) = match pack_id {
        "featured-dsh-web-ui" => (
            None,
            Some("Apache-2.0".to_string()),
            PluginPackPlugin {
                id: "dsh-web-ui-all".to_string(),
                name: "@linxin666/dsh-web-ui-all".to_string(),
                kind: "plugin".to_string(),
                spec: "@linxin666/dsh-web-ui-all@latest".to_string(),
                repository: Some(listing.repository.clone()),
                description: Some("DSH Web UI 功能插件与皮肤聚合包".to_string()),
                requires: Vec::new(),
            },
        ),
        "featured-dsh-webui" => (
            None,
            Some("BSD-3-Clause".to_string()),
            PluginPackPlugin {
                id: "dsh-webui".to_string(),
                name: "dsh-webui".to_string(),
                kind: "plugin".to_string(),
                spec: "github:statem-li/dsh-webui".to_string(),
                repository: Some(listing.repository.clone()),
                description: Some("DeepSeek Harness 会话增强全家桶".to_string()),
                requires: Vec::new(),
            },
        ),
        _ => return None,
    };
    Some(PluginPackDetail {
        listing,
        version,
        license,
        plugins: vec![plugin],
        profile: Some("web".to_string()),
    })
}

/// 按插件包声明的 requires 关系生成稳定安装顺序。
pub fn ordered_plugins(detail: &PluginPackDetail) -> Result<Vec<PluginPackPlugin>, String> {
    let by_id: HashMap<&str, &PluginPackPlugin> = detail
        .plugins
        .iter()
        .map(|plugin| (plugin.id.as_str(), plugin))
        .collect();
    let mut state = HashMap::<String, u8>::new();
    let mut ordered = Vec::with_capacity(detail.plugins.len());

    for plugin in &detail.plugins {
        visit_plugin(plugin, &by_id, &mut state, &mut ordered)?;
    }
    Ok(ordered)
}

/// 根据目标 Profile 已安装的直接依赖，过滤出真正需要安装的插件。
pub fn missing_plugins(
    detail: &PluginPackDetail,
    installed: &[DshPlugin],
) -> Result<Vec<PluginPackPlugin>, String> {
    let installed_names: HashSet<String> = installed
        .iter()
        .flat_map(|plugin| {
            [
                plugin.id.to_ascii_lowercase(),
                plugin.name.to_ascii_lowercase(),
            ]
        })
        .collect();
    Ok(ordered_plugins(detail)?
        .into_iter()
        .filter(|plugin| {
            let candidates = [
                plugin.id.to_ascii_lowercase(),
                plugin.name.to_ascii_lowercase(),
                spec_package_name(&plugin.spec).unwrap_or_default(),
            ];
            !candidates
                .iter()
                .any(|candidate| installed_names.contains(candidate))
        })
        .collect())
}

/// 校验插件包声明的 Profile 与目标实例是否兼容。
fn parse_json_manifest(
    listing: PluginPackListing,
    content: &str,
) -> Result<PluginPackDetail, String> {
    let manifest = serde_json::from_str::<JsonPackManifest>(content)
        .map_err(|error| format!("PLUGIN_PACK_MANIFEST_JSON: {error}"))?;
    if manifest.schema_version != 1 {
        return Err("PLUGIN_PACK_SCHEMA_UNSUPPORTED: schemaVersion must be 1".to_string());
    }
    if manifest.id != listing.id {
        return Err("PLUGIN_PACK_ID_MISMATCH: manifest id does not match market entry".to_string());
    }
    Ok(PluginPackDetail {
        profile: listing.profile.clone(),
        listing,
        version: manifest.version,
        license: manifest.license,
        plugins: manifest
            .plugins
            .into_iter()
            .map(|plugin| PluginPackPlugin {
                id: plugin.id,
                name: plugin.name,
                kind: plugin.kind,
                spec: plugin.spec,
                repository: plugin.repository,
                description: plugin.description,
                requires: plugin.requires,
            })
            .collect(),
    })
}

fn parse_readme_manifest(
    listing: PluginPackListing,
    content: &str,
) -> Result<PluginPackDetail, String> {
    let mut plugins = Vec::new();
    let mut seen_specs = HashSet::new();
    let mut command_profile = None::<String>;
    for line in content.lines() {
        let Some(tokens) = tokenize_command(line.trim()) else {
            continue;
        };
        if tokens.len() != 6
            || tokens[0] != "dsh"
            || tokens[1] != "plugin"
            || tokens[2] != "--profile"
            || tokens[4] != "add"
        {
            continue;
        }
        let profile = &tokens[3];
        if !valid_profile(profile) {
            return Err("PLUGIN_PACK_PROFILE_INVALID: README profile is invalid".to_string());
        }
        if let Some(declared) = listing.profile.as_deref() {
            if declared != profile {
                return Err(
                    "PLUGIN_PACK_PROFILE_MISMATCH: market profile differs from README".to_string(),
                );
            }
        }
        if let Some(previous) = command_profile.as_deref() {
            if previous != profile {
                return Err(
                    "PLUGIN_PACK_PROFILE_MIXED: README contains multiple Profiles".to_string(),
                );
            }
        } else {
            command_profile = Some(profile.clone());
        }
        let spec = tokens[5].clone();
        validate_spec(&spec)?;
        if !seen_specs.insert(spec.clone()) {
            continue;
        }
        let index = plugins.len() + 1;
        let name = spec_package_name(&spec).unwrap_or_else(|| format!("plugin-{index}"));
        plugins.push(PluginPackPlugin {
            id: format!("readme-{index}"),
            name,
            kind: "plugin".to_string(),
            spec,
            repository: None,
            description: None,
            requires: Vec::new(),
        });
    }

    if plugins.is_empty() {
        return Err("PLUGIN_PACK_EMPTY: README contains no supported add commands".to_string());
    }
    Ok(PluginPackDetail {
        profile: listing.profile.clone().or(command_profile),
        listing,
        version: None,
        license: None,
        plugins,
    })
}

fn visit_plugin(
    plugin: &PluginPackPlugin,
    by_id: &HashMap<&str, &PluginPackPlugin>,
    state: &mut HashMap<String, u8>,
    ordered: &mut Vec<PluginPackPlugin>,
) -> Result<(), String> {
    match state.get(&plugin.id).copied() {
        Some(2) => return Ok(()),
        Some(1) => return Err(format!("PLUGIN_PACK_DEPENDENCY_CYCLE: {}", plugin.id)),
        _ => {}
    }
    state.insert(plugin.id.clone(), 1);
    for dependency in &plugin.requires {
        let dependency = by_id.get(dependency.as_str()).ok_or_else(|| {
            format!(
                "PLUGIN_PACK_DEPENDENCY_MISSING: {} requires {dependency}",
                plugin.id
            )
        })?;
        visit_plugin(dependency, by_id, state, ordered)?;
    }
    state.insert(plugin.id.clone(), 2);
    ordered.push(plugin.clone());
    Ok(())
}

fn validate_catalog(catalog: &PluginPackCatalog) -> Result<(), String> {
    if catalog.schema_version != 1 {
        return Err("PLUGIN_PACK_MARKET_SCHEMA: schemaVersion must be 1".to_string());
    }
    if catalog.packs.is_empty() {
        return Err("PLUGIN_PACK_MARKET_EMPTY: no plugin packs are published".to_string());
    }
    if catalog.packs.len() > MAX_PACKS {
        return Err("PLUGIN_PACK_MARKET_TOO_LARGE: too many plugin packs".to_string());
    }
    let mut ids = HashSet::new();
    for pack in &catalog.packs {
        if !valid_id(&pack.id) || !ids.insert(&pack.id) {
            return Err(format!("PLUGIN_PACK_MARKET_INVALID_ID: {}", pack.id));
        }
        if pack.name.trim().is_empty() || pack.description.trim().is_empty() {
            return Err(format!("PLUGIN_PACK_MARKET_INVALID: {}", pack.id));
        }
        if !pack.repository.starts_with("https://github.com/") {
            return Err(format!("PLUGIN_PACK_MARKET_REPOSITORY: {}", pack.id));
        }
        if !pack.topics.iter().any(|topic| topic == "dsh-plugin-pack") {
            return Err(format!("PLUGIN_PACK_MARKET_TOPIC: {}", pack.id));
        }
        if !matches!(
            pack.format.as_str(),
            "json-manifest" | "readme-command-list"
        ) {
            return Err(format!("PLUGIN_PACK_MARKET_FORMAT: {}", pack.id));
        }
        validate_source_url(&pack.source_url)?;
        if let Some(profile) = pack.profile.as_deref() {
            if !valid_profile(profile) && profile != "*" {
                return Err(format!("PLUGIN_PACK_MARKET_PROFILE: {}", pack.id));
            }
        }
    }
    Ok(())
}

fn validate_detail(detail: &PluginPackDetail) -> Result<(), String> {
    if detail.plugins.is_empty() || detail.plugins.len() > MAX_PLUGINS_PER_PACK {
        return Err(format!("PLUGIN_PACK_PLUGIN_COUNT: {}", detail.listing.id));
    }
    let mut ids = HashSet::new();
    for plugin in &detail.plugins {
        if !valid_id(&plugin.id) || !ids.insert(&plugin.id) {
            return Err(format!("PLUGIN_PACK_PLUGIN_ID: {}", plugin.id));
        }
        if plugin.name.trim().is_empty() {
            return Err(format!("PLUGIN_PACK_PLUGIN_NAME: {}", plugin.id));
        }
        validate_spec(&plugin.spec)?;
        if let Some(repository) = plugin.repository.as_deref() {
            if !repository.starts_with("https://github.com/") {
                return Err(format!("PLUGIN_PACK_PLUGIN_REPOSITORY: {}", plugin.id));
            }
        }
    }
    let _ = ordered_plugins(detail)?;
    Ok(())
}

async fn fetch_text(url: &str, prefix: &str) -> Result<String, String> {
    validate_source_url(url)?;
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("{prefix}_CLIENT: {error}"))?;
    let response = client
        .get(url)
        .header(USER_AGENT, "deepseek-harness-desktop-plugin-pack")
        .send()
        .await
        .map_err(|error| format!("{prefix}_NETWORK: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{prefix}_HTTP: {}", response.status()));
    }
    response
        .text()
        .await
        .map_err(|error| format!("{prefix}_READ: {error}"))
}

fn validate_source_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://raw.githubusercontent.com/") {
        return Err(format!(
            "PLUGIN_PACK_SOURCE_URL: unsupported source URL {url}"
        ));
    }
    Ok(())
}

fn validate_spec(spec: &str) -> Result<(), String> {
    if spec.is_empty()
        || spec.len() > 512
        || spec.starts_with('-')
        || spec.chars().any(char::is_control)
        || spec.starts_with("file:")
        || spec.starts_with("link:")
        || spec.contains('\\')
    {
        return Err("PLUGIN_PACK_SPEC_INVALID: local or unsafe package spec".to_string());
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')
        })
}

fn valid_profile(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

fn tokenize_command(line: &str) -> Option<Vec<String>> {
    if !line.starts_with("dsh plugin --profile") {
        return None;
    }
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in line.chars() {
        match (quote, ch) {
            (Some(expected), value) if value == expected => quote = None,
            (Some(_), value) => current.push(value),
            (None, '\'' | '"') => quote = Some(ch),
            (None, value) if value.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            (None, value) => current.push(value),
        }
    }
    if quote.is_some() {
        return None;
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Some(tokens)
}

fn spec_package_name(spec: &str) -> Option<String> {
    let mut value = spec.trim().trim_matches(['\'', '"']).to_string();
    if let Some((base, _)) = value.split_once('#') {
        value = base.to_string();
    }
    if let Some((base, _)) = value.split_once("::") {
        value = base.to_string();
    }
    if value.starts_with('@') {
        if let Some(offset) = value[1..].rfind('@') {
            value.truncate(offset + 1);
        }
        return Some(value.to_ascii_lowercase());
    }
    if value.starts_with("github:") {
        value = value.trim_start_matches("github:").to_string();
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        value = value.split('/').next_back().unwrap_or_default().to_string();
    } else if value.contains('/') {
        value = value.split('/').next_back().unwrap_or_default().to_string();
    }
    for suffix in [".tar.gz", ".tgz", ".zip", ".git"] {
        if let Some(base) = value.strip_suffix(suffix) {
            value = base.to_string();
        }
    }
    if let Some((base, version)) = value.rsplit_once('@') {
        if !base.is_empty() && !version.is_empty() {
            value = base.to_string();
        }
    }
    if value.is_empty() {
        None
    } else {
        Some(value.to_ascii_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        featured_pack_detail, featured_packs, parse_readme_manifest, spec_package_name,
        tokenize_command, PluginPackListing,
    };

    fn listing(format: &str) -> PluginPackListing {
        PluginPackListing {
            id: "example-pack".to_string(),
            name: "Example".to_string(),
            description: "Example".to_string(),
            repository: "https://github.com/example/example".to_string(),
            topics: vec!["dsh-plugin-pack".to_string()],
            format: format.to_string(),
            source_file: "README.md".to_string(),
            source_url: "https://raw.githubusercontent.com/example/example/main/README.md"
                .to_string(),
            profile: Some("web".to_string()),
            source: Some("community".to_string()),
        }
    }

    #[test]
    fn parses_quoted_readme_specs() {
        let detail = parse_readme_manifest(
            listing("readme-command-list"),
            "dsh plugin --profile web add github:owner/one\ndsh plugin --profile web add \"https://example.invalid/a.tar.gz\"\ndsh plugin --profile web add github:owner/one\n",
        )
        .unwrap();
        assert_eq!(detail.plugins.len(), 2);
        assert_eq!(detail.plugins[1].spec, "https://example.invalid/a.tar.gz");
    }

    #[test]
    fn tokenizes_only_complete_commands() {
        assert_eq!(
            tokenize_command("dsh plugin --profile web add github:owner/repo")
                .unwrap()
                .len(),
            6
        );
        assert!(tokenize_command("# dsh plugin --profile web add github:owner/repo").is_none());
    }

    #[test]
    fn derives_package_names() {
        assert_eq!(
            spec_package_name("github:owner/dsh-example#main").as_deref(),
            Some("dsh-example")
        );
        assert_eq!(
            spec_package_name("@scope/example@^1.0.0").as_deref(),
            Some("@scope/example")
        );
    }

    #[test]
    fn keeps_user_featured_packs_in_required_order() {
        let packs = featured_packs();
        assert_eq!(packs[0].id, "featured-dsh-web-ui");
        assert_eq!(packs[1].id, "featured-dsh-webui");
        assert_eq!(
            featured_pack_detail("featured-dsh-web-ui").unwrap().plugins[0].spec,
            "@linxin666/dsh-web-ui-all@latest"
        );
        assert_eq!(
            featured_pack_detail("featured-dsh-webui").unwrap().plugins[0].spec,
            "github:statem-li/dsh-webui"
        );
    }
}
