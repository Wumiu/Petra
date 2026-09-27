//! launch_application：安全解析并启动本机应用（小助手"打开软件"专用）。
//! 与 run_shell 严格分离：这里只接受应用名称，绝不执行任意 shell 命令，
//! 不接受 & | ; > < 等 shell 元字符与危险关键词。
//!
//! Linux 版：扫 freedesktop 的 .desktop 入口
//! （/usr/share/applications、/usr/local/share/applications、XDG_DATA_DIRS 里各 data
//! 目录下的 applications、以及 ~/.local/share/applications），解析 Name= / Exec=，
//! 跳过 NoDisplay=true / Hidden=true，启动用 gio launch <desktop 文件>。
//! 为什么交给 gio launch 而不是自己拼 Exec 命令行：这样不经过 shell，
//! 也把 Terminal=true、DBusActivatable=true、TryExec 之类的启动细节留给 GLib，
//! 我们只需保证"选中的是哪个桌面入口"。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::log_line;

#[derive(Serialize)]
pub struct LaunchResult {
    pub success: bool,
    pub message: String,
    pub resolved: Option<String>,
}

/// 一个桌面入口：只需要显示名与文件路径。
/// Exec 只用来判断这个入口是否可启动（没有 Exec 的 .desktop 无法 launch）。
struct DesktopEntry {
    name: String,
    path: PathBuf,
}

/// 用户口语 → 候选应用名（与 .desktop 的 Name= 比对）。保持精简，按需扩展。
const APP_ALIASES: &[(&[&str], &[&str])] = &[
    (
        &["浏览器", "browser"],
        &["Firefox", "Google Chrome", "Chromium", "Microsoft Edge"],
    ),
    (
        &["文件管理器", "资源管理器", "files", "nautilus"],
        &["Files", "Nautilus", "Dolphin", "Thunar"],
    ),
    (
        &["终端", "terminal"],
        &[
            "Terminal",
            "GNOME Terminal",
            "Konsole",
            "Alacritty",
            "kitty",
        ],
    ),
    (
        &["计算器", "calc", "calculator"],
        &["Calculator", "GNOME Calculator", "KCalc"],
    ),
    (
        &["记事本", "notepad", "文本编辑", "text editor"],
        &["Text Editor", "gedit", "Kate"],
    ),
    (&["音乐", "music"], &["Rhythmbox", "Elisa", "Spotify"]),
    (&["邮件", "mail"], &["Thunderbird", "Evolution"]),
    (
        &["截图", "screenshot"],
        &["Screenshot", "Flameshot", "Spectacle"],
    ),
    (
        &["系统设置", "设置", "settings", "preferences"],
        &["Settings", "System Settings", "GNOME Control Center"],
    ),
    (
        &["任务管理器", "系统监视器", "activity monitor"],
        &["System Monitor", "GNOME System Monitor"],
    ),
    (
        &["网易云", "网易云音乐", "netease", "cloudmusic"],
        &["网易云音乐", "Netease Cloud Music"],
    ),
    (&["微信", "wechat", "weixin"], &["WeChat", "微信"]),
    (&["qq", "腾讯qq"], &["QQ"]),
    (
        &["vscode", "vs code", "visual studio code"],
        &["Visual Studio Code", "Code"],
    ),
    (&["chrome", "谷歌浏览器"], &["Google Chrome"]),
    (&["edge", "微软浏览器"], &["Microsoft Edge"]),
    (&["steam"], &["Steam"]),
    (&["spotify"], &["Spotify"]),
    (&["telegram"], &["Telegram"]),
    (&["discord"], &["Discord"]),
    (&["wps"], &["WPS Office"]),
    (
        &["office", "word", "excel", "powerpoint", "ppt"],
        &[
            "LibreOffice Writer",
            "LibreOffice Calc",
            "LibreOffice Impress",
        ],
    ),
];

/// 应用名安全校验：只允许纯应用名（可含空格/中文），拦截 shell 元字符与危险关键词。
/// 即使参数是以数组传给 gio launch（没有 shell），这一层仍然保留：防御性编程的第二道门。
fn validate_app_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("应用名称为空".into());
    }
    if name.chars().count() > 64 {
        return Err("应用名称过长".into());
    }
    const FORBIDDEN: &[&str] = &[
        "rm", "del", "delete", "format", "shutdown", "killall", "rmdir", "sudo", "osascript",
        "launchctl", "diskutil", "csrutil", "spctl", "chmod", "chown", "security", "networksetup",
        "dscl", "defaults", "curl", "wget", "bash", "zsh", "sh ", "python", "perl", "ruby", "dd ",
    ];
    let lower = name.to_lowercase();
    for f in FORBIDDEN {
        if lower.contains(f) {
            return Err(format!("应用名被拦截（含危险关键词 {f}）"));
        }
    }
    if name.starts_with('-') {
        // gio launch 的参数以 - 开头时会被当成选项
        return Err("应用名不能以 - 开头".into());
    }
    // shell 元字符 / 引号 / 路径分隔符 / 通配符 / 控制字符
    const ILLEGAL: &[char] = &[
        '&', '|', ';', '>', '<', '\u{60}', '$', '%', '^', '\\', '/', '"', '\'', '\n', '\r', '\t',
        '(', ')', '{', '}', '*', '?', '~', '!', '#',
    ];
    if name.chars().any(|c| c.is_control() || ILLEGAL.contains(&c)) {
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

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn application_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    // XDG_DATA_DIRS 是发行版/Flatpak 追加 data 目录的正式途径
    // （例如 /var/lib/flatpak/exports/share），照着它找才不至于漏掉应用。
    if let Ok(v) = std::env::var("XDG_DATA_DIRS") {
        for d in std::env::split_paths(&v) {
            if !d.as_os_str().is_empty() {
                dirs.push(d.join("applications"));
            }
        }
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("share").join("applications"));
    }
    dirs
}

