use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use zip::write::FileOptions;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileExportInput {
    pub instance_id: String,
    pub include_profile: bool,
    pub include_plugins: bool,
    pub include_sessions: bool,
}

const EXPORT_PROGRESS_EVENT: &str = "export-progress";
/// 大目录里每个文件都会记账，事件必须节流，否则前端会被进度淹没。
const EXPORT_PROGRESS_INTERVAL: Duration = Duration::from_millis(160);
static EXPORT_CANCEL: AtomicBool = AtomicBool::new(false);
static EXPORT_ACTIVE: Mutex<Option<String>> = Mutex::new(None);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub instance_id: String,
    /// 阶段名而非路径：Home 内部的目录与会话文件名不回传前端。
    pub stage: String,
    pub files: u64,
    pub bytes: u64,
}

/// 导出槽位的持有者；离开作用域即释放，错误与取消路径同样释放。
struct ExportSlot {
    instance_id: String,
}

impl Drop for ExportSlot {
    fn drop(&mut self) {
        let mut active = EXPORT_ACTIVE.lock().unwrap_or_else(|error| error.into_inner());
        if active.as_deref() == Some(self.instance_id.as_str()) {
            *active = None;
        }
    }
}

struct ExportReporter<'a> {
    app: &'a AppHandle,
    instance_id: String,
    stage: &'static str,
    files: u64,
    bytes: u64,
    last_emit: Instant,
}

/// 占用导出槽位。文件对话框之后调用：用户取消对话框不算一次导出。
fn begin_export<'a>(app: &'a AppHandle, instance_id: &str) -> Result<(ExportSlot, ExportReporter<'a>), String> {
    {
        let mut active = EXPORT_ACTIVE.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(running) = active.as_deref() {
            return Err(format!("EXPORT_ALREADY_RUNNING:{running}"));
        }
        *active = Some(instance_id.to_string());
    }
    EXPORT_CANCEL.store(false, Ordering::SeqCst);
    Ok((
        ExportSlot { instance_id: instance_id.to_string() },
        ExportReporter {
            app,
            instance_id: instance_id.to_string(),
            stage: "prepare",
            files: 0,
            bytes: 0,
            last_emit: Instant::now(),
        },
    ))
}

/// 请求取消，必须命中当前正在导出的实例；没有导出在跑时明确报错而不是静默成功。
pub fn request_cancel(instance_id: &str) -> Result<(), String> {
    let active = EXPORT_ACTIVE.lock().unwrap_or_else(|error| error.into_inner());
    match active.as_deref() {
        None => Err("EXPORT_NOT_RUNNING".to_string()),
        Some(running) if running != instance_id => Err(format!("EXPORT_INSTANCE_MISMATCH:{running}")),
        Some(_) => {
            EXPORT_CANCEL.store(true, Ordering::SeqCst);
            Ok(())
        }
    }
}

impl ExportReporter<'_> {
    fn set_stage(&mut self, stage: &'static str) {
        self.stage = stage;
        self.emit(true);
    }

    /// 每打包一个文件调用一次；取消只在这里生效，否则大目录要压到结束才响应。
    fn record(&mut self, bytes: u64) -> Result<(), String> {
        if EXPORT_CANCEL.load(Ordering::SeqCst) {
            return Err("EXPORT_CANCELLED_BY_USER".to_string());
        }
        self.files += 1;
        self.bytes += bytes;
        self.emit(false);
        Ok(())
    }

    fn emit(&mut self, force: bool) {
        if !force && self.last_emit.elapsed() < EXPORT_PROGRESS_INTERVAL {
            return;
        }
        self.last_emit = Instant::now();
        let _ = self.app.emit(
            EXPORT_PROGRESS_EVENT,
            ExportProgress {
                instance_id: self.instance_id.clone(),
                stage: self.stage.to_string(),
                files: self.files,
                bytes: self.bytes,
            },
        );
    }
}

fn add_directory<W: Write + std::io::Seek>(
    archive: &mut zip::ZipWriter<W>,
    root: &Path,
    current: &Path,
    options: FileOptions,
    reporter: &mut ExportReporter<'_>,
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
            add_directory(archive, root, &path, options, reporter)?;
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
            reporter.record(buffer.len() as u64)?;
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
    let (_slot, mut reporter) = begin_export(&app_handle, &input.instance_id)?;
    let written = write_profile_archive(
        &destination,
        &instance.dsh_home,
        &profile_dir,
        &input,
        &mut reporter,
    );
    if written.is_err() {
        // 失败与取消都会留下半个压缩包，必须删掉，否则用户会误以为备份已完成。
        let _ = fs::remove_file(&destination);
    }
    written?;
    reporter.set_stage("finish");
    Ok(destination.to_string_lossy().into_owned())
}

fn write_profile_archive(
    destination: &Path,
    dsh_home: &Path,
    profile_dir: &Path,
    input: &ProfileExportInput,
    reporter: &mut ExportReporter<'_>,
) -> Result<(), String> {
    let file = fs::File::create(destination).map_err(|error| format!("EXPORT_CREATE: {error}"))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    if input.include_profile {
        reporter.set_stage("profile");
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
                reporter.record(buffer.len() as u64)?;
            }
        }
    }
    if input.include_plugins {
        let plugins_dir = profile_dir.join("node_modules");
        if plugins_dir.is_dir() {
            reporter.set_stage("plugins");
            add_directory(&mut archive, profile_dir, &plugins_dir, options, reporter)?;
        }
    }
    if input.include_sessions {
        let sessions_dir = dsh_home.join("sessions");
        if sessions_dir.is_dir() {
            reporter.set_stage("sessions");
            add_directory(&mut archive, dsh_home, &sessions_dir, options, reporter)?;
        }
    }
    archive
        .finish()
        .map_err(|error| format!("EXPORT_FINISH: {error}"))?;
    Ok(())
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
    let (_slot, mut reporter) = begin_export(&app_handle, instance_id)?;
    let written = write_home_archive(&destination, &home, &manifest, &mut reporter);
    if written.is_err() {
        // 取消或失败留下的半份备份比没有备份更危险，必须删除。
        let _ = fs::remove_file(&destination);
    }
    written?;
    reporter.set_stage("finish");
    Ok(destination.to_string_lossy().into_owned())
}

fn write_home_archive(
    destination: &Path,
    home: &Path,
    manifest: &[u8],
    reporter: &mut ExportReporter<'_>,
) -> Result<(), String> {
    let file = fs::File::create(destination).map_err(|error| format!("EXPORT_CREATE: {error}"))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    archive
        .start_file("manifest.json", options)
        .map_err(|error| format!("EXPORT_START_FILE: {error}"))?;
    archive
        .write_all(manifest)
        .map_err(|error| format!("EXPORT_WRITE_MANIFEST: {error}"))?;
    reporter.record(manifest.len() as u64)?;
    reporter.set_stage("home");
    add_directory(&mut archive, home, home, options, reporter)?;
    archive
        .finish()
        .map_err(|error| format!("EXPORT_FINISH: {error}"))?;
    Ok(())
}
