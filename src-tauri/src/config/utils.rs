use std::path::{Path, PathBuf};

/// 生成不冲突的下载路径：目标已存在时按 `name (n).ext` 递增命名，
/// 与浏览器下载管理器的重名行为保持一致。
///
/// `destination` 是 WebView2 给出的默认保存路径（系统下载目录 + 文件名），
/// 父目录不存在时回退到 `%USERPROFILE%\Downloads`。
pub fn unique_download_path(destination: &Path) -> PathBuf {
    use std::env;

    let dir = match destination.parent() {
        Some(parent) if parent.is_dir() => parent.to_path_buf(),
        // 下载目录不存在（如被用户删除）时兜底到 USERPROFILE\Downloads
        _ => env::var("USERPROFILE")
            .map(PathBuf::from)
            .map(|home| home.join("Downloads"))
            .unwrap_or_else(|_| PathBuf::from(".")),
    };
    let name = destination
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    // 拆分主名与扩展名，重名时在扩展名前插入 " (n)"
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{ext}")),
        None => (name.to_string(), String::new()),
    };
    let mut counter = 0usize;
    loop {
        let candidate = if counter == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({counter}){ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

/// 递归搜索 node 二进制文件
pub fn search_node_binary(dir: &PathBuf, target: &str) -> Option<PathBuf> {
    use std::fs;

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // 递归搜索子目录
                if let Some(found) = search_node_binary(&path, target) {
                    return Some(found);
                }
            } else if path.file_name().and_then(|n| n.to_str()) == Some("node")
                || path.file_name().and_then(|n| n.to_str()) == Some("node.exe")
            {
                // 找到 node 或 node.exe 文件
                return Some(path);
            }
        }
    }

    // 如果没找到，尝试拼接目标路径
    let candidate = dir.join(target);
    if candidate.exists() {
        return Some(candidate);
    }

    None
}