/// 解析一个 .desktop：只认 [Desktop Entry] 段，跳过隐藏项。
fn parse_desktop(path: &Path) -> Option<DesktopEntry> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut name: Option<String> = None;
    let mut has_exec = false;
    let mut skip = false;
    let mut in_entry = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            // 后面的 [Desktop Action xxx] 是右键菜单项，不是启动入口
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let (key, val) = (k.trim(), v.trim());
        match key {
            "Name" => name = Some(val.to_string()),
            "Exec" => has_exec = !val.is_empty(),
            "NoDisplay" | "Hidden" => {
                if val.eq_ignore_ascii_case("true") {
                    skip = true;
                }
            }
            "Type" => {
                // 只有 Type=Application 才是可直接启动的应用（Link/Directory 不是）
                if !val.is_empty() && !val.eq_ignore_ascii_case("Application") {
                    skip = true;
                }
            }
            _ => {}
        }
    }
    if skip || !has_exec {
        return None;
    }
    let name = name?.trim().to_string();
    let low = name.to_lowercase();
    // 卸载项/帮助页/网页链接会污染候选
    if name.is_empty()
        || low.contains("uninstall")
        || name.contains("卸载")
        || low.starts_with("http")
    {
        return None;
    }
    Some(DesktopEntry {
        name,
        path: path.to_path_buf(),
    })
}

fn collect_entries() -> Vec<DesktopEntry> {
    let mut entries: Vec<DesktopEntry> = Vec::new();
    for dir in application_dirs() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("desktop") {
                continue;
            }
            if let Some(entry) = parse_desktop(&p) {
                entries.push(entry);
            }
        }
    }
    entries
}

/// 列出本机可启动的应用名（去重排序）。
/// 用途：让小助手知道"本机能打开什么"，回答用户时不必瞎猜应用名。
pub fn list_applications() -> Vec<String> {
    let mut names: Vec<String> = collect_entries().into_iter().map(|e| e.name).collect();
    names.sort();
    names.dedup();
    names
}

/// 用 gio launch 启动桌面入口。参数走数组，不经过 shell。
fn launch_desktop(entry: &DesktopEntry) -> Result<(), String> {
    let out = std::process::Command::new("gio")
        .arg("launch")
        .arg(&entry.path)
        .output()
        .map_err(|e| format!("启动失败: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() {
        format!("启动失败（gio launch 退出码 {}）", out.status)
    } else {
        err
    })
}

/// 主入口：应用名 → 启动。解析优先级：别名展开 → .desktop 的 Name 精确匹配 → 包含匹配。
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

    let entries = collect_entries();
    let mut last_error = String::new();
    for c in &candidates {
        let lower = c.to_lowercase();
        // 精确匹配优先（用户复述了菜单里显示的名字），其次做包含匹配
        let found = entries
            .iter()
            .find(|e| e.name.eq_ignore_ascii_case(c))
            .or_else(|| entries.iter().find(|e| e.name.to_lowercase().contains(lower.as_str())));
        let Some(entry) = found else {
            continue;
        };
        match launch_desktop(entry) {
            Ok(()) => {
                log_line(&format!("launch: {application} -> {}", entry.path.display()));
                return ok(format!("已打开 {}", entry.name), entry.name.clone());
            }
            Err(e) => {
                log_line(&format!(
                    "launch: {application} -> {} 失败: {e}",
                    entry.path.display()
                ));
                last_error = e;
            }
        }
    }
    fail(if last_error.is_empty() {
        format!("没有找到 {name} 的桌面入口，请确认已安装")
    } else {
        format!("没有找到 {name} 的桌面入口（{last_error}）")
    })
}

/// 用系统默认浏览器打开 URL（更新提示下载页等）。只允许 http/https。
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅支持 http/https 链接".into());
    }
    // 参数以数组传给 xdg-open，不经过 shell；仍然拒绝控制字符和空白，
    // 避免 xdg-open 把参数当成选项或本地文件路径。
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("链接包含非法字符".into());
    }
    let out = std::process::Command::new("xdg-open")
        .arg(url)
        .output()
        .map_err(|e| format!("打开失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("打开失败（xdg-open 退出码 {}）", out.status)
        } else {
            err
        })
    }
}

/// Tauri command 入口。Linux 没有 COM，保留同名 API 让 lib.rs 的调用点无需 cfg。
pub fn launch_application_checked(application: String) -> LaunchResult {
    launch_application(application)
}
