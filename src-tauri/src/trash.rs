use windows::Win32::UI::Shell::{
    SHFileOperationW, SHFILEOPSTRUCTW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOERRORUI, FOF_NOCONFIRMATION,
    FOF_SILENT,
};

fn is_system_path(p: &str) -> bool {
    let norm = p.to_lowercase();
    if norm.len() <= 3 && norm.ends_with('\\') && norm.chars().nth(1) == Some(':') {
        return true;
    }
    if let Some(windir) = std::env::var_os("WINDIR") {
        if let Some(w) = windir.to_str() {
            if norm == w.to_lowercase() {
                return true;
            }
        }
    }
    let system32 = format!(
        "{}\\System32",
        std::env::var_os("WINDIR")
            .unwrap_or_else(|| std::ffi::OsString::from("C:\\Windows"))
            .to_string_lossy()
    )
    .to_lowercase();
    norm.starts_with(&system32)
}

/// 将文件移入回收站（可撤销），返回实际处理的文件数。
pub fn move_to_recycle_bin(paths: &[String]) -> Result<usize, String> {
    let allowed: Vec<String> = paths
        .iter()
        .filter(|p| !is_system_path(p))
        .cloned()
        .collect();

    if allowed.is_empty() {
        return Err("被拒绝：不删操作系统文件".into());
    }

    // pFrom 格式：路径1\0路径2\0\0（路径间单 \0，结尾双 \0 终止）
    let mut buf: Vec<u16> = Vec::new();
    for p in &allowed {
        buf.extend(p.encode_utf16());
        buf.push(0);
    }
    buf.push(0);

    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = windows::core::PCWSTR(buf.as_ptr());
    op.fFlags = (FOF_ALLOWUNDO.0 | FOF_SILENT.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0) as u16;

    let result = unsafe { SHFileOperationW(&mut op) };
    if result != 0 {
        return Err(format!("删除失败 (0x{:08X})", result));
    }
    Ok(allowed.len())
}