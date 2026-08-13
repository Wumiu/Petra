//! launch_application：安全解析并启动本机应用（小助手“打开软件”专用）。
//! 与 run_shell 严格分离：这里只接受应用名称，绝不执行任意 shell 命令，
//! 不接受 & | ; > < 等 shell 元字符与危险关键词。

use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::Serialize;
use windows::core::{Interface, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellExecuteW, ShellLink, SLGP_UNCPRIORITY, SLR_NO_UI};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::log_line;

#[derive(Serialize)]
pub struct LaunchResult {
    pub success: bool,
    pub message: String,
    pub resolved: Option<String>,
}

/// 用户口语 → 候选关键词（匹配 Start Menu 快捷方式/系统应用）。保持精简，按需扩展。
const APP_ALIASES: &[(&[&str], &[&str])] = &[
    (
        &["网易云", "网易云音乐", "netease", "cloudmusic", "cloud music"],
        &["网易云", "cloudmusic", "netease"],
    ),
    (&["微信", "wechat", "weixin"], &["微信", "wechat", "weixin"]),
    (&["qq", "腾讯qq"], &["qq"]),
    (&["记事本", "notepad", "笔记本"], &["notepad"]),
    (&["计算器", "calc", "calculator"], &["calc", "calculator"]),
    (
        &["vscode", "vs code", "visual studio code"],
        &["visual studio code", "code"],
    ),
    (&["浏览器", "browser"], &["edge", "chrome", "firefox", "browser"]),
    (&["画图", "mspaint", "paint"], &["mspaint", "paint"]),
    (
        &["资源管理器", "文件管理器", "explorer", "此电脑", "我的电脑"],
        &["explorer"],
    ),
    (&["任务管理器", "taskmgr"], &["taskmgr"]),
    (&["steam"], &["steam"]),
    (&["bilibili", "哔哩哔哩"], &["bilibili", "哔哩哔哩"]),
    (&["wps"], &["wps"]),
    (
        &["office", "word", "excel", "powerpoint", "ppt"],
        &["word", "excel", "powerpoint"],
    ),
    (&["抖音", "douyin"], &["抖音", "douyin"]),
    (&["钉钉", "dingtalk"], &["钉钉", "dingtalk"]),
    (&["飞书", "feishu"], &["飞书", "feishu"]),
    (&["spotify"], &["spotify"]),
    (&["telegram"], &["telegram"]),
    (&["discord"], &["discord"]),
];

/// 系统自带应用：ShellExecuteW 会经 PATH / App Paths 注册表解析，无需 Start Menu。
const SYSTEM_APPS: &[&str] = &[
    "notepad", "calc", "mspaint", "explorer", "taskmgr", "control", "snippingtool",
    "winword", "excel", "powerpnt", "winver", "dxdiag",
];

/// 应用名安全校验：只允许纯应用名（可含空格/中文），拦截 shell 元字符与危险关键词。
fn validate_app_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("应用名称为空".into());
    }
    if name.chars().count() > 64 {
        return Err("应用名称过长".into());
    }
    const FORBIDDEN: &[&str] = &[
        "rm", "del", "delete", "format", "shutdown", "taskkill", "rd ", "rmdir",
        "powershell", "cmd", "reg ", "net ", "sc ", "wmic", "mshta", "wscript",
        "cscript", "diskpart", "cipher", "fsutil", "bcdedit", "takeown", "vssadmin",
    ];
    let lower = name.to_lowercase();
    for f in FORBIDDEN {
        if lower.contains(f) {
            return Err(format!("应用名被拦截（含危险关键词 {f}）"));
        }
    }
    if name.contains(['&', '|', ';', '>', '<', '`', '$', '%', '^', '\\', '/', '"', '\'']) {
        return Err("应用名包含非法字符".into());
    }
    Ok(name.to_string())
}

fn fail(msg: impl Into<String>) -> LaunchResult {
    LaunchResult {
        success: false,
        message: msg.into(),
        resolved: None,
    }
}

fn ok(msg: impl Into<String>, resolved: String) -> LaunchResult {
    LaunchResult {
        success: true,
        message: msg.into(),
        resolved: Some(resolved),
    }
}

/// ShellExecuteW 启动；返回值 >32 表示成功（>32 为 HINSTANCE）。
fn shell_execute(target: &str, params: &str) -> Result<(), String> {
    let t: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let p: Vec<u16> = params.encode_utf16().chain(Some(0)).collect();
    let ret = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            PCWSTR(t.as_ptr()),
            PCWSTR(p.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = ret.0 as isize;
    if code <= 32 {
        Err(format!("启动失败（错误码 {code}）"))
    } else {
        Ok(())
    }
}

/// 解析 .lnk 快捷方式 → 目标路径（IShellLinkW + IPersistFile）。
/// 先 Resolve（UWP 等快捷方式需解析后才可 GetPath），再读目标。
fn resolve_lnk_target(lnk: &Path) -> Option<String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = link.cast().ok()?;
        let wide: Vec<u16> = lnk
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        file.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
        let _ = link.Resolve(None, SLR_NO_UI.0 as u32);
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_UNCPRIORITY.0 as u32)
            .ok()?;
        let end = buf.iter().position(|&c| c == 0)?;
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

