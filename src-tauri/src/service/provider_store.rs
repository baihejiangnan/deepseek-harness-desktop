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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn encrypted_store_roundtrip_edit_and_remove() {
        let path = std::env::temp_dir().join(format!(
            "dsh-provider-test-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut template = ProviderTemplate {
            id: "test-route".into(),
            name: "Test".into(),
            base_url: "https://example.com/v1".into(),
            protocol: "openai-completions".into(),
            model_id: "test-model".into(),
            models: vec![],
            default_for_new: false,
        };
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
}
