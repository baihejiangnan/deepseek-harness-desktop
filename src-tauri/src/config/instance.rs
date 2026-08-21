//! DSH 实例注册表：只保存启动元数据，不保存凭据、会话或用户预设。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const REGISTRY_FILE: &str = "instances.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DshVersionRef {
    pub channel: String,
    pub tag: String,
}

impl Default for DshVersionRef {
    fn default() -> Self {
        Self {
            channel: "preview".to_string(),
            tag: "latest".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DshInstance {
    pub id: String,
    pub name: String,
    pub dsh_home: PathBuf,
    pub profile: String,
    pub version: DshVersionRef,
    #[serde(default)]
    pub favorite: bool,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRegistry {
    #[serde(default)]
    pub instances: Vec<DshInstance>,
    #[serde(default)]
    pub active_instance_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstanceInput {
    pub name: String,
    pub dsh_home: PathBuf,
    pub profile: String,
    #[serde(default)]
    pub version: DshVersionRef,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstanceInput {
    pub id: String,
    pub name: String,
    pub dsh_home: PathBuf,
    pub profile: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSharing {
    pub home_users: usize,
    pub profile_users: usize,
    pub level: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRemovalImpact {
    pub dsh_home: PathBuf,
    pub instances: Vec<DshInstance>,
    pub profiles: Vec<String>,
}

static ACTIVE_INSTANCE: OnceLock<Mutex<Option<DshInstance>>> = OnceLock::new();

fn active_lock() -> &'static Mutex<Option<DshInstance>> {
    ACTIVE_INSTANCE.get_or_init(|| Mutex::new(None))
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(REGISTRY_FILE))
        .map_err(|error| format!("INSTANCE_REGISTRY_PATH: {error}"))
}

fn read_registry(app: &AppHandle) -> Result<InstanceRegistry, String> {
    let path = registry_path(app)?;
    if !path.exists() {
        return Ok(InstanceRegistry::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("INSTANCE_REGISTRY_READ: {error}"))?;
    let mut registry: InstanceRegistry = serde_json::from_str(&content)
        .map_err(|error| format!("INSTANCE_REGISTRY_INVALID: {error}"))?;
    for instance in &mut registry.instances {
        instance.dsh_home = normalize_home(&instance.dsh_home)?;
    }
    Ok(registry)
}

fn write_registry(app: &AppHandle, registry: &InstanceRegistry) -> Result<(), String> {
    let path = registry_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("INSTANCE_REGISTRY_CREATE: {error}"))?;
    }
    let content = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("INSTANCE_REGISTRY_SERIALIZE: {error}"))?;
    fs::write(&path, format!("{content}\n"))
        .map_err(|error| format!("INSTANCE_REGISTRY_WRITE: {error}"))
}

fn validate_profile(profile: &str) -> Result<(), String> {
    if profile.is_empty()
        || profile.len() > 64
        || !profile
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(
            "INSTANCE_PROFILE_INVALID: use 1-64 ASCII letters, numbers, '-' or '_'".to_string(),
        );
    }
    Ok(())
}

fn normalize_home(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("INSTANCE_HOME_EMPTY: choose a DSH_HOME directory".to_string());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| format!("INSTANCE_HOME_RESOLVE: {error}"))?
    };
    Ok(dunce::canonicalize(&absolute).unwrap_or(absolute))
}

/// Export service validation needs the same canonical Home semantics as the
/// registry without exposing the internal path normalization implementation.
pub(crate) fn normalize_home_for_export(path: &Path) -> Result<PathBuf, String> {
    normalize_home(path)
}

fn ensure_profile(home: &Path, profile: &str) -> Result<(), String> {
    let directory = home.join("profiles").join(profile);
    fs::create_dir_all(&directory).map_err(|error| format!("INSTANCE_PROFILE_CREATE: {error}"))?;
    let manifest = directory.join("package.json");
    if !manifest.exists() {
        let value = serde_json::json!({
            "name": format!("dsh-profile-{profile}"),
            "private": true,
            "dependencies": {},
            "dsh": {
                "profile": {
                    "bundles": [
                        "@deepseek-ai/dsh-base",
                        "@deepseek-ai/dsh-web-app"
                    ]
                }
            }
        });
        let content = serde_json::to_string_pretty(&value)
            .map_err(|error| format!("INSTANCE_PROFILE_SERIALIZE: {error}"))?;
        fs::write(&manifest, format!("{content}\n"))
            .map_err(|error| format!("INSTANCE_PROFILE_WRITE: {error}"))?;
    }
    let patch = directory.join("cordis.patch.yml");
    if !patch.exists() {
        fs::write(&patch, "# Profile-local overrides.\n[]\n")
            .map_err(|error| format!("INSTANCE_PATCH_WRITE: {error}"))?;
    }
    Ok(())
}

pub fn list(app: &AppHandle) -> Result<InstanceRegistry, String> {
    read_registry(app)
}

/// 读取指定实例而不修改注册表中的 active_instance_id。
/// 实例宿主进程使用它初始化本地状态，避免多个宿主互相覆盖启动器选择。
pub fn find(app: &AppHandle, id: &str) -> Result<DshInstance, String> {
    read_registry(app)?
        .instances
        .into_iter()
        .find(|instance| instance.id == id)
        .ok_or_else(|| format!("INSTANCE_NOT_FOUND: {id}"))
}

pub fn create(app: &AppHandle, input: CreateInstanceInput) -> Result<DshInstance, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("INSTANCE_NAME_EMPTY: enter an instance name".to_string());
    }
    validate_profile(&input.profile)?;
    let home = normalize_home(&input.dsh_home)?;
    ensure_profile(&home, &input.profile)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("INSTANCE_CLOCK: {error}"))?
        .as_millis();
    let instance = DshInstance {
        id: format!("instance-{now}-{}", std::process::id()),
        name: name.to_string(),
        dsh_home: home,
        profile: input.profile,
        version: input.version,
        favorite: false,
        created_at: now as u64,
    };
    let mut registry = read_registry(app)?;
    registry.instances.push(instance.clone());
    registry.active_instance_id = Some(instance.id.clone());
    write_registry(app, &registry)?;
    set_active(Some(instance.clone()));
    Ok(instance)
}

