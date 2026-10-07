//! 小助手的文件能力：新建 / 读取 / 写入 / 精确替换 / 列目录。
//!
//! 「用默认程序打开文件」不在本模块 —— 已有的 `open_path` 就干这个，直接复用。
//!
//! # 安全模型（这是本模块的重点，不是附属）
//!
//! 把"写磁盘"的能力交给 AI，等于递给它一把能改用户文件的刀。边界必须画在 **Rust 侧**：
//! 前端可能被模型的话术诱导，Rust 侧不能只信前端传了什么。
//!
//! 1. **只接受绝对路径**。相对路径一律拒绝 —— AI 无法可靠地知道"当前目录"，
//!    而"相对于哪儿"正是最容易出意外的地方。
//! 2. **规范化之后再判定**。新建多级路径时末尾几段还不存在，`canonicalize` 会失败，
//!    所以先找到"最近的存在祖先"再 canonicalize，然后把剩下几段拼回去。这样 `..`
//!    会被展开、符号链接会被解引用，判定落在**真实位置**上。另外路径里出现 `..` 段
//!    直接拒绝（纵深防御，报错也更好懂）。
//! 3. **允许根只有三个常用目录**：桌面 / 文档 / 下载。用 Tauri 的 known-folder 取
//!    （Windows 上桌面可能被重定向到 `D:\桌面` 这种位置，自己拼 `%USERPROFILE%\Desktop`
//!    会取错地方）。
//! 4. **禁止表**在内置敏感项之外，还接受用户在设置里加的目录（文件禁止目录）。
//!    禁止表**优先于**允许根：命中即拒绝。`.git` 一律不碰 —— 改坏仓库元数据比改坏
//!    文件更难恢复。
//! 5. **可执行/脚本类后缀不许新建**（exe / bat / ps1 / lnk…）。改用户**已有**的这类
//!    文件不拦：那是他本来就有的东西，而且是他明确要求的；拦的是"凭空造一个"。
//! 6. **覆盖已有文件前先备份**成 `xxx.petra-bak`，改错了能直接还原。
//! 7. 读有字节上限与行区间，写有字节上限；超限**如实报错**，不静默截断。
//!
//! 判定核心 `guard_with` 不依赖 `AppHandle`（roots/deny 由调用方传入），所以安全逻辑
//! 可以直接单测 —— 见文件末尾的 tests。

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::log_line;

/// 单次读取的字节上限（超出后按行截断，并在结果里说明）
const MAX_READ_BYTES: u64 = 512 * 1024;
/// 单次写入的字节上限（防止模型一次灌爆磁盘）
const MAX_WRITE_BYTES: usize = 1024 * 1024;
/// 默认返回行数 / 上限
const DEFAULT_MAX_LINES: usize = 200;
const MAX_LINES: usize = 2000;
/// 列目录最多返回多少条
const MAX_DIR_ENTRIES: usize = 300;
/// 覆盖前的备份后缀
pub const BACKUP_SUFFIX: &str = ".petra-bak";

/// 禁止**新建**的可执行 / 脚本类后缀。
/// 只拦"凭空造一个"：用户已有的这类文件允许改（他明确要求了，改前还会备份）。
const FORBIDDEN_NEW_EXT: &[&str] = &[
    "exe", "dll", "sys", "scr", "com", "pif", "cpl", "msi", "msp", "bat", "cmd", "ps1", "psm1",
    "vbs", "vbe", "jse", "wsf", "wsh", "hta", "lnk", "reg", "inf", "scf", "jar", "apk", "dmg",
    "app", "sh", "bash",
];

/// Windows 保留设备名：这些名字建不出来（或建出来是设备）
const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// 文本编码：只区分"UTF-8"与"系统 ANSI 代码页"（简中即 GBK）。
/// 读写都要记住原编码，否则把一个 GBK 文件写成 UTF-8，别的程序就看不懂了。
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TextEncoding {
    Utf8,
    Ansi,
}

impl TextEncoding {
    fn label(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "UTF-8",
            TextEncoding::Ansi => "系统 ANSI 代码页（简中即 GBK）",
        }
    }
}

