//! 已安装插件更新检查与执行。
//!
//! 更新目标始终由后端根据 Profile 的直接依赖与 npm registry 重新计算；前端只
//! 提交插件 id、预览时看到的版本和依赖规格，用于并发变化检测。

use super::installed::{profile_dir, ProfilePackageJson};
use futures_util::{stream, StreamExt};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateInfo {
    pub plugin_id: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub source_fingerprint: String,
    pub source_kind: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateIntent {
    pub plugin_id: String,
    pub expected_version: String,
    pub expected_source_fingerprint: String,
    pub target_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateResult {
    pub plugin_id: String,
    pub previous_version: String,
    pub installed_version: String,
    pub restored: bool,
}

#[derive(Deserialize)]
struct RegistryMetadata {
    #[serde(rename = "dist-tags")]
    dist_tags: std::collections::HashMap<String, String>,
    #[serde(default)]
    versions: std::collections::HashMap<String, serde_json::Value>,
}

pub async fn check_profile(profile: &Path) -> Result<Vec<PluginUpdateInfo>, String> {
    let manifest = read_manifest(profile)?;
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("PLUGIN_UPDATE_CLIENT: {error}"))?;
    let profile = profile.to_path_buf();
    let mut output = stream::iter(manifest.dependencies.into_iter().map(|(id, spec)| {
        let client = client.clone();
        let profile = profile.clone();
        async move {
            let current = installed_version(&profile, &id).unwrap_or_default();
            let source = classify_source(&id, &spec);
            if let Some(selector) = source.npm_tag {
                match registry_version(&client, &id, &selector).await {
                    Ok(latest) => {
                        let status = compare_versions(&current, &latest);
                        PluginUpdateInfo {
                            plugin_id: id,
                            current_version: current,
                            latest_version: Some(latest),
                            source_fingerprint: fingerprint(&spec),
                            source_kind: source.kind.into(),
                            status: status.into(),
                            reason: source.reason.map(str::to_string),
                        }
                    }
                    Err(error) => PluginUpdateInfo {
                        plugin_id: id,
                        current_version: current,
                        latest_version: None,
                        source_fingerprint: fingerprint(&spec),
                        source_kind: source.kind.into(),
                        status: "check-failed".into(),
                        reason: Some(error),
                    },
                }
            } else {
                PluginUpdateInfo {
                    plugin_id: id,
                    current_version: current,
                    latest_version: None,
                    source_fingerprint: fingerprint(&spec),
                    source_kind: source.kind.into(),
                    status: source.status.into(),
                    reason: source.reason.map(str::to_string),
                }
            }
        }
    }))
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    output.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
    Ok(output)
}

pub async fn apply(
    app_handle: &AppHandle,
    intent: &PluginUpdateIntent,
) -> Result<PluginUpdateResult, String> {
    validate_plugin_id(&intent.plugin_id)?;
    Version::parse(&intent.target_version).map_err(|_| {
        "PLUGIN_UPDATE_TARGET_INVALID: target is not a semantic version".to_string()
    })?;
    let profile = profile_dir(app_handle);
    let manifest = read_manifest(&profile)?;
    let current_spec = manifest
        .dependencies
        .get(&intent.plugin_id)
        .ok_or_else(|| "PLUGIN_NOT_INSTALLED: plugin is not a direct dependency".to_string())?;
    let current_version = installed_version(&profile, &intent.plugin_id).unwrap_or_default();
    if fingerprint(current_spec) != intent.expected_source_fingerprint
        || current_version != intent.expected_version
    {
        return Err(
            "PLUGIN_UPDATE_CONFLICT: installed plugin changed after the update check".to_string(),
        );
    }
    let source = classify_source(&intent.plugin_id, current_spec);
    let selector = source.npm_tag.ok_or_else(|| {
        "PLUGIN_UPDATE_SOURCE_UNSUPPORTED: this source cannot be updated automatically".to_string()
    })?;
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("PLUGIN_UPDATE_CLIENT: {error}"))?;
    let latest = registry_version(&client, &intent.plugin_id, &selector).await?;
    if latest != intent.target_version {
        return Err(
            "PLUGIN_UPDATE_TARGET_CHANGED: available version changed; check again".to_string(),
        );
    }

    let snapshot = Snapshot::capture(&profile)?;
    let was_enabled = manifest
        .dsh
        .as_ref()
        .and_then(|d| d.profile.as_ref())
        .is_some_and(|p| p.bundles.iter().any(|id| id == &intent.plugin_id));
    let target = format!("{}@{}", intent.plugin_id, intent.target_version);
    if let Err(error) = super::install(app_handle, &[target]).await {
        let restored = snapshot.restore(&profile).is_ok()
            && super::install(app_handle, &[current_spec.clone()])
                .await
                .is_ok()
            && installed_version(&profile, &intent.plugin_id).as_deref()
                == Some(intent.expected_version.as_str());
        return Err(format!(
            "PLUGIN_UPDATE_FAILED: {error}; restored={restored}"
        ));
    }
    // `add name@version` gives pnpm an exact, reviewable target. Restore the
    // user's original range/tag declaration afterwards while retaining the
    // newly resolved lockfile and installed tree.
    let post_install = snapshot
        .restore_manifest()
        .and_then(|()| super::watch::set_enabled(app_handle, &intent.plugin_id, was_enabled));
    let installed = installed_version(&profile, &intent.plugin_id).unwrap_or_default();
    if let Err(error) = post_install {
        let restored = snapshot.restore(&profile).is_ok()
            && super::install(app_handle, &[current_spec.clone()])
                .await
                .is_ok()
            && installed_version(&profile, &intent.plugin_id).as_deref()
                == Some(intent.expected_version.as_str());
        return Err(format!(
            "PLUGIN_UPDATE_POST_INSTALL_FAILED: {error}; restored={restored}"
        ));
    }
    if installed != intent.target_version {
        let restored = snapshot.restore(&profile).is_ok()
            && super::install(app_handle, &[current_spec.clone()])
                .await
                .is_ok()
            && installed_version(&profile, &intent.plugin_id).as_deref()
                == Some(intent.expected_version.as_str());
        return Err(format!(
            "PLUGIN_UPDATE_VERIFY_FAILED: expected {}, found {}; restored={restored}",
            intent.target_version, installed
        ));
    }
    Ok(PluginUpdateResult {
        plugin_id: intent.plugin_id.clone(),
        previous_version: current_version,
        installed_version: installed,
        restored: false,
    })
}