pub fn update(app: &AppHandle, input: UpdateInstanceInput) -> Result<DshInstance, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("INSTANCE_NAME_EMPTY: enter an instance name".to_string());
    }
    validate_profile(&input.profile)?;
    let home = normalize_home(&input.dsh_home)?;
    ensure_profile(&home, &input.profile)?;

    let mut registry = read_registry(app)?;
    let instance = registry
        .instances
        .iter_mut()
        .find(|instance| instance.id == input.id)
        .ok_or_else(|| format!("INSTANCE_NOT_FOUND: {}", input.id))?;
    instance.name = name.to_string();
    instance.dsh_home = home;
    instance.profile = input.profile;
    let updated = instance.clone();
    write_registry(app, &registry)?;

    if registry.active_instance_id.as_deref() == Some(updated.id.as_str()) {
        set_active(Some(updated.clone()));
    }
    Ok(updated)
}

pub fn select(app: &AppHandle, id: &str) -> Result<DshInstance, String> {
    let mut registry = read_registry(app)?;
    let instance = registry
        .instances
        .iter()
        .find(|instance| instance.id == id)
        .cloned()
        .ok_or_else(|| format!("INSTANCE_NOT_FOUND: {id}"))?;
    registry.active_instance_id = Some(id.to_string());
    write_registry(app, &registry)?;
    set_active(Some(instance.clone()));
    Ok(instance)
}

pub fn remove(app: &AppHandle, id: &str) -> Result<InstanceRegistry, String> {
    let mut registry = read_registry(app)?;
    let impact = removal_impact_from_registry(&registry, id)?;
    remove_home_directory(&impact.dsh_home)?;
    let removed_ids: std::collections::HashSet<&str> = impact
        .instances
        .iter()
        .map(|instance| instance.id.as_str())
        .collect();
    registry
        .instances
        .retain(|instance| !removed_ids.contains(instance.id.as_str()));
    if registry
        .active_instance_id
        .as_deref()
        .is_some_and(|active| removed_ids.contains(active))
    {
        registry.active_instance_id = registry
            .instances
            .first()
            .map(|instance| instance.id.clone());
    }
    write_registry(app, &registry)?;
    let active = registry
        .active_instance_id
        .as_deref()
        .and_then(|active_id| registry.instances.iter().find(|item| item.id == active_id))
        .cloned();
    set_active(active);
    Ok(registry)
}

