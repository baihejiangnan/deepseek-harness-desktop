//! Discovery and selection of launcher-managed and user-installed DSH runtimes.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Runtime};

use super::constants::DSH_ENTRY_RELATIVE;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DshRuntimeSource {
    Launcher,
    Npm,
    Pnpm,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DshRuntimeStatus {
    Ready,
    MissingNode,
    IncompatibleNode,
    InvalidPackage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshRuntime {
    pub id: String,
    pub source: DshRuntimeSource,
    pub entry_path: PathBuf,
    pub working_dir: PathBuf,
    pub node_path: PathBuf,
    pub version: Option<String>,
    pub status: DshRuntimeStatus,
    pub writable: bool,
    pub update_supported: bool,
    pub selected: bool,
}

fn normalized_id(path: &Path) -> String {
    let value = dunce::canonicalize(path).unwrap_or_else(|_| {
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        normalized
    });
    let text = value.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

fn package_root(entry: &Path) -> Option<PathBuf> {
    let mut current = entry.parent();
    while let Some(dir) = current {
        if dir.file_name().is_some_and(|name| name == "dsh")
            && dir
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "@deepseek-ai")
        {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn version_from_root(root: &Path) -> Option<String> {
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join("package.json")).ok()?).ok()?;
    value.get("version")?.as_str().map(str::to_owned)
}

fn node_compatible(node: &Path) -> bool {
    static CACHE: OnceLock<Mutex<std::collections::HashMap<String, bool>>> = OnceLock::new();
    let key = normalized_id(node);
    let cache = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Some(value) = cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&key)
        .copied()
    {
        return value;
    }
    let compatible = super::is_node_binary_compatible(node);
    cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(key, compatible);
    compatible
}

fn classify(entry: &Path, managed_entry: &Path) -> DshRuntimeSource {
    if normalized_id(entry) == normalized_id(managed_entry) {
        return DshRuntimeSource::Launcher;
    }
    let value = normalized_id(entry);
    if value.contains("/.pnpm/") || value.contains("/pnpm/global/") {
        DshRuntimeSource::Pnpm
    } else if value.contains("/node_modules/") {
        DshRuntimeSource::Npm
    } else {
        DshRuntimeSource::External
    }
}

fn wrapper_entry(wrapper: &Path) -> Option<PathBuf> {
    let direct = wrapper
        .parent()?
        .join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    if direct.is_file() {
        return Some(direct);
    }
    let content = fs::read_to_string(wrapper).ok()?;
    let normalized = content.replace('\\', "/");
    let marker = "node_modules/@deepseek-ai/dsh/lib/bin.js";
    let end = normalized.find(marker)? + marker.len();
    let prefix = &normalized[..end];
    let start = prefix
        .rfind(['\"', '\'', ' ', '='])
        .map_or(0, |index| index + 1);
    let raw = prefix[start..].trim_matches(['\"', '\'']);
    let candidate = if raw.contains("$basedir") || raw.contains("%dp0%") {
        wrapper.parent()?.join(marker)
    } else {
        PathBuf::from(raw)
    };
    candidate.is_file().then_some(candidate)
}

fn candidate_from_entry<R: Runtime>(app: &AppHandle<R>, entry: PathBuf) -> Option<DshRuntime> {
    if !entry.is_file() {
        return None;
    }
    let root = package_root(&entry)?;
    let managed_entry = super::get_dsh_install_path(app).join(DSH_ENTRY_RELATIVE);
    let source = classify(&entry, &managed_entry);
    let node_path = root
        .ancestors()
        .find_map(|dir| {
            let node = dir.join(if cfg!(windows) {
                "node.exe"
            } else {
                "bin/node"
            });
            node.is_file().then_some(node)
        })
        .unwrap_or_else(|| super::get_node_binary_path(app));
    let version = version_from_root(&root);
    let status = if version.is_none() {
        DshRuntimeStatus::InvalidPackage
    } else if !node_path.is_file() {
        DshRuntimeStatus::MissingNode
    } else if !node_compatible(&node_path) {
        DshRuntimeStatus::IncompatibleNode
    } else {
        DshRuntimeStatus::Ready
    };
    let writable = fs::metadata(&root)
        .map(|meta| !meta.permissions().readonly())
        .unwrap_or(false);
    let update_supported = matches!(
        source,
        DshRuntimeSource::Launcher | DshRuntimeSource::Npm | DshRuntimeSource::Pnpm
    );
    Some(DshRuntime {
        id: normalized_id(&entry),
        source,
        entry_path: entry,
        working_dir: root.clone(),
        node_path,
        version,
        status,
        writable,
        update_supported,
        selected: false,
    })
}

fn path_wrappers<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let launcher_bin = crate::service::cli::get_bin_dir(app);
    let mut wrappers = Vec::new();
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if normalized_id(&dir) == normalized_id(&launcher_bin) {
            continue;
        }
        if cfg!(windows) {
            wrappers.extend([
                dir.join("dsh.cmd"),
                dir.join("dsh.exe"),
                dir.join("dsh.ps1"),
            ]);
        } else {
            wrappers.push(dir.join("dsh"));
        }
    }
    wrappers
}

