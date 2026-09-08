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
    #[serde(default)]
    pub repair_assistant: bool,
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
    #[serde(default)]
    pub repair_assistant: bool,
    pub name: String,
    pub dsh_home: PathBuf,
    pub profile: String,
    #[serde(default)]
    pub version: DshVersionRef,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstanceInput {
    #[serde(default)]
    pub repair_assistant: Option<bool>,
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

fn registry_sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| REGISTRY_FILE.to_string());
    path.with_file_name(format!("{name}{suffix}"))
}

/// 读取已存储记录时的 Home 规范化：单条记录不可用不能拖垮整个注册表，
/// 退回原始值并告警，让用户仍能看到该实例并用“仅移除记录”修复。
fn normalize_stored_home(path: &Path) -> PathBuf {
    normalize_home(path).unwrap_or_else(|error| {
        log::warn!(
            "instance home {} cannot be normalized, keeping the stored value: {error}",
            path.display()
        );
        path.to_path_buf()
    })
}

fn parse_registry(content: &str) -> Result<InstanceRegistry, serde_json::Error> {
    let mut registry: InstanceRegistry = serde_json::from_str(content)?;
    for instance in &mut registry.instances {
        instance.dsh_home = normalize_stored_home(&instance.dsh_home);
    }
    Ok(registry)
}

fn read_registry_at(path: &Path) -> Result<InstanceRegistry, String> {
    let backup = registry_sibling(path, ".bak");
    if !path.exists() {
        // 主文件缺失但备份存在：上次写入在替换完成前被中断
        if let Ok(backup_content) = fs::read_to_string(&backup) {
            if let Ok(registry) = parse_registry(&backup_content) {
                log::error!(
                    "{} is missing; recovered the instance registry from {}",
                    path.display(),
                    backup.display()
                );
                return Ok(registry);
            }
        }
        return Ok(InstanceRegistry::default());
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("INSTANCE_REGISTRY_READ: {error}"))?;
    match parse_registry(&content) {
        Ok(registry) => Ok(registry),
        Err(error) => {
            if let Ok(backup_content) = fs::read_to_string(&backup) {
                if let Ok(registry) = parse_registry(&backup_content) {
                    log::error!(
                        "{} is corrupt ({error}); recovered the instance registry from {}",
                        path.display(),
                        backup.display()
                    );
                    return Ok(registry);
                }
            }
            Err(format!("INSTANCE_REGISTRY_INVALID: {error}"))
        }
    }
}

fn read_registry(app: &AppHandle) -> Result<InstanceRegistry, String> {
    read_registry_at(&registry_path(app)?)
}

fn write_registry_at(path: &Path, registry: &InstanceRegistry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("INSTANCE_REGISTRY_CREATE: {error}"))?;
    }
    let content = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("INSTANCE_REGISTRY_SERIALIZE: {error}"))?;
    // 同目录暂存 + rename 原子替换：崩溃或断电只会留下无用暂存文件，
    // 主文件始终是完整的旧版或完整的新版。
    let staging = registry_sibling(path, ".tmp");
    fs::write(&staging, format!("{content}\n"))
        .map_err(|error| format!("INSTANCE_REGISTRY_WRITE: {error}"))?;
    // 替换前保留上一份可用注册表。备份失败不阻断本次写入。
    if path.exists() {
        if let Err(error) = fs::copy(path, registry_sibling(path, ".bak")) {
            log::warn!("failed to back up {}: {error}", path.display());
        }
    }
    fs::rename(&staging, path).map_err(|error| {
        let _ = fs::remove_file(&staging);
        format!("INSTANCE_REGISTRY_WRITE: {error}")
    })
}

