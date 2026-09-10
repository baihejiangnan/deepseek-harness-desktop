//! User-bound encrypted provider template storage. No secrets in list responses.
use super::providers::ProviderTemplate;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
pub(crate) struct StoredProvider {
    pub template: ProviderTemplate,
    pub api_key: String,
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| "PROVIDER_STORE_TOO_LARGE")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("PROVIDER_SECURE_STORAGE_FAILED".into());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

#[cfg(not(windows))]
fn crypt(_bytes: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> {
    Err("PROVIDER_SECURE_STORAGE_UNSUPPORTED".into())
}

fn read(path: &Path) -> Result<Vec<StoredProvider>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("PROVIDER_STORE_READ_FAILED".into()),
    };
    serde_json::from_slice(&crypt(&bytes, false)?).map_err(|_| "PROVIDER_STORE_INVALID".into())
}

fn write(path: &Path, entries: &[StoredProvider]) -> Result<(), String> {
    let data = serde_json::to_vec(entries).map_err(|_| "PROVIDER_STORE_INVALID")?;
    let encrypted = crypt(&data, true)?;
    let parent = path.parent().ok_or("PROVIDER_STORE_PATH_INVALID")?;
    std::fs::create_dir_all(parent).map_err(|_| "PROVIDER_STORE_WRITE_FAILED")?;
    let temp = path.with_extension("pending");
    std::fs::write(&temp, encrypted).map_err(|_| "PROVIDER_STORE_WRITE_FAILED")?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            let _ = std::fs::remove_file(&temp);
            return Err("PROVIDER_STORE_WRITE_FAILED".into());
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(temp, path).map_err(|_| "PROVIDER_STORE_WRITE_FAILED")?;
    Ok(())
}

pub fn list(path: &Path) -> Result<Vec<ProviderTemplate>, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(read(path)?
        .into_iter()
        .map(|entry| entry.template)
        .collect())
}

/// Blank keys retain the existing key on edit; creation requires a key.
pub fn save(
    path: &Path,
    template: ProviderTemplate,
    api_key: Option<String>,
    editing: bool,
) -> Result<(), String> {
    template.validate()?;
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read(path)?;
    let existing = entries
        .iter()
        .position(|entry| entry.template.id == template.id);
    match (editing, existing.is_some()) {
        (false, true) => return Err("PROVIDER_ID_CONFLICT".into()),
        (true, false) => return Err("PROVIDER_NOT_FOUND".into()),
        _ => {}
    }
    let api_key = api_key
        .filter(|key| !key.is_empty())
        .or_else(|| existing.map(|i| entries[i].api_key.clone()))
        .ok_or("PROVIDER_KEY_REQUIRED")?;
    if api_key.len() > 16384 || api_key.chars().any(char::is_control) {
        return Err("PROVIDER_KEY_INVALID".into());
    }
    let entry = StoredProvider { template, api_key };
    if let Some(index) = existing {
        entries[index] = entry;
    } else {
        entries.push(entry);
    }
    write(path, &entries)
}

pub fn remove(path: &Path, id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read(path)?;
    entries.retain(|entry| entry.template.id != id);
    write(path, &entries)
}

pub(crate) fn get(path: &Path, id: &str) -> Result<StoredProvider, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read(path)?
        .into_iter()
        .find(|entry| entry.template.id == id)
        .ok_or("PROVIDER_NOT_FOUND".into())
}

/// 重命名一条模板的 route key。密钥与其余字段留在**同一条记录**上，用户不必重新录入。
///
/// 这只改启动器模板库：已经写进实例的路由用的是实例自己的 dict key，
/// 既不会被改写，也不会被删除——之后再次应用这条模板才会写入新 key。
pub fn rename(path: &Path, from: &str, to: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read(path)?;
    let index = entries
        .iter()
        .position(|entry| entry.template.id == from)
        .ok_or("PROVIDER_NOT_FOUND")?;
    if entries.iter().any(|entry| entry.template.id == to) {
        return Err("PROVIDER_ID_CONFLICT".into());
    }
    let mut template = entries[index].template.clone();
    template.id = to.to_string();
    // 新 key 走与保存完全相同的规则：字符集、长度、保留 ID 一个都不为"重命名"放宽。
    template.validate()?;
    entries[index].template = template;
    write(path, &entries)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 每个用例一份独立的临时库文件，避免并行用例互相覆盖。
    fn temp_store(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "dsh-provider-{}-{}-{}.bin",
            tag,
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    fn route(id: &str) -> ProviderTemplate {
        ProviderTemplate {
            id: id.into(),
            name: "Test".into(),
            kind: crate::service::providers::ProviderTemplateKind::Custom,
            base_url: "https://example.com/v1".into(),
            protocol: "openai-completions".into(),
            model_id: "test-model".into(),
            models: vec![],
            model_overrides: vec![],
            selection: crate::service::providers::ProviderModelSelection::All,
            default_for_new: false,
        }
    }

    #[test]
    fn encrypted_store_roundtrip_edit_and_remove() {
        let path = temp_store("roundtrip");
        let mut template = route("test-route");
        save(&path, template.clone(), Some("secret-test-key".into()), false).unwrap();
        assert_eq!(save(&path, template.clone(), Some("replacement".into()), false).unwrap_err(), "PROVIDER_ID_CONFLICT");
        assert!(
            !String::from_utf8_lossy(&std::fs::read(&path).unwrap()).contains("secret-test-key")
        );
        assert_eq!(get(&path, "test-route").unwrap().api_key, "secret-test-key");
        template.default_for_new = true;
        save(&path, template.clone(), None, true).unwrap();
        assert!(list(&path).unwrap()[0].default_for_new);
        assert_eq!(get(&path, "test-route").unwrap().api_key, "secret-test-key");
        remove(&path, "test-route").unwrap();
        assert_eq!(save(&path, template, Some("replacement".into()), true).unwrap_err(), "PROVIDER_NOT_FOUND");
        assert!(list(&path).unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }

    /// 重命名的全部价值在于"换 key 不换记录"：密钥留在同一条条目上跟着走，
    /// 用户不必为了改个名字先删掉模板再重新录入。
    #[test]
    fn rename_moves_the_record_and_keeps_the_credential() {
        let path = temp_store("rename");
        save(&path, route("old-route"), Some("carry-me".into()), false).unwrap();
        save(&path, route("taken-route"), Some("other-key".into()), false).unwrap();

        // 四种拒绝都必须发生在写盘之前，库里的两条记录一条都不许动。
        assert_eq!(rename(&path, "old-route", "taken-route").unwrap_err(), "PROVIDER_ID_CONFLICT");
        assert_eq!(rename(&path, "ghost", "anything").unwrap_err(), "PROVIDER_NOT_FOUND");
        assert_eq!(rename(&path, "old-route", "Bad Key!").unwrap_err(), "PROVIDER_ID_INVALID");
        assert_eq!(rename(&path, "old-route", "deepseek-official").unwrap_err(), "PROVIDER_ID_RESERVED");
        let ids = |path: &std::path::Path| list(path).unwrap().into_iter().map(|item| item.id).collect::<Vec<_>>();
        assert_eq!(ids(&path), ["old-route", "taken-route"]);

        rename(&path, "old-route", "renamed-route").unwrap();
        assert_eq!(get(&path, "renamed-route").unwrap().api_key, "carry-me");
        assert!(get(&path, "old-route").is_err());
        assert_eq!(get(&path, "taken-route").unwrap().api_key, "other-key");
        std::fs::remove_file(path).unwrap();
    }
}