fn removal_impact_from_registry(
    registry: &InstanceRegistry,
    id: &str,
) -> Result<InstanceRemovalImpact, String> {
    let target = registry
        .instances
        .iter()
        .find(|instance| instance.id == id)
        .cloned()
        .ok_or_else(|| format!("INSTANCE_NOT_FOUND: {id}"))?;
    let instances: Vec<DshInstance> = registry
        .instances
        .iter()
        .filter(|instance| instance.dsh_home == target.dsh_home)
        .cloned()
        .collect();
    let mut profiles: Vec<String> = instances
        .iter()
        .map(|instance| instance.profile.clone())
        .collect();
    profiles.sort();
    profiles.dedup();
    Ok(InstanceRemovalImpact {
        dsh_home: target.dsh_home,
        instances,
        profiles,
    })
}

pub fn removal_impact(app: &AppHandle, id: &str) -> Result<InstanceRemovalImpact, String> {
    let registry = read_registry(app)?;
    removal_impact_from_registry(&registry, id)
}

/// 删除实例数据前拒绝文件系统根目录，避免错误配置扩大删除范围。
fn remove_home_directory(home: &Path) -> Result<(), String> {
    let normalized = normalize_home(home)?;
    if normalized.parent().is_none() {
        return Err("INSTANCE_HOME_UNSAFE: refusing to remove a filesystem root".to_string());
    }
    if !normalized.exists() {
        return Ok(());
    }
    if !normalized.is_dir() {
        return Err("INSTANCE_HOME_INVALID: DSH_HOME is not a directory".to_string());
    }
    fs::remove_dir_all(&normalized).map_err(|error| format!("INSTANCE_HOME_REMOVE: {error}"))
}

pub fn sharing(
    app: &AppHandle,
    home: &Path,
    profile: &str,
    exclude_id: Option<&str>,
) -> Result<InstanceSharing, String> {
    let registry = read_registry(app)?;
    let normalized_home = normalize_home(home)?;
    let home_users = registry
        .instances
        .iter()
        .filter(|instance| {
            if exclude_id == Some(instance.id.as_str()) {
                return false;
            }
            normalize_home(&instance.dsh_home).unwrap_or_else(|_| instance.dsh_home.clone())
                == normalized_home
        })
        .count();
    let profile_users = registry
        .instances
        .iter()
        .filter(|instance| {
            if exclude_id == Some(instance.id.as_str()) {
                return false;
            }
            normalize_home(&instance.dsh_home).unwrap_or_else(|_| instance.dsh_home.clone())
                == normalized_home
                && instance.profile == profile
        })
        .count();
    let level = if profile_users > 0 {
        "shared_profile"
    } else if home_users > 0 {
        "shared_home"
    } else {
        "isolated"
    };
    Ok(InstanceSharing {
        home_users,
        profile_users,
        level: level.to_string(),
    })
}

pub fn restore_active(app: &AppHandle) -> Result<Option<DshInstance>, String> {
    let registry = read_registry(app)?;
    let active = registry
        .active_instance_id
        .as_deref()
        .and_then(|id| registry.instances.iter().find(|instance| instance.id == id))
        .cloned();
    set_active(active.clone());
    Ok(active)
}

pub fn active() -> Option<DshInstance> {
    active_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

pub fn set_active(instance: Option<DshInstance>) {
    *active_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = instance;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_validation_rejects_paths() {
        assert!(validate_profile("tauri").is_ok());
        assert!(validate_profile("../web").is_err());
        assert!(validate_profile("with space").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn normalized_home_uses_a_node_compatible_windows_path() {
        let normalized = normalize_home(&std::env::temp_dir()).expect("normalize temp dir");
        assert!(!normalized.to_string_lossy().starts_with(r"\\?\"));
        assert!(normalized.is_absolute());
    }

    #[test]
    fn home_removal_rejects_filesystem_root() {
        let root = std::path::Path::new(std::path::MAIN_SEPARATOR_STR);
        assert!(remove_home_directory(root).is_err());
    }

    #[test]
    fn home_removal_deletes_instance_directory() {
        let home =
            std::env::temp_dir().join(format!("dsh-instance-remove-test-{}", std::process::id()));
        fs::create_dir_all(home.join("profiles/tauri")).expect("create test instance");
        fs::write(home.join("profiles/tauri/package.json"), "{}").expect("write test data");

        remove_home_directory(&home).expect("remove test instance");

        assert!(!home.exists());
    }
}
