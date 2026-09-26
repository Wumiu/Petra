//! launch_application：安全解析并启动本机应用（小助手"打开软件"专用）。
//! 与 run_shell 严格分离：这里只接受应用名称，绝不执行任意 shell 命令，
//! 不接受 & | ; > < 等 shell 元字符与危险关键词。
//!
//! macOS 版：扫 /Applications、/System/Applications、~/Applications 里的 .app，
//! 用 /usr/bin/open -a <名字> 启动（参数以数组传入，不经过 shell）。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::log_line;

#[derive(Serialize)]
pub struct LaunchResult {
    pub success: bool,
    pub message: String,
    pub resolved: Option<String>,
}

/// 用户口语 → 候选应用名（匹配 /Applications 里的 .app 名）。保持精简，按需扩展。
const APP_ALIASES: &[(&[&str], &[&str])] = &[
    (&["浏览器", "browser", "safari"], &["Safari"]),
    (&["访达", "finder", "文件管理器", "资源管理器"], &["Finder"]),
    (&["终端", "terminal", "iterm"], &["Terminal", "iTerm"]),
    (&["计算器", "calc", "calculator"], &["Calculator"]),
    (&["记事本", "notepad", "文本编辑", "textedit"], &["TextEdit"]),
    (&["音乐", "music"], &["Music"]),
    (&["邮件", "mail"], &["Mail"]),
    (&["日历", "calendar"], &["Calendar"]),
    (&["截图", "screenshot"], &["Screenshot"]),
    (
        &["系统设置", "设置", "preferences", "settings"],
        &["System Settings", "System Preferences"],
    ),
    (
        &["活动监视器", "任务管理器", "activity monitor"],
        &["Activity Monitor"],
    ),
    (
        &["网易云", "网易云音乐", "netease", "cloudmusic"],
        &["网易云音乐", "NeteaseMusic"],
    ),
    (&["微信", "wechat", "weixin"], &["WeChat", "微信"]),
    (&["qq", "腾讯qq"], &["QQ"]),
    (
        &["vscode", "vs code", "visual studio code"],
        &["Visual Studio Code"],
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
        &["Microsoft Word", "Microsoft Excel", "Microsoft PowerPoint"],
    ),
];

/// 应用名安全校验：只允许纯应用名（可含空格/中文），拦截 shell 元字符与危险关键词。
/// 即使参数是以数组传给 open（没有 shell），这一层仍然保留：防御性编程的第二道门。
fn validate_app_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("应用名称为空".into());
    }
    if name.chars().count() > 64 {
        return Err("应用名称过长".into());
    }
    const FORBIDDEN: &[&str] = &[
        "rm", "del", "delete", "format", "shutdown", "killall", "rmdir", "sudo",
        "osascript", "launchctl", "diskutil", "csrutil", "spctl", "chmod", "chown",
        "security", "networksetup", "dscl", "defaults", "curl", "wget", "bash",
        "zsh", "sh ", "python", "perl", "ruby", "dd ",
    ];
    let lower = name.to_lowercase();
    for f in FORBIDDEN {
        if lower.contains(f) {
            return Err(format!("应用名被拦截（含危险关键词 {f}）"));
        }
    }
    if name.starts_with('-') {
        // open -a -x 之类会把名字当成选项
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

/// 用 open -a <app> 启动。参数走数组，不经过 shell。
fn open_app(app: &str) -> Result<(), String> {
    let out = std::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app)
        .output()
        .map_err(|e| format!("启动失败: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() {
        format!("启动失败（open 退出码 {}）", out.status)
    } else {
        err
    })
}

/// 只扫顶层和一层子目录（/Applications/Utilities 这类），不递归进 .app 内部——
/// 否则一个 Xcode 就能刷出上万条。
fn collect_apps(dir: &Path, depth: usize, out: &mut Vec<String>) {
    if out.len() > 400 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) == Some("app") {
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                let n = stem.trim();
                // 过滤卸载/帮助/说明类，避免污染候选
                if n.is_empty()
                    || n.contains("卸载")
                    || n.contains("Uninstall")
                    || n.starts_with("http")
                {
                    continue;
                }
                out.push(n.to_string());
            }
        } else if depth > 0 && p.is_dir() {
            collect_apps(&p, depth - 1, out);
        }
    }
}

/// 列出本机可启动的应用名（去重排序）。
/// 用途：让小助手知道"本机能打开什么"，回答用户时不必瞎猜应用名。
pub fn list_applications() -> Vec<String> {
    let mut roots: Vec<PathBuf> = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    let mut names: Vec<String> = Vec::new();
    for root in roots {
        collect_apps(&root, 1, &mut names);
    }
    names.sort();
    names.dedup();
    names
}

/// 主入口：应用名 → 启动。解析优先级：别名展开 → open -a（LaunchServices 解析）。
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

    // 交给 open -a：它自己会查 /Applications、/System/Applications、~/Applications
    // 以及 LaunchServices 注册表，所以别名候选可以逐个试。
    let mut last_error = String::new();
    for c in &candidates {
        match open_app(c) {
            Ok(()) => {
                log_line(&format!("launch: {application} -> {c}"));
                return ok(format!("已打开 {name}"), c.clone());
            }
            Err(e) => {
                log_line(&format!("launch: {application} -> {c} 失败: {e}，继续查找"));
                last_error = e;
            }
        }
    }
    if last_error.is_empty() {
        fail(format!("没有找到 {name} 的可执行程序，请确认已安装"))
    } else {
        fail(format!("没有找到 {name} 的可执行程序（{last_error}）"))
    }
}

/// 用系统默认浏览器打开 URL（更新提示下载页等）。只允许 http/https。
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("仅支持 http/https 链接".into());
    }
    // 参数以数组传给 open，不经过 shell；仍然拒绝控制字符和空白，
    // 避免 open 把参数当成选项或本地文件路径。
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("链接包含非法字符".into());
    }
    let out = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .output()
        .map_err(|e| format!("打开失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("打开失败（open 退出码 {}）", out.status)
        } else {
            err
        })
    }
}

/// Tauri command 入口。macOS 没有 COM，保留同名 API 让 lib.rs 的调用点无需 cfg。
pub fn launch_application_checked(application: String) -> LaunchResult {
    launch_application(application)
}