struct Source {
    kind: &'static str,
    npm_tag: Option<String>,
    status: &'static str,
    reason: Option<&'static str>,
}

fn classify_source(id: &str, spec: &str) -> Source {
    let value = spec.trim();
    if value.starts_with("github:") || value.starts_with("git+") || value.contains("github.com/") {
        return Source {
            kind: "git",
            npm_tag: None,
            status: "unsupported",
            reason: Some("Git source update requires a verified installed commit"),
        };
    }
    if value.starts_with("http:") || value.starts_with("https:") {
        return Source {
            kind: "archive",
            npm_tag: None,
            status: "fixed",
            reason: Some("Archive source is fixed; use its catalog entry to choose a newer spec"),
        };
    }
    if value.starts_with("file:") || value.starts_with("link:") || value.starts_with("workspace:") {
        return Source {
            kind: "local",
            npm_tag: None,
            status: "unsupported",
            reason: Some("Local source has no trusted remote update target"),
        };
    }
    if value.starts_with("npm:") || value.starts_with("catalog:") {
        return Source {
            kind: "unknown",
            npm_tag: None,
            status: "unsupported",
            reason: Some("This dependency protocol is not supported yet"),
        };
    }
    if Version::parse(value).is_ok() || value.starts_with('=') {
        return Source {
            kind: "npm-fixed",
            npm_tag: None,
            status: "fixed",
            reason: Some("Exact npm version is pinned"),
        };
    }
    if semver::VersionReq::parse(value).is_ok() {
        return Source {
            kind: "npm",
            npm_tag: Some(format!("range:{value}")),
            status: "checking",
            reason: None,
        };
    }
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Source {
            kind: "npm-tag",
            npm_tag: Some(value.to_string()),
            status: "checking",
            reason: None,
        };
    }
    let _ = id;
    Source {
        kind: "unknown",
        npm_tag: None,
        status: "unsupported",
        reason: Some("The dependency specifier is not supported yet"),
    }
}