#[derive(Serialize)]
pub struct ReadResult {
    pub path: String,
    pub encoding: String,
    /// 文件总字节数
    pub bytes: u64,
    /// 文件总行数
    pub total_lines: usize,
    /// 本次返回的第一行（1 基）
    pub start_line: usize,
    pub content: String,
    /// true = 文件太大或行数太多，只返回了一部分（可带 start_line 再读一段）
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    /// "dir" / "file" / "link"
    pub kind: String,
    pub size: u64,
}

#[derive(Serialize)]
pub struct ListResult {
    pub path: String,
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
}

/// 路径判定结果
#[derive(Debug)]
pub struct Guarded {
    /// 规范化后的真实路径（读写都用它）
    pub real: PathBuf,
    /// 给用户看的路径（保留模型写的那份写法）
    pub shown: String,
}

// ==================== 允许根 / 禁止表 ====================

/// 允许的根目录：桌面 / 文档 / 下载。
/// 用 Tauri 的 known-folder（Windows 走 SHGetKnownFolderPath），能正确处理被重定向的桌面。
pub fn allowed_roots(app: &AppHandle) -> Vec<PathBuf> {
    let p = app.path();
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in [p.desktop_dir(), p.document_dir(), p.download_dir()] {
        if let Ok(d) = dir {
            if let Ok(c) = d.canonicalize() {
                if !out.contains(&c) {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// 禁止访问的目录：内置敏感项 + 用户设置里的「文件禁止目录」。
pub fn denied_paths(app: &AppHandle, user_deny: &[String]) -> Vec<PathBuf> {
    let p = app.path();
    let mut out: Vec<PathBuf> = Vec::new();

    // 桌宠自己的数据目录（模型、密钥、日志）永远不许碰
    if let Ok(d) = p.app_data_dir() {
        push_canon(&mut out, d);
    }
    // 用户主目录下的敏感目录
    if let Ok(home) = p.home_dir() {
        for name in [".ssh", ".aws", ".gnupg", ".config", ".password-store", ".kube"] {
            push_canon(&mut out, home.join(name));
        }
    }
    // Windows 系统目录（正常情况下也不在允许根里，这里是纵深防御）
    for var in [
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ] {
        if let Some(v) = std::env::var_os(var) {
            push_canon(&mut out, PathBuf::from(v));
        }
    }
    // 用户自己加的：一行一个，支持 # 注释；相对路径按用户主目录解析
    for raw in user_deny {
        let t = raw.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let t = t.trim_matches('"');
        let path = PathBuf::from(t);
        let abs = if path.is_absolute() {
            path
        } else if let Ok(home) = p.home_dir() {
            home.join(path)
        } else {
            continue;
        };
        // 用户填的目录可能还不存在，用宽松规范化（这样"先加禁止、后建目录"也不会漏）
        if let Ok(c) = canonicalize_lenient(&abs) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

fn push_canon(out: &mut Vec<PathBuf>, p: PathBuf) {
    if let Ok(c) = p.canonicalize() {
        if !out.contains(&c) {
            out.push(c);
        }
    }
}

// ==================== 判定核心 ====================

/// 全部文件命令的唯一入口：路径必须过这一关。
///
/// 拒绝时**记日志**：不然"它为什么说不行"只能靠复现，排查成本很高
/// （判定逻辑仍在纯函数 guard_with 里，这里只负责拿 roots/deny 与记一笔）。
pub fn guard(app: &AppHandle, raw: &str, user_deny: &[String]) -> Result<Guarded, String> {
    let result = guard_with(&allowed_roots(app), &denied_paths(app, user_deny), raw);
    if let Err(e) = &result {
        log_line(&format!("files: 拒绝 {}", raw));
        log_line(&format!("files:   原因：{e}"));
    }
    result
}

/// 展示用路径：Windows 的 canonicalize 会带 `\\?\`（verbatim）前缀，那是实现细节 ——
/// 直接回给模型/用户会变成"反斜杠反斜杠问号"，TTS 还会念出来。
/// **只影响展示**，判定一律用规范化后的真实路径。
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").unwrap_or(s.as_str()).to_string()
}

/// 判定核心（与 `AppHandle` 解耦，单测直接喂 roots/deny）。
pub fn guard_with(roots: &[PathBuf], deny: &[PathBuf], raw: &str) -> Result<Guarded, String> {
    let shown = raw.trim().trim_matches('"').trim().to_string();
    if shown.is_empty() {
        return Err("路径为空".into());
    }
    let path = Path::new(&shown);

    if !path.is_absolute() {
        return Err(format!(
            "「{shown}」不是绝对路径。小助手只接受完整路径（例如 {}）",
            roots
                .first()
                .map(|r| r.display().to_string())
                .unwrap_or_else(|| "D:\\我的文件\\a.txt".to_string())
        ));
    }
    if has_parent_component(path) {
        return Err("路径里不允许出现 ..（请直接给完整路径）".into());
    }
    if has_git_component(path) {
        return Err("不允许操作 .git 目录（改坏仓库元数据很难恢复）".into());
    }

    let real = canonicalize_lenient(path)?;

    // 符号链接可能指进 .git，展开后再查一次
    if has_git_component(&real) {
        return Err("不允许操作 .git 目录（改坏仓库元数据很难恢复）".into());
    }
    if roots.is_empty() {
        return Err("取不到允许的目录（桌面 / 文档 / 下载），为安全起见已拒绝本次操作".into());
    }
    if !roots.iter().any(|r| real.starts_with(r)) {
        return Err(format!(
            "「{shown}」不在允许范围内：小助手只能动这几个目录 —— {}",
            roots
                .iter()
                .map(|r| display_path(r))
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    for d in deny {
        if real.starts_with(d) {
            return Err(format!(
                "「{shown}」在禁止目录「{}」里，已拒绝（可在「小助手设置 → 文件禁止目录」里调整）",
                display_path(d)
            ));
        }
    }
    Ok(Guarded {
        real,
        // 回显用的路径也过一遍展示层：万一调用方自己传了 `\\?\…`（例如把我们上一条
        // 错误信息里的路径原样抄回来），也不该把这个前缀再喂回去
        shown: display_path(Path::new(&shown)),
    })
}

fn has_git_component(p: &Path) -> bool {
    p.components().any(|c| c.as_os_str() == ".git")
}

/// 路径里是否含 `..`。
///
/// **不能只判断 `Component::ParentDir`**：带 `\\?\` 前缀的 verbatim 路径（Windows 上
/// `canonicalize` 的返回值就是这种）会把 `..` 当成**普通组件**，`components()` 不会
/// 给出 ParentDir。只认 ParentDir 的话，像
/// `\\?\C:\…\允许根\还不存在\..\..\..\逃逸.txt` 这种路径会先通过文本检查、再被
/// canonicalize_lenient 原样拼回去（前缀仍是允许根，`starts_with` 判定通过），
/// 而真正的写入会被系统在解析 `..` 后落到允许根之外 —— 沙箱就漏了。
/// 所以这里按**字面名字**查，两种形态都能拦住。
fn has_parent_component(p: &Path) -> bool {
    p.components()
        .any(|c| c.as_os_str() == ".." || matches!(c, Component::ParentDir))
}

/// 规范化到"最近的存在祖先"再拼回剩余段。
///
/// 新建 `D:\桌宠\a\b\c.txt` 时 a/b 还不存在，直接 canonicalize 会失败；这样处理后
/// `..` 与符号链接都会被展开，判定才落在真实位置。
fn canonicalize_lenient(path: &Path) -> Result<PathBuf, String> {
    let mut probe = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !probe.exists() {
        let Some(name) = probe.file_name().map(|s| s.to_os_string()) else {
            return Err(format!("路径无效：{}", path.display()));
        };
        tail.push(name);
        if !probe.pop() {
            return Err(format!("路径无效：{}", path.display()));
        }
    }
    let mut real = probe
        .canonicalize()
        .map_err(|e| format!("解析路径失败（{}）：{e}", probe.display()))?;
    for name in tail.iter().rev() {
        real.push(name);
    }
    Ok(real)
}

// ==================== 文本编码 ====================

/// 是否二进制：含 NUL 字节就不是文本（docx/图片/压缩包都会命中）
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

/// 解码：先 UTF-8（吃掉 BOM），失败后在 Windows 上按系统 ANSI 代码页再试一次。
fn decode_text(bytes: &[u8]) -> (String, TextEncoding) {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Ok(s) = std::str::from_utf8(body) {
        return (s.to_string(), TextEncoding::Utf8);
    }
    #[cfg(windows)]
    if let Some(s) = ansi_to_string(body) {
        return (s, TextEncoding::Ansi);
    }
    (String::from_utf8_lossy(body).to_string(), TextEncoding::Utf8)
}

/// 按原编码写回（GBK 文件写回 GBK）。
fn encode_text(text: &str, enc: TextEncoding) -> Vec<u8> {
    match enc {
        TextEncoding::Utf8 => text.as_bytes().to_vec(),
        #[cfg(windows)]
        TextEncoding::Ansi => string_to_ansi(text).unwrap_or_else(|| text.as_bytes().to_vec()),
        #[cfg(not(windows))]
        TextEncoding::Ansi => text.as_bytes().to_vec(),
    }
}

/// 系统 ANSI 代码页 → UTF-16 → String（简中机器上即 GBK）。
#[cfg(windows)]
fn ansi_to_string(bytes: &[u8]) -> Option<String> {
    use windows::Win32::Globalization::{MultiByteToWideChar, CP_ACP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};
    if bytes.is_empty() {
        return Some(String::new());
    }
    let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
    let need = unsafe { MultiByteToWideChar(CP_ACP, flags, bytes, None) };
    if need <= 0 {
        return None;
    }
    let mut buf = vec![0u16; need as usize];
    let got = unsafe { MultiByteToWideChar(CP_ACP, flags, bytes, Some(&mut buf)) };
    if got <= 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(String::from_utf16_lossy(&buf))
}

#[cfg(windows)]
fn string_to_ansi(text: &str) -> Option<Vec<u8>> {
    use windows::core::PCSTR;
    use windows::Win32::Globalization::{WideCharToMultiByte, CP_ACP};
    let wide: Vec<u16> = text.encode_utf16().collect();
    if wide.is_empty() {
        return Some(Vec::new());
    }
    let need = unsafe { WideCharToMultiByte(CP_ACP, 0, &wide, None, PCSTR::null(), None) };
    if need <= 0 {
        return None;
    }
    let mut buf = vec![0u8; need as usize];
    let got = unsafe { WideCharToMultiByte(CP_ACP, 0, &wide, Some(&mut buf), PCSTR::null(), None) };
    if got <= 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(buf)
}

// ==================== 杂项校验 ====================

fn check_new_file_ext(real: &Path) -> Result<(), String> {
    let ext = real
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if FORBIDDEN_NEW_EXT.contains(&ext.as_str()) {
        return Err(format!(
            "不允许新建 .{ext} 这类可执行 / 脚本文件（小助手只能新建普通文档）。确实需要的话，请自己先建好空文件，再让小助手写内容"
        ));
    }
    Ok(())
}

fn check_reserved_name(real: &Path) -> Result<(), String> {
    let stem = real
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(format!("「{stem}」是 Windows 保留设备名，不能作为文件名"));
    }
    Ok(())
}

fn backup_path(real: &Path) -> PathBuf {
    let mut name = real
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(BACKUP_SUFFIX);
    real.with_file_name(name)
}

/// 覆盖前留一份原样（同名即覆盖上一代备份，不堆垃圾）
fn make_backup(real: &Path) -> Result<PathBuf, String> {
    let bak = backup_path(real);
    std::fs::copy(real, &bak).map_err(|e| format!("备份失败（{}）：{e}", bak.display()))?;
    Ok(bak)
}

fn ensure_parent(real: &Path) -> Result<(), String> {
    if let Some(parent) = real.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建上级目录失败：{e}"))?;
        }
    }
    Ok(())
}

fn write_capped(real: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "内容太大（{} 字节），单次上限 {} 字节",
            bytes.len(),
            MAX_WRITE_BYTES
        ));
    }
    std::fs::write(real, bytes).map_err(|e| format!("写入失败：{e}"))
}

/// 纯函数：按行取一段，返回 (内容, 实际起始行, 总行数)
fn slice_lines(text: &str, start_line: usize, max_lines: usize) -> (String, usize, usize) {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    if total == 0 {
        return (String::new(), 1, 0);
    }
    let start = start_line.max(1).min(total);
    let end = (start - 1 + max_lines.max(1)).min(total);
    (lines[start - 1..end].join("\n"), start, total)
}

// ==================== 命令实现 ====================

/// 新建文件夹或文件（已存在的文件不覆盖：改内容走 write / edit）
pub fn create_entry(
    app: &AppHandle,
    path: &str,
    is_dir: bool,
    content: Option<String>,
    user_deny: &[String],
) -> Result<String, String> {
    let g = guard(app, path, user_deny)?;
    if is_dir {
        if g.real.is_dir() {
            return Ok(format!("文件夹已存在：{}", g.shown));
        }
        if g.real.exists() {
            return Err(format!("「{}」已经是一个文件了，不能建同名文件夹", g.shown));
        }
        std::fs::create_dir_all(&g.real).map_err(|e| format!("新建文件夹失败：{e}"))?;
        log_line(&format!("files: mkdir {}", display_path(&g.real)));
        return Ok(format!("已新建文件夹：{}", g.shown));
    }

    if g.real.exists() {
        return Err(format!(
            "「{}」已经存在了：要改内容请用 write_text_file / edit_text_file（会自动备份），想新建请换个名字",
            g.shown
        ));
    }
    check_reserved_name(&g.real)?;
    check_new_file_ext(&g.real)?;
    ensure_parent(&g.real)?;
    let text = content.unwrap_or_default();
    write_capped(&g.real, text.as_bytes())?;
    log_line(&format!("files: create {}", display_path(&g.real)));
    Ok(format!("已新建文件：{}（{} 字节）", g.shown, text.len()))
}

/// 读文本文件：按行区间返回，附带编码/总行数；超过上限会说明"只给了一部分"
pub fn read_text_file(
    app: &AppHandle,
    path: &str,
    user_deny: &[String],
    start_line: Option<usize>,
    max_lines: Option<usize>,
) -> Result<ReadResult, String> {
    let g = guard(app, path, user_deny)?;
    let meta = std::fs::metadata(&g.real).map_err(|e| format!("读不到「{}」：{e}", g.shown))?;
    if meta.is_dir() {
        return Err(format!(
            "「{}」是文件夹。要看里面有什么请用 list_directory",
            g.shown
        ));
    }
    let total_bytes = meta.len();
    let bytes = std::fs::read(&g.real).map_err(|e| format!("读取失败：{e}"))?;
    let size_capped = bytes.len() as u64 > MAX_READ_BYTES;
    let slice = if size_capped {
        &bytes[..MAX_READ_BYTES as usize]
    } else {
        &bytes[..]
    };
    if looks_binary(slice) {
        return Err(format!(
            "「{}」看起来是二进制文件（含 NUL 字节），小助手只能读文本",
            g.shown
        ));
    }
    let (text, enc) = decode_text(slice);
    let want_lines = max_lines.unwrap_or(DEFAULT_MAX_LINES).clamp(1, MAX_LINES);
    let (content, start, total_lines) = slice_lines(&text, start_line.unwrap_or(1), want_lines);
    let line_capped = start - 1 + content.lines().count() < total_lines;
    log_line(&format!(
        "files: read {} lines {}-{}",
        display_path(&g.real),
        start,
        start + content.lines().count().saturating_sub(1)
    ));
    Ok(ReadResult {
        path: g.shown,
        encoding: enc.label().to_string(),
        bytes: total_bytes,
        total_lines,
        start_line: start,
        content,
        truncated: size_capped || line_capped,
    })
}

/// 写文件（mode = "overwrite" 覆盖 | "append" 追加）；覆盖已有文件前先备份
pub fn write_text_file(
    app: &AppHandle,
    path: &str,
    content: &str,
    mode: &str,
    user_deny: &[String],
) -> Result<String, String> {
    let g = guard(app, path, user_deny)?;
    if g.real.is_dir() {
        return Err(format!("「{}」是文件夹，不能当文件写", g.shown));
    }
    let append = mode == "append";
    let existed = g.real.exists();
    if !existed {
        check_reserved_name(&g.real)?;
        check_new_file_ext(&g.real)?;
    }
    ensure_parent(&g.real)?;

    // 保留原编码：把 GBK 文件写成 UTF-8 会让别的程序看不懂
    let mut enc = TextEncoding::Utf8;
    let mut note = String::new();
    if existed {
        if let Ok(old) = std::fs::read(&g.real) {
            enc = decode_text(&old).1;
        }
        if !append {
            let bak = make_backup(&g.real)?;
            note = format!(
                "（原文件已备份为 {}）",
                bak.file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            );
        }
    }
    let bytes = encode_text(content, enc);
    if append {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&g.real)
            .map_err(|e| format!("打开失败：{e}"))?;
        f.write_all(&bytes)
            .map_err(|e| format!("追加失败：{e}"))?;
    } else {
        write_capped(&g.real, &bytes)?;
    }
    log_line(&format!(
        "files: {} {}",
        if append { "append" } else { "write" },
        display_path(&g.real)
    ));
    Ok(format!(
        "已{}：{}{}",
        if append { "追加内容到" } else { "写入" },
        g.shown,
        note
    ))
}

/// 精确替换：`old_string` 必须与文件内容完全一致；多处匹配时要求 replace_all
pub fn edit_text_file(
    app: &AppHandle,
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    user_deny: &[String],
) -> Result<String, String> {
    if old_string.is_empty() {
        return Err("old_string 不能为空".into());
    }
    let g = guard(app, path, user_deny)?;
    if !g.real.exists() {
        return Err(format!(
            "「{}」不存在。新建文件请用 create_entry",
            g.shown
        ));
    }
    if g.real.is_dir() {
        return Err(format!("「{}」是文件夹", g.shown));
    }
    let bytes = std::fs::read(&g.real).map_err(|e| format!("读取失败：{e}"))?;
    if looks_binary(&bytes) {
        return Err(format!("「{}」是二进制文件，不能按文本替换", g.shown));
    }
    let (text, enc) = decode_text(&bytes);
    let count = text.matches(old_string).count();
    if count == 0 {
        return Err(
            "文件里找不到 old_string。它必须与文件内容**完全一致**（含缩进与换行）；建议先 read_text_file 看一遍再改"
                .into(),
        );
    }
    if count > 1 && !replace_all {
        return Err(format!(
            "old_string 匹配到 {count} 处，无法确定改哪一个：请给出更长的唯一片段，或把 replace_all 设为 true"
        ));
    }
    let updated = if replace_all {
        text.replace(old_string, new_string)
    } else {
        text.replacen(old_string, new_string, 1)
    };
    let out = encode_text(&updated, enc);
    if out.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "改完之后太大（{} 字节），单次上限 {} 字节",
            out.len(),
            MAX_WRITE_BYTES
        ));
    }
    let bak = make_backup(&g.real)?;
    std::fs::write(&g.real, &out).map_err(|e| format!("写入失败：{e}"))?;
    log_line(&format!(
        "files: edit {} ({} 处)",
        display_path(&g.real),
        count
    ));
    Ok(format!(
        "已在「{}」替换 {} 处（原文件备份为 {}）",
        g.shown,
        count,
        bak.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    ))
}