/// 递归收集 Start Menu 下的 .lnk（限制深度与数量，避免全盘扫描）。
fn collect_start_menu_lnks() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(pd) = std::env::var("ProgramData") {
        roots.push(PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(ad) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(ad).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    let mut out = Vec::new();
    for root in roots {
        collect_lnks(&root, 0, &mut out);
    }
    out
}

fn collect_lnks(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 4 || out.len() > 400 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_lnks(&p, depth + 1, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("lnk") {
            out.push(p);
        }
    }
}

/// 归一化：仅保留字母数字并转小写（中文字符也保留，用于中文名匹配）。
fn normalize(s: &str) -> String {
    s.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 阶段 1 匹配：归一化后完全相等（最可靠）。
fn stem_exact(candidate: &str, stem: &str) -> bool {
    let c = normalize(candidate);
    let s = normalize(stem);
    !c.is_empty() && c == s
}

/// 阶段 2 匹配：快捷方式名包含候选关键词。
/// 注意只做 s.contains(c) 方向，避免“netease 包含 ea”这类误配。
fn stem_contains(candidate: &str, stem: &str) -> bool {
    let c = normalize(candidate);
    let s = normalize(stem);
    !c.is_empty() && s.contains(&c)
}

/// 快捷方式名是否值得尝试（排除卸载/修复/诊断类）。
fn is_plausible_stem(stem: &str) -> bool {
    let lower = stem.to_lowercase();
    !(lower.contains("uninstall")
        || lower.contains("remove")
        || lower.contains("repair")
        || lower.contains("卸载")
        || lower.contains("修复"))
}

/// 解析出的目标是否为普通 GUI 应用（排除系统中间层启动器，防止误启动弹错）。
fn is_safe_gui_target(target: &str) -> bool {
    let Some(name) = Path::new(target)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
    else {
        return false;
    };
    !matches!(
        name.as_str(),
        "rundll32.exe" | "cmd.exe" | "wscript.exe" | "cscript.exe" | "mshta.exe"
    )
}

/// 主入口：应用名 → 启动。解析优先级：
/// 别名展开 → 系统应用 → Start Menu 快捷方式 → ShellExecute 兜底。
pub fn launch_application(application: String) -> LaunchResult {
    let name = match validate_app_name(&application) {
        Ok(n) => n,
        Err(e) => return fail(e),
    };
    // 别名展开（找不到别名则用原名）
    let mut candidates: Vec<String> = vec![name.clone()];
    for (aliases, keys) in APP_ALIASES {
        if aliases
            .iter()
            .any(|a| a.eq_ignore_ascii_case(&name) || name.contains(a))
        {
            candidates = keys.iter().map(|k| k.to_string()).collect();
            break;
        }
    }

    // 1) 系统应用（含“浏览器”→ 默认浏览器，用空白页 http:// 触发）
    for c in &candidates {
        let c_lower = c.to_lowercase();
        if c_lower == "browser" {
            match shell_execute("http://", "") {
                Ok(()) => {
                    log_line(&format!("launch: {application} -> 默认浏览器"));
                    return ok("已打开默认浏览器", "默认浏览器".into());
                }
                Err(e) => return fail(e),
            }
        }
        if SYSTEM_APPS.iter().any(|s| *s == c_lower) {
            match shell_execute(c, "") {
                Ok(()) => {
                    log_line(&format!("launch: {application} -> 系统应用 {c}"));
                    return ok(format!("已打开 {name}"), c.clone());
                }
                Err(e) => {
                    log_line(&format!("launch: {application} -> {c} 失败: {e}"));
                    return fail(format!("没有找到 {name} 的可执行程序（{e}）"));
                }
            }
        }
    }

    // 2) Start Menu 快捷方式：先精确匹配，再包含匹配；
    //    解析失败/目标无效（中间层启动器、文件不存在、启动失败）则继续尝试下一个。
    let lnks = collect_start_menu_lnks();
    for stage in 0..2 {
        for lnk in &lnks {
            let Some(stem) = lnk.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_plausible_stem(stem) {
                continue;
            }
            let hit = candidates.iter().any(|c| {
                if stage == 0 {
                    stem_exact(c, stem)
                } else {
                    stem_contains(c, stem)
                }
            });
            if !hit {
                continue;
            }
            let Some(target) = resolve_lnk_target(lnk) else {
                continue;
            };
            if !is_safe_gui_target(&target) {
                log_line(&format!("launch: 跳过中间层目标 {target} (via {lnk:?})"));
                continue;
            }
            if !Path::new(&target).exists() {
                log_line(&format!("launch: 目标不存在 {target} (via {lnk:?})，继续查找"));
                continue;
            }
            match shell_execute(&target, "") {
                Ok(()) => {
                    log_line(&format!("launch: {application} -> {target} (via {lnk:?})"));
                    return ok(format!("已打开 {name}"), target);
                }
                Err(e) => {
                    log_line(&format!("launch: {application} -> {target} 失败: {e}，继续查找"));
                }
            }
        }
    }

    // 3) ShellExecute 兜底（App Paths 注册表等系统解析）
    for c in &candidates {
        match shell_execute(c, "") {
            Ok(()) => {
                log_line(&format!("launch: {application} -> ShellExecute 兜底 {c}"));
                return ok(format!("已打开 {name}"), c.clone());
            }
            Err(e) => {
                log_line(&format!("launch: {application} -> {c} 失败: {e}"));
            }
        }
    }
    fail(format!("没有找到 {name} 的可执行程序，请确认已安装或在开始菜单中创建快捷方式"))
}

/// 用系统默认浏览器打开 URL（更新提示下载页等）。只允许 http/https。
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅支持 http/https 链接".into());
    }
    shell_execute(url, "")
}

/// Tauri command 入口：command 可能在任意线程执行，这里自行初始化/清理 COM。
pub fn launch_application_checked(application: String) -> LaunchResult {
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let result = launch_application(application);
    unsafe { CoUninitialize() };
    result
}