fn selected_id(runtimes: &[DshRuntime], configured: Option<&str>) -> Option<String> {
    configured
        .filter(|id| {
            runtimes
                .iter()
                .any(|runtime| runtime.id == *id && runtime.status == DshRuntimeStatus::Ready)
        })
        .map(str::to_owned)
        .or_else(|| {
            runtimes
                .iter()
                .find(|runtime| {
                    runtime.status == DshRuntimeStatus::Ready
                        && runtime.source != DshRuntimeSource::Launcher
                })
                .map(|runtime| runtime.id.clone())
        })
        .or_else(|| {
            runtimes
                .iter()
                .find(|runtime| runtime.status == DshRuntimeStatus::Ready)
                .map(|runtime| runtime.id.clone())
        })
}

pub fn discover<R: Runtime>(app: &AppHandle<R>) -> Vec<DshRuntime> {
    let setting = super::get_store_dat_setting(app);
    let managed_entry = super::get_dsh_install_path(app).join(DSH_ENTRY_RELATIVE);
    let mut entries = vec![managed_entry];
    entries.extend(path_wrappers(app).into_iter().filter_map(|wrapper| {
        if wrapper
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            None
        } else {
            wrapper_entry(&wrapper)
        }
    }));
    let mut seen = HashSet::new();
    let mut runtimes: Vec<_> = entries
        .into_iter()
        .filter_map(|entry| candidate_from_entry(app, entry))
        .filter(|runtime| seen.insert(runtime.id.clone()))
        .collect();
    let selected_id = selected_id(&runtimes, setting.active_dsh_runtime_id.as_deref());
    for runtime in &mut runtimes {
        runtime.selected = selected_id.as_deref() == Some(runtime.id.as_str());
    }
    runtimes
}

pub fn active<R: Runtime>(app: &AppHandle<R>) -> Option<DshRuntime> {
    discover(app).into_iter().find(|runtime| runtime.selected)
}

pub fn select<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<DshRuntime, String> {
    let runtime = discover(app)
        .into_iter()
        .find(|runtime| runtime.id == id)
        .ok_or_else(|| format!("DSH_RUNTIME_NOT_FOUND:{id}"))?;
    if runtime.status != DshRuntimeStatus::Ready {
        return Err("DSH_RUNTIME_INVALID:selected runtime is not usable".to_string());
    }
    let mut setting = super::get_store_dat_setting(app);
    setting.active_dsh_runtime_id = Some(runtime.id.clone());
    setting.installed = true;
    setting.dsh_web_capability_key = None;
    setting.dsh_web_supports_no_open = None;
    super::set_store_dat_setting(app, setting);
    Ok(DshRuntime {
        selected: true,
        ..runtime
    })
}

