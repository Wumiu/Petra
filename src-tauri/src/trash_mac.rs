//! macOS 回收站：把文件移动到 ~/.Trash（Finder 里还能「放回原处」）。
//!
//! Windows 版走 SHFileOperationW + FOF_ALLOWUNDO；macOS 上没有等价的一步式 API
//! （NSFileManager 的 trashItem 需要 ObjC 绑定），所以直接用 rename 移进 ~/.Trash。
//! 系统目录一律拒绝，思路与 Windows 版拦 WINDIR / Program Files 一致。

use std::path::{Path, PathBuf};

/// 系统目录：绝不删除。macOS 上即使有权限也不该让桌宠去动这些地方。
fn is_system_path(p: &str) -> bool {
    // 根目录本身（"/"）不删
    if Path::new(p).parent().is_none() {
        return true;
    }
    const SYSTEM_ROOTS: &[&str] = &[
        "/system",
        "/usr",
        "/bin",
        "/sbin",
        "/private",
        "/library",
        "/applications",
        "/cores",
        "/dev",
        "/volumes",
        "/network",
    ];
    let lower = p.to_lowercase();
    SYSTEM_ROOTS
        .iter()
        .any(|root| lower == *root || lower.starts_with(&format!("{root}/")))
}

/// 回收站目录（~/.Trash），不存在则创建。
fn trash_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "无法确定用户主目录（HOME 未设置）".to_string())?;
    let dir = home.join(".Trash");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建回收站目录: {e}"))?;
    Ok(dir)
}

/// 同名文件已存在时加时间戳后缀，绝不覆盖回收站里已有的同名文件。
fn unique_target(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S");
    for n in 0..1000u32 {
        let suffix = if n == 0 { String::new() } else { format!("-{n}") };
        let candidate = dir.join(format!("{stem} {stamp}{suffix}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} {stamp}-{}", std::process::id()))
}

/// 将文件移入回收站（可撤销），返回实际处理的文件数。
pub fn move_to_recycle_bin(paths: &[String]) -> Result<usize, String> {
    let allowed: Vec<&String> = paths.iter().filter(|p| !is_system_path(p)).collect();

    if allowed.is_empty() {
        return Err("被拒绝：不删操作系统文件".into());
    }

    let dir = trash_dir()?;
    let mut moved = 0usize;
    let mut first_error: Option<String> = None;

    for p in allowed {
        let src = Path::new(p);
        if !src.exists() {
            first_error.get_or_insert_with(|| format!("文件不存在：{p}"));
            continue;
        }
        let Some(name) = src.file_name() else {
            first_error.get_or_insert_with(|| format!("路径无效：{p}"));
            continue;
        };
        let dst = unique_target(&dir, name);
        // rename 在同一卷内是原子操作。跨卷（文件在别的磁盘上）会失败，这里如实报错，
        // 不做「复制 + 删除」：那对大目录会长时间卡住，而且中途失败会留下半个文件。
        match std::fs::rename(src, &dst) {
            Ok(()) => moved += 1,
            Err(e) => {
                crate::log_warn(&format!("trash: {p} 移入回收站失败: {e}"));
                first_error.get_or_insert_with(|| format!("移入回收站失败（{p}）：{e}"));
            }
        }
    }

    // 一个都没成功时按失败上报，避免前端误报"已删除 N 个"
    if moved == 0 {
        return Err(first_error.unwrap_or_else(|| "删除失败".into()));
    }
    Ok(moved)
}
