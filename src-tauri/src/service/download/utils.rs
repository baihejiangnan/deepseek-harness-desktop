use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// 递归设置权限 (rwxr-xr-x)
#[cfg(unix)]
pub fn fix_recursive_permissions(path: &Path) -> io::Result<()> {
    // 设置当前路径权限
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)?;

    // 如果是目录，递归处理子项
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            fix_recursive_permissions(&entry?.path())?;
        }
    }
    Ok(())
}

const PRESERVE_DIRS: &[&str] = &["node_modules", ".git"];

pub fn flatten_directory(dest: &PathBuf) -> Result<(), String> {
    // 1. 寻找唯一合法的子目录
    let sub_dirs: Vec<PathBuf> = fs::read_dir(dest)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|path| {
            if !path.is_dir() {
                return false;
            }

            // 检查文件名（过滤隐藏文件和保留目录）
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|name| !name.starts_with('.') && !PRESERVE_DIRS.contains(&name))
                .unwrap_or(false)
        })
        .collect();

    // 如果不满足“只有一个子目录”的条件，直接返回
    if sub_dirs.len() != 1 {
        return Ok(());
    }

    let sub_dir = &sub_dirs[0];
    log::debug!("Flattening subdirectory: {:?}", sub_dir);

    // 2. 移动子目录下的内容
    for entry in fs::read_dir(sub_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let file_name = entry.file_name();
        let to = dest.join(&file_name);

        force_move(&from, &to).map_err(|e| {
            let msg = format!("Failed to move {:?} to {:?}: {}", from, to, e);
            log::error!("{}", msg);
            msg
        })?;
    }

    // 3. 清理空的子目录
    if let Err(e) = fs::remove_dir(sub_dir) {
        log::warn!("Could not remove empty directory {:?}: {}", sub_dir, e);
    }

    Ok(())
}

/// 辅助函数：强制移动文件或目录（如果目标存在则覆盖）
fn force_move(from: &Path, to: &Path) -> io::Result<()> {
    // 尝试直接重命名
    if let Err(err) = fs::rename(from, to) {
        // 如果失败是因为目标已存在 (通常是目录冲突或跨文件系统)
        if to.exists() {
            log::debug!("Target exists, removing: {:?}", to);
            if to.is_dir() {
                fs::remove_dir_all(to)?;
            } else {
                fs::remove_file(to)?;
            }
            // 删除目标后再次尝试重命名
            fs::rename(from, to)?;
        } else {
            return Err(err);
        }
    }
    Ok(())
}