fn write_registry(app: &AppHandle, registry: &InstanceRegistry) -> Result<(), String> {
    write_registry_at(&registry_path(app)?, registry)
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

fn validate_repair_home(registry: &InstanceRegistry, home: &Path, repair: bool, exclude: Option<&str>) -> Result<(), String> {
    if registry.instances.iter().any(|instance| {
        exclude != Some(instance.id.as_str()) && (repair || instance.repair_assistant) && {
            #[cfg(windows)]
            { instance.dsh_home.to_string_lossy().eq_ignore_ascii_case(&home.to_string_lossy()) }
            #[cfg(not(windows))]
            { instance.dsh_home == home }
        }
    }) {
        return Err("REPAIR_HOME_SHARED: repair assistant requires an independent DSH Home".into());
    }
    Ok(())
}

pub(crate) fn ensure_profile(home: &Path, profile: &str) -> Result<(), String> {
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
    let mut registry = read_registry(app)?;
    validate_repair_home(&registry, &home, input.repair_assistant, None)?;
    ensure_profile(&home, &input.profile)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("INSTANCE_CLOCK: {error}"))?
        .as_millis();
    let instance = DshInstance {
        repair_assistant: input.repair_assistant,
        id: format!("instance-{now}-{}", std::process::id()),
        name: name.to_string(),
        dsh_home: home,
        profile: input.profile,
        version: input.version,
        favorite: false,
        created_at: now as u64,
    };
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
    let mut registry = read_registry(app)?;
    let current = registry.instances.iter().find(|instance| instance.id == input.id)
        .ok_or_else(|| format!("INSTANCE_NOT_FOUND: {}", input.id))?;
    let repair = input.repair_assistant.unwrap_or(current.repair_assistant);
    validate_repair_home(&registry, &home, repair, Some(&input.id))?;
    ensure_profile(&home, &input.profile)?;
    let instance = registry
        .instances
        .iter_mut()
        .find(|instance| instance.id == input.id)
        .ok_or_else(|| format!("INSTANCE_NOT_FOUND: {}", input.id))?;
    instance.name = name.to_string();
    instance.repair_assistant = repair;
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
    // 守卫必须在删除入口内部：命令层的检查只看本进程宿主表，看不到上一会话
    // 崩溃或被强杀后遗留、仍在写这个 Home 的 DSH 进程。
    if let Some(pid) = crate::service::workflow::home_service_is_live(&impact.dsh_home) {
        let affected = impact
            .instances
            .iter()
            .find(|instance| instance.id == id)
            .or_else(|| impact.instances.first());
        log::error!(
            "refusing to remove DSH_HOME {}: harness process {pid} is still alive",
            impact.dsh_home.display()
        );
        return Err(match affected {
            Some(instance) => format!("INSTANCE_HOME_RUNNING:{}:{}", instance.id, instance.name),
            None => {
                "INSTANCE_HOME_RUNNING:stop the DSH service using this DSH_HOME before removing it"
                    .to_string()
            }
        });
    }
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

/// Remove only the registry entry. The DSH Home and all files remain intact.
pub fn remove_registry_entry(app: &AppHandle, id: &str) -> Result<InstanceRegistry, String> {
    let mut registry = read_registry(app)?;
    if !registry.instances.iter().any(|instance| instance.id == id) {
        return Err(format!("INSTANCE_NOT_FOUND: {id}"));
    }
    registry.instances.retain(|instance| instance.id != id);
    if registry.active_instance_id.as_deref() == Some(id) {
        registry.active_instance_id = registry.instances.first().map(|instance| instance.id.clone());
    }
    write_registry(app, &registry)?;
    let active = registry.active_instance_id.as_deref()
        .and_then(|active_id| registry.instances.iter().find(|item| item.id == active_id)).cloned();
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
///
/// 存活进程门在这里再查一遍：`remove` 里的同一检查是为了在写注册表之前就失败，
/// 并能报出实例名；这一层保证任何未来的调用方也无法绕过删除一个仍在使用的 Home。
fn remove_home_directory(home: &Path) -> Result<(), String> {
    let normalized = normalize_home(home)?;
    if let Some(pid) = crate::service::workflow::home_service_is_live(&normalized) {
        return Err(format!(
            "INSTANCE_HOME_RUNNING: {pid} is still using {}",
            normalized.display()
        ));
    }
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
    fn repair_home_isolation_is_symmetric_and_allows_self_update() {
        let home = std::env::temp_dir().join("dsh-repair-isolation-test");
        let mut registry = InstanceRegistry::default();
        registry.instances.push(DshInstance {
            id: "existing".into(), name: "Existing".into(), dsh_home: home.clone(),
            profile: "tauri".into(), version: DshVersionRef::default(),
            favorite: false, created_at: 0, repair_assistant: false,
        });
        assert!(validate_repair_home(&registry, &home, false, None).is_ok());
        assert!(validate_repair_home(&registry, &home, true, None).is_err());
        assert!(validate_repair_home(&registry, &home, true, Some("existing")).is_ok());
        registry.instances[0].repair_assistant = true;
        assert!(validate_repair_home(&registry, &home, false, None).is_err());
        assert!(validate_repair_home(&registry, &home.join("independent"), true, None).is_ok());
    }

    #[test]
    fn legacy_instance_inputs_preserve_repair_marker_on_update() {
        let input: UpdateInstanceInput = serde_json::from_value(serde_json::json!({
            "id": "legacy", "name": "Legacy", "dshHome": "test-home", "profile": "tauri"
        })).unwrap();
        assert_eq!(input.repair_assistant, None);
        let input: CreateInstanceInput = serde_json::from_value(serde_json::json!({
            "name": "Legacy", "dshHome": "test-home", "profile": "tauri"
        })).unwrap();
        assert!(!input.repair_assistant);
    }

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

    fn registry_with(id: &str, home: &Path) -> InstanceRegistry {
        InstanceRegistry {
            instances: vec![DshInstance {
                id: id.into(),
                name: id.into(),
                dsh_home: home.to_path_buf(),
                profile: "web".into(),
                version: DshVersionRef::default(),
                favorite: false,
                created_at: 0,
                repair_assistant: false,
            }],
            active_instance_id: Some(id.into()),
        }
    }

    fn temp_registry_dir(case: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-registry-{case}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp registry dir");
        dir
    }

    #[test]
    fn registry_write_keeps_previous_generation_as_backup() {
        let dir = temp_registry_dir("atomic");
        let path = dir.join(REGISTRY_FILE);

        write_registry_at(&path, &registry_with("first", &dir.join("home-a")))
            .expect("first write");
        assert!(
            !registry_sibling(&path, ".bak").exists(),
            "first write has no previous generation"
        );

        write_registry_at(&path, &registry_with("second", &dir.join("home-b")))
            .expect("second write");

        let backup: InstanceRegistry =
            serde_json::from_str(&fs::read_to_string(registry_sibling(&path, ".bak")).unwrap())
                .expect("backup parses");
        assert_eq!(backup.instances[0].id, "first");
        assert_eq!(read_registry_at(&path).unwrap().instances[0].id, "second");
        assert!(
            !registry_sibling(&path, ".tmp").exists(),
            "staging file is consumed by rename"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_registry_recovers_from_backup() {
        let dir = temp_registry_dir("corrupt");
        let path = dir.join(REGISTRY_FILE);
        write_registry_at(&path, &registry_with("kept", &dir.join("home"))).expect("seed");
        write_registry_at(&path, &registry_with("lost", &dir.join("home"))).expect("second");
        // 备份此刻是 "kept"，主文件随后被写坏
        fs::write(&path, "{ not json").expect("corrupt primary");

        let registry = read_registry_at(&path).expect("recover from backup");
        assert_eq!(registry.instances[0].id, "kept");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_registry_recovers_from_backup() {
        let dir = temp_registry_dir("missing");
        let path = dir.join(REGISTRY_FILE);
        write_registry_at(&path, &registry_with("first", &dir.join("home"))).expect("seed");
        write_registry_at(&path, &registry_with("second", &dir.join("home"))).expect("second");
        fs::remove_file(&path).expect("drop primary");

        let registry = read_registry_at(&path).expect("recover from backup");
        assert_eq!(registry.instances[0].id, "first");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_registry_without_backup_still_reports_invalid() {
        let dir = temp_registry_dir("no-backup");
        let path = dir.join(REGISTRY_FILE);
        fs::write(&path, "{ not json").expect("corrupt primary");

        let error = read_registry_at(&path).expect_err("no backup to recover from");
        assert!(error.starts_with("INSTANCE_REGISTRY_INVALID:"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_unusable_home_does_not_break_the_whole_registry() {
        let dir = temp_registry_dir("partial");
        let path = dir.join(REGISTRY_FILE);
        let healthy = dir.join("healthy-home");
        let content = serde_json::json!({
            "instances": [
                {
                    "id": "broken", "name": "Broken", "dshHome": "", "profile": "web",
                    "version": { "channel": "preview", "tag": "latest" },
                    "favorite": false, "createdAt": 1
                },
                {
                    "id": "healthy", "name": "Healthy", "dshHome": healthy, "profile": "web",
                    "version": { "channel": "preview", "tag": "latest" },
                    "favorite": false, "createdAt": 2
                }
            ],
            "activeInstanceId": "healthy"
        });
        fs::write(&path, serde_json::to_string_pretty(&content).unwrap()).expect("write registry");

        let registry = read_registry_at(&path).expect("registry stays readable");
        assert_eq!(
            registry.instances.len(),
            2,
            "the healthy instance is still listed"
        );
        assert_eq!(registry.active_instance_id.as_deref(), Some("healthy"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_home_marker_does_not_block_removal() {
        let home = std::env::temp_dir().join(format!("dsh-stale-marker-{}", std::process::id()));
        fs::create_dir_all(&home).expect("create home");
        // 极大 PID 在任何平台都不可能是存活进程
        fs::write(home.join(".harness.pid"), "4000000000\n3080\n").expect("write stale marker");

        assert_eq!(crate::service::workflow::home_service_is_live(&home), None);
        remove_home_directory(&home).expect("stale marker must not block removal");
        assert!(!home.exists());
    }

    #[test]
    fn live_home_marker_blocks_removal() {
        let home = std::env::temp_dir().join(format!("dsh-live-marker-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).expect("create home");
        // 测试进程自身必然存活，用它作为"服务仍在跑"的样本
        fs::write(
            home.join(".harness.pid"),
            format!("{}\n3080\n", std::process::id()),
        )
        .expect("write live marker");

        assert_eq!(
            crate::service::workflow::home_service_is_live(&home),
            Some(std::process::id())
        );

        let error = remove_home_directory(&home).expect_err("a live marker must block removal");
        assert!(error.starts_with("INSTANCE_HOME_RUNNING:"), "{error}");
        assert!(home.exists(), "a refused removal must leave the Home intact");

        let _ = fs::remove_dir_all(&home);
    }
}
