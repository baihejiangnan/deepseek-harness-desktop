use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use zip::write::FileOptions;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileExportInput {
    pub instance_id: String,
    pub include_profile: bool,
    pub include_plugins: bool,
    pub include_sessions: bool,
}

fn add_directory<W: Write + std::io::Seek>(
    archive: &mut zip::ZipWriter<W>,
    root: &Path,
    current: &Path,
    options: FileOptions,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|error| format!("EXPORT_READ_DIR: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("EXPORT_READ_ENTRY: {error}"))?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("EXPORT_RELATIVE_PATH: {error}"))?;
        let name = relative.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            archive
                .add_directory(format!("{name}/"), options)
                .map_err(|error| format!("EXPORT_ADD_DIRECTORY: {error}"))?;
            add_directory(archive, root, &path, options)?;
        } else {
            let mut file =
                fs::File::open(&path).map_err(|error| format!("EXPORT_OPEN: {error}"))?;
            archive
                .start_file(name, options)
                .map_err(|error| format!("EXPORT_START_FILE: {error}"))?;
            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)
                .map_err(|error| format!("EXPORT_READ_FILE: {error}"))?;
            archive
                .write_all(&buffer)
                .map_err(|error| format!("EXPORT_WRITE_FILE: {error}"))?;
        }
    }
    Ok(())
}

pub async fn export_profile(
    app_handle: AppHandle,
    input: ProfileExportInput,
) -> Result<String, String> {
    let instance = crate::config::instance::find(&app_handle, &input.instance_id)?;
    if !input.include_profile && !input.include_plugins && !input.include_sessions {
        return Err("EXPORT_EMPTY: select profile, plugins, or sessions to export".to_string());
    }

    let profile_dir = instance.dsh_home.join("profiles").join(&instance.profile);
    // Session-only exports remain useful even when a profile has not been
    // initialized yet, so require the profile directory only for profile or
    // plugin exports.
    if (input.include_profile || input.include_plugins) && !profile_dir.is_dir() {
        return Err("EXPORT_PROFILE_NOT_FOUND: profile directory does not exist".to_string());
    }

    let destination = rfd::AsyncFileDialog::new()
        .set_title("Export DSH Profile")
        .set_file_name(format!("{}-{}-export.zip", instance.name, instance.profile))
        .add_filter("ZIP archive", &["zip"])
        .save_file()
        .await
        .ok_or_else(|| "EXPORT_CANCELLED".to_string())?;
    let destination = PathBuf::from(destination.path());
    let file = fs::File::create(&destination).map_err(|error| format!("EXPORT_CREATE: {error}"))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    if input.include_profile {
        for filename in ["package.json", "pnpm-workspace.yaml", "cordis.patch.yml"] {
            let path = profile_dir.join(filename);
            if path.is_file() {
                let mut file =
                    fs::File::open(&path).map_err(|error| format!("EXPORT_OPEN: {error}"))?;
                archive
                    .start_file(format!("profile/{filename}"), options)
                    .map_err(|error| format!("EXPORT_START_FILE: {error}"))?;
                let mut buffer = Vec::new();
                file.read_to_end(&mut buffer)
                    .map_err(|error| format!("EXPORT_READ_FILE: {error}"))?;
                archive
                    .write_all(&buffer)
                    .map_err(|error| format!("EXPORT_WRITE_FILE: {error}"))?;
            }
        }
    }
    if input.include_plugins {
        let plugins_dir = profile_dir.join("node_modules");
        if plugins_dir.is_dir() {
            add_directory(&mut archive, &profile_dir, &plugins_dir, options)?;
        }
    }
    if input.include_sessions {
        let sessions_dir = instance.dsh_home.join("sessions");
        if sessions_dir.is_dir() {
            add_directory(&mut archive, &instance.dsh_home, &sessions_dir, options)?;
        }
    }
    archive
        .finish()
        .map_err(|error| format!("EXPORT_FINISH: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

/// Export the complete DSH_HOME before a destructive Home-level removal.
/// The archive intentionally contains the full Home (including credentials and
/// root settings) so that restoring it preserves all instances that pointed to
/// this Home, not just the instance that opened the export page.
pub async fn export_instance_home(
    app_handle: AppHandle,
    instance_id: &str,
) -> Result<String, String> {
    let impact = crate::config::instance::removal_impact(&app_handle, instance_id)?;
    let destination = rfd::AsyncFileDialog::new()
        .set_title("Export complete DSH Home")
        .set_file_name(format!("dsh-home-{}-backup.zip", instance_id))
        .add_filter("ZIP archive", &["zip"])
        .save_file()
        .await
        .ok_or_else(|| "EXPORT_CANCELLED".to_string())?;
    let destination = PathBuf::from(destination.path());

    // Never allow the backup file to be created inside the directory that is
    // about to be removed; otherwise the archive would be deleted with it and
    // recursive traversal could include the archive itself.
    let home = crate::config::instance::normalize_home_for_export(&impact.dsh_home)?;
    let destination_parent = destination
        .parent()
        .ok_or_else(|| "EXPORT_DESTINATION_INVALID: missing parent directory".to_string())?;
    let destination_parent = dunce::canonicalize(destination_parent)
        .unwrap_or_else(|_| destination_parent.to_path_buf());
    if destination_parent == home || destination_parent.starts_with(&home) {
        return Err(
            "EXPORT_DESTINATION_INSIDE_HOME: choose a location outside DSH_HOME".to_string(),
        );
    }
    if !home.is_dir() {
        return Err("EXPORT_HOME_NOT_FOUND: DSH_HOME directory does not exist".to_string());
    }

    let file = fs::File::create(&destination).map_err(|error| format!("EXPORT_CREATE: {error}"))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let manifest = serde_json::json!({
        "format": "deepseek-harness-desktop.dsh-home-backup",
        "version": 1,
        "dshHome": impact.dsh_home.to_string_lossy(),
        "profiles": &impact.profiles,
        "instances": impact.instances.iter().map(|instance| serde_json::json!({
            "id": &instance.id,
            "name": &instance.name,
            "profile": &instance.profile,
            "version": &instance.version,
            "favorite": instance.favorite,
            "createdAt": instance.created_at,
        })).collect::<Vec<_>>(),
    });
    let manifest = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("EXPORT_MANIFEST_SERIALIZE: {error}"))?;
    archive
        .start_file("manifest.json", options)
        .map_err(|error| format!("EXPORT_START_FILE: {error}"))?;
    archive
        .write_all(&manifest)
        .map_err(|error| format!("EXPORT_WRITE_MANIFEST: {error}"))?;
    add_directory(&mut archive, &home, &home, options)?;
    archive
        .finish()
        .map_err(|error| format!("EXPORT_FINISH: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}