/// 列目录：目录在前，同类按名字排序
pub fn list_directory(
    app: &AppHandle,
    path: &str,
    user_deny: &[String],
) -> Result<ListResult, String> {
    let g = guard(app, path, user_deny)?;
    if !g.real.exists() {
        return Err(format!("「{}」不存在", g.shown));
    }
    if !g.real.is_dir() {
        return Err(format!(
            "「{}」不是文件夹（看单个文件的内容请用 read_text_file）",
            g.shown
        ));
    }
    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut truncated = false;
    let rd = std::fs::read_dir(&g.real).map_err(|e| format!("列目录失败：{e}"))?;
    for e in rd.flatten() {
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let (kind, size) = match e.file_type() {
            Ok(t) if t.is_dir() => ("dir", 0),
            Ok(t) if t.is_symlink() => ("link", 0),
            _ => ("file", e.metadata().map(|m| m.len()).unwrap_or(0)),
        };
        entries.push(DirEntryInfo {
            name,
            kind: kind.to_string(),
            size,
        });
    }
    entries.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(ListResult {
        path: g.shown,
        entries,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个真实存在的临时目录当"允许根"
    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join("petra-files-test");
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn roots() -> Vec<PathBuf> {
        vec![temp_root()]
    }

    // ---------- 路径边界（安全核心） ----------

    #[test]
    fn relative_path_is_rejected() {
        let err = guard_with(&roots(), &[], "a.txt").unwrap_err();
        assert!(err.contains("绝对路径"), "{err}");
    }

    #[test]
    fn parent_dir_is_rejected() {
        // 注意：必须用**字符串**拼路径。PathBuf::join("..") 在 verbatim 前缀（\\?\…）下
        // 会词法折叠掉 ".."，测试就测不到东西了 —— 上一版正因如此假失败过一次。
        // 模型的威胁模型本来就是"给一个字符串路径"。
        let raw = format!("{}\\..\\escape.txt", temp_root().display());
        let err = guard_with(&roots(), &[], &raw).unwrap_err();
        assert!(err.contains(".."), "{err}");
    }

    /// 不存在的尾巴里塞 `..`：这是最像"逃逸"的一种写法，必须被拦下。
    #[test]
    fn parent_dir_in_deep_tail_is_rejected() {
        let raw = format!(
            "{}\\no-such-dir\\..\\..\\..\\escape.txt",
            temp_root().display()
        );
        let err = guard_with(&roots(), &[], &raw).unwrap_err();
        assert!(err.contains(".."), "{err}");
    }

    /// 允许根里的符号链接指向外面：因为判定前先 canonicalize（解引用），必须被拒。
    /// 建符号链接需要开发者模式/管理员权限，没权限就跳过这条。
    #[test]
    fn symlink_pointing_outside_is_rejected() {
        let outside = std::env::temp_dir().join("petra-outside-target.txt");
        std::fs::write(&outside, "x").unwrap();
        let link = temp_root().join("escape-link.txt");
        let _ = std::fs::remove_file(&link);
        if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
            return;
        }
        let err = guard_with(&roots(), &[], &link.to_string_lossy()).unwrap_err();
        assert!(err.contains("不在允许范围"), "{err}");
        let _ = std::fs::remove_file(&link);
    }

    #[test]
    fn outside_root_is_rejected() {
        // 临时目录的上一级必然不在允许根内
        let outside = temp_root().parent().unwrap().to_path_buf();
        let target = outside.join("petra-outside-probe.txt");
        let err = guard_with(&roots(), &[], &target.to_string_lossy()).unwrap_err();
        assert!(err.contains("不在允许范围"), "{err}");
    }

    /// 手动测试时发现的毛病：拒绝信息里漏出了 Windows canonicalize 的 `\\?\` 前缀
    /// （模型会读到它，TTS 还会念成"反斜杠反斜杠问号"）。展示层必须剥掉。
    ///
    /// 注意输入路径要用**普通写法**（`std::env::temp_dir()` 那种）：若拿 canonicalize
    /// 过的 PathBuf 去拼，输入本身就带 `\\?\`，测的就不是"展示层有没有剥"这件事了。
    #[test]
    fn reject_message_hides_verbatim_prefix() {
        let outside = std::env::temp_dir().join("petra-outside-probe.txt");
        let err = guard_with(&roots(), &[], &outside.to_string_lossy()).unwrap_err();
        assert!(!err.contains(r"\\?\"), "不该把 verbatim 前缀回给模型：{err}");
        assert!(
            err.contains(&display_path(&temp_root())),
            "要给出可读的允许根：{err}"
        );
    }

    /// 调用方自己传 `\\?\…`（例如把我们上一条错误信息里的路径抄回来）时也要剥掉。
    /// 这里用**普通写法**拼出 verbatim 输入，别拿 canonicalize 过的路径去套 `\\?\`，
    /// 否则会拼出双前缀，测的就不是这件事了。
    #[test]
    fn verbatim_input_is_echoed_clean() {
        let plain_root = std::env::temp_dir().join("petra-files-test");
        let raw = format!(r"\\?\{}\x.txt", plain_root.display());
        let g = guard_with(&roots(), &[], &raw).unwrap();
        assert!(!g.shown.contains(r"\\?\"), "回显路径不该带前缀：{}", g.shown);
    }

    #[test]
    fn display_path_strips_verbatim_prefix() {
        #[cfg(windows)]
        {
            assert_eq!(display_path(Path::new(r"\\?\D:\桌面\a.txt")), r"D:\桌面\a.txt");
            assert_eq!(
                display_path(Path::new(r"\\?\UNC\server\share\a")),
                r"\\server\share\a"
            );
        }
        // 本来就没有前缀的路径原样返回
        assert_eq!(display_path(Path::new(r"D:\桌面\a.txt")), r"D:\桌面\a.txt");
    }

    #[test]
    fn non_existent_nested_path_still_resolves_inside() {
        // 新建多级路径：末尾几段不存在，也必须能判定并通过
        let target = temp_root().join("no-such-a").join("no-such-b").join("c.txt");
        let g = guard_with(&roots(), &[], &target.to_string_lossy()).unwrap();
        assert!(g.real.starts_with(temp_root()));
        assert!(g.real.ends_with("c.txt"));
    }

    #[test]
    fn deny_wins_over_allow() {
        let denied = temp_root().join("denied");
        std::fs::create_dir_all(&denied).unwrap();
        let target = denied.join("x.txt");
        let err = guard_with(&roots(), &[denied.canonicalize().unwrap()], &target.to_string_lossy())
            .unwrap_err();
        assert!(err.contains("禁止目录"), "{err}");
    }

    #[test]
    fn git_dir_is_rejected() {
        let target = temp_root().join(".git").join("config");
        let err = guard_with(&roots(), &[], &target.to_string_lossy()).unwrap_err();
        assert!(err.contains(".git"), "{err}");
    }

    #[test]
    fn empty_roots_rejects_everything() {
        let target = temp_root().join("x.txt");
        let err = guard_with(&[], &[], &target.to_string_lossy()).unwrap_err();
        assert!(err.contains("取不到允许的目录"), "{err}");
    }

    #[test]
    fn quoted_path_is_tolerated() {
        // 模型有时会把路径连引号一起传过来
        let target = temp_root().join("x.txt");
        let quoted = format!("\"{}\"", target.display());
        let g = guard_with(&roots(), &[], &quoted).unwrap();
        // 回显走展示层，所以与 display_path 比（verbatim 前缀会被剥掉）
        assert_eq!(g.shown, display_path(&target));
    }

    // ---------- 后缀 / 文件名策略 ----------

    #[test]
    fn forbids_creating_executables_and_scripts() {
        for name in ["a.exe", "a.bat", "a.ps1", "a.lnk", "a.vbs", "A.BAT"] {
            assert!(check_new_file_ext(Path::new(name)).is_err(), "{name} 应被拦截");
        }
        for name in ["a.txt", "a.md", "a.json", "a.ts", "a.py", "note"] {
            assert!(check_new_file_ext(Path::new(name)).is_ok(), "{name} 不该被拦");
        }
    }

    #[test]
    fn reserved_device_names_are_rejected() {
        assert!(check_reserved_name(Path::new("CON.txt")).is_err());
        assert!(check_reserved_name(Path::new("nul")).is_err());
        assert!(check_reserved_name(Path::new("console.txt")).is_ok());
    }

    #[test]
    fn backup_name_appends_suffix() {
        let p = backup_path(Path::new("D:\\a\\note.txt"));
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "note.txt.petra-bak");
    }

    // ---------- 文本处理 ----------

    #[test]
    fn utf8_and_bom_are_decoded() {
        let (s, e) = decode_text("中文abc".as_bytes());
        assert_eq!(s, "中文abc");
        assert_eq!(e, TextEncoding::Utf8);

        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice("中文".as_bytes());
        let (s2, _) = decode_text(&with_bom);
        assert_eq!(s2, "中文", "BOM 要去掉，否则第一个字段会带上不可见字符");
    }

    #[test]
    fn binary_is_detected() {
        assert!(looks_binary(&[0x50, 0x4B, 0x00, 0x01]));
        assert!(!looks_binary("纯文本".as_bytes()));
    }

    #[test]
    fn line_slicing_works() {
        let text = "a\nb\nc\nd";
        assert_eq!(slice_lines(text, 1, 2).0, "a\nb");
        assert_eq!(slice_lines(text, 2, 2).0, "b\nc");
        assert_eq!(slice_lines(text, 4, 10).0, "d");
        // 起始行超出范围时钳到末行，而不是报错
        assert_eq!(slice_lines(text, 99, 10).0, "d");
        // 空文件
        assert_eq!(slice_lines("", 1, 10), (String::new(), 1, 0));
    }

    #[cfg(windows)]
    #[test]
    fn gbk_roundtrip() {
        // "中文" 的 GBK 字节；中文用户的老 .txt 就是这样存的
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        let (s, e) = decode_text(&gbk);
        assert_eq!(s, "中文");
        assert_eq!(e, TextEncoding::Ansi, "GBK 字节要按 ANSI 代码页解出来，而不是乱码");
        assert_eq!(encode_text(&s, e), gbk, "写回时必须还原成同一套字节");
    }
}