pub fn package_manager_executable(runtime: &DshRuntime) -> Option<PathBuf> {
    let names: &[&str] = match runtime.source {
        DshRuntimeSource::Npm if cfg!(windows) => &["npm.cmd"],
        DshRuntimeSource::Npm => &["npm"],
        DshRuntimeSource::Pnpm if cfg!(windows) => &["pnpm.cmd"],
        DshRuntimeSource::Pnpm => &["pnpm"],
        _ => return None,
    };
    for ancestor in runtime.working_dir.ancestors() {
        for name in names {
            let candidate = ancestor.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

/// Build an update invocation pinned to the selected installation instead of
/// relying on the package manager's process-global default prefix.
pub fn package_manager_update_args(runtime: &DshRuntime) -> Result<Vec<OsString>, String> {
    const PACKAGE: &str = "@deepseek-ai/dsh@latest";
    match runtime.source {
        DshRuntimeSource::Npm => {
            let node_modules = runtime
                .working_dir
                .ancestors()
                .find(|dir| dir.file_name().is_some_and(|name| name == "node_modules"))
                .ok_or_else(|| {
                    "DSH_RUNTIME_UPDATE_UNSUPPORTED:npm prefix could not be resolved".to_string()
                })?;
            let prefix = node_modules.parent().ok_or_else(|| {
                "DSH_RUNTIME_UPDATE_UNSUPPORTED:npm prefix could not be resolved".to_string()
            })?;
            Ok(vec![
                OsString::from("--prefix"),
                prefix.as_os_str().to_os_string(),
                OsString::from("install"),
                OsString::from("--global"),
                OsString::from(PACKAGE),
            ])
        }
        DshRuntimeSource::Pnpm => {
            let store = runtime
                .working_dir
                .ancestors()
                .find(|dir| dir.file_name().is_some_and(|name| name == ".pnpm"))
                .ok_or_else(|| {
                    "DSH_RUNTIME_UPDATE_UNSUPPORTED:pnpm global directory could not be resolved"
                        .to_string()
                })?;
            let global_dir = store.parent().ok_or_else(|| {
                "DSH_RUNTIME_UPDATE_UNSUPPORTED:pnpm global directory could not be resolved"
                    .to_string()
            })?;
            Ok(vec![
                OsString::from("--global-dir"),
                global_dir.as_os_str().to_os_string(),
                OsString::from("add"),
                OsString::from("--global"),
                OsString::from(PACKAGE),
            ])
        }
        _ => Err("DSH_RUNTIME_UPDATE_UNSUPPORTED:unknown installation source".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_root_is_found_from_cli_entry() {
        let entry = Path::new("x/node_modules/@deepseek-ai/dsh/lib/bin.js");
        assert_eq!(
            package_root(entry),
            Some(PathBuf::from("x/node_modules/@deepseek-ai/dsh"))
        );
    }

    #[test]
    fn normalized_ids_are_stable() {
        let first = normalized_id(Path::new("alpha/../alpha/dsh"));
        let second = normalized_id(Path::new("alpha/dsh"));
        assert_eq!(first, second);
    }

    fn runtime(id: &str, source: DshRuntimeSource, status: DshRuntimeStatus) -> DshRuntime {
        DshRuntime {
            id: id.to_string(),
            source,
            entry_path: PathBuf::from(id),
            working_dir: PathBuf::from(id),
            node_path: PathBuf::from("node"),
            version: Some("0.1.0".to_string()),
            status,
            writable: true,
            update_supported: true,
            selected: false,
        }
    }

    #[test]
    fn configured_ready_runtime_wins() {
        let runtimes = vec![
            runtime(
                "managed",
                DshRuntimeSource::Launcher,
                DshRuntimeStatus::Ready,
            ),
            runtime("npm", DshRuntimeSource::Npm, DshRuntimeStatus::Ready),
        ];
        assert_eq!(
            selected_id(&runtimes, Some("managed")).as_deref(),
            Some("managed")
        );
    }

    #[test]
    fn invalid_configured_runtime_falls_back_to_external_ready_runtime() {
        let runtimes = vec![
            runtime(
                "broken",
                DshRuntimeSource::Launcher,
                DshRuntimeStatus::MissingNode,
            ),
            runtime("npm", DshRuntimeSource::Npm, DshRuntimeStatus::Ready),
        ];
        assert_eq!(
            selected_id(&runtimes, Some("broken")).as_deref(),
            Some("npm")
        );
    }

    #[test]
    fn no_broken_runtime_is_selected() {
        let runtimes = vec![runtime(
            "broken",
            DshRuntimeSource::Npm,
            DshRuntimeStatus::IncompatibleNode,
        )];
        assert_eq!(selected_id(&runtimes, None), None);
    }

    #[test]
    fn package_manager_sources_are_inferred_from_package_layout() {
        let managed =
            Path::new("C:/launcher/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
        assert_eq!(
            classify(
                Path::new("C:/npm/node_modules/@deepseek-ai/dsh/lib/bin.js"),
                managed
            ),
            DshRuntimeSource::Npm
        );
        assert_eq!(
            classify(
                Path::new("C:/pnpm/global/5/.pnpm/pkg/node_modules/@deepseek-ai/dsh/lib/bin.js"),
                managed
            ),
            DshRuntimeSource::Pnpm
        );
    }

    #[test]
    fn npm_wrapper_resolves_adjacent_cli_entry() {
        let root = std::env::temp_dir().join(format!("dsh-runtime-test-{}", std::process::id()));
        let entry = root.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
        fs::create_dir_all(entry.parent().expect("entry parent")).expect("create fixture");
        fs::write(&entry, "#!/usr/bin/env node").expect("write entry");
        let wrapper = root.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
        fs::write(&wrapper, "wrapper").expect("write wrapper");
        assert_eq!(wrapper_entry(&wrapper), Some(entry));
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn npm_update_is_pinned_to_detected_prefix() {
        let mut runtime = runtime("npm", DshRuntimeSource::Npm, DshRuntimeStatus::Ready);
        runtime.working_dir = PathBuf::from("C:/node/node_modules/@deepseek-ai/dsh");
        let args = package_manager_update_args(&runtime).expect("npm args");
        assert_eq!(args[0], "--prefix");
        assert_eq!(args[1], Path::new("C:/node").as_os_str());
        assert_eq!(args[2], "install");
    }

    #[test]
    fn pnpm_update_is_pinned_to_detected_global_dir() {
        let mut runtime = runtime("pnpm", DshRuntimeSource::Pnpm, DshRuntimeStatus::Ready);
        runtime.working_dir = PathBuf::from(
            "C:/pnpm/global/5/.pnpm/pkg/node_modules/@deepseek-ai/dsh",
        );
        let args = package_manager_update_args(&runtime).expect("pnpm args");
        assert_eq!(args[0], "--global-dir");
        assert_eq!(args[1], Path::new("C:/pnpm/global/5").as_os_str());
        assert_eq!(args[2], "add");
    }
}
