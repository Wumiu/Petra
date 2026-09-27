//! Linux 回收站：遵循 freedesktop.org Trash 规范。
//!
//! 优先 gio trash：它是 GLib 自带实现，自己按规范写 info/ 元数据，
//! 并且能处理跨卷（同卷 rename，跨卷复制后删除）。
//! gio 不存在时退回手工实现：把文件 rename 进 $XDG_DATA_HOME/Trash/files
//! （默认 ~/.local/share/Trash/files），并在 .../info 写一份同名 .trashinfo
//! （Path 用百分号编码的绝对路径、DeletionDate 用本地时间）。
//! 不用 rm：那是真删，文件管理器里没有"放回原处"。
//!
//! 系统目录一律拒绝，思路与 Windows 版拦 WINDIR / Program Files、
//! macOS 版拦 /System 一致。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 系统目录：绝不删除。
fn is_system_path(p: &str) -> bool {
    // 根目录本身（"/"）不删
    if Path::new(p).parent().is_none() {
        return true;
    }
    // 家目录本身不删：下面的系统目录列表管不到 /home/<user>，
    // 误删整个家目录的后果比误删 /usr 更严重。
    if let Some(home) = home_dir() {
        if Path::new(p) == home.as_path() {
            return true;
        }
    }
    const SYSTEM_ROOTS: &[&str] = &[
        "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/boot", "/sys",
        "/proc", "/dev", "/run", "/var", "/opt", "/srv", "/root", "/lost+found",
    ];
    let lower = p.to_lowercase();
    SYSTEM_ROOTS
        .iter()
        .any(|root| lower == *root || lower.starts_with(&format!("{root}/")))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// 回收站的两个目录：files（文件本体）与 info（.trashinfo 元数据），不存在则创建。
fn trash_dirs() -> Result<(PathBuf, PathBuf), String> {
    let base = match std::env::var_os("XDG_DATA_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home_dir()
            .ok_or_else(|| "无法确定用户主目录（HOME 未设置）".to_string())?
            .join(".local")
            .join("share"),
    };
    let root = base.join("Trash");
    let files = root.join("files");
    let info = root.join("info");
    std::fs::create_dir_all(&files).map_err(|e| format!("无法创建回收站目录: {e}"))?;
    std::fs::create_dir_all(&info).map_err(|e| format!("无法创建回收站目录: {e}"))?;
    Ok((files, info))
}

/// 同名条目已存在时在扩展名前加序号，绝不覆盖回收站里已有的文件；
/// files 与 info 两侧用同一个基名，保证文件管理器能配对上。
fn unique_target(files: &Path, info: &Path, name: &std::ffi::OsStr) -> (PathBuf, PathBuf) {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 0..1000u32 {
        let candidate = if n == 0 {
            format!("{stem}{ext}")
        } else {
            format!("{stem}.{n}{ext}")
        };
        let f = files.join(&candidate);
        let i = info.join(format!("{candidate}.trashinfo"));
        if !f.exists() && !i.exists() {
            return (f, i);
        }
    }
    let fallback = format!("{stem}.{}{ext}", std::process::id());
    (
        files.join(&fallback),
        info.join(format!("{fallback}.trashinfo")),
    )
}

/// freedesktop 规范要求 .trashinfo 的 Path 是 URL 编码的绝对路径。
/// 只保留 RFC 3986 的 unreserved 集合与路径分隔符 /。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn write_trashinfo(info_path: &Path, src: &Path) -> Result<(), String> {
    let abs = if src.is_absolute() {
        src.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("无法确定当前目录: {e}"))?
            .join(src)
    };
    let date = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S");
    let content = format!(
        "[Trash Info]\nPath={}\nDeletionDate={date}\n",
        percent_encode(&abs.to_string_lossy())
    );
    std::fs::write(info_path, content).map_err(|e| format!("写入回收站元数据失败: {e}"))
}

/// 手工实现（gio 不存在时）：先写 .trashinfo 再 rename。
/// 顺序不能反：先移动后写元数据的话，中途失败会留下一个无法"放回原处"的孤儿文件；
/// 反过来最坏只留下一条指向不存在文件的空记录，文件管理器会忽略它。
fn manual_trash(src: &Path) -> Result<(), String> {
    let (files, info) = trash_dirs()?;
    let name = src
        .file_name()
        .ok_or_else(|| format!("路径无效：{}", src.display()))?;
    let (dst, info_path) = unique_target(&files, &info, name);
    write_trashinfo(&info_path, src)?;
    match std::fs::rename(src, &dst) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&info_path);
            Err(format!("移入回收站失败（{}）：{e}", src.display()))
        }
    }
}

/// gio 是否存在（缓存一次；PATH 不会在进程内变化到需要重复探测）。
fn gio_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::process::Command::new("gio")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

fn gio_trash(path: &str) -> Result<(), String> {
    // -- 终止选项解析：路径以 - 开头时不会被 gio 当成开关
    let out = std::process::Command::new("gio")
        .args(["trash", "--", path])
        .output()
        .map_err(|e| format!("启动 gio 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("移入回收站失败（{path}）：gio 退出码 {}", out.status)
        } else {
            format!("移入回收站失败（{path}）：{err}")
        })
    }
}

/// 将文件移入回收站（可撤销），返回实际处理的文件数。
pub fn move_to_recycle_bin(paths: &[String]) -> Result<usize, String> {
    let allowed: Vec<&String> = paths.iter().filter(|p| !is_system_path(p)).collect();

    if allowed.is_empty() {
        return Err("被拒绝：不删操作系统文件".into());
    }

    let use_gio = gio_available();
    let mut moved = 0usize;
    let mut first_error: Option<String> = None;

    for p in allowed {
        let src = Path::new(p);
        if !src.exists() {
            first_error.get_or_insert_with(|| format!("文件不存在：{p}"));
            continue;
        }
        let result = if use_gio {
            gio_trash(p)
        } else {
            manual_trash(src)
        };
        match result {
            Ok(()) => moved += 1,
            Err(e) => {
                crate::log_warn(&format!("trash: {p} 移入回收站失败: {e}"));
                first_error.get_or_insert(e);
            }
        }
    }

    // 一个都没成功时按失败上报，避免前端误报"已删除 N 个"
    if moved == 0 {
        return Err(first_error.unwrap_or_else(|| "删除失败".into()));
    }
    Ok(moved)
}