async fn registry_version(
    client: &reqwest::Client,
    id: &str,
    selector: &str,
) -> Result<String, String> {
    let encoded = id.replace('/', "%2F");
    let response = client
        .get(format!("https://registry.npmjs.org/{encoded}"))
        .header(reqwest::header::USER_AGENT, "dsh-launcher-plugin-update")
        .send()
        .await
        .map_err(|e| format!("PLUGIN_UPDATE_NETWORK: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "PLUGIN_UPDATE_REGISTRY_HTTP: {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > 8 * 1024 * 1024)
    {
        return Err("PLUGIN_UPDATE_REGISTRY_TOO_LARGE: registry metadata exceeds 8 MiB".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("PLUGIN_UPDATE_REGISTRY_BODY: {e}"))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("PLUGIN_UPDATE_REGISTRY_TOO_LARGE: registry metadata exceeds 8 MiB".into());
    }
    let metadata = serde_json::from_slice::<RegistryMetadata>(&bytes)
        .map_err(|e| format!("PLUGIN_UPDATE_REGISTRY_JSON: {e}"))?;
    if let Some(range) = selector.strip_prefix("range:") {
        let requirement = semver::VersionReq::parse(range)
            .map_err(|_| "PLUGIN_UPDATE_RANGE_INVALID: dependency range is invalid".to_string())?;
        return metadata
            .versions
            .keys()
            .filter_map(|value| Version::parse(value).ok())
            .filter(|version| requirement.matches(version))
            .max()
            .map(|version| version.to_string())
            .ok_or_else(|| {
                format!("PLUGIN_UPDATE_RANGE_EMPTY: no published version matches {range}")
            });
    }
    metadata
        .dist_tags
        .get(selector)
        .cloned()
        .ok_or_else(|| format!("PLUGIN_UPDATE_TAG_NOT_FOUND: {selector}"))
}

fn compare_versions(current: &str, latest: &str) -> &'static str {
    match (Version::parse(current), Version::parse(latest)) {
        (Ok(a), Ok(b)) if a < b => "available",
        (Ok(a), Ok(b)) if a == b => "current",
        (Ok(_), Ok(_)) => "newer-local",
        _ => "unknown-version",
    }
}

fn fingerprint(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn read_manifest(profile: &Path) -> Result<ProfilePackageJson, String> {
    let value = std::fs::read_to_string(profile.join("package.json"))
        .map_err(|e| format!("PLUGIN_PROFILE_READ: {e}"))?;
    serde_json::from_str(&value).map_err(|e| format!("PLUGIN_PROFILE_JSON: {e}"))
}

fn installed_version(profile: &Path, id: &str) -> Option<String> {
    let value =
        std::fs::read_to_string(profile.join("node_modules").join(id).join("package.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&value)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 || id.starts_with('-') || id.chars().any(char::is_control) {
        Err("PLUGIN_UPDATE_ID_INVALID: invalid plugin id".into())
    } else {
        Ok(())
    }
}

struct Snapshot {
    files: Vec<(PathBuf, Option<Vec<u8>>)>,
}
impl Snapshot {
    fn capture(profile: &Path) -> Result<Self, String> {
        let mut files = Vec::new();
        for name in ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"] {
            let path = profile.join(name);
            let value = if path.exists() {
                Some(
                    std::fs::read(&path)
                        .map_err(|e| format!("PLUGIN_UPDATE_SNAPSHOT_READ: {e}"))?,
                )
            } else {
                None
            };
            files.push((path, value));
        }
        Ok(Self { files })
    }
    fn restore(&self, profile: &Path) -> Result<(), String> {
        if profile
            != self
                .files
                .first()
                .and_then(|(p, _)| p.parent())
                .unwrap_or(profile)
        {
            return Err("PLUGIN_UPDATE_RESTORE_PATH: profile path changed".into());
        }
        for (path, value) in &self.files {
            match value {
                Some(bytes) => std::fs::write(path, bytes)
                    .map_err(|e| format!("PLUGIN_UPDATE_RESTORE_WRITE: {e}"))?,
                None if path.exists() => std::fs::remove_file(path)
                    .map_err(|e| format!("PLUGIN_UPDATE_RESTORE_REMOVE: {e}"))?,
                None => {}
            }
        }
        Ok(())
    }
    fn restore_manifest(&self) -> Result<(), String> {
        let (path, value) = self
            .files
            .first()
            .ok_or_else(|| "PLUGIN_UPDATE_SNAPSHOT_EMPTY: no manifest snapshot".to_string())?;
        let bytes = value
            .as_ref()
            .ok_or_else(|| "PLUGIN_UPDATE_SNAPSHOT_MANIFEST: manifest did not exist".to_string())?;
        std::fs::write(path, bytes).map_err(|e| format!("PLUGIN_UPDATE_RESTORE_WRITE: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_source, compare_versions};
    #[test]
    fn classifies_safe_update_sources() {
        assert_eq!(classify_source("foo", "^1.0.0").kind, "npm");
        assert_eq!(classify_source("foo", "1.0.0").status, "fixed");
        assert_eq!(classify_source("foo", "github:owner/repo").kind, "git");
    }
    #[test]
    fn compares_semver_including_prerelease() {
        assert_eq!(compare_versions("1.0.0-rc.1", "1.0.0"), "available");
        assert_eq!(compare_versions("2.0.0", "1.9.0"), "newer-local");
    }
}
