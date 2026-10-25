// 平台专属模块：Windows 走 Win32 / WASAPI / SMTC，macOS 走 *_mac.rs，
// Linux 走 *_linux.rs 里的等价实现。三边的公开 API 保持一致，
// lib.rs 里的调用点因此不需要逐处 cfg（只在 setup 之类的入口做极少量分叉）。
#[cfg(windows)]
mod audio;
#[cfg(target_os = "macos")]
#[path = "audio_mac.rs"]
mod audio;
#[cfg(target_os = "linux")]
#[path = "audio_linux.rs"]
mod audio;

#[cfg(windows)]
mod launch;
#[cfg(target_os = "macos")]
#[path = "launch_mac.rs"]
mod launch;
#[cfg(target_os = "linux")]
#[path = "launch_linux.rs"]
mod launch;

#[cfg(windows)]
mod media;
#[cfg(target_os = "macos")]
#[path = "media_mac.rs"]
mod media;
#[cfg(target_os = "linux")]
#[path = "media_linux.rs"]
mod media;

#[cfg(windows)]
mod proxy;
#[cfg(target_os = "macos")]
#[path = "proxy_mac.rs"]
mod proxy;
#[cfg(target_os = "linux")]
#[path = "proxy_linux.rs"]
mod proxy;

#[cfg(windows)]
mod screen;
#[cfg(target_os = "macos")]
#[path = "screen_mac.rs"]
mod screen;
#[cfg(target_os = "linux")]
#[path = "screen_linux.rs"]
mod screen;

// 屏幕截图（桌宠"识图"用）：非 Linux 走 xcap，Linux 是桩。
// 为什么单独分叉而不是三平台各一份 —— xcap 自身已经跨 Windows/macOS，
// 真正需要分叉的是"Linux 不引入 xcap"这件事（它会拉进一批系统库，见 Cargo.toml）。
#[cfg(not(target_os = "linux"))]
mod capture;
#[cfg(target_os = "linux")]
#[path = "capture_linux.rs"]
mod capture;

// Wayland 会话下的能力补齐（输入区域 / 移动 / 光标）：只编译进 Linux 目标。
// screen_linux.rs 是它的主要调用方，lib.rs 的穿透决策线程也会直接用一次。
#[cfg(target_os = "linux")]
mod wayland_linux;

#[cfg(windows)]
mod trash;
#[cfg(target_os = "macos")]
#[path = "trash_mac.rs"]
mod trash;
#[cfg(target_os = "linux")]
#[path = "trash_linux.rs"]
mod trash;

// 关网页（小助手"关掉那个 B站页面"）：Windows 走 UI Automation 找标签页并点它的
// 关闭按钮；macOS 走 AppleScript；Linux 如实不支持（Wayland 拿不到窗口列表）。
#[cfg(windows)]
mod webpage;
#[cfg(target_os = "macos")]
#[path = "webpage_mac.rs"]
mod webpage;
#[cfg(target_os = "linux")]
#[path = "webpage_linux.rs"]
mod webpage;

// 文件能力（小助手"建个文件/读一下/改一下"）：纯 std::fs，三平台同一份实现，
// 安全边界（允许根 + 禁止表 + .git + 后缀策略）都在 files.rs 里。
mod files;

// 控制面板：内嵌的本地 HTTP 服务 + 浏览器页面（纯 std::net，零新依赖）。
// 页面本体是 src-tauri/panel/index.html，用 include_str! 编进二进制。
mod panel;

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use crate::capture::capture_screen;

/// Windows GUI 子系统中启动控制台程序（powershell/cmd/reg/shutdown）时，
/// 默认会弹出一个新的控制台窗口。加 CREATE_NO_WINDOW 避免窗口闪现。
#[cfg(windows)]
const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

/// 启动子进程：Windows 上加 CREATE_NO_WINDOW 防止控制台窗口闪现。
#[cfg(windows)]
fn hidden_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW_FLAG);
    cmd
}

/// macOS / Linux 没有"控制台窗口闪现"的问题，等价于普通 Command。
#[cfg(unix)]
fn hidden_command(program: &str) -> std::process::Command {
    std::process::Command::new(program)
}

pub struct AudioState {
    pub enabled: Arc<AtomicBool>,
}

pub struct TopmostState {
    pub enabled: Arc<AtomicBool>,
}

/// 窗口移动目标：前端只发目标点（10Hz），Rust 线程原生平滑移动（60fps）。
/// (x, y, speed)：speed 为移动速度 px/s（漫游 340，拖动 3000）。
pub struct PetMotion {
    pub target: std::sync::Mutex<Option<(f64, f64, f64)>>,
    pub tracking: std::sync::atomic::AtomicBool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveRegion {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub enabled: bool,
}

#[derive(Clone)]
struct InteractionSnapshot {
    regions: Vec<InteractiveRegion>,
    initialized: bool,
    last_update: Option<std::time::Instant>,
    /// 前端视口宽度（CSS px × devicePixelRatio）= 交互区域所在的坐标系宽度。
    /// 用于把 Win32 的客户端光标坐标换算到同一空间（高 DPI / WebView 缩放时常不一致）。
    viewport_px: Option<(f32, f32)>,
}

pub struct InteractionState {
    snapshot: std::sync::Mutex<InteractionSnapshot>,
    renderer_locked: std::sync::atomic::AtomicBool,
}

// 前端 100ms 上报一次区域；留 10 秒宽限是为了扛住「首次加载模型 / PSD 解析 /
// 长任务」这类主线程被占满的时段 —— 2.5 秒太紧，一卡就整窗穿透，用户看到的就是
// 「右键菜单/按钮点了没反应」。
const INTERACTION_STATE_STALE_AFTER: std::time::Duration =
    std::time::Duration::from_millis(10_000);

/// 右键菜单打开状态，仅用于光标离开主窗口时通知前端关闭菜单。
pub struct MenuOpen {
    pub active: std::sync::atomic::AtomicBool,
}

/// 小助手全局呼出快捷键状态：前端负责「设置/清除」的交互与持久化，
/// Rust 侧负责系统级注册（tauri-plugin-global-shortcut）并在按下时向前端 emit 事件。
pub struct AssistantHotkey {
    pub shortcut: std::sync::Mutex<Option<Shortcut>>,
}

/// 拖动状态：开始后由 8ms 线程直接 GetCursorPos 跟随（零每帧 IPC）。
/// locked_y 为待机边缘滑动：y 锁定在该值（物理），只随鼠标水平移动。
pub struct DragState {
    pub active: std::sync::atomic::AtomicBool,
    pub offset: std::sync::Mutex<(i32, i32)>,
    pub locked_y: std::sync::Mutex<Option<i32>>,
    /// 模型边界（窗口内像素）：拖拽时用于计算窗口硬边界
    pub model_bounds: std::sync::Mutex<(i32, i32, i32, i32)>, // (left, top, right, bottom)
}

#[derive(Serialize, Clone)]
pub struct WorkArea {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Clone)]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
    /// 光标相对真实窗口中心的偏移（物理像素），供视线跟随使用
    pub rx: i32,
    pub ry: i32,
    /// 窗口左上角（物理像素），供模型边缘补偿判断窗口实际出屏量
    pub left: i32,
    pub top: i32,
}

#[derive(Serialize, Clone)]
pub struct TrashResult {
    pub ok: bool,
    pub count: usize,
}

/// 诊断日志目录（app_data_dir/logs），setup 时初始化。
static LOG_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

/// 「详细日志」开关：拖动/交互/菜单这类高频埋点是否落盘。
/// 默认 debug 构建开、release 关；用户可在右键菜单「诊断日志」里切换，选择存到 logs/verbose。
static VERBOSE_LOG: AtomicBool = AtomicBool::new(false);

/// 日志事件用的 AppHandle：ERROR 级别日志会向前端 emit 一条 `petra:log-error`，
/// 由桌宠在模型上方弹红色提示（前端不可见时只写日志，不弹）。
static LOG_EVENT_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// 前端心跳时间戳（毫秒）。前端每 5 秒 invoke 一次 app_heartbeat；
/// 看门狗发现长时间不跳 => 界面卡死/白屏（WebView 渲染进程崩了、主线程被同步任务堵死等），
/// 这类情况 JS 层根本发不出错误，只能靠外部观察。
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 反馈邮件/导出里附带的日志上限（超长只保留开头 + 结尾）
const LOG_ATTACH_MAX_CHARS: usize = 120_000;
/// 单次运行 lasted.log 的硬上限：长时间不关程序时，超了就截掉最早的内容
const LASTED_TRIM_BYTES: u64 = 20_000_000;
/// error.log 上限：错误日志带上下文，容易涨；超了只留后半段
const ERROR_TRIM_BYTES: u64 = 2_000_000;
/// 归档最多保留多少份
const LOG_ARCHIVE_KEEP: usize = 15;

/// 最近若干行日志（给 error.log 做"错误发生前的上下文"）
static RECENT_LINES: std::sync::Mutex<std::collections::VecDeque<String>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
/// 上一行日志的日期，用于跨天时插一条"日期变更"分隔
static LAST_DATE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 判断目录能否写（日志必须可写，否则等于没有日志）。
fn ensure_dir_writable(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".petra-write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 日志目录：优先「程序根目录/logs」，不可写时退回用户数据目录。
///
/// dev 下 exe 在 `src-tauri/target/debug`，直接用它会把日志写进 build 目录
/// （cargo clean 就没了），所以向上找含 `src-tauri` 的仓库根当程序根目录。
fn resolve_log_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;

    // 显式覆盖：排查/测试时用 PETRA_LOG_DIR 指定
    if let Ok(dir) = std::env::var("PETRA_LOG_DIR") {
        let dir = std::path::PathBuf::from(dir);
        if ensure_dir_writable(&dir) {
            return dir;
        }
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    if let Some(exe_dir) = exe_dir {
        let mut roots: Vec<std::path::PathBuf> = Vec::new();
        // 开发构建：<repo>/src-tauri/target/debug → <repo>
        let mut probe = exe_dir.clone();
        for _ in 0..4 {
            if probe.join("src-tauri").is_dir() {
                roots.push(probe.clone());
                break;
            }
            match probe.parent() {
                Some(p) => probe = p.to_path_buf(),
                None => break,
            }
        }
        roots.push(exe_dir.clone());
        for root in roots {
            let dir = root.join("logs");
            if ensure_dir_writable(&dir) {
                return dir;
            }
        }
    }

    // 兜底：用户数据目录（安装到 Program Files 这类不可写位置时）
    let fallback = app
        .path()
        .app_data_dir()
        .map(|d| d.join("logs"))
        .unwrap_or_else(|_| std::env::temp_dir().join("pet-logs"));
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// 把旧位置（用户数据目录）的日志搬到新位置，只在第一次切换时做一次。
fn migrate_old_logs(old_dir: &std::path::Path, new_dir: &std::path::Path) {
    if old_dir == new_dir || new_dir.join("lasted.log").exists() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(old_dir) else { return };
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        let dst = new_dir.join(src.file_name().unwrap_or_default());
        if dst.exists() {
            continue;
        }
        if std::fs::rename(&src, &dst).is_err() {
            if std::fs::copy(&src, &dst).is_ok() {
                let _ = std::fs::remove_file(&src);
            }
        }
    }
}

/// 本地时间戳：日志是给人看的，用可读时间而不是 unix 秒。
fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 追加写文件（失败不 panic：日志不能把主流程带崩）
fn append_file(path: &std::path::Path, text: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(text.as_bytes());
    }
}

/// 文件超过上限时只保留后半段（截断时加一行提示）
fn trim_file(path: &std::path::Path, max: u64) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() <= max {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let keep = (max / 2) as usize;
    if text.len() <= keep {
        return;
    }
    let mut cut = text.len() - keep;
    // 从字符边界开始，避免切坏 UTF-8
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    let tail = format!("[{}] [INFO] （日志过长，已截断更早的内容）\n{}", stamp(), &text[cut..]);
    let _ = std::fs::write(path, tail);
}

/// 写一行日志：`[时间] [级别] 内容`。verbose 行只在「详细日志」开启时落盘。
///
/// 落盘规则：
///   - 所有内容进 `lasted.log`（本次启动的完整运行记录）；
///   - WARN / ERROR 另外写进 `error.log`，并附上最近 80 行上下文，
///     方便定位"错误发生之前发生了什么"。
fn log_write(level: &str, verbose: bool, s: &str) {
    log_write_ex(level, verbose, s, true);
}

/// emit=false 用于 panic hook：panic 过程中不要再跨线程发事件。
fn log_write_ex(level: &str, verbose: bool, s: &str, emit: bool) {
    if verbose && !VERBOSE_LOG.load(Ordering::Relaxed) {
        return;
    }
    println!("[pet-debug][{level}] {s}");
    let Some(dir) = LOG_DIR.get() else { return };

    let time = stamp();
    let line = format!("[{time}] [{level}] {s}");
    let date = time.get(..10).unwrap_or("").to_string();

    // 跨天仍在运行时补一条日期分隔，读日志时不会把两天混在一起
    let mut marker = String::new();
    if let Ok(mut last) = LAST_DATE.lock() {
        if !last.is_empty() && *last != date {
            marker = format!("===== 日期变更 {date} =====\n");
        }
        *last = date;
    }

    let lasted = dir.join("lasted.log");
    append_file(&lasted, &format!("{marker}{line}\n"));
    trim_file(&lasted, LASTED_TRIM_BYTES);

    if level == "WARN" || level == "ERROR" {
        let mut block = format!("===== {time} {level} =====\n");
        if let Ok(ring) = RECENT_LINES.lock() {
            for l in ring.iter() {
                block.push_str(l);
                block.push('\n');
            }
        }
        block.push_str(&line);
        block.push_str("\n\n");
        let err_path = dir.join("error.log");
        append_file(&err_path, &block);
        trim_file(&err_path, ERROR_TRIM_BYTES);
    }

    // ERROR 级别推给前端弹红条。歌词拉取失败属于高频噪声，前端不弹（这里照常落盘）。
    if emit && level == "ERROR" && !s.starts_with("[lyrics]") {
        if let Some(app) = LOG_EVENT_HANDLE.get() {
            let _ = app.emit(
                "petra:log-error",
                serde_json::json!({ "text": s, "at": time }),
            );
        }
    }

    // 关键 WARN（异常退出 / 前端无心跳）也推给前端，橙色提示。
    if emit && level == "WARN" && warn_needs_popup(s) {
        if let Some(app) = LOG_EVENT_HANDLE.get() {
            let _ = app.emit(
                "petra:log-warn",
                serde_json::json!({ "text": s, "at": time }),
            );
        }
    }

    // 环形缓冲也收 DEBUG：详细日志开着时，这些操作细节正是事后定位问题的上下文。
    // （verbose 关闭时 DEBUG 根本走不到这里，不占内存）
    if let Ok(mut ring) = RECENT_LINES.lock() {
        ring.push_back(line);
        while ring.len() > 80 {
            ring.pop_front();
        }
    }
}

/// 常规日志（启动信息、状态变化、用户操作）
fn log_line(s: &str) {
    log_write("INFO", false, s);
}

/// 高频细节（拖动、交互区域、模型路径…）：默认不落盘，排查问题时再打开
fn log_verbose(s: &str) {
    log_write("DEBUG", true, s);
}

/// 需要注意但不致命
/// 哪些 WARN 值得打断用户（橙色提示）。
///
/// 平台降级（Wayland 定位、屏幕回环、SMTC）、内部容量（交互区域截断）、
/// 回收站失败这类只写日志：它们要么每次启动都出现，要么用户操作时才出现，
/// 全都弹窗会把真正重要的提示淹掉。
fn warn_needs_popup(s: &str) -> bool {
    s.starts_with("[boot] 上次运行没有正常退出") || s.starts_with("[watchdog]")
}

fn log_warn(s: &str) {
    log_write("WARN", false, s);
}

/// 出错了
fn log_error(s: &str) {
    log_write("ERROR", false, s);
}

/// 归档名里的时间片段：优先用 lasted.log 第一行的时间（= 上次启动时刻）。
fn archive_stamp(dir: &std::path::Path) -> String {
    if let Ok(text) = std::fs::read_to_string(dir.join("lasted.log")) {
        if let Some(line) = text.lines().next() {
            // [2026-10-24 16:58:07] → 2026-10-24_16-58-07
            // 精确到秒：只到分钟的话，同一分钟内重启两次会撞名；
            // 用 get 而不是切片，避免畸形首行正好切在多字节字符中间。
            if line.starts_with('[') {
                if let Some(t) = line.get(1..20) {
                    return t.replace(' ', "_").replace(':', "-");
                }
            }
        }
    }
    let s = stamp();
    s.get(..19).unwrap_or(&s).replace(' ', "_").replace(':', "-")
}

/// 把上次运行的 lasted.log / error.log 以日期命名压成 zip，并只保留最近 15 份。
fn archive_logs(dir: &std::path::Path) {
    // 迁移历史文件：更早叫 pet.log，上一版叫 lasted.txt，都接过来别丢
    let lasted_path = dir.join("lasted.log");
    if !lasted_path.exists() {
        for legacy in [dir.join("pet.log"), dir.join("lasted.txt")] {
            if legacy.exists() {
                let _ = std::fs::rename(&legacy, &lasted_path);
                break;
            }
        }
    }
    let error_path = dir.join("error.log");
    if !error_path.exists() && dir.join("error.txt").exists() {
        let _ = std::fs::rename(dir.join("error.txt"), &error_path);
    }
    // lasted.log 已存在但还留着上一版的 lasted.txt（升级后第一次重启就是这种状态）：
    // 把旧内容接在 lasted.log 末尾再删掉，否则它会永远躺在日志目录里占地方。
    absorb_legacy_txt(dir, &lasted_path);

    let non_empty = |p: &std::path::Path| std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false);
    if !non_empty(&lasted_path) && !non_empty(&error_path) {
        let _ = std::fs::remove_file(&error_path);
        return;
    }

    let name = archive_stamp(dir);
    // 同一分钟内可能启动多次（崩溃后自动重启、用户连点重启）：
    // 直接 File::create 会把上一份归档截断，所以同名的自动加 -2、-3
    let zip_path = unique_archive_path(dir, &format!("lasted-{name}"), "zip");
    let zip_ok = (|| -> std::io::Result<()> {
        let file = std::fs::File::create(&zip_path)?;
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (entry, path) in [("lasted.log", &lasted_path), ("error.log", &error_path)] {
            let Ok(bytes) = std::fs::read(path) else { continue };
            if bytes.is_empty() {
                continue;
            }
            zw.start_file(format!("{}_{}.log", entry.trim_end_matches(".log"), name), opts)
                .map_err(std::io::Error::other)?;
            zw.write_all(&bytes)?;
        }
        zw.finish().map_err(std::io::Error::other)?;
        Ok(())
    })();

    if zip_ok.is_ok() {
        let _ = std::fs::remove_file(&lasted_path);
        let _ = std::fs::remove_file(&error_path);
        log_line(&format!(
            "上次运行的日志已归档：{}",
            zip_path.file_name().unwrap_or_default().to_string_lossy()
        ));
    } else {
        // 压缩失败也不能让日志无限堆：半截 zip 删掉，正文直接改名保留
        let _ = std::fs::remove_file(&zip_path);
        let _ = std::fs::rename(&lasted_path, unique_archive_path(dir, &format!("lasted-{name}"), "log"));
        if std::fs::metadata(&error_path).map(|m| m.len() > 0).unwrap_or(false) {
            let _ = std::fs::rename(&error_path, unique_archive_path(dir, &format!("error-{name}"), "log"));
        } else {
            let _ = std::fs::remove_file(&error_path);
        }
    }

    prune_archives(dir);
}

/// 把上一版遗留的 lasted.txt 并进 lasted.log（只会在升级后的第一次启动触发一次）。
fn absorb_legacy_txt(dir: &std::path::Path, lasted: &std::path::Path) {
    let legacy = dir.join("lasted.txt");
    let Ok(old) = std::fs::read_to_string(&legacy) else { return };
    if old.trim().is_empty() {
        let _ = std::fs::remove_file(&legacy);
        return;
    }
    append_file(
        lasted,
        &format!("===== 以下为上一版 lasted.txt 迁移内容 =====\n{old}"),
    );
    let _ = std::fs::remove_file(&legacy);
}

/// 归档文件名去重：`lasted-<时间>.zip` 已存在就试 `-2`、`-3`…
fn unique_archive_path(dir: &std::path::Path, stem: &str, ext: &str) -> std::path::PathBuf {
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    path
}

/// 归档只保留最近 15 份（按修改时间倒序）
fn prune_archives(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut zips: Vec<(std::path::PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            if !name.starts_with("lasted-") || !(name.ends_with(".zip") || name.ends_with(".log")) {
                return None;
            }
            let mtime = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            Some((path, mtime))
        })
        .collect();
    if zips.len() <= LOG_ARCHIVE_KEEP {
        return;
    }
    zips.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in zips.into_iter().skip(LOG_ARCHIVE_KEEP) {
        let _ = std::fs::remove_file(path);
    }
}

/// 「详细日志」开关：默认 debug 构建开、release 关；
/// 需要时可用环境变量 PETRA_VERBOSE_LOG=1 临时打开（support 排查用）。
fn verbose_log_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var("PETRA_VERBOSE_LOG").map(|v| v == "1").unwrap_or(false)
}

// ---------- 盲区观测：运行状态 / 心跳 / 内存 ----------

fn run_state_path() -> Option<std::path::PathBuf> {
    LOG_DIR.get().map(|d| d.join("run-state.json"))
}

/// 记录"应用正在运行"。正常退出时会改写成 false；
/// 下次启动若发现上次仍是 true，说明上次没走正常退出（崩溃 / 被强杀 / 断电）。
fn save_run_state(running: bool) {
    let Some(path) = run_state_path() else { return };
    let _ = std::fs::write(path, format!("{{\"running\":{running},\"at\":{}}}", now_ms()));
}

fn log_previous_run_state() {
    let Some(path) = run_state_path() else { return };
    if let Ok(text) = std::fs::read_to_string(&path) {
        if text.contains("\"running\":true") {
            log_warn("[boot] 上次运行没有正常退出（崩溃 / 被强制结束 / 断电），本次启动前请留意末尾日志");
        }
    }
    save_run_state(true);
}

/// 前端心跳（每 5 秒一次）。看门狗据此判断界面是否还活着。
#[tauri::command]
fn app_heartbeat() {
    LAST_BEAT_MS.store(now_ms(), Ordering::Relaxed);
}

/// 看门狗：前端超过 25 秒没心跳就记一条（只记一次，恢复时再记一条）。
/// WebView 渲染进程崩溃 / 主线程卡死时 JS 发不出任何错误，这是唯一能留下线索的地方。
fn spawn_heartbeat_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut warned = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            // 窗口隐藏/最小化时 WebView 会节流定时器，心跳变慢是正常现象，
            // 不能当成"卡死"。这里只在窗口可见时判定。
            let visible = app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(true);
            if !visible {
                warned = false;
                continue;
            }
            let last = LAST_BEAT_MS.load(Ordering::Relaxed);
            if last == 0 {
                continue; // 前端还没起来
            }
            let idle = now_ms().saturating_sub(last);
            if idle > 25_000 {
                if !warned {
                    warned = true;
                    log_warn(&format!(
                        "[watchdog] 前端 {:.0} 秒没有心跳（界面可能卡死或白屏）",
                        idle as f64 / 1000.0
                    ));
                }
            } else if warned {
                warned = false;
                log_line("[watchdog] 前端心跳恢复");
            }
        }
    });
}

/// 当前进程内存（工作集 MB，私有字节 MB）。
#[cfg(windows)]
fn current_memory_mb() -> Option<(u64, u64)> {
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;
    // EX 版本才带 PrivateUsage；函数签名收的是 COUNTERS 指针，按 EX 的大小传即可
    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    let ok = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        )
    };
    ok.ok()
        .map(|_| (counters.WorkingSetSize as u64 / 1_048_576, counters.PrivateUsage as u64 / 1_048_576))
}

/// Linux：/proc/self/statm 里前两个字段是总页数、常驻页数。
#[cfg(target_os = "linux")]
fn current_memory_mb() -> Option<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/self/statm").ok()?;
    let mut it = text.split_whitespace();
    let _total: u64 = it.next()?.parse().ok()?;
    let resident: u64 = it.next()?.parse().ok()?;
    let mb = resident * 4096 / 1_048_576;
    Some((mb, mb))
}

/// macOS：暂不采集（需要 mach task_info，收益不如前两个平台明显）。
#[cfg(target_os = "macos")]
fn current_memory_mb() -> Option<(u64, u64)> {
    None
}

/// 每 5 分钟记一次内存；超过 1.5GB 用 WARN，方便事后判断"是不是内存涨爆的"。
fn spawn_memory_sampler() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(300));
        let Some((working, private)) = current_memory_mb() else { continue };
        if working >= 1500 {
            log_warn(&format!(
                "[mem] 工作集 {working} MB / 私有 {private} MB（偏高，留意内存泄漏）"
            ));
        } else {
            log_line(&format!("[mem] 工作集 {working} MB / 私有 {private} MB"));
        }
    });
}


#[cfg(test)]
mod log_tests {
    use super::*;

    #[test]
    fn stamp_is_readable_local_time() {
        let s = stamp();
        assert_eq!(s.len(), 19, "时间戳格式应为 YYYY-MM-DD HH:MM:SS，实际 {s}");
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[10], b' ');
        assert_eq!(s.as_bytes()[13], b':');
        assert!(s.starts_with("20"), "年份异常：{s}");
    }

    #[test]
    fn truncate_keeps_short_text_intact() {
        let s = "[2026-01-01 00:00:00] [INFO] hi\n";
        assert_eq!(truncate_log(s), s);
    }

    #[test]
    fn truncate_keeps_head_and_tail() {
        let head_marker = "[2026-01-01 00:00:00] [INFO] === pet started v0.2.4 ===";
        let tail_marker = "[2026-01-01 00:00:10] [ERROR] 最后一条";
        let middle = "x".repeat(LOG_ATTACH_MAX_CHARS);
        let text = format!("{head_marker}\n{middle}\n{tail_marker}\n");
        let out = truncate_log(&text);
        assert!(out.chars().count() < text.chars().count());
        assert!(out.contains(head_marker), "保留了开头");
        assert!(out.contains(tail_marker), "保留了结尾");
        assert!(out.contains("中间省略"), "有省略提示");
    }

    #[test]
    fn trim_file_keeps_tail_only() {
        let dir = std::env::temp_dir().join(format!("petra-trim-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("lasted.log");
        let mut text = String::new();
        for i in 0..5000 {
            text.push_str(&format!("[2026-10-24 10:00:00] [INFO] 第 {i} 行\n"));
        }
        std::fs::write(&path, &text).unwrap();
        trim_file(&path, 4096);
        let kept = std::fs::read_to_string(&path).unwrap();
        assert!(kept.len() <= 4096, "截断后应不超过上限，实际 {}", kept.len());
        assert!(kept.contains("第 4999 行"), "保留最新内容");
        assert!(kept.contains("已截断"), "有截断提示");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_archive_path_avoids_overwrite() {
        let dir = std::env::temp_dir().join(format!("petra-unique-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_archive_path(&dir, "lasted-2026-10-24_17-03-05", "zip");
        assert!(first.to_string_lossy().ends_with("lasted-2026-10-24_17-03-05.zip"));
        std::fs::write(&first, b"x").unwrap();
        let second = unique_archive_path(&dir, "lasted-2026-10-24_17-03-05", "zip");
        assert!(second.to_string_lossy().ends_with("lasted-2026-10-24_17-03-05-2.zip"), "同名要加序号，实际 {second:?}");
        std::fs::write(&second, b"x").unwrap();
        let third = unique_archive_path(&dir, "lasted-2026-10-24_17-03-05", "zip");
        assert!(third.to_string_lossy().ends_with("-3.zip"), "第三次应是 -3，实际 {third:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_only_fifteen() {
        let dir = std::env::temp_dir().join(format!("petra-prune-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..20 {
            let path = dir.join(format!("lasted-2026-10-{i:02}_10-00.zip"));
            std::fs::write(&path, b"x").unwrap();
            // 拉开修改时间，避免同一毫秒内排序不稳定
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        prune_archives(&dir);
        let left = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(left, LOG_ARCHIVE_KEEP, "应只保留 15 份，实际 {left}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_stamp_uses_first_log_time() {
        let dir = std::env::temp_dir().join(format!("petra-stamp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("lasted.log"),
            "[2026-10-24 16:58:07] [INFO] === pet started ===\n",
        )
        .unwrap();
        assert_eq!(archive_stamp(&dir), "2026-10-24_16-58-07");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 系统名（诊断日志 / 反馈里用）。Windows 读 OS 环境变量，macOS 用编译期常量。
fn os_description() -> String {
    #[cfg(windows)]
    let v = std::env::var("OS").unwrap_or_default();
    #[cfg(unix)]
    let v = std::env::consts::OS.to_string();
    v
}

#[cfg(windows)]
fn read_reg_value(subkey: &str, value: &str) -> String {
    hidden_command("reg")
        .args(["query", subkey, "/v", value])
        .output()
        .map(|o| {
            let text = String::from_utf8_lossy(&o.stdout);
            // reg 输出末行形如: "    pv    REG_SZ    121.0.0.0"
            text.lines()
                .rev()
                .find(|l| l.contains("REG_SZ"))
                .and_then(|l| l.split("REG_SZ").nth(1))
                .map(|v| v.trim().to_string())
                .unwrap_or_default()
        })
        .unwrap_or_else(|_| String::new())
}

/// macOS / Linux 没有注册表。这里的调用点（WebView2 版本、WinINET ProxyEnable）
/// 全是 Windows 专属信息，统一返回空串即可。
#[cfg(unix)]
fn read_reg_value(_subkey: &str, _value: &str) -> String {
    String::new()
}

/// 启动时打印环境信息，帮助定位 WebView2 加载问题。
fn log_environment() {
    log_line(&format!("OS_VAR: {}", os_description()));
    // WebView2 是 Windows 专有运行时，mac 上打了也是空值
    #[cfg(windows)]
    log_line(&format!(
        "WebView2(64): {}",
        read_reg_value(
            r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
            "pv"
        )
    ));
    let sys = read_reg_value(
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        "ProxyEnable",
    );
    // 这行留在 INFO：歌词/更新/小助手都走网络，出问题时第一眼就要看走没走代理
    log_line(&format!(
        "系统代理: {}",
        crate::proxy::get_system_proxy().unwrap_or_else(|| "无".into())
    ));
    log_verbose(&format!("WinINET ProxyEnable: {sys}"));
    log_verbose(&format!(
        "HTTP_PROXY env: '{}'",
        std::env::var("HTTP_PROXY").unwrap_or_default()
    ));
    log_verbose(&format!(
        "HTTPS_PROXY env: '{}'",
        std::env::var("HTTPS_PROXY").unwrap_or_default()
    ));
    log_verbose(&format!(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '{}'",
        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default()
    ));
    if let Some(dir) = LOG_DIR.get() {
        log_line(&format!("日志目录: {}", dir.display()));
    }
}

#[tauri::command]
fn trash_files(paths: Vec<String>) -> Result<TrashResult, String> {
    log_line(&format!("trash_files: {} paths", paths.len()));
    let count = trash::move_to_recycle_bin(&paths)?;
    log_line(&format!("trash_files: ok, moved {count}"));
    Ok(TrashResult { ok: true, count })
}

#[tauri::command]
fn work_area_at(x: i32, y: i32) -> WorkArea {
    screen::work_area_at(x, y)
}

#[tauri::command]
fn cursor_pos(app: AppHandle) -> CursorPos {
    screen::cursor_pos(&app)
}

fn point_in_interactive_regions(x: i32, y: i32, regions: &[InteractiveRegion]) -> bool {
    regions.iter().any(|region| {
        if !region.enabled || region.width <= 0 || region.height <= 0 {
            return false;
        }
        let left = i64::from(region.x);
        let top = i64::from(region.y);
        let right = left + i64::from(region.width);
        let bottom = top + i64::from(region.height);
        let px = i64::from(x);
        let py = i64::from(y);
        px >= left && px < right && py >= top && py < bottom
    })
}

fn should_accept_input(
    snapshot: &InteractionSnapshot,
    renderer_locked: bool,
    native_dragging: bool,
    cursor: Option<(i32, i32)>,
    now: std::time::Instant,
    // 上一次的判定结果：光标取不到时沿用它，避免一次失败就整窗穿透
    fallback: bool,
    // 客户端实际像素尺寸（Win32 口径），用于把光标坐标换算到区域坐标系
    client_size: Option<(u32, u32)>,
) -> bool {
    // 前端尚未上报交互区域前（例如启动加载模型期间），窗口必须保持鼠标穿透，
    // 否则透明的 700x700 窗口会挡住屏幕中央，导致点击桌面和其他窗口无效。
    if !snapshot.initialized {
        return false;
    }
    if renderer_locked || native_dragging {
        return true;
    }
    let Some(last_update) = snapshot.last_update else {
        return false;
    };
    // 前端长时间未更新区域（可能已卡死）时同样穿透，避免透明窗口持续拦截屏幕。
    if now.duration_since(last_update) > INTERACTION_STATE_STALE_AFTER {
        return false;
    }
    let Some((x, y)) = cursor else {
        // 取不到光标（远程桌面 / UAC 安全桌面 / 多屏边界等）时沿用上一次判定：
        // 一次取不到就整窗穿透，会让菜单和按钮「点了没反应」
        return fallback;
    };
    if point_in_interactive_regions(x, y, &snapshot.regions) {
        return true;
    }
    // 坐标系不匹配的兜底：前端上报的是「CSS px × devicePixelRatio」，而 Win32 的
    // ScreenToClient 在高 DPI / WebView 缩放下可能给出另一套刻度（实测 200% 缩放下
    // 差将近 2 倍）。用「前端视口 / 客户端实际尺寸」求出换算比再试一次，
    // 否则表现就是「明明指着宠物却整窗穿透，点不动也拖不动」。
    if let Some((vw, vh)) = snapshot.viewport_px {
        if vw > 1.0 && vh > 1.0 {
            if let Some((cw, ch)) = client_size {
                if cw > 1 && ch > 1 {
                    let kx = vw / cw as f32;
                    let ky = vh / ch as f32;
                    let sx = (x as f32 * kx).round() as i32;
                    let sy = (y as f32 * ky).round() as i32;
                    if point_in_interactive_regions(sx, sy, &snapshot.regions) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[tauri::command]
fn sync_interaction_regions(
    state: State<'_, InteractionState>,
    regions: Vec<InteractiveRegion>,
    viewport_width: Option<f32>,
    viewport_height: Option<f32>,
) -> Result<(), String> {
    const MAX_REGIONS: usize = 128;
    // 逐条过滤非法区域，**不要整批失败**：以前只要有一条坏数据（数量超限、
    // 坐标越界、尺寸为 0），整次上报被拒、快照停在旧值，10 秒后全窗穿透 ——
    // 一条坏区域拖垮所有点击。
    let mut clean: Vec<InteractiveRegion> = Vec::with_capacity(regions.len().min(MAX_REGIONS));
    for region in regions {
        if region.id.is_empty() || region.id.len() > 128 {
            continue;
        }
        if region.width <= 0 || region.height <= 0 {
            continue;
        }
        if region.x.unsigned_abs() > 100_000
            || region.y.unsigned_abs() > 100_000
            || region.width > 100_000
            || region.height > 100_000
        {
            continue;
        }
        if clean.len() >= MAX_REGIONS {
            log_warn("交互区域超过 128 条，已截断");
            break;
        }
        clean.push(region);
    }
    let mut snapshot = state.snapshot.lock().unwrap();
    snapshot.regions = clean;
    snapshot.initialized = true;
    if let (Some(w), Some(h)) = (viewport_width, viewport_height) {
        if w > 1.0 && h > 1.0 {
            snapshot.viewport_px = Some((w, h));
        }
    }
    snapshot.last_update = Some(std::time::Instant::now());
    Ok(())
}

/// 窗口偏好文件路径：app_data_dir/window-state.json
/// 只存用户明确改过的窗口状态（目前是置顶开关）；放应用数据目录，卸装/重装仍保留。
fn window_state_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("window-state.json"))
}

/// 读回用户上次选的置顶状态；没有文件（首次运行）→ None。
fn load_topmost_pref(app: &AppHandle) -> Option<bool> {
    let p = window_state_path(app).ok()?;
    let raw = std::fs::read_to_string(p).ok()?;
    topmost_from_json(&raw)
}

/// 写入置顶状态，**保留文件里的其它字段**（以后再加别的窗口状态不会互相覆盖）。
/// 写失败只丢一次记忆，不影响本次置顶效果，因此不向上报错。
fn save_topmost_pref(app: &AppHandle, on: bool) {
    let Ok(path) = window_state_path(app) else {
        return;
    };
    let mut obj = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert("topmost".into(), serde_json::Value::Bool(on));
    if let Ok(json) = serde_json::to_string_pretty(&serde_json::Value::Object(obj)) {
        let _ = std::fs::write(&path, json);
    }
}

#[tauri::command]
fn hide_pet(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

/// 从已存的窗口状态 JSON 里读 topmost；缺字段 / 文件损坏 → None（由调用方定默认值）。
/// 纯函数，便于单测（不碰文件系统与 AppHandle）。
fn topmost_from_json(raw: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("topmost")?.as_bool()
}

#[tauri::command]
fn set_topmost(app: AppHandle, state: State<'_, TopmostState>, on: bool) -> bool {
    if let Some(win) = app.get_webview_window("main") {
        // 同步 Tauri 内部标志，避免后续其它窗口操作覆盖
        let _ = win.set_always_on_top(on);
        // 直接 Win32 立即生效
        screen::set_topmost(&win, on);
        state.enabled.store(on, Ordering::SeqCst);
        // 落盘：以前只存在内存里，重启必然回到配置里的 alwaysOnTop=true，
        // 于是「取消置顶」每次重开都失效。这里记住用户的选择，setup 里读回来。
        save_topmost_pref(&app, on);
        return true;
    }
    false
}

#[tauri::command]
fn is_topmost(state: State<'_, TopmostState>) -> bool {
    state.enabled.load(Ordering::SeqCst)
}

#[tauri::command]
fn show_pet(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 诊断通道入口：前端所有报错/阶段埋点汇集于此（stdout + 日志文件）。
#[tauri::command]
fn debug_mark(msg: String) {
    log_line(&msg);
}

/// 验证「panic 也会写进日志」用：仅在 debug 构建里真的 panic。
/// 前端可以通过 `invoke("debug_panic_test")` 触发一次，确认 pet.log 里出现
/// `[panic] ... @ 文件:行:列` —— 发布版会直接返回错误，不会崩。
#[tauri::command]
fn debug_panic_test() -> Result<(), String> {
    // 用 cfg 而不是运行时判断：发布版里连 panic 字符串都不会编进二进制。
    // 命令本身保留（否则 generate_handler! 的列表要分叉），发布版只返回错误。
    #[cfg(debug_assertions)]
    {
        panic!("这是一条用于验证日志的测试 panic（debug_panic_test）");
    }
    #[cfg(not(debug_assertions))]
    {
        Err("仅调试构建可用".into())
    }
}


/// 测试用：写一条 WARN 级别日志（白名单内的会触发橙色提示）。
/// 仅 debug 构建可用；发布版直接返回错误，不写日志。
#[tauri::command]
fn debug_log_warn(msg: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        log_warn(&msg);
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = msg;
        Err("仅调试构建可用".into())
    }
}

/// 测试用：写一条 ERROR 级别日志（会触发前端红色提示条）。
/// 仅 debug 构建可用；发布版直接返回错误，不写日志。
#[tauri::command]
fn debug_log_error(msg: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        log_error(&msg);
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = msg;
        Err("仅调试构建可用".into())
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

pub(crate) fn sanitize_psd_name(name: &str) -> String {
    const MAX_NAME_LEN: usize = 64;
    // 导入名称可能包含 Windows 路径；在 macOS/Linux 上也必须剥离反斜杠目录。
    let normalized = name.replace('\\', "/");
    let base = std::path::Path::new(&normalized)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let clean: String = base
        .chars()
        .take(MAX_NAME_LEN)
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' { c } else { '_' })
        .collect();
    if clean.to_lowercase().ends_with(".psd") {
        clean
    } else {
        format!("{clean}.psd")
    }
}

pub(crate) fn models_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 拖放导入用：读取磁盘任意文件的字节（仅前端触发，用于 PSD 导入）。
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    if !path.to_lowercase().ends_with(".psd") {
        return Err("只接受 .psd 文件".into());
    }
    // 大小上限：避免超大 PSD 全量读入内存导致进程 OOM/卡死（正常 PSD 约 3~16MB）
    const MAX_BYTES: u64 = 200 * 1024 * 1024;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "文件过大（{} MB），请使用 200MB 以内的 PSD",
            meta.len() / 1024 / 1024
        ));
    }
    std::fs::read(&path).map_err(|e| e.to_string())
}

/// 把导入的 PSD 存到应用数据目录 models/ 下，返回文件名。
#[tauri::command]
fn save_psd(app: AppHandle, name: String, bytes: Vec<u8>) -> Result<String, String> {
    let file_name = sanitize_psd_name(&name);
    let dir = models_dir(&app)?;
    std::fs::write(dir.join(&file_name), bytes).map_err(|e| e.to_string())?;
    Ok(file_name)
}

/// 读取数据目录里的 PSD。
#[tauri::command]
fn read_psd(app: AppHandle, name: String) -> Result<Vec<u8>, String> {
    let file_name = sanitize_psd_name(&name);
    let dir = models_dir(&app)?;
    std::fs::read(dir.join(&file_name)).map_err(|e| e.to_string())
}

/// 聊天历史文件路径：app_data_dir/chat-history.json
/// 放在用户数据目录（而非软件安装目录），卸载/重装后仍保留。
fn chat_history_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("chat-history.json"))
}

/// 保存聊天历史（前端传入 JSON 字符串，整体覆盖写）。
#[tauri::command]
fn save_chat_history(app: AppHandle, content: String) -> Result<(), String> {
    let p = chat_history_path(&app)?;
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取聊天历史；文件不存在时返回空字符串（首次运行）。
#[tauri::command]
fn load_chat_history(app: AppHandle) -> Result<String, String> {
    let p = chat_history_path(&app)?;
    if !p.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

/// 读取内置模型 manifest.json（多路径尝试，适配便携版和安装版）
#[tauri::command]
fn read_model_manifest(app: AppHandle) -> Result<String, String> {
    // 候选路径：资源目录 + exe 同级目录（覆盖便携/安装/NSIS 场景）
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(base) = app.path().resource_dir() {
        candidates.push(base.join("_up_/public/models/manifest.json"));
        candidates.push(base.join("models/manifest.json"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("_up_/public/models/manifest.json"));
            candidates.push(dir.join("models/manifest.json"));
            candidates.push(dir.join("resources/models/manifest.json"));
        }
    }
    for p in &candidates {
        if p.exists() {
            log_verbose(&format!("read_model_manifest: {}", p.display()));
            return std::fs::read_to_string(p).map_err(|e| e.to_string());
        }
    }
    Err(format!(
        "manifest.json 未找到，尝试: {}",
        candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("; ")
    ))
}

/// 列出数据目录中已导入的 PSD 模型文件名（模型设置面板用）。
#[tauri::command]
fn list_models(app: AppHandle) -> Vec<String> {
    let dir = match models_dir(&app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|it| {
            it.filter_map(|e| {
                e.ok().and_then(|f| {
                    let n = f.file_name().to_string_lossy().to_string();
                    n.to_lowercase().ends_with(".psd").then_some(n)
                })
            })
            .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// 删除一个已导入的 PSD 模型文件。
/// 仅允许删除应用模型目录（models_dir）内的 .psd 文件：
/// - sanitize_psd_name 剥离目录部分并强制 .psd 后缀，天然阻断路径穿越
/// - canonicalize + starts_with 二次校验，确保目标确在模型目录内
/// - 只删普通文件，文件不存在返回明确错误（可幂等重试）
fn delete_model_file(models_dir: &std::path::Path, name: &str) -> Result<(), String> {
    let file_name = sanitize_psd_name(name);
    if !file_name.to_lowercase().ends_with(".psd") {
        return Err("只允许删除 PSD 模型".into());
    }
    let dir = models_dir
        .canonicalize()
        .map_err(|e| format!("模型目录无效: {e}"))?;
    let target = dir.join(&file_name);
    let canon = target
        .canonicalize()
        .map_err(|e| format!("模型文件不存在或已被删除: {e}"))?;
    if !canon.starts_with(&dir) {
        return Err("非法路径，已拒绝删除".into());
    }
    if !canon.is_file() {
        return Err("目标不是普通文件，已拒绝删除".into());
    }
    std::fs::remove_file(&canon).map_err(|e| format!("删除失败: {e}"))?;
    Ok(())
}

/// 读取内置 PSD 模型字节（通过 model_resource_path 找到文件后直接 read，不走 asset protocol）
#[tauri::command]
fn read_builtin_psd(app: AppHandle, name: String) -> Result<Vec<u8>, String> {
    let path = model_resource_path(app, name)?;
    std::fs::read(&path).map_err(|e| format!("读取 PSD 失败: {e}"))
}

/// 返回内置 PSD 模型在资源目录的绝对路径（供前端 convertFileSrc 读取）。
/// 内置模型作为 bundle.resources 打包为真实文件，不走二进制嵌入（嵌入对大文件有限制）。
#[tauri::command]
fn model_resource_path(app: AppHandle, name: String) -> Result<String, String> {
    let file = sanitize_psd_name(&name);
    if !file.to_lowercase().ends_with(".psd") {
        return Err("只支持 PSD 模型".into());
    }
    // 多路径尝试：资源目录 + exe 同级（跟 read_model_manifest 逻辑一致）
    let mut tried: Vec<String> = Vec::new();
    let mut paths: Vec<(String, std::path::PathBuf)> = Vec::new();
    if let Ok(base) = app.path().resource_dir() {
        for rel in [format!("resources/models/{file}"), format!("models/{file}"), format!("{file}")] {
            paths.push((rel.clone(), base.join(&rel)));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for rel in [
                format!("_up_/public/models/{file}"),
                format!("models/{file}"),
                format!("resources/models/{file}"),
                format!("{file}"),
            ] {
                paths.push((rel.clone(), dir.join(&rel)));
            }
        }
    }
    for (rel, p) in &paths {
        let exists = p.exists();
        tried.push(format!("{rel} -> {} (exists={})", p.display(), exists));
        if exists {
            log_verbose(&format!("model_resource_path: {file} -> {}", p.display()));
            return Ok(p.to_string_lossy().to_string());
        }
    }
    log_warn(&format!("model_resource_path: {file} 未找到，尝试: {}", tried.join("; ")));
    Err(format!("模型资源不存在: {file}"))
}

/// 删除已导入模型（模型设置面板「删除」按钮调用）。
/// 内置模型位于打包资源（public/models），不在 app_data/models，
/// 本命令只操作 app_data/models，天然无法删除内置模型。
#[tauri::command]
fn delete_imported_model(app: AppHandle, name: String) -> Result<(), String> {
    let file_name = sanitize_psd_name(&name);
    let dir = models_dir(&app)?;
    match delete_model_file(&dir, &file_name) {
        Ok(()) => {
            log_line(&format!("delete_imported_model: 已删除 {file_name}"));
            Ok(())
        }
        Err(e) => {
            log_error(&format!("delete_imported_model: 删除 {file_name} 失败: {e}"));
            Err(e)
        }
    }
}

#[tauri::command]
fn set_audio_enabled(state: State<'_, AudioState>, enabled: bool) -> bool {
    state.enabled.store(enabled, Ordering::SeqCst);
    enabled
}

/// 前端每 ~100ms 上报漫游目标点，由 mover 线程原生平滑移动窗口。
#[tauri::command]
fn set_pet_target(state: State<'_, PetMotion>, x: f64, y: f64) {
    *state.target.lock().unwrap() = Some((x, y, 340.0));
}

/// 拖动专用：高速移动（跟手），避免 IPC 跳变残影。
#[tauri::command]
fn set_pet_target_speed(state: State<PetMotion>, x: f64, y: f64, speed: f64) {
    *state.target.lock().unwrap() = Some((x, y, speed.max(100.0)));
}

#[tauri::command]
fn set_pet_tracking(state: State<PetMotion>, on: bool) {
    state.tracking.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// 更新拖拽时的模型边界（前端每帧调用，用于拖拽时夹紧窗口不让模型出屏）
#[tauri::command]
fn set_model_bounds(state: State<'_, DragState>, left: i32, top: i32, right: i32, bottom: i32) {
    // 范围校验（对齐 sync_interaction_regions）：防止极端值让 8ms 拖动线程
    // 的 i32 运算溢出（debug 直接 panic 杀掉线程，release 回绕导致窗口乱跳）
    const LIMIT: i32 = 100_000;
    let sane = [left, top, right, bottom]
        .iter()
        .all(|v| v.unsigned_abs() <= LIMIT as u32)
        && right > left
        && bottom > top;
    if !sane {
        return;
    }
    *state.model_bounds.lock().unwrap() = (left, top, right, bottom);
}

/// 拖动开始：记录抓取偏移（鼠标 - 窗口左上角），进入跟随模式。
/// locked_y（可选）：待机边缘滑动，y 锁定该值（物理），只随鼠标水平移动。
#[tauri::command]
fn drag_start(app: AppHandle, state: State<'_, DragState>, locked_y: Option<i32>) {
    if let Some(win) = app.get_webview_window("main") {
        if let Some(off) = screen::drag_offset(&win) {
            *state.offset.lock().unwrap() = off;
            *state.locked_y.lock().unwrap() = locked_y;
            state.active.store(true, Ordering::SeqCst);
            log_verbose(&format!(
                "drag:start locked_y={}",
                locked_y.map(|v| v.to_string()).unwrap_or_else(|| "none".into())
            ));
        }
    }
}

/// 拖动结束：退出跟随模式。
#[tauri::command]
fn drag_end(state: State<'_, DragState>) {
    if state.active.swap(false, Ordering::SeqCst) {
        *state.locked_y.lock().unwrap() = None;
        log_verbose("drag:end");
    }
}

/// 程序化改窗口尺寸（物理像素，DPI 换算由前端完成）。
/// 绕开 Tauri setSize 在 resizable:false 下可能失效的限制。
#[tauri::command]
fn set_window_size(app: AppHandle, width: u32, height: u32) {
    if let Some(win) = app.get_webview_window("main") {
        screen::set_window_size(&win, width as i32, height as i32);
    }
}

/// 8ms 循环：拖动中直接 GetCursorPos → SetWindowPos 跟随鼠标（像素级、无 IPC 每帧延迟）。
fn spawn_drag_follower(app: AppHandle) {
    std::thread::spawn(move || {
        // scale_factor 每 8ms 问一次 tao 会跟主线程的渲染循环抢锁，实测是拖拽"发涩"的来源之一；
        // 拖拽期间缩放几乎不会变，缓存起来每 ~0.5 秒刷一次就够
        let mut scale = 1.0f64;
        let mut scale_tick = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(8));
            let Some(drag) = app.try_state::<DragState>() else {
                continue;
            };
            if !drag.active.load(Ordering::SeqCst) {
                scale_tick = 0; // 下次开始拖拽时立刻取一次
                continue;
            }
            // 物理鼠标键自愈：active 只由前端的 pointerup/cancel/blur 清掉，
            // 一旦松手事件被吞（窗口跟着光标走，前端的"光标出窗"看门狗又不会触发），
            // 桌宠会一直跟着鼠标跑。这里每 8ms 校验一次左键，松开就自行结束拖拽。
            #[cfg(windows)]
            {
                let down = unsafe {
                    windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
                        windows::Win32::UI::Input::KeyboardAndMouse::VK_LBUTTON.0 as i32,
                    )
                } as u16
                    & 0x8000
                    != 0;
                if !down {
                    drag.active.store(false, Ordering::SeqCst);
                    scale_tick = 0;
                    continue;
                }
            }
            let Some(win) = app.get_webview_window("main") else {
                continue;
            };
            let off = *drag.offset.lock().unwrap();
            let locked = *drag.locked_y.lock().unwrap();
            let bounds = *drag.model_bounds.lock().unwrap();
            if scale_tick == 0 {
                scale = get_window_scale_factor(&app);
            }
            scale_tick = (scale_tick + 1) % 60;
            screen::drag_follow(&win, off.0, off.1, locked, Some(bounds), scale);
        }
    });
}

/// 小助手主动问候：取当前前台窗口标题 + 进程名，供 AI 判断用户在做什么。
///
/// 桌宠自己的窗口（点击、开面板、弹气泡）经常就是前台窗口，直接返回会永远
/// 识别成"Petra"。所以从前景窗口沿 z 序往下找第一个不属于本进程、且可见的窗口
/// —— 也就是桌宠底下那层，主人真正在用的那个。
#[cfg(windows)]
#[tauri::command]
fn active_window_title() -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindow, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, GW_HWNDNEXT,
    };
    unsafe {
        let mut hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return String::new();
        }
        let own_pid = std::process::id();
        let mut walked = 0u32;
        loop {
            let mut wpid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut wpid));
            if wpid != own_pid && IsWindowVisible(hwnd).as_bool() {
                break;
            }
            // 上限兜底：z 序理论上有限，但异常窗口链不该让这里转死
            let next = match GetWindow(hwnd, GW_HWNDNEXT) {
                Ok(h) => h,
                Err(_) => return String::new(),
            };
            if next.is_invalid() || next == hwnd || walked >= 200 {
                return String::new();
            }
            hwnd = next;
            walked += 1;
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..len as usize]).trim().to_string();
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut exe = String::new();
        if pid != 0 {
            if let Ok(proc) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                // windows 0.58 的 HANDLE 是 Copy 类型且无 Drop 实现，
                // OpenProcess 成功后必须显式 CloseHandle，否则每次调用泄漏一个进程句柄。
                // 本作用域内无 early return，块结束前必然走到这里释放。
                let mut exebuf = [0u16; 1024];
                let mut size = exebuf.len() as u32;
                if QueryFullProcessImageNameW(
                    proc,
                    PROCESS_NAME_WIN32,
                    windows::core::PWSTR(exebuf.as_mut_ptr()),
                    &mut size,
                )
                .is_ok()
                {
                    let path = String::from_utf16_lossy(&exebuf[..size as usize]);
                    exe = std::path::Path::new(&path)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or(path);
                }
                let _ = CloseHandle(proc);
            }
        }
        if !exe.is_empty() {
            format!("{title} [{exe}]")
        } else {
            title
        }
    }
}

/// 小助手主动问候：取当前前台窗口标题。
///
/// macOS 版暂时返回空串：读取前台 App / 窗口标题要走
/// macOS 版"当前在用什么软件"：NSWorkspace.frontmostApplication。
///
/// 关键点：这是**公开 API，不需要辅助功能权限**（拿窗口标题才需要，所以这里只取 app 名）。
/// 日记的「常用软件」时间线、小助手回答"你现在在用什么"用的正是 app 名，够用。
/// Windows 那边是 GetForegroundWindow + GetWindowText，能拿到完整窗口标题。
#[cfg(target_os = "macos")]
#[tauri::command]
fn active_window_title() -> String {
    use objc2_app_kit::NSWorkspace;
    // NSWorkspace 的信息类查询在任意线程调用都安全（不涉及 UI 更新）
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .and_then(|app| app.localizedName())
        .map(|name| name.to_string())
        .unwrap_or_default()
}

/// 小助手主动问候：取当前前台应用名（Linux）。
///
/// Wayland 下**拿不到**前台应用：合成器不向普通客户端暴露"谁拥有焦点"。
/// X11 时代可以读根窗口的 _NET_ACTIVE_WINDOW（EWMH 属性）再看进程名，
/// 但 Wayland 没有对应机制：能替代的只有合成器私有接口（如 GNOME Shell 的 Eval）
/// 或 wlr-foreign-toplevel-management 这类协议，前者绑死某个桌面环境、
/// 后者要引入新依赖。所以这里如实返回空串 —— 日记的「常用软件」时间线在 Linux 上
/// 缺这一段，小助手问"我在用什么"会得到空答案；其它功能不受影响（前端对空串有兜底）。
#[cfg(target_os = "linux")]
#[tauri::command]
fn active_window_title() -> String {
    String::new()
}

/// 读取 updater 可用的系统代理 URL（只读，不修改系统代理，不记录凭据）。
/// 优先环境变量 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY，其次 WinINET 系统代理。
/// 无代理或失败返回 None，绝不导致启动失败。
#[tauri::command]
fn get_system_proxy() -> Option<String> {
    proxy::get_system_proxy()
}

/// 返回用户空闲秒数（鼠标键盘无输入的时间）。
/// 主动问候场景触发用：空闲太久回来时打招呼、久坐提醒等。
#[cfg(windows)]
#[tauri::command]
fn get_idle_seconds() -> u64 {
    // 使用 raw FFI 调用 GetLastInputInfo，避免 windows crate feature 依赖问题
    #[repr(C)]
    #[allow(non_snake_case)]
    struct LASTINPUTINFO {
        cbSize: u32,
        dwTime: u32,
    }
    extern "system" {
        fn GetLastInputInfo(plii: *mut LASTINPUTINFO) -> i32;
        fn GetTickCount() -> u32;
    }
    unsafe {
        let mut li = LASTINPUTINFO { cbSize: 8, dwTime: 0 };
        if GetLastInputInfo(&mut li) != 0 {
            let tick = GetTickCount();
            return tick.saturating_sub(li.dwTime) as u64 / 1000;
        }
    }
    0
}

/// 返回用户空闲秒数（鼠标键盘无输入的时间）。
///
/// macOS 走 ioreg 读 IOHIDSystem 的 HIDIdleTime（"距上次输入"的纳秒数）。
/// 这是唯一不需要辅助功能权限、也不用引 CoreGraphics 依赖的做法。
/// 读不到就返回 0（等同于"刚刚有输入"，不会误触发久坐提醒）。
#[cfg(target_os = "macos")]
#[tauri::command]
fn get_idle_seconds() -> u64 {
    let out = match hidden_command("/usr/sbin/ioreg")
        .args(["-c", "IOHIDSystem"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return 0,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    // 输出形如：    "HIDIdleTime" = 12345678900
    for line in text.lines() {
        let Some(rest) = line.split("HIDIdleTime").nth(1) else {
            continue;
        };
        let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(ns) = digits.parse::<u64>() {
            return ns / 1_000_000_000;
        }
    }
    0
}

/// 返回用户空闲秒数（鼠标键盘无输入的时间）。
///
/// Linux 走 D-Bus：Wayland 下没有 XScreenSaver 那种"查询空闲"的 X11 扩展，
/// 桌面环境通过 D-Bus 暴露空闲时间，这是公开接口，且与 X11/Wayland 会话类型无关：
///   1. GNOME：org.gnome.Mutter.IdleMonitor.GetIdleTime → 微秒（类型签名 t）
///   2. ScreenSaver 规范：GetSessionIdleTime → 秒（类型签名 u），
///      KDE 在 /ScreenSaver、GNOME 在 /org/gnome/ScreenSaver 各有一份实现。
/// 用 busctl --user 调用（systemd 自带），不引入 zbus/dbus 依赖。
/// 全都取不到就返回 0（等同于"刚刚有输入"，不会误触发久坐提醒）。
#[cfg(target_os = "linux")]
#[tauri::command]
fn get_idle_seconds() -> u64 {
    /// 跑一条 busctl 方法调用，成功返回 stdout 文本。
    fn busctl_call(service: &str, path: &str, iface: &str, method: &str) -> Option<String> {
        let out = hidden_command("busctl")
            .args(["--user", "call", service, path, iface, method])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// busctl 输出形如 "t 123456789"（类型签名 + 值）；取最后一个空白分隔的 token 当数值。
    fn last_number(text: &str) -> Option<u64> {
        text.split_whitespace().last()?.parse::<u64>().ok()
    }

    if let Some(micros) = busctl_call(
        "org.gnome.Mutter.IdleMonitor",
        "/org/gnome/Mutter/IdleMonitor/Core",
        "org.gnome.Mutter.IdleMonitor",
        "GetIdleTime",
    )
    .and_then(|t| last_number(&t))
    {
        return micros / 1_000_000;
    }
    for (service, path, iface) in [
        (
            "org.freedesktop.ScreenSaver",
            "/ScreenSaver",
            "org.freedesktop.ScreenSaver",
        ),
        (
            "org.gnome.ScreenSaver",
            "/org/gnome/ScreenSaver",
            "org.gnome.ScreenSaver",
        ),
    ] {
        if let Some(secs) =
            busctl_call(service, path, iface, "GetSessionIdleTime").and_then(|t| last_number(&t))
        {
            return secs;
        }
    }
    0
}

/// 用 Windows DPAPI 加密数据（绑定当前用户，无需额外密钥）。
#[cfg(windows)]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    unsafe {
        CryptProtectData(
            &in_blob,
            windows::core::PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("加密失败: {e}"))?;
        let v = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(windows::Win32::Foundation::HLOCAL(out_blob.pbData as *mut core::ffi::c_void));
        Ok(v)
    }
}

/// 用 Windows DPAPI 解密数据。
#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    unsafe {
        CryptUnprotectData(
            &in_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("解密失败: {e}"))?;
        let v = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(windows::Win32::Foundation::HLOCAL(out_blob.pbData as *mut core::ffi::c_void));
        Ok(v)
    }
}

#[cfg(windows)]
fn api_key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("api_key.bin"))
}

#[cfg(windows)]
fn tts_key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tts_key.bin"))
}

#[cfg(windows)]
#[tauri::command]
fn set_tts_key(app: AppHandle, api_key: String) -> Result<(), String> {
    if api_key.is_empty() {
        let _ = std::fs::remove_file(tts_key_path(&app)?);
        return Ok(());
    }
    let enc = dpapi_protect(api_key.as_bytes())?;
    std::fs::write(tts_key_path(&app)?, enc).map_err(|e| e.to_string())
}

#[cfg(windows)]
#[tauri::command]
fn get_tts_key(app: AppHandle) -> Result<String, String> {
    let path = tts_key_path(&app)?;
    let enc = std::fs::read(&path).map_err(|_| "".to_string())?;
    if enc.is_empty() { return Ok("".to_string()); }
    let dec = dpapi_unprotect(&enc)?;
    String::from_utf8(dec).map_err(|e| e.to_string())
}

/// 语音识别（ASR）密钥单独存一份：与聊天密钥、TTS 密钥互不覆盖
/// （聊天换供应商时不该把语音识别一起清掉，反之亦然）。
#[cfg(windows)]
fn asr_key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("asr_key.bin"))
}

/// 存 ASR 密钥（Windows/DPAPI）。空字符串 = 清除。
#[cfg(windows)]
#[tauri::command]
fn set_asr_key(app: AppHandle, api_key: String) -> Result<(), String> {
    if api_key.is_empty() {
        let _ = std::fs::remove_file(asr_key_path(&app)?);
        return Ok(());
    }
    let enc = dpapi_protect(api_key.as_bytes())?;
    std::fs::write(asr_key_path(&app)?, enc).map_err(|e| e.to_string())
}

/// 读**用户自己存的** ASR 密钥（Windows/DPAPI）。没存过、存坏了都返回空串。
///
/// 刻意不套内置默认值：这条只用来给设置弹窗回填，绝不能把内置默认 Key 显示到界面上
/// （否则用户一复制，内置 Key 就流出去被刷额度了）。"能不能用"由 asr_key_ready 回答。
#[cfg(windows)]
fn read_stored_asr_key(app: &AppHandle) -> String {
    let Ok(path) = asr_key_path(app) else { return String::new() };
    let Ok(enc) = std::fs::read(&path) else { return String::new() };
    if enc.is_empty() { return String::new(); }
    // 解密失败也当"没有自己的 Key"：下一步会回退到内置默认值，功能照样能用，
    // 没必要为此把整条语音链卡死
    dpapi_unprotect(&enc)
        .ok()
        .and_then(|d| String::from_utf8(d).ok())
        .unwrap_or_default()
}

#[cfg(windows)]
#[tauri::command]
fn get_asr_key(app: AppHandle) -> Result<String, String> {
    Ok(read_stored_asr_key(&app))
}

/// 按供应商分槽的 API Key 存储：`{"deepseek":"sk-...","openai":"sk-..."}`。
type ApiKeyStore = std::collections::BTreeMap<String, String>;

/// 解析存储内容。
///
/// 旧版本只存"一整串 Key"（不是 JSON）。升级时把它当成 `__legacy`，用户不需要重新填写；
/// 之后任意一次保存都会把它归入当时选中的供应商（一份 Key 只可能属于一个）。
fn api_key_store_parse(raw: &str) -> ApiKeyStore {
    let raw = raw.trim();
    if raw.is_empty() {
        return ApiKeyStore::new();
    }
    if let Ok(map) = serde_json::from_str::<ApiKeyStore>(raw) {
        return map;
    }
    let mut map = ApiKeyStore::new();
    map.insert("__legacy".to_string(), raw.to_string());
    map
}

fn api_key_store_serialize(map: &ApiKeyStore) -> Result<String, String> {
    serde_json::to_string(map).map_err(|e| e.to_string())
}

fn api_key_store_apply(map: &mut ApiKeyStore, scope: &str, api_key: &str) {
    let scope = if scope.trim().is_empty() { "default" } else { scope.trim() };
    let key = api_key.trim();
    if key.is_empty() {
        map.remove(scope);
        return;
    }
    map.insert(scope.to_string(), key.to_string());
}

/// 首次读取时的迁移：把旧版单 Key 归到调用方指定的供应商名下。
///
/// **不能**在 set_api_key 里顺手删 `__legacy`：那样用户只要先给任意一个供应商存过 Key
/// （比如新增的 OpenAI），还没被读取过的旧 DeepSeek Key 就被永久删掉了 —— 真实踩过。
/// 改成"第一次读到某个供应商时才把它领走"，之后它只属于那个供应商。
fn api_key_store_adopt_legacy(map: &mut ApiKeyStore, scope: &str) -> Option<String> {
    let scope = scope.trim();
    if scope.is_empty() {
        return None;
    }
    let legacy = map.remove("__legacy")?;
    let key = legacy.trim().to_string();
    if key.is_empty() {
        return None;
    }
    map.insert(scope.to_string(), key.clone());
    Some(key)
}

/// 只查槽位，不做旧版兜底（旧版由 adopt_legacy 在读取路径上一次性迁移）
fn api_key_store_lookup(map: &ApiKeyStore, scope: &str) -> Option<String> {
    map.get(scope.trim())
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// 存储 API Key（DPAPI 加密到应用数据目录，不明文存 localStorage）。
///
/// `scope` = 供应商 id（deepseek / openai / custom …）。以前只有一份全局 Key，
/// 切换供应商后旧 Key 会被直接发给新厂商（401，且 Key 泄露给别家）。
#[cfg(windows)]
#[tauri::command]
fn set_api_key(app: AppHandle, scope: String, api_key: String) -> Result<(), String> {
    let mut map = api_key_store_parse(&read_api_key_store(&app));
    api_key_store_apply(&mut map, &scope, &api_key);
    write_api_key_store(&app, &api_key_store_serialize(&map)?)
}

/// 读取 API Key（DPAPI 解密）。没有该供应商的槽位时，把旧版单 Key 领到当前供应商名下。
#[cfg(windows)]
#[tauri::command]
fn get_api_key(app: AppHandle, scope: String) -> Result<String, String> {
    let mut map = api_key_store_parse(&read_api_key_store(&app));
    if let Some(k) = api_key_store_lookup(&map, &scope) {
        return Ok(k);
    }
    if let Some(k) = api_key_store_adopt_legacy(&mut map, &scope) {
        let _ = write_api_key_store(&app, &api_key_store_serialize(&map).unwrap_or_default());
        return Ok(k);
    }
    Err("未设置 API Key".to_string())
}

#[cfg(windows)]
fn read_api_key_store(app: &AppHandle) -> String {
    let Ok(path) = api_key_path(app) else {
        return String::new();
    };
    let Ok(enc) = std::fs::read(&path) else {
        return String::new();
    };
    dpapi_unprotect(&enc)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default()
}

#[cfg(windows)]
fn write_api_key_store(app: &AppHandle, raw: &str) -> Result<(), String> {
    let enc = dpapi_protect(raw.as_bytes())?;
    std::fs::write(api_key_path(app)?, enc).map_err(|e| e.to_string())
}

/// macOS 上 API Key 存 Keychain（通用密码项），不落盘、也不写 localStorage。
/// 服务名用应用的 bundle identifier，与 tauri.conf.json 的 identifier 对齐。
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "com.wumiu.petra.apikey";
#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT: &str = "petra";

/// TTS 与聊天 API Key 使用不同的 Keychain 项，互不覆盖。
#[cfg(target_os = "macos")]
const TTS_KEYCHAIN_SERVICE: &str = "com.wumiu.petra.ttskey";

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_tts_key(api_key: String) -> Result<(), String> {
    // 与聊天密钥一致：参数直接传给 security，不经过 shell，也不记录密钥。
    // 空字符串保存为空值，表示用户已清除 TTS 密钥。
    let status = hidden_command("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            TTS_KEYCHAIN_SERVICE,
            "-w",
            api_key.as_str(),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("写入 TTS 钥匙串失败: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("写入 TTS 钥匙串失败（security 退出码 {status}）"))
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn get_tts_key() -> Result<String, String> {
    let out = hidden_command("/usr/bin/security")
        .args([
            "find-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            TTS_KEYCHAIN_SERVICE,
            "-w",
        ])
        .output()
        .map_err(|e| format!("读取 TTS 钥匙串失败: {e}"))?;
    if !out.status.success() {
        return Err("未设置 TTS API Key 或钥匙串不可用".to_string());
    }
    String::from_utf8(out.stdout)
        .map(|key| key.trim().to_string())
        .map_err(|_| "TTS API Key 编码无效".to_string())
}

/// 语音识别（ASR）用独立的 Keychain 项，与聊天密钥、TTS 密钥互不覆盖。
#[cfg(target_os = "macos")]
const ASR_KEYCHAIN_SERVICE: &str = "com.wumiu.petra.asrkey";

/// 存 ASR 密钥（macOS/Keychain）。空字符串 = 删掉该项。
#[cfg(target_os = "macos")]
#[tauri::command]
fn set_asr_key(_app: AppHandle, api_key: String) -> Result<(), String> {
    if api_key.is_empty() {
        // 删除不存在的项会返回非零，这里按"清干净了"看待，不打扰用户
        let _ = hidden_command("/usr/bin/security")
            .args([
                "delete-generic-password",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                ASR_KEYCHAIN_SERVICE,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        return Ok(());
    }
    let status = hidden_command("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            ASR_KEYCHAIN_SERVICE,
            "-w",
            api_key.as_str(),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("写入语音识别钥匙串失败: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("写入语音识别钥匙串失败（security 退出码 {status}）"))
    }
}

/// 读**用户自己存的** ASR 密钥（macOS/Keychain）。没存过返回空串，见 Windows 版注释。
#[cfg(target_os = "macos")]
fn read_stored_asr_key(_app: &AppHandle) -> String {
    hidden_command("/usr/bin/security")
        .args([
            "find-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            ASR_KEYCHAIN_SERVICE,
            "-w",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn get_asr_key(app: AppHandle) -> Result<String, String> {
    Ok(read_stored_asr_key(&app))
}

/// 存储 API Key 到 Keychain（-U 表示已存在就更新，避免堆出重复项）。
///
/// 参数以数组传给 security，不经过 shell，key 里的特殊字符不会被展开；
/// 全程不把 key 写进日志。
#[cfg(target_os = "macos")]
#[tauri::command]
fn set_api_key(scope: String, api_key: String) -> Result<(), String> {
    let mut map = api_key_store_parse(&read_api_key_store());
    api_key_store_apply(&mut map, &scope, &api_key);
    write_api_key_store(&api_key_store_serialize(&map)?)
}

/// 从 Keychain 读取 API Key（-w 只输出密码本身，不带其它字段）。
///
/// 存的内容是"供应商 → Key"的 JSON；旧版本存的是裸 Key，由 api_key_store_parse 兼容。
#[cfg(target_os = "macos")]
#[tauri::command]
fn get_api_key(scope: String) -> Result<String, String> {
    let mut map = api_key_store_parse(&read_api_key_store());
    if let Some(k) = api_key_store_lookup(&map, &scope) {
        return Ok(k);
    }
    if let Some(k) = api_key_store_adopt_legacy(&mut map, &scope) {
        let _ = write_api_key_store(&api_key_store_serialize(&map).unwrap_or_default());
        return Ok(k);
    }
    Err("未设置 API Key".to_string())
}

#[cfg(target_os = "macos")]
fn read_api_key_store() -> String {
    let out = hidden_command("/usr/bin/security")
        .args([
            "find-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

#[cfg(target_os = "macos")]
fn write_api_key_store(raw: &str) -> Result<(), String> {
    let status = hidden_command("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            raw,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("写入钥匙串失败: {e}"))?;
    if status.success() {
        log_line("set_api_key: 已写入 Keychain");
        Ok(())
    } else {
        Err(format!("写入钥匙串失败（security 退出码 {status}）"))
    }
}

/// Linux 上 API Key 的两条存储路径：
///   1. 桌面 Secret Service（secret-tool 命令行）—— GNOME Keyring / KWallet 提供，
///      按用户登录密钥环加密，语义上最接近 Windows DPAPI / macOS Keychain；
///   2. 退化到 ~/.config/petra/api_key（权限 600）—— 明文，只是"不给同机其它用户读"。
///
/// 为什么必须留退路：Secret Service 依赖桌面组件在运行，纯 Wayland 合成器 + 自建会话、
/// SSH 里启动、或根本没装 keyring 时都不可用。这正是 Linux 与 Windows/macOS 的实质差别：
/// 前两者有操作系统级、必然存在的每用户密钥保护（DPAPI 绑定登录凭据、Keychain 由
/// securityd 托管），Linux 没有等价的统一保证，所以只能"能加密就加密，不能就 600 明文"，
/// 并如实写进日志。
#[cfg(target_os = "linux")]
const SECRET_TOOL_SERVICE: &str = "petra";
#[cfg(target_os = "linux")]
const SECRET_TOOL_ACCOUNT: &str = "api_key";

/// API Key 的降级落盘位置：$XDG_CONFIG_HOME/petra/api_key（默认 ~/.config/petra/api_key）。
#[cfg(target_os = "linux")]
fn linux_key_file(name: &str) -> Result<std::path::PathBuf, String> {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => std::path::PathBuf::from(v),
        _ => std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "无法确定配置目录（HOME 未设置）".to_string())?
            .join(".config"),
    };
    Ok(base.join("petra").join(name))
}

#[cfg(target_os = "linux")]
fn linux_api_key_file() -> Result<std::path::PathBuf, String> {
    linux_key_file("api_key")
}

/// 语音识别密钥的降级落盘位置：~/.config/petra/asr_key（同样 600 权限）。
#[cfg(target_os = "linux")]
fn linux_asr_key_file() -> Result<std::path::PathBuf, String> {
    linux_key_file("asr_key")
}

/// TTS 密钥的降级落盘位置：~/.config/petra/tts_key（同样 600 权限）。
#[cfg(target_os = "linux")]
fn linux_tts_key_file() -> Result<std::path::PathBuf, String> {
    linux_key_file("tts_key")
}

/// 从 Secret Service 读密码：键不存在、keyring 没运行、secret-tool 没装都返回 None。
#[cfg(target_os = "linux")]
fn secret_tool_lookup_for(account: &str) -> Option<String> {
    let out = hidden_command("secret-tool")
        .args([
            "lookup",
            "service",
            SECRET_TOOL_SERVICE,
            "username",
            account,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[cfg(target_os = "linux")]
fn secret_tool_lookup() -> Option<String> {
    secret_tool_lookup_for(SECRET_TOOL_ACCOUNT)
}

/// 把密码写进 Secret Service：值走 stdin，不经过 shell，也不会出现在进程命令行里。
#[cfg(target_os = "linux")]
fn secret_tool_store_for(account: &str, label: &str, secret: &str) -> bool {
    let spawned = hidden_command("secret-tool")
        .args([
            "store",
            &format!("--label={label}"),
            "service",
            SECRET_TOOL_SERVICE,
            "username",
            account,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = spawned else {
        return false;
    };
    if let Some(mut si) = child.stdin.take() {
        // 写完就 drop，关掉管道；否则 secret-tool 会一直等 EOF
        let _ = si.write_all(secret.as_bytes());
    }
    matches!(child.wait(), Ok(s) if s.success())
}

#[cfg(target_os = "linux")]
fn secret_tool_store(api_key: &str) -> bool {
    secret_tool_store_for(SECRET_TOOL_ACCOUNT, "Petra API Key", api_key)
}

/// 把密钥写进 600 权限文件（Secret Service 不可用时的退路）。
/// 抽出来是因为 API Key 和语音识别密钥走完全一样的落盘语义。
#[cfg(target_os = "linux")]
fn write_private_file(path: &std::path::Path, secret: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    {
        use std::os::unix::fs::OpenOptionsExt;
        // mode(0o600) 让文件从出现的第一刻起就只有本用户可读写，
        // 避免"先创建、再 chmod"之间那段可被同机其它用户读到的窗口。
        // 注意：文件已存在时 open 的 mode 不生效，所以下面再补一次 set_permissions。
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("写入密钥失败: {e}"))?;
        f.write_all(secret.as_bytes())
            .map_err(|e| format!("写入密钥失败: {e}"))?;
    }
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 语音识别的 Secret Service 账号名，与聊天密钥分开存。
#[cfg(target_os = "linux")]
const ASR_SECRET_ACCOUNT: &str = "asr_key";

/// 存 ASR 密钥（Linux）：优先 Secret Service，失败落 600 权限文件。
#[cfg(target_os = "linux")]
#[tauri::command]
fn set_asr_key(_app: AppHandle, api_key: String) -> Result<(), String> {
    let path = linux_asr_key_file()?;
    if api_key.is_empty() {
        // 同 set_tts_key：清空时必须无条件删降级文件，否则 get_asr_key 会把旧 Key 读回来
        let _ = secret_tool_store_for(ASR_SECRET_ACCOUNT, "Petra ASR Key", "");
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if secret_tool_store_for(ASR_SECRET_ACCOUNT, "Petra ASR Key", &api_key) {
        let _ = std::fs::remove_file(&path);
        log_line("set_asr_key: 已写入 Secret Service");
        return Ok(());
    }
    write_private_file(&path, &api_key)?;
    log_line("set_asr_key: Secret Service 不可用，已写入 ~/.config/petra/asr_key（权限 600）");
    Ok(())
}

/// 读**用户自己存的** ASR 密钥（Linux）：先 Secret Service，再降级文件，都没有返回空串。
#[cfg(target_os = "linux")]
fn read_stored_asr_key(_app: &AppHandle) -> String {
    if let Some(v) = secret_tool_lookup_for(ASR_SECRET_ACCOUNT) {
        return v;
    }
    linux_asr_key_file()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn get_asr_key(app: AppHandle) -> Result<String, String> {
    Ok(read_stored_asr_key(&app))
}

/// TTS 密钥的 Secret Service 账户名（与 api_key / asr_key 分开存，互不覆盖）。
#[cfg(target_os = "linux")]
const TTS_SECRET_ACCOUNT: &str = "tts_key";

/// 存 TTS 密钥（Linux）：优先 Secret Service，失败落 600 权限文件。
///
/// 之前 **Linux 上根本没有 set_tts_key / get_tts_key**，但 generate_handler! 是
/// 三平台共享的列表 —— Linux 目标会直接报 "cannot find function"。这个缺口
/// 只有真正在 Linux 上编译才会暴露，所以一直没被发现。
#[cfg(target_os = "linux")]
#[tauri::command]
fn set_tts_key(_app: AppHandle, api_key: String) -> Result<(), String> {
    let path = linux_tts_key_file()?;
    if api_key.is_empty() {
        // 清空时必须**无条件**删掉降级文件：secret_tool_lookup_for 会把空值过滤成 None，
        // 于是 get_tts_key 会回落读这个文件，把刚清掉的旧 Key 又"复活"出来
        // （以前只在 keyring 写入失败时才删）。
        let _ = secret_tool_store_for(TTS_SECRET_ACCOUNT, "Petra TTS Key", "");
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if secret_tool_store_for(TTS_SECRET_ACCOUNT, "Petra TTS Key", &api_key) {
        let _ = std::fs::remove_file(&path);
        log_line("set_tts_key: 已写入 Secret Service");
        return Ok(());
    }
    write_private_file(&path, &api_key)?;
    log_line("set_tts_key: Secret Service 不可用，已写入 ~/.config/petra/tts_key（权限 600）");
    Ok(())
}

/// 读 TTS 密钥（Linux）：先 Secret Service，再降级文件。
#[cfg(target_os = "linux")]
#[tauri::command]
fn get_tts_key(_app: AppHandle) -> Result<String, String> {
    if let Some(v) = secret_tool_lookup_for(TTS_SECRET_ACCOUNT) {
        return Ok(v);
    }
    let path = linux_tts_key_file()?;
    let v = std::fs::read_to_string(&path).map_err(|_| "未设置 TTS Key".to_string())?;
    let v = v.trim().to_string();
    if v.is_empty() {
        return Err("未设置 TTS Key".to_string());
    }
    Ok(v)
}

/// 存储 API Key（Linux）：优先 Secret Service，失败落 600 权限文件。
#[cfg(target_os = "linux")]
#[tauri::command]
fn set_api_key(scope: String, api_key: String) -> Result<(), String> {
    let mut map = api_key_store_parse(&read_api_key_store());
    api_key_store_apply(&mut map, &scope, &api_key);
    write_api_key_store(&api_key_store_serialize(&map)?)
}

/// 读取 API Key（Linux）：先 Secret Service，再降级文件。
#[cfg(target_os = "linux")]
#[tauri::command]
fn get_api_key(scope: String) -> Result<String, String> {
    let mut map = api_key_store_parse(&read_api_key_store());
    if let Some(k) = api_key_store_lookup(&map, &scope) {
        return Ok(k);
    }
    if let Some(k) = api_key_store_adopt_legacy(&mut map, &scope) {
        let _ = write_api_key_store(&api_key_store_serialize(&map).unwrap_or_default());
        return Ok(k);
    }
    Err("未设置 API Key".to_string())
}

#[cfg(target_os = "linux")]
fn read_api_key_store() -> String {
    if let Some(v) = secret_tool_lookup() {
        return v;
    }
    let Ok(path) = linux_api_key_file() else {
        return String::new();
    };
    std::fs::read_to_string(&path).unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn write_api_key_store(raw: &str) -> Result<(), String> {
    if secret_tool_store(raw) {
        // 成功写进 keyring 时顺手清掉旧的降级文件，避免留下两个不一致的副本
        if let Ok(path) = linux_api_key_file() {
            let _ = std::fs::remove_file(&path);
        }
        log_line("set_api_key: 已写入 Secret Service");
        return Ok(());
    }
    write_private_file(&linux_api_key_file()?, raw)?;
    log_line("set_api_key: Secret Service 不可用，已写入 ~/.config/petra/api_key（权限 600）");
    Ok(())
}

/// 本次启动日志的起始偏移（setup 时记录 pet.log 现有大小，反馈只取本次启动后的日志）。
static LOG_START_OFFSET: OnceLock<u64> = OnceLock::new();

/// 收集环境信息。
fn collect_env_info(app: &AppHandle) -> String {
    let mut out = String::new();
    out.push_str(&format!("时间: {}\n", chrono_now()));
    out.push_str(&format!("OS: {}\n", os_description()));
    #[cfg(windows)]
    out.push_str(&format!(
        "WebView2: {}\n",
        read_reg_value(
            r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
            "pv"
        )
    ));
    out.push_str(&format!("版本: {}\n", app.package_info().version));
    out
}

/// 只取本次启动后的日志（从 LOG_START_OFFSET 到文件末尾）。
fn collect_session_log() -> String {
    let Some(dir) = LOG_DIR.get() else {
        return "（无日志）\n".into();
    };
    let path = dir.join("lasted.log");
    let Ok(bytes) = std::fs::read(&path) else {
        return "（无日志）\n".into();
    };
    // 日志被 trim_file 截断过时 offset 可能比文件还大，这时 min 会退化成从头读
    let offset = LOG_START_OFFSET.get().copied().unwrap_or(0) as usize;
    let start = offset.min(bytes.len());
    let text = String::from_utf8_lossy(&bytes[start..]).to_string();
    truncate_log(&text)
}

/// 日志太长时只保留开头（启动/环境信息）和结尾（最近的问题），避免反馈邮件超限。
fn truncate_log(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= LOG_ATTACH_MAX_CHARS {
        return text.to_string();
    }
    let head_len = 2_000usize;
    let tail_len = LOG_ATTACH_MAX_CHARS - head_len;
    let head: String = chars[..head_len].iter().collect();
    let tail: String = chars[chars.len() - tail_len..].iter().collect();
    format!(
        "{head}\n…（中间省略 {} 个字符；完整日志见菜单「诊断日志 → 打开日志文件夹」）…\n{tail}\n",
        chars.len() - LOG_ATTACH_MAX_CHARS
    )
}

/// 轻量混淆解密：XOR + 位置偏移（非密码学强度，仅防止明文散落在二进制/源码中）。
const SMTP_KEY: &[u8] = b"p3t_smtp_aozora_2026";
fn xdecrypt(cipher: &[u8]) -> String {
    let bytes: Vec<u8> = cipher
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ SMTP_KEY[i % SMTP_KEY.len()] ^ (i as u8 & 0xFF))
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// SMTP 反馈配置：敏感字段（授权码/邮箱）以加密字节内嵌，运行时解密。
/// 加密生成方式见 scripts/enc-smtp.py（更新配置后需重新生成密文）。
struct SmtpConfig {
    smtp_server: String,
    port: u16,
    username: String,
    auth_code: String,
    to_email: String,
    /// 第二个收件人（可选，留空则只发 to_email）。
    /// 放在 Bcc：两个收件人互相看不到对方地址，回复也各回各的。
    to_email2: String,
}

impl SmtpConfig {
    fn load() -> Self {
        Self {
            smtp_server: xdecrypt(&[
                3, 95, 2, 44, 89, 89, 68, 68, 121, 11, 10, 28,
            ]),
            port: 465,
            username: xdecrypt(&[
                7, 71, 27, 53, 2, 91, 74, 70, 23, 89, 83, 66, 77, 28, 0, 61,
            ]),
            auth_code: xdecrypt(&[
                33, 122, 28, 63, 17, 11, 69, 59, 38, 49, 15, 21,
                9, 29, 1, 26,
            ]),
            to_email: xdecrypt(&[
                65, 10, 69, 110, 65, 91, 65, 71, 103, 94, 37, 0, 18, 81, 12, 63, 79,
            ]),
            // 第二个收件人（走 Bcc，两个收件人互相看不到）：
            // 用 scripts/enc-smtp.py --to2 <地址> 重新生成密文
            to_email2: xdecrypt(&[
                42, 69, 28, 111, 68, 94, 64, 66, 102, 94, 87, 67,
                85, 63, 0, 37, 86, 77, 79, 74, 15, 8, 1, 39,
                6,
            ]),
        }
    }
}

impl SmtpConfig {
    /// 去掉空值后的实际收件人（最多两个）
    fn recipients(&self) -> Vec<String> {
        [self.to_email.trim(), self.to_email2.trim()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    }
}

/// 组装反馈邮件。抽成独立函数，方便单测「两个收件人是否都进了信封」。
fn build_feedback_email(cfg: &SmtpConfig, subject: String, body: String) -> Result<lettre::Message, String> {
    use lettre::message::Mailbox;
    use lettre::Message;

    let parse = |addr: &str| {
        addr.parse::<Mailbox>()
            .map_err(|e| format!("收件邮箱无效（{addr}）：{e}"))
    };
    let recipients = cfg.recipients();
    let (first, rest) = recipients.split_first().ok_or("没有配置收件邮箱")?;

    // lettre 的 .to() / .bcc() 是"有则追加"（MessageBuilder::mailbox → join_mailboxes），
    // 所以连续调用就能把多个收件人都放进信封；第一个进 To，其余走 Bcc（互相看不到地址）。
    let mut builder = Message::builder()
        .from(
            format!("<{}>", cfg.username)
                .parse::<Mailbox>()
                .map_err(|e| format!("发件邮箱无效（{}）：{e}", cfg.username))?,
        )
        .to(parse(first)?)
        .subject(subject);
    for addr in rest {
        builder = builder.bcc(parse(addr)?);
    }
    builder.body(body).map_err(|e| e.to_string())
}

/// 组织一份反馈文本（用户描述 + 环境信息 + 本次启动日志）。
/// 邮件发送、桌面导出、前端「复制」都用它，保证三处内容一致。
fn compose_feedback_text(app: &AppHandle, message: &str) -> String {
    let msg = message.trim();
    format!(
        "用户反馈：\n{}\n\n{}\n=== 本次启动日志 ===\n{}",
        if msg.is_empty() { "（未填写问题描述）" } else { msg },
        collect_env_info(app),
        collect_session_log(),
    )
}

/// 把 SMTP 原始错误翻译成用户能看懂、能行动的一句话。
fn describe_smtp_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    // 163/QQ 邮箱的"授权码"会被重置或过期，服务器回 535 —— 这是最常见的失效原因
    if raw.contains("535") || lower.contains("authentication") {
        "邮箱授权码失效（服务器拒绝认证），已改用桌面文件导出".into()
    } else if lower.contains("timeout") || lower.contains("timed out") || lower.contains("connect") {
        "连不上邮件服务器（网络或代理问题），已改用桌面文件导出".into()
    } else {
        format!("发送失败: {raw}")
    }
}

/// 反馈文本（前端「复制」用，不写文件、不发邮件）
#[tauri::command]
fn feedback_text(app: AppHandle, message: String) -> String {
    compose_feedback_text(&app, &message)
}

/// 飞书自定义机器人：用户反馈直接推送到 QQ 群对应讨论群。
const FEISHU_WEBHOOK: &str = "https://open.feishu.cn/open-apis/bot/v2/hook/4443ab4f-eb1a-4ba8-a007-ad9905698482";
const FEISHU_SECRET: &str = "hTBaQ11bX5YqSU8G0L6wXb";

/// 发送反馈：用户问题描述 + 环境信息 + 本次启动日志，通过飞书自定义机器人推送到群里。
#[tauri::command]
async fn send_feedback(app: AppHandle, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        use base64::Engine;
        type HmacSha256 = Hmac<Sha256>;

        let body = compose_feedback_text(&app, &message);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();

        // 飞书机器人签名：HMAC-SHA256(key="<timestamp>\n<secret>", msg=空) → base64
        let string_to_sign = format!("{timestamp}\n{FEISHU_SECRET}");
        let mut mac = HmacSha256::new_from_slice(string_to_sign.as_bytes())
            .map_err(|e| format!("签名初始化失败: {e}"))?;
        let sign = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

        let payload = serde_json::json!({
            "timestamp": timestamp,
            "sign": sign,
            "msg_type": "text",
            "content": { "text": body }
        });

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| format!("HTTP 客户端失败: {e}"))?;

        log_line("send_feedback: 推送飞书群…");
        let resp = client
            .post(FEISHU_WEBHOOK)
            .json(&payload)
            .send()
            .map_err(|e| format!("连不上飞书: {e}"))?;
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        if status.is_success() && text.contains("\"code\":0") {
            log_line("send_feedback: 飞书已投递");
            Ok("反馈已发送，感谢！".into())
        } else {
            log_error(&format!("send_feedback 飞书失败: {status} {text}"));
            Err(format!("发送失败: {text}"))
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

fn chrono_now() -> String {
    // 毫秒级时间戳，避免同秒多次导出互相覆盖
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("ts{ms}")
}

/// 桌面目录：Windows 是 %USERPROFILE%\Desktop，macOS/Linux 是 $HOME/Desktop。
/// 取不到时退回临时目录，保证导出不会因为环境异常而失败。
///
/// Linux 理论上应读 XDG user-dirs 的 XDG_DESKTOP_DIR（桌面目录可能被本地化成
/// "桌面"或其它名字），但那要多解析一个配置文件；导出功能只在桌面上放一份文件，
/// 退回 $HOME/Desktop 的收益/成本比更好，且与 macOS 版行为一致。
fn desktop_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(unix)]
    let home = std::env::var_os("HOME");
    home.map(std::path::PathBuf::from)
        .map(|p| p.join("Desktop"))
        .unwrap_or_else(std::env::temp_dir)
}

/// 把一段文本写到桌面的文件里（目前用于日记导出），返回文件路径。
/// 只取文件名并过滤掉路径分隔符/非法字符，避免写到桌面以外的地方。
#[tauri::command]
fn export_text_to_desktop(file_name: String, text: String) -> Result<String, String> {
    let mut safe: String = file_name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .take(80)
        .collect();
    safe = safe.trim().to_string();
    // 空名、纯点名或隐藏文件都换成默认名
    if safe.is_empty() || safe.starts_with('.') || safe == "." || safe == ".." {
        safe = format!("petra-导出-{}.txt", chrono_now());
    }
    let desktop = desktop_dir();
    let path = desktop.join(&safe);
    log_line(&format!("导出到桌面: {}", path.display()));
    std::fs::write(&path, text).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出反馈文本到桌面文件（含用户描述 + 环境信息 + 本次启动日志），返回文件路径。
#[tauri::command]
fn export_feedback(app: AppHandle, message: String) -> Result<String, String> {
    let text = compose_feedback_text(&app, &message);
    let desktop = desktop_dir();
    let name = format!("live2d-pet-反馈_{}.txt", chrono_now());
    let path = desktop.join(&name);
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ==================== 小助手扩展工具 ====================

/// 设置系统音量（0-100），或静音/取消静音。
/// mute=true 设音量为 0（静音），mute=false 恢复到 level（默认 50）。
/// level 和 mute 可同时使用（如 level=30, mute=true → 静音，记住 30）。
#[cfg(windows)]
#[tauri::command]
fn set_volume(level: Option<u8>, mute: Option<bool>) -> Result<String, String> {
    let target = match mute {
        Some(true) => 0u8,          // 静音：强制 0
        Some(false) => level.unwrap_or(50).min(100),  // 取消静音：恢复到 level
        None => level.unwrap_or(50).min(100),          // 纯设音量
    };
    // 用 winmm.dll waveOutSetVolume 直接设置（左声道 = 右声道）
    let vol = (target as f64 / 100.0 * 65535.0).round() as u32;
    let packed = vol | (vol << 16); // 左右声道同值
    let script = format!(
        r#"Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Vol {{ [DllImport("winmm.dll")] public static extern int waveOutSetVolume(IntPtr h, uint v); }}
"@; [Vol]::waveOutSetVolume([IntPtr]::Zero, {packed})"#
    );
    let _ = hidden_command("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output();
    match mute {
        Some(true) => Ok("已静音".into()),
        Some(false) => Ok(format!("已恢复音量 {target}%")),
        None => Ok(format!("音量已设为 {target}%")),
    }
}

/// 设置系统音量（0-100），或静音/取消静音。macOS 走 osascript 的 set volume。
/// macOS 的「音量」和「是否静音」是两个独立开关，所以静音/取消静音要分别设置。
#[cfg(target_os = "macos")]
#[tauri::command]
fn set_volume(level: Option<u8>, mute: Option<bool>) -> Result<String, String> {
    let target = match mute {
        Some(true) => 0u8,                            // 静音：强制 0
        Some(false) => level.unwrap_or(50).min(100),  // 取消静音：恢复到 level
        None => level.unwrap_or(50).min(100),         // 纯设音量
    };
    let script = match mute {
        Some(true) => "set volume output muted true".to_string(),
        Some(false) => format!("set volume output muted false\nset volume output volume {target}"),
        None => format!("set volume output volume {target}"),
    };
    let output = hidden_command("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("调节音量失败: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "调节音量失败".to_string()
        } else {
            format!("调节音量失败: {err}")
        });
    }
    match mute {
        Some(true) => Ok("已静音".into()),
        Some(false) => Ok(format!("已恢复音量 {target}%")),
        None => Ok(format!("音量已设为 {target}%")),
    }
}

/// 设置系统音量（0-100），或静音/取消静音（Linux）。
///
/// 桌面音频栈有三种常见形态，按覆盖面从高到低探测，第一个"能起来且退出码为 0"的生效：
///   1. wpctl（PipeWire，WirePlumber 提供）—— 现代发行版默认；
///   2. pactl（PulseAudio / pipewire-pulse）—— 兼容层与老系统；
///   3. amixer（ALSA）—— 没有声音服务器、纯 ALSA 的环境。
/// 不引入 libpulse/libpipewire 链接依赖：这三个命令行工具覆盖面已经够，
/// 也不需要目标机上装开发头文件。
#[cfg(target_os = "linux")]
#[tauri::command]
fn set_volume(level: Option<u8>, mute: Option<bool>) -> Result<String, String> {
    let target = match mute {
        Some(true) => 0u8,                           // 静音
        Some(false) => level.unwrap_or(50).min(100), // 取消静音：恢复到 level
        None => level.unwrap_or(50).min(100),        // 纯设音量
    };

    /// 跑一条命令，返回是否成功（起不来 = 这个后端不存在）。
    fn run(program: &str, args: &[&str]) -> bool {
        hidden_command(program)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    let pct = format!("{target}%");
    let pct = pct.as_str();
    let applied = match mute {
        // 静音只动 mute 开关，不覆盖用户原来的音量（与 Windows / macOS 版语义一致）
        Some(true) => {
            run("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", "1"])
                || run("pactl", &["set-sink-mute", "@DEFAULT_SINK@", "1"])
                || run("amixer", &["-q", "sset", "Master", "mute"])
        }
        // 取消静音要先解 mute 再恢复音量，两个都成功才算这个后端生效
        Some(false) => {
            (run("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", "0"])
                && run("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", pct]))
                || (run("pactl", &["set-sink-mute", "@DEFAULT_SINK@", "0"])
                    && run("pactl", &["set-sink-volume", "@DEFAULT_SINK@", pct]))
                || (run("amixer", &["-q", "sset", "Master", "unmute"])
                    && run("amixer", &["-q", "sset", "Master", pct]))
        }
        None => {
            run("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", pct])
                || run("pactl", &["set-sink-volume", "@DEFAULT_SINK@", pct])
                || run("amixer", &["-q", "sset", "Master", pct])
        }
    };

    if !applied {
        return Err("调节音量失败（wpctl / pactl / amixer 都不可用）".into());
    }
    match mute {
        Some(true) => Ok("已静音".into()),
        Some(false) => Ok(format!("已恢复音量 {target}%")),
        None => Ok(format!("音量已设为 {target}%")),
    }
}

/// 获取当前天气信息（调用 wttr.in 纯文本接口，无需 API Key）。
/// 发送 Windows 托盘通知（用 NotifyIcon 气泡，不依赖 WinRT AUMID）
#[cfg(windows)]
#[tauri::command]
fn send_notification(title: String, body: String) {
    // 自定义美化弹窗（Windows Forms）：浅粉圆角、标题+内容、6 秒自动关闭
    // 不用系统 Toast（请勿打扰模式会屏蔽），不受打扰设置影响
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
        $form = New-Object System.Windows.Forms.Form;
        $form.Text = 'Petra'; $form.FormBorderStyle = 'None';
        $form.BackColor = [System.Drawing.Color]::FromArgb(255,245,248);
        $form.Size = New-Object System.Drawing.Size(340,120);
        $form.StartPosition = 'CenterScreen'; $form.TopMost = $true;
        $t = New-Object System.Windows.Forms.Label;
        $t.Text = '{}';
        $t.Font = New-Object System.Drawing.Font('Microsoft YaHei',11,[System.Drawing.FontStyle]::Bold);
        $t.ForeColor = [System.Drawing.Color]::FromArgb(208,106,154);
        $t.AutoSize = $true; $t.Location = New-Object System.Drawing.Point(22,12);
        $form.Controls.Add($t);
        $c = New-Object System.Windows.Forms.Label;
        $c.Text = '{}';
        $c.Font = New-Object System.Drawing.Font('Microsoft YaHei',12);
        $c.ForeColor = [System.Drawing.Color]::FromArgb(90,60,90);
        $c.AutoSize = $true; $c.Location = New-Object System.Drawing.Point(22,40);
        $form.Controls.Add($c);
        $tm = New-Object System.Windows.Forms.Timer; $tm.Interval = 6000;
        $tm.Add_Tick({{ $form.Close() }}); $tm.Start();
        $form.ShowDialog()"#,
        title.replace('\'', "''"),
        body.replace('\'', "''")
    );
    let _ = hidden_command("powershell")
        .args(["-NoProfile", "-Command", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    crate::log_line("send_notification: 已发送（标题与正文不入日志）");
}

/// 发送系统通知。macOS 用 osascript 的 display notification，走系统通知中心。
///
/// 与 Windows 版刻意绕开系统 Toast 的取舍不同：macOS 上通知中心是唯一入口，
/// 没有等价的免打扰旁路，用户可在「专注模式」里自行屏蔽。
#[cfg(target_os = "macos")]
#[tauri::command]
fn send_notification(title: String, body: String) {
    // 先转义反斜杠再转义双引号，避免 AppleScript 字符串被截断；
    // 参数以数组传给 osascript，不经过 shell。
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display notification \"{}\" with title \"{}\"",
        esc(&body),
        esc(&title)
    );
    let _ = hidden_command("/usr/bin/osascript")
        .args(["-e", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    crate::log_line("send_notification: 已发送（标题与正文不入日志）");
}

/// 发送系统通知（Linux）：notify-send → org.freedesktop.Notifications。
///
/// 与 Windows 版刻意绕开系统 Toast 不同：Linux 上通知守护进程是唯一入口，
/// 是否显示由桌面环境的"勿扰"决定。参数以数组传给 notify-send，不经过 shell；
/// 标题/正文前的 -- 防止以 - 开头的内容被当成选项。
/// 失败只记日志不向上报错：通知是锦上添花，调用方不该为此处理错误（与 macOS 版一致）。
#[cfg(target_os = "linux")]
#[tauri::command]
fn send_notification(title: String, body: String) {
    if let Err(e) = hidden_command("notify-send")
        .arg("--")
        .arg(&title)
        .arg(&body)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        log_verbose(&format!("send_notification: notify-send 不可用: {e}"));
    }
    crate::log_line("send_notification: 已发送（标题与正文不入日志）");
}

/// 天气查询脚本。`@PROXY@=0` 时绕过系统代理直连。
/// 为什么要直连：开着梯子（系统代理）时 wttr.in 按**出口 IP** 定位，
/// 实测出口在日本时返回的是 Tokyo/Sarugakcho —— 信息板就会显示梯子地区的天气。
#[cfg(windows)]
const WEATHER_PS: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
if ('@PROXY@' -eq '0') { [System.Net.WebRequest]::DefaultWebProxy = $null }
try {
  $r = Invoke-WebRequest -Uri '@URL@' -TimeoutSec 6 -UseBasicParsing
  $j = $r.Content | ConvertFrom-Json
  $c = $j.current_condition[0]
  $w = $j.weather[0]
  $a = $j.nearest_area[0]
  "$($a.areaName[0].value)|$($c.weatherDesc[0].value)|$($c.temp_C)|$($w.maxtempC)|$($w.mintempC)|$($w.hourly[4].chanceofrain)|$($a.country[0].value)"
} catch { "获取失败|天气获取失败|—|—|—|—|" }"#;

/// 系统区域（zh-CN、en-US…）→ wttr.in 用的英文国名，用来判断定位有没有被代理带偏。
fn locale_expected_country(locale: &str) -> Option<&'static str> {
    let region = locale.rsplit('-').next().unwrap_or("").to_ascii_uppercase();
    Some(match region.as_str() {
        "CN" => "China",
        "TW" => "Taiwan",
        "HK" => "Hong Kong",
        "MO" => "Macau",
        "JP" => "Japan",
        "KR" => "South Korea",
        "SG" => "Singapore",
        "MY" => "Malaysia",
        "TH" => "Thailand",
        "VN" => "Vietnam",
        "PH" => "Philippines",
        "ID" => "Indonesia",
        "IN" => "India",
        "US" => "United States",
        "CA" => "Canada",
        "GB" => "United Kingdom",
        "DE" => "Germany",
        "FR" => "France",
        "IT" => "Italy",
        "ES" => "Spain",
        "NL" => "Netherlands",
        "RU" => "Russia",
        "AU" => "Australia",
        "BR" => "Brazil",
        _ => return None,
    })
}

/// 定位到的国家与系统区域不符 → 很可能走了代理出口（区域未知时不判断，避免误报）
fn weather_location_suspect(locale: &str, country: &str) -> bool {
    let Some(expected) = locale_expected_country(locale) else {
        return false;
    };
    let got = country.trim();
    if got.is_empty() {
        return false;
    }
    !got.eq_ignore_ascii_case(expected)
}

/// 取天气：优先用户指定的城市，否则先试 Windows 位置 API，再按 IP 定位。
/// 网络请求一律**直连优先**，直连失败且有系统代理时才回退代理；
/// 最后附一个"定位可疑"标记（系统区域与定位国家不符时），前端据此提示用户指定城市。
#[cfg(windows)]
#[tauri::command]
async fn get_weather(city: Option<String>) -> Result<String, String> {
    let city_arg = city.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        // 构建查询 URL：优先用用户设置的城市，否则尝试 Windows 位置 API
        let url = if !city_arg.trim().is_empty() {
            format!("https://wttr.in/{}?format=j1&lang=zh", city_arg.trim())
        } else {
            // 尝试通过 Windows 位置 API 获取真实坐标（不受 VPN 影响）
            let coord_cmd = r#"Add-Type -AssemblyName System.Device; $w = New-Object System.Device.Location.GeoCoordinateWatcher; $w.Start(); Start-Sleep -Milliseconds 1500; $c = $w.Position.Location; if ($c.IsUnknown) { "" } else { "$($c.Latitude),$($c.Longitude)" }; $w.Stop()"#;
            let coord_output = hidden_command("powershell")
                .args(["-NoProfile", "-Command", coord_cmd])
                .output();
            let coords = coord_output.ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty() && s.contains(","));
            if let Some(c) = coords {
                format!("https://wttr.in/{}?format=j1&lang=zh", c)
            } else {
                // Windows 位置不可用，回退到 IP 定位
                "https://wttr.in/?format=j1&lang=zh".to_string()
            }
        };

        let run_pass = |use_proxy: bool| -> Result<String, String> {
            let cmd = WEATHER_PS
                .replace("@PROXY@", if use_proxy { "1" } else { "0" })
                .replace("@URL@", &url);
            let output = hidden_command("powershell")
                .args(["-NoProfile", "-Command", &cmd])
                .output()
                .map_err(|e| format!("启动失败: {e}"))?;
            if !output.status.success() {
                return Err(format!("天气命令执行失败: {}", output.status));
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        };

        // 直连优先（拿真实的本地出口 IP）；只有直连真的不通时才走系统代理
        let mut raw = run_pass(false)?;
        if raw.starts_with("获取失败") && crate::proxy::get_system_proxy().is_some() {
            crate::log_line("[weather] 直连取天气失败，改用系统代理重试");
            if let Ok(via_proxy) = run_pass(true) {
                if !via_proxy.starts_with("获取失败") {
                    raw = via_proxy;
                }
            }
        }

        let parts: Vec<String> = raw.split('|').map(|s| s.trim().to_string()).collect();
        if parts.len() < 7 {
            return Ok(raw);
        }
        let country = parts[6].clone();
        let locale = read_reg_value(r"HKCUControl PanelInternational", "LocaleName");
        let suspect = weather_location_suspect(&locale, &country);
        if suspect {
            crate::log_line(&format!(
                "[weather] 定位 {}({country}) 与系统区域 {locale} 不符，疑似代理出口",
                parts[0]
            ));
        }
        crate::log_line(&format!(
            "[weather] {} {}°C（{}）定位可疑={suspect}",
            parts[0], parts[2], parts[1]
        ));
        Ok(format!(
            "{}|{}|{}|{}|{}|{}|{}",
            parts[0],
            parts[1],
            parts[2],
            parts[3],
            parts[4],
            parts[5],
            if suspect { 1 } else { 0 }
        ))
    })
    .await
    .map_err(|e| format!("天气任务异常: {e}"))?
}

/// 系统区域（形如 zh-CN）：macOS 从 AppleLocale 读，读不到退回 LANG 环境变量。
/// 用来判断 wttr.in 按出口 IP 定位到的国家与用户所在区域是否一致。
#[cfg(target_os = "macos")]
fn system_locale() -> String {
    if let Ok(out) = hidden_command("/usr/bin/defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
    {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s.replace('_', "-");
            }
        }
    }
    std::env::var("LANG")
        .unwrap_or_default()
        .split('.')
        .next()
        .unwrap_or("")
        .replace('_', "-")
}

/// 系统区域（形如 zh-CN）：Linux 按 GLib/GTK 的优先级读 LC_ALL → LC_MESSAGES → LANG。
/// macOS 的 AppleLocale 在 Linux 上不存在，不能沿用那套（/usr/bin/defaults 也没有）。
/// 用来判断 wttr.in 按出口 IP 定位到的国家与用户所在区域是否一致。
#[cfg(target_os = "linux")]
fn system_locale() -> String {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        let value = std::env::var(key).unwrap_or_default();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        // 形如 zh_CN.UTF-8 或 sr_RS@latin → 取语言_地区并统一成 zh-CN
        return value
            .split('@')
            .next()
            .unwrap_or("")
            .split('.')
            .next()
            .unwrap_or("")
            .replace('_', "-");
    }
    String::new()
}

/// 从 wttr.in 的 j1 JSON 里抽出与 PowerShell 版逐字段一致的
/// 「区域|天气描述|温度|最高|最低|降雨概率|国家」。
/// 任何字段缺失都算失败（返回 None），等价于 PS 脚本里 ConvertFrom-Json 抛错。
#[cfg(unix)]
fn parse_weather_json(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let cur = v.get("current_condition")?.get(0)?;
    let day = v.get("weather")?.get(0)?;
    let area = v.get("nearest_area")?.get(0)?;
    let desc = cur.get("weatherDesc")?.get(0)?.get("value")?.as_str()?;
    let temp = cur.get("temp_C")?.as_str()?;
    let max = day.get("maxtempC")?.as_str()?;
    let min = day.get("mintempC")?.as_str()?;
    // hourly[4] 对应 PowerShell 里的 $w.hourly[4].chanceofrain
    let rain = day.get("hourly")?.get(4)?.get("chanceofrain")?.as_str()?;
    let name = area.get("areaName")?.get(0)?.get("value")?.as_str()?;
    let country = area.get("country")?.get(0)?.get("value")?.as_str()?;
    Some(format!("{name}|{desc}|{temp}|{max}|{min}|{rain}|{country}"))
}

/// curl 的可执行路径：macOS 自带 /usr/bin/curl；Linux 上 curl 可能装在
/// /usr/local/bin 或 /bin（发行版差异），交给 PATH 解析更稳。
#[cfg(target_os = "macos")]
fn curl_program() -> &'static str {
    "/usr/bin/curl"
}
#[cfg(target_os = "linux")]
fn curl_program() -> &'static str {
    "curl"
}

/// 取天气：优先用户指定的城市，否则按 IP 定位。
///
/// macOS / Linux 共用：用 curl 取 wttr.in 的 j1 JSON（Windows 版是 PowerShell 的
/// Invoke-WebRequest），JSON 用 serde_json 解析（已在依赖里）。
/// 输出格式、以及「直连优先、失败再用系统代理」的取舍都和 Windows 版保持一致，
/// 前端无需改动。
///
/// 区别：不查「位置 API」（macOS 要走 CoreLocation 权限弹窗、Linux 没有统一接口），
/// 所以没有城市时直接用 IP 定位；定位国家与系统区域不符时照常打「定位可疑」标记。
#[cfg(unix)]
#[tauri::command]
async fn get_weather(city: Option<String>) -> Result<String, String> {
    let city_arg = city.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let url = if city_arg.trim().is_empty() {
            "https://wttr.in/?format=j1&lang=zh".to_string()
        } else {
            format!("https://wttr.in/{}?format=j1&lang=zh", city_arg.trim())
        };

        let run_pass = |use_proxy: bool| -> Result<String, String> {
            let mut cmd = hidden_command(curl_program());
            // --fail：HTTP 4xx/5xx 直接当失败，避免把错误页当成天气 JSON
            cmd.args(["--silent", "--show-error", "--fail", "--max-time", "10"]);
            if use_proxy {
                // 走系统代理（与 Windows 版的第二遍等价）
                if let Some(p) = crate::proxy::get_system_proxy() {
                    cmd.arg("--proxy").arg(p);
                }
            } else {
                // 直连：显式忽略环境变量里的代理
                cmd.arg("--noproxy").arg("*");
            }
            let out = cmd
                .arg(&url)
                .output()
                .map_err(|e| format!("启动失败: {e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(if err.is_empty() {
                    "天气请求失败".to_string()
                } else {
                    err
                });
            }
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        };

        // 直连优先（拿真实的本地出口 IP）；只有直连真的没拿到才走系统代理
        let mut raw = run_pass(false).unwrap_or_default();
        if parse_weather_json(&raw).is_none() && crate::proxy::get_system_proxy().is_some() {
            crate::log_line("[weather] 直连取天气失败，改用系统代理重试");
            if let Ok(via_proxy) = run_pass(true) {
                raw = via_proxy;
            }
        }

        let Some(fields) = parse_weather_json(&raw) else {
            return Ok("获取失败|天气获取失败|—|—|—|—|".to_string());
        };
        let parts: Vec<String> = fields.split('|').map(|s| s.trim().to_string()).collect();
        if parts.len() < 7 {
            return Ok(fields);
        }
        let country = parts[6].clone();
        let locale = system_locale();
        let suspect = weather_location_suspect(&locale, &country);
        if suspect {
            crate::log_line(&format!(
                "[weather] 定位 {}({country}) 与系统区域 {locale} 不符，疑似代理出口",
                parts[0]
            ));
        }
        crate::log_line(&format!(
            "[weather] {} {}°C（{}）定位可疑={suspect}",
            parts[0], parts[2], parts[1]
        ));
        Ok(format!(
            "{}|{}|{}|{}|{}|{}|{}",
            parts[0],
            parts[1],
            parts[2],
            parts[3],
            parts[4],
            parts[5],
            if suspect { 1 } else { 0 }
        ))
    })
    .await
    .map_err(|e| format!("天气任务异常: {e}"))?
}

/// 查询参数百分号编码（避免引入额外依赖；只用于歌词接口的 query string）
/// Windows 的 PowerShell 链路和 macOS 的 LRCLIB 直连都要用，两个平台都编译。
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 取歌词的 PowerShell 脚本（多来源链：网易云 → QQ音乐 → 酷狗 → LRCLIB）。
/// 用脚本文件而非 -Command，避免超长单行与转义地狱；占位符由 Rust 侧替换。
/// 注意：脚本本身保持 ASCII，路径占位符可能含非 ASCII（用户名），写盘时带 UTF-8 BOM 供 PS 5.1 正确解析。
#[cfg(windows)]
const LYRICS_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$UA = 'Petra/0.2.4 (+https://github.com/Wumiu/Petra)'
$BR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
$OUT = '@OUT@'
$ART = [System.Uri]::UnescapeDataString('@ARTIST_ENC@')
$items = New-Object System.Collections.Generic.List[object]
$err = ''
# 直连优先：开着 VPN（系统代理，例如 127.0.0.1:7890）时，网易云会按异地出口返回**加密**的 eapi
# 结果（result 变成一串密文、songs 解析为空），QQ/酷狗也可能被风控，整条链就全军覆没。
# 所以先绕过系统代理直连；Rust 侧发现一条都没取到时，会用 @DIRECT@=0 走系统代理再试一遍。
if ('@DIRECT@' -eq '1') { [System.Net.WebRequest]::DefaultWebProxy = $null }
$neEnc = 0
$errs = 0
$neHits = 0
$qqHits = 0
$kgHits = 0
# 最佳艺人匹配档位：0=完全相同 1=包含 2=不匹配。为 2 时继续问下一个来源（例如网易云只有翻唱）
$bestRank = 9

# 安全取"第一个艺人名"：返回的畸形结果里可能没有 artists/singer 字段，
# 直接写 $_.artists[0].name 会抛"无法索引到空数组"，把整个来源整段 catch 掉。
function FirstName($arr) {
  if ($null -eq $arr) { return '' }
  $f = @($arr)
  if ($f.Count -eq 0 -or $null -eq $f[0]) { return '' }
  return [string]$f[0].name
}

function Get-Rank([string]$singer) {
  if ([string]::IsNullOrEmpty($ART) -or [string]::IsNullOrEmpty($singer)) { return 1 }
  if ($singer -eq $ART) { return 0 }
  if ($singer.Contains($ART) -or $ART.Contains($singer)) { return 1 }
  return 2
}

# ---------- 1) 网易云音乐 ----------
if ($items.Count -eq 0) {
  try {
    $h = @{ Referer = 'https://music.163.com/'; 'User-Agent' = $BR }
    $r = Invoke-WebRequest -Uri '@NE_SEARCH@' -Headers $h -TimeoutSec 8 -UseBasicParsing
    $j = $r.Content | ConvertFrom-Json
    if ($j.result -is [string]) { $neEnc = 1 }
    $songs = @(@($j.result.songs) | Where-Object { $_ -and $_.id })
    $songs = @($songs | Sort-Object { Get-Rank (FirstName $_.artists) })
    $n = [Math]::Min(3, $songs.Count)
    $i = 0
    while ($i -lt $n -and $items.Count -lt 3) {
      $sg = $songs[$i]; $i++
      try {
        $lr = Invoke-WebRequest -Uri ('https://music.163.com/api/song/lyric?id=' + $sg.id + '&lv=1&kv=1&tv=-1') -Headers $h -TimeoutSec 8 -UseBasicParsing
        $lj = $lr.Content | ConvertFrom-Json
        $ly = [string]$lj.lrc.lyric
        if ($ly.Length -gt 20) {
          $items.Add([ordered]@{ source = 'netease'; trackName = [string]$sg.name; artistName = (FirstName $sg.artists); duration = [int]($sg.duration / 1000); instrumental = $false; syncedLyrics = $ly; translatedLyrics = [string]$lj.tlyric.lyric })
          $bestRank = [Math]::Min($bestRank, (Get-Rank (FirstName $sg.artists)))
          $neHits++
        }
      } catch { Start-Sleep -Milliseconds 250 }
    }
  } catch { $err = $_.Exception.Message; $errs++ }
}

# ---------- 2) QQ 音乐 ----------
if ($items.Count -eq 0 -or $bestRank -ge 2) {
  try {
    $h = @{ Referer = 'https://y.qq.com/'; 'User-Agent' = $BR }
    $r = Invoke-WebRequest -Uri '@QQ_SEARCH@' -Headers $h -TimeoutSec 8 -UseBasicParsing
    $songs = @(@(($r.Content | ConvertFrom-Json).data.song.list) | Where-Object { $_ -and $_.songmid })
    $songs = @($songs | Sort-Object { Get-Rank (FirstName $_.singer) })
    $n = [Math]::Min(3, $songs.Count)
    $i = 0
    while ($i -lt $n -and $items.Count -lt 3) {
      $sg = $songs[$i]; $i++
      try {
        $lr = Invoke-WebRequest -Uri ('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + $sg.songmid + '&format=json&nobase64=1&g_tk=5381') -Headers $h -TimeoutSec 8 -UseBasicParsing
        $lj = $lr.Content | ConvertFrom-Json
        $ly = [string]$lj.lyric
        if ($ly.Length -gt 20) {
          $items.Add([ordered]@{ source = 'qq'; trackName = [string]$sg.songname; artistName = (FirstName $sg.singer); duration = [int]$sg.interval; instrumental = $false; syncedLyrics = $ly; translatedLyrics = [string]$lj.trans })
          $bestRank = [Math]::Min($bestRank, (Get-Rank (FirstName $sg.singer)))
          $qqHits++
        }
      } catch { Start-Sleep -Milliseconds 250 }
    }
  } catch { $err = $_.Exception.Message; $errs++ }
}

# ---------- 3) 酷狗音乐 ----------
if ($items.Count -eq 0 -or $bestRank -ge 2) {
  try {
    $h = @{ 'User-Agent' = $BR }
    # 酷狗搜索会间歇性返回空候选（实测 0 条 / 10 条 交替），必须重试
    $cands = @()
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        $r = Invoke-WebRequest -Uri '@KG_SEARCH@' -Headers $h -TimeoutSec 8 -UseBasicParsing
        $cands = @(@(($r.Content | ConvertFrom-Json).candidates) | Where-Object { $_ -and $_.id -and $_.accesskey })
      } catch { $err = $_.Exception.Message }
      if ($cands.Count -gt 0) { break }
      Start-Sleep -Milliseconds 900
    }
    $cands = @($cands | Sort-Object { Get-Rank ([string]$_.singer) })
    $n = [Math]::Min(3, $cands.Count)
    $i = 0
    while ($i -lt $n -and $items.Count -lt 3) {
      $c = $cands[$i]; $i++
      try {
        $b64 = ''
        for ($attempt2 = 1; $attempt2 -le 2; $attempt2++) {
          $dl = Invoke-WebRequest -Uri ('https://lyrics.kugou.com/download?ver=1&client=pc&id=' + $c.id + '&accesskey=' + $c.accesskey + '&fmt=lrc&charset=utf8') -Headers $h -TimeoutSec 8 -UseBasicParsing
          $b64 = [string](($dl.Content | ConvertFrom-Json).content)
          if ($b64.Length -gt 0) { break }
          Start-Sleep -Milliseconds 800
        }
        if ($b64.Length -gt 0) {
          $ly = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
          if ($ly.Length -gt 20) {
            $items.Add([ordered]@{ source = 'kugou'; trackName = [string]$c.song; artistName = [string]$c.singer; duration = [int]($c.duration / 1000); instrumental = $false; syncedLyrics = $ly; translatedLyrics = '' })
            $bestRank = [Math]::Min($bestRank, (Get-Rank ([string]$c.singer)))
            $kgHits++
          }
        }
      } catch { Start-Sleep -Milliseconds 250 }
    }
  } catch { $err = $_.Exception.Message; $errs++ }
}

# ---------- 4) LRCLIB 兜底 ----------
# 诊断行供 Rust 侧判断"这一遍到底查到没有"（决定要不要换代理再跑一遍）并写进日志
$diag = 'items=' + $items.Count + ' ne=' + $neHits + ' qq=' + $qqHits + ' kg=' + $kgHits + ' enc=' + $neEnc + ' errs=' + $errs
if ($items.Count -gt 0) {
  [System.IO.File]::WriteAllText($OUT, ($items | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('OK ' + $diag)
  exit 0
}
$ok = $false
foreach ($u in @('@LR_GET@', '@LR_SEARCH@')) {
  if ($ok) { break }
  try {
    Invoke-WebRequest -Uri $u -UserAgent $UA -TimeoutSec 8 -UseBasicParsing -OutFile $OUT | Out-Null
    $ok = $true
  } catch { $err = $_.Exception.Message; Start-Sleep -Milliseconds 1200 }
}
if ($ok) { Write-Output ('OK_LRCLIB ' + $diag) } else { Write-Output ('ERR ' + $diag + ' ' + $err); exit 1 }
"#;

/// 解析取词脚本 stdout 里的诊断行（形如 `OK items=1 ne=1 qq=0 kg=0 enc=0 errs=0`）。
/// items=这一遍真正查到几条歌词，enc=网易云是否返回了加密结果，errs=抛异常的来源数。
#[cfg(windows)]
fn parse_lyric_diag(stdout: &str) -> (usize, bool, usize) {
    let mut items = 0usize;
    let mut enc = false;
    let mut errs = 0usize;
    for tok in stdout.split_whitespace() {
        if let Some(v) = tok.strip_prefix("items=") {
            items = v.parse().unwrap_or(0);
        } else if let Some(v) = tok.strip_prefix("enc=") {
            enc = v.trim() == "1";
        } else if let Some(v) = tok.strip_prefix("errs=") {
            errs = v.parse().unwrap_or(0);
        }
    }
    (items, enc, errs)
}

/// 取词脚本单遍执行的结果
#[cfg(windows)]
struct LyricsPass {
    /// 脚本写出的 JSON（可能是 LRCLIB 的单条对象或搜索结果数组；全失败时为空）
    body: String,
    /// 这一遍真正查到的歌词条数（0 表示三个中文来源都没命中）
    items: usize,
    /// 网易云是否返回了加密的 eapi 结果（走系统代理/异地出口时的典型症状）
    enc: bool,
    /// 抛异常的来源数（网络不通 / 超时的信号）
    errs: usize,
    /// 给日志和用户看的失败详情
    detail: String,
}

/// 在线获取歌词：多来源链（网易云 → QQ音乐 → 酷狗 → LRCLIB），均返回带时间戳的 LRC。
#[cfg(windows)]
#[tauri::command]
async fn fetch_lyrics(title: String, artist: String, album: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = title.trim().to_string();
        let a = artist.trim().to_string();
        if t.is_empty() {
            return Err("缺少歌名".to_string());
        }
        let alb = album.unwrap_or_default().trim().to_string();

        let q = format!("{} {}", t, a).trim().to_string();
        // 各来源搜索 URL（全部百分号编码，脚本里只用单引号包裹，无注入面）
        let ne_search = format!(
            "https://music.163.com/api/search/get/web?s={}&type=1&limit=5",
            url_encode(&t)
        );
        let qq_search = format!(
            "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w={}&format=json",
            url_encode(&q)
        );
        let kg_search = format!(
            "https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword={}&duration=&hash=",
            url_encode(&q)
        );
        let lr_get = format!(
            "https://lrclib.net/api/get?track_name={}&artist_name={}&album_name={}",
            url_encode(&t),
            url_encode(&a),
            url_encode(&alb)
        );
        let lr_search = format!("https://lrclib.net/api/search?q={}", url_encode(&q));

        // 单遍执行（direct=true 时脚本会绕过系统代理直连）
        let run_pass = |direct: &str| -> LyricsPass {
            // 临时文件名带时间戳 + 模式，避免并发/重入时互相覆盖
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let tag = if direct == "1" { "direct" } else { "proxy" };
            let tmp = std::env::temp_dir().join(format!(
                "petra_lyrics_{}_{}_{}.json",
                std::process::id(),
                stamp,
                tag
            ));
            let tmp_s = tmp.to_string_lossy().to_string();
            let tmp_ps1 = std::env::temp_dir().join(format!(
                "petra_lyrics_{}_{}_{}.ps1",
                std::process::id(),
                stamp,
                tag
            ));
            let ps1_s = tmp_ps1.to_string_lossy().to_string();
            let _ = std::fs::remove_file(&tmp);
            let _ = std::fs::remove_file(&tmp_ps1);

            let script = LYRICS_SCRIPT
                .replace("@OUT@", &tmp_s)
                .replace("@DIRECT@", direct)
                .replace("@ARTIST_ENC@", &url_encode(&a))
                .replace("@NE_SEARCH@", &ne_search)
                .replace("@QQ_SEARCH@", &qq_search)
                .replace("@KG_SEARCH@", &kg_search)
                .replace("@LR_GET@", &lr_get)
                .replace("@LR_SEARCH@", &lr_search);
            // 带 UTF-8 BOM 写盘：脚本本身是 ASCII，但临时路径可能含非 ASCII（用户名），
            // PowerShell 5.1 只有见到 BOM 才会按 UTF-8 解析。
            if let Err(e) = std::fs::write(&tmp_ps1, format!("\u{feff}{}", script)) {
                return LyricsPass {
                    body: String::new(),
                    items: 0,
                    enc: false,
                    errs: 0,
                    detail: format!("写入取词脚本失败: {e}"),
                };
            }

            let out = match hidden_command("powershell")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &ps1_s])
                .output()
            {
                Ok(o) => o,
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp_ps1);
                    return LyricsPass {
                        body: String::new(),
                        items: 0,
                        enc: false,
                        errs: 0,
                        detail: format!("启动失败: {e}"),
                    };
                }
            };
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let _ = std::fs::remove_file(&tmp_ps1);

            let body = std::fs::read_to_string(&tmp).unwrap_or_default();
            let _ = std::fs::remove_file(&tmp);
            let body = body.trim_start_matches('\u{feff}').trim().to_string();

            let (items, enc, errs) = parse_lyric_diag(&stdout);
            // PowerShell 的语法/网络错误走 stderr；诊断行里还带着 enc/errs，一起留作详情
            let detail = if !stderr.is_empty() { stderr } else { stdout };
            LyricsPass {
                body,
                items,
                enc,
                errs,
                detail: detail.chars().take(200).collect(),
            }
        };

        // 第一遍：绕过系统代理直连。
        // 开着 VPN（系统代理）时网易云会按异地出口返回加密的 eapi 结果，直连能绕开这个问题；
        // 反过来"只能通过代理上网"的用户，直连会失败，再由第二遍走系统代理兜底。
        let mut pass = run_pass("1");
        let mut mode = "直连";
        if pass.items == 0 {
            let proxy = crate::proxy::get_system_proxy();
            // 只在"确实像网络路径出了问题"时才多跑一遍代理：有代理配置，且要么连 LRCLIB 都空手而归，
            // 要么网易云返回了加密结果、要么有来源直接抛错。纯粹"曲库里没有这首歌"不重试。
            let retry = proxy.is_some() && (pass.body.is_empty() || pass.enc || pass.errs > 0);
            if retry {
                crate::log_line(&format!(
                    "[lyrics] 直连未取到（enc={} errs={}），改用系统代理重试",
                    pass.enc as u8, pass.errs
                ));
                let second = run_pass("0");
                if second.items > 0 {
                    pass = second;
                    mode = "系统代理";
                } else if !second.detail.is_empty() {
                    pass.detail = second.detail;
                }
            }
        }

        if pass.body.is_empty() {
            let detail = if pass.detail.is_empty() {
                "脚本无响应".to_string()
            } else {
                pass.detail.clone()
            };
            // 脚本的报错里可能带着请求 URL（含编码后的歌名），落盘前把歌名/歌手抹掉
            let safe_detail = if t.is_empty() {
                detail.clone()
            } else {
                detail.replace(t.as_str(), "***").replace(a.as_str(), "***")
            };
            crate::log_error(&format!("[lyrics] 取歌词失败（{mode}）：{safe_detail}"));
            return Err(format!("歌词接口无响应（{detail}）"));
        }
        // 成功也记一行：便于区分"接口没查到"与"接口坏了"
        let src = if pass.body.contains("netease") {
            "网易云"
        } else if pass.body.contains("kugou") {
            "酷狗"
        } else if pass.body.contains("qq") {
            "QQ音乐"
        } else {
            "LRCLIB"
        };
        crate::log_line(&format!(
            "[lyrics] 取歌词 → {} 字节，{}，来源{}（{mode}，命中 {} 条）",
            pass.body.len(),
            if pass.body.contains("syncedLyrics") { "含同步歌词" } else { "无同步歌词" },
            src,
            pass.items
        ));
        Ok(pass.body)
    })
    .await
    .map_err(|e| format!("歌词任务异常: {e}"))?
}

/// 在线获取歌词：macOS / Linux 共用，直接查 LRCLIB（https://lrclib.net）。
///
/// 为什么这样最划算：前端 src/music/Lyrics.ts 本来就是按 **LRCLIB 的 JSON 结构**解析的
/// （syncedLyrics / instrumental / trackName / duration），Windows 的 PowerShell 链路也是把
/// 四个来源统一成这个格式返回。所以这里只要把 LRCLIB 的原始响应原样返回，
/// 取最佳匹配、解析 LRC、本地缓存与负缓存这些逻辑一行都不用动。
/// Linux 因此直接白拿歌词功能，不必为 MPRIS 之外再写一套取词链。
///
/// 已知差别：LRCLIB 不提供译文，所以 mac / Linux 上「歌词翻译」拿不到中文翻译
/// （Windows 额外合并了网易云的 tlyric，前端在非 Windows 平台隐藏了该开关）；
/// 另外查不到时返回空数组，前端会记成 miss（负缓存），不会反复打接口。
#[cfg(unix)]
#[tauri::command]
async fn fetch_lyrics(
    title: String,
    artist: String,
    album: Option<String>,
) -> Result<String, String> {
    let t = title.trim();
    let a = artist.trim();
    if t.is_empty() {
        return Err("缺少歌名".to_string());
    }
    // 参数名必须与前端传的一致（Tauri 按名反序列化）；LRCLIB 只按歌名+歌手搜索
    let _ = album;

    let url = format!(
        "https://lrclib.net/api/search?track_name={}&artist_name={}",
        url_encode(t),
        url_encode(a)
    );
    // LRCLIB 明确要求带上可识别的 User-Agent
    const UA: &str = concat!(
        "Petra/",
        env!("CARGO_PKG_VERSION"),
        " (+https://github.com/Wumiu/Petra)"
    );
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

    let direct = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(UA)
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;

    let body = match direct.get(&url).send().await {
        Ok(resp) => resp
            .text()
            .await
            .map_err(|e| format!("读取歌词响应失败: {e}"))?,
        Err(direct_err) => {
            // 直连失败：配了系统代理就再试一次（与 updater / 天气的策略一致）
            match crate::proxy::get_system_proxy().and_then(|p| reqwest::Proxy::all(&p).ok()) {
                Some(proxy) => {
                    let via_proxy = reqwest::Client::builder()
                        .timeout(TIMEOUT)
                        .user_agent(UA)
                        .proxy(proxy)
                        .build()
                        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
                    via_proxy
                        .get(&url)
                        .send()
                        .await
                        .map_err(|e| format!("歌词接口请求失败（直连与代理都不通）: {e}"))?
                        .text()
                        .await
                        .map_err(|e| format!("读取歌词响应失败: {e}"))?
                }
                None => return Err(format!("歌词接口请求失败: {direct_err}")),
            }
        }
    };

    // 查不到时 LRCLIB 返回 []（HTTP 200），这里做一次 JSON 校验，
    // 免得把运营商劫持页 / 错误页当成歌词丢给前端
    if serde_json::from_str::<serde_json::Value>(body.trim()).is_err() {
        return Err("歌词接口返回了非 JSON 内容（可能被网络劫持）".to_string());
    }
    Ok(body)
}

/// 列出开始菜单里可启动的软件（供小助手回答"你能打开什么"并按正确名称调用）
#[cfg(windows)]
#[tauri::command]
fn list_installed_apps() -> String {
    let mut names = launch::list_applications();
    let total = names.len();
    names.truncate(60);
    if total == 0 {
        return "没有在开始菜单里找到快捷方式".to_string();
    }
    let tail = if total > names.len() { "（仅列出前 60 个）" } else { "" };
    format!("开始菜单里可启动的软件共 {total} 个{tail}：{}", names.join("、"))
}

#[tauri::command]
async fn tts_synthesize(
    api_key: String,
    speaker: String,
    text: String,
    language: Option<String>,
    // "clone"（默认）= 声音复刻音色走 seed-icl-2.0；
    // "tts2" = 豆包语音合成2.0 官方音色走 seed-tts-2.0，可用「语音指令」控制语气语调
    mode: Option<String>,
    // tts2 模式下要用的 2.0 音色 ID（clone 模式忽略）
    voice: Option<String>,
    // tts2 模式下的语音指令，如「用特别痛心的语气说话」
    instruction: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    // 两套模型共用同一个 HTTP 端点，只靠 X-Api-Resource-Id 区分：
    //   seed-icl-2.0 = 声音复刻（你自己的音色，语气偏平）
    //   seed-tts-2.0 = 豆包语音合成 2.0（官方音色，支持 context_texts 语音指令）
    let is_tts2 = mode.as_deref() == Some("tts2");
    let resource = if is_tts2 { "seed-tts-2.0" } else { "seed-icl-2.0" };
    // tts2 必须用「豆包语音合成2.0 官方音色」；克隆音色 ID（S_/ICL_ 开头）在 2.0 上会
    // 直接报 InvalidModelType，所以这里兜一层：不是官方音色就退回内置默认音色。
    const TTS2_DEFAULT_VOICE: &str = "zh_female_vv_uranus_bigtts";
    let use_speaker = if is_tts2 {
        let v = voice.unwrap_or_default();
        let v = v.trim();
        if v.is_empty() || v.starts_with("S_") || v.starts_with("ICL_") {
            TTS2_DEFAULT_VOICE.to_string()
        } else {
            v.to_string()
        }
    } else {
        speaker.clone()
    };
    let mut req = serde_json::json!({
        "req_params": {
            "text": text,
            "speaker": use_speaker,
            "audio_params": { "format": "mp3", "sample_rate": 24000 }
        }
    });
    if let Some(lang) = language.filter(|l| !l.is_empty()) {
        req["req_params"]["explicit_language"] = serde_json::Value::String(lang);
    }
    // 语音指令：只有 2.0 官方音色支持（复刻音色传了也没用，甚至报错），所以只在 tts2 下带
    if is_tts2 {
        if let Some(ins) = instruction.filter(|s| !s.trim().is_empty()) {
            req["req_params"]["context_texts"] = serde_json::json!([ins]);
        }
    }

    let resp = client
        .post("https://openspeech.bytedance.com/api/v3/tts/unidirectional")
        .header("X-Api-Key", &api_key)
        .header("X-Api-Resource-Id", resource)
        .header("X-Api-Request-Id", &format!("{:x}{:x}{:x}{:x}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
            std::process::id()))
        .header("Content-Type", "application/json")
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("TTS request: {e}"))?;

    let body = resp.text().await.map_err(|e| format!("TTS read: {e}"))?;
    let mut combined = String::new();
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() { continue; }
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(t) {
            if let Some(data) = j.get("data").and_then(|d| d.as_str()) {
                combined.push_str(data);
            }
        }
    }
    if combined.is_empty() {
        return Err(format!("TTS no audio: {}", body));
    }
    Ok(combined)
}

/// 语音识别的服务端点与模型：与 TTS 同一路子 —— 请求从 Rust 侧发出，
/// 密钥只存在于 Rust（DPAPI / Keychain / 600 权限文件），前端只拿到转写出来的文本。
const ASR_API_URL: &str = "https://api.siliconflow.cn/v1/audio/transcriptions";
/// 默认识别模型：XingChen (中国电信) 的 ASR-V3.2-Ultra，中文短句比 SenseVoice 更稳。
const ASR_MODEL: &str = "XingChenAGI/XingChenASR-V3.2-Ultra";
/// 兜底模型：万一账号没开通上面的模型（400/403/404），自动退回这个，
/// 别让「模型没权限」直接把语音输入整条链路废掉。
const ASR_MODEL_FALLBACK: &str = "FunAudioLLM/SenseVoiceSmall";

/// 内置的默认 ASR Key：**编译期**从环境变量注入，源码与仓库里都没有这个字符串。
///
/// 为什么允许内置：硅基流动的语音模型是免费的，内置一个默认 Key 才能让用户开箱即用、
/// 不必自己注册（这正是它原本被写死在代码里的原因）。但免费模型的 Rate Limits 是
/// **固定的** —— Key 一旦进公开仓库就容易被人刷满额度，而且没法花钱提额，只能换 Key。
/// 所以走 `option_env!`：值来自构建时的 PETRA_ASR_KEY（见根目录 .cargo/config.toml，
/// 那个文件在 .gitignore 里），仓库保持干净，打出来的应用里仍然带着它。
///
/// 换 Key：改 .cargo/config.toml 里那一行，然后 `cargo clean -p petra` 强制重编
/// （option_env! 变了 cargo 不一定能感知）。注入为空时自动退化成"要用户自己填 Key"。
///
/// 这里必须用 match 而不是 `option_env!(...).unwrap_or("")`：后者在 const 上下文里
/// 还没稳定（E0658 cannot call conditionally-const method in constants）。
const DEFAULT_ASR_KEY: &str = match option_env!("PETRA_ASR_KEY") {
    Some(key) => key,
    None => "",
};

/// 用户没存自己的 Key → 回退到内置默认值；存了就用用户自己的。
fn asr_key_or_default(stored: String) -> String {
    if stored.trim().is_empty() {
        DEFAULT_ASR_KEY.trim().to_string()
    } else {
        stored
    }
}

/// 现在到底有没有可用的识别 Key（用户自己的或内置默认的）。
///
/// 前端点麦克风前先问它：没有就直接提示去配置，别白录一轮再报错。
/// 注意别用 get_asr_key 做这件事 —— 那个只报"用户自己填的"，内置默认是隐藏的。
/// 生效中的 ASR Key（用户填的优先，否则内置）+ 它是不是内置的。
/// ⚠️ 这条命令会把 Key 明文交给前端 —— 用户明确说过"不怕泄露，直接贴在控制面板上"，
/// 所以面板可以把 Key 显示出来方便查看/复制。别拿它做别的用途。
#[tauri::command]
fn asr_key_info(app: AppHandle) -> serde_json::Value {
    let own = read_stored_asr_key(&app);
    let builtin = DEFAULT_ASR_KEY.trim().to_string();
    let (key, from_builtin) = if !own.trim().is_empty() {
        (own, false)
    } else {
        (builtin, true)
    };
    serde_json::json!({ "key": key, "builtin": from_builtin })
}

/// 当前用的云端识别模型名（面板上显示，免得用户不清楚到底在跑哪个模型）
#[tauri::command]
fn asr_model_name() -> String {
    ASR_MODEL.to_string()
}

#[tauri::command]
fn asr_key_ready(app: AppHandle) -> bool {
    !asr_key_or_default(read_stored_asr_key(&app)).is_empty()
}

// =============== 麦克风权限（Windows 的隐私开关） ===============

/// 系统里的麦克风权限状态：`allow` / `deny` / `unset`（没设过=跟随上一层）/ `unsupported`
#[derive(serde::Serialize)]
struct MicPermission {
    /// 全局总开关（设置 → 隐私和安全性 → 麦克风 最上面那个）
    global: String,
    /// 本应用（WebView2 宿主进程）的逐应用开关
    app: String,
}

#[cfg(windows)]
const MIC_CONSENT_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

#[cfg(windows)]
fn norm_perm(v: &str) -> String {
    match v.trim().to_ascii_lowercase().as_str() {
        "allow" => "allow".to_string(),
        "deny" => "deny".to_string(),
        _ => "unset".to_string(),
    }
}

/// 列出 `ConsentStore\microphone\NonPackaged` 下所有 WebView2 的项。
///
/// 为什么要枚举而不是拼一个固定路径：键名里带着 WebView2 的**版本号目录**
/// （…\EdgeWebView\Application\154.0.4258.62\msedgewebview2.exe，`\` 换成 `#`），
/// 运行时一旦升级，路径就变了；枚举能同时覆盖新旧几份。
#[cfg(windows)]
fn webview2_mic_keys() -> Vec<String> {
    let Ok(out) = hidden_command("reg")
        .args(["query", &format!("{MIC_CONSENT_KEY}\\NonPackaged")])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| l.to_ascii_lowercase().contains("msedgewebview2.exe"))
        .collect()
}

#[cfg(windows)]
#[tauri::command]
fn get_mic_permission() -> MicPermission {
    let global = norm_perm(&read_reg_value(MIC_CONSENT_KEY, "Value"));
    // 任一 WebView2 项是 Deny 就算"本应用被拒"（逐应用项会覆盖全局）
    let mut app = "unset".to_string();
    for key in webview2_mic_keys() {
        match norm_perm(&read_reg_value(&key, "Value")).as_str() {
            "deny" => {
                app = "deny".to_string();
                break;
            }
            "allow" => app = "allow".to_string(),
            _ => {}
        }
    }
    MicPermission { global, app }
}

/// 改系统里的麦克风权限。
///
/// 开启：全局置 Allow（否则逐应用放行也没用）+ 删掉逐应用的覆盖项，让它跟随全局 ——
///       这样用户以后自己在 Windows 设置里关掉总开关，本应用也会一起被关。
/// 关闭：**只**把本应用（WebView2）的逐应用项设成 Deny，不动全局，免得影响其它软件。
///
/// ⚠️ 对**已经在跑的** WebView2 进程，系统这一层不一定立刻生效（实测：设成 Deny 后
/// getUserMedia 照样拿得到麦克风，页面 reload 也不行）—— 所以真正的即时开关在应用内
/// （settings.asr.micAllowed），这里只是把系统设置同步成一致的状态、重启后由系统兜底。
#[cfg(windows)]
#[tauri::command]
fn set_mic_permission(allow: bool) -> Result<String, String> {
    let keys = webview2_mic_keys();
    if allow {
        let _ = hidden_command("reg")
            .args(["add", MIC_CONSENT_KEY, "/v", "Value", "/t", "REG_SZ", "/d", "Allow", "/f"])
            .output();
        for key in &keys {
            let _ = hidden_command("reg").args(["delete", key, "/v", "Value", "/f"]).output();
        }
        return Ok("已在系统里允许麦克风".to_string());
    }
    if keys.is_empty() {
        return Err("没找到本应用在系统里的麦克风权限项，请到 Windows 设置的麦克风页面里关".to_string());
    }
    for key in &keys {
        let _ = hidden_command("reg")
            .args(["add", key, "/v", "Value", "/t", "REG_SZ", "/d", "Deny", "/f"])
            .output();
    }
    Ok("已在系统里拒绝麦克风".to_string())
}

/// macOS 的麦克风权限由系统 TCC 托管，应用只能请求、不能替用户改；Linux 没有对应概念。
#[cfg(not(windows))]
#[tauri::command]
fn get_mic_permission() -> MicPermission {
    MicPermission { global: "unsupported".to_string(), app: "unsupported".to_string() }
}

#[cfg(not(windows))]
#[tauri::command]
fn set_mic_permission(_allow: bool) -> Result<String, String> {
    Err("当前系统的麦克风权限只能在系统设置里改".to_string())
}

/// 单次录音上限：超过这个大小大概率是 VAD 没判出静音、录了一大段环境音，
/// 与其把几十兆传上去等超时，不如当场给一句人话。
const ASR_MAX_AUDIO_BYTES: usize = 20 * 1024 * 1024;

/// 转写一段 WebM/Opus 录音（base64 传入）。
///
/// 为什么手拼 multipart：`reqwest` 的 multipart 要额外开 feature（会拉进 mime_guess
/// 一串新 crate），而这里只需要一个固定的 form-data 体，手拼不到 20 行。
#[tauri::command]
async fn asr_transcribe(app: AppHandle, audio: String) -> Result<String, String> {
    use base64::Engine as _;
    // 用户自己的 Key 优先，其次编译期注入的内置默认 Key
    let api_key = asr_key_or_default(read_stored_asr_key(&app));
    if api_key.trim().is_empty() {
        return Err("未配置语音识别 API Key（右键菜单 →「🎤 语音识别设置」）".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio.as_bytes())
        .map_err(|e| format!("录音数据解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("这段录音是空的".to_string());
    }
    if bytes.len() > ASR_MAX_AUDIO_BYTES {
        return Err(format!(
            "录音太大（{} MB），请说得短一点",
            bytes.len() / 1024 / 1024
        ));
    }

    let boundary = format!(
        "----petra{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    // 主模型不行（账号没开通 / 名字不认）就退回兜底模型，别让语音输入整个不可用
    let mut last_err = String::new();
    for model in [ASR_MODEL, ASR_MODEL_FALLBACK] {
        let body = asr_multipart(&boundary, model, &bytes);
        let resp = client
            .post(ASR_API_URL)
            .header("Authorization", format!("Bearer {}", api_key.trim()))
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| format!("语音识别请求失败: {e}"))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取识别结果失败: {e}"))?;
        if status.is_success() {
            let json: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("识别结果解析失败: {e}"))?;
            let recognized = json
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            log_line(&format!(
                "[asr] model={model} bytes={} status={status} textLen={}",
                bytes.len(),
                recognized.chars().count()
            ));
            // 200 但一个字都没有：可能是这个模型不认这种音频格式（录音是 webm/opus）。
            // 先别急着把空串还给用户，换兜底模型再试一次——它有结果就用它的。
            if recognized.is_empty() && model == ASR_MODEL {
                log_line("[asr] 主模型返回空文本，改用兜底模型重试");
                last_err = "没听清".to_string();
                continue;
            }
            return Ok(recognized);
        }
        last_err = format!(
            "语音识别服务返回 {status}: {}",
            text.chars().take(200).collect::<String>()
        );
        // 只有「模型不存在 / 没权限 / 参数不对」才值得换模型重试；
        // 401（Key 错）、429（限流）、5xx 换模型也没用，直接报错更诚实。
        let retryable = matches!(status.as_u16(), 400 | 403 | 404 | 422);
        log_line(&format!(
            "[asr] {model} 失败（{status}），retryable={retryable}，bytes={}，body={}",
            bytes.len(),
            text.chars().take(120).collect::<String>()
        ));
        if !retryable {
            break;
        }
    }
    Err(last_err)
}

/// 按文件头猜音频类型：浏览器录音是 webm，面板「识别自检」可能是 wav/mp3。
/// 服务端会按 filename 后缀 + Content-Type 判断，猜错了容易 400。
fn audio_kind(bytes: &[u8]) -> (&'static str, &'static str) {
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        ("audio.wav", "audio/wav")
    } else if bytes.len() > 3 && (&bytes[0..3] == b"ID3" || (bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0)) {
        ("audio.mp3", "audio/mpeg")
    } else if bytes.len() > 4 && &bytes[0..4] == b"OggS" {
        ("audio.ogg", "audio/ogg")
    } else {
        ("audio.webm", "audio/webm")
    }
}

/// 手拼 multipart/form-data（model + file），避免为此引入 mime_guess 一串依赖
fn asr_multipart(boundary: &str, model: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body: Vec<u8> = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{model}\r\n")
            .as_bytes(),
    );
    let (filename, ctype) = audio_kind(bytes);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// 列出可启动的应用（macOS 扫 /Applications，Linux 扫 freedesktop 的 .desktop）。
#[cfg(unix)]
#[tauri::command]
fn list_installed_apps() -> String {
    let mut names = launch::list_applications();
    let total = names.len();
    names.truncate(60);
    if total == 0 {
        return "没有找到已安装的应用".to_string();
    }
    let tail = if total > names.len() { "（仅列出前 60 个）" } else { "" };
    format!("可启动的应用共 {total} 个{tail}：{}", names.join("、"))
}

/// 用系统默认程序打开文件或文件夹（路径必须存在，避免误开未知目标）
#[cfg(windows)]
#[tauri::command]
fn open_path(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    hidden_command("cmd")
        .args(["/C", "start", "", &path])
        .spawn()
        .map_err(|e| format!("打开失败: {e}"))?;
    Ok(format!("已打开 {path}"))
}

/// 用系统默认程序打开文件或文件夹（macOS 用 open，等价于 Finder 里双击）
/// 路径必须存在，避免误开未知目标；参数以数组传给 open，不经过 shell。
#[cfg(target_os = "macos")]
#[tauri::command]
fn open_path(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    hidden_command("/usr/bin/open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("打开失败: {e}"))?;
    Ok(format!("已打开 {path}"))
}

/// 用系统默认程序打开文件或文件夹（Linux 用 xdg-open，等价于文件管理器里双击）。
/// 路径必须存在，避免误开未知目标；参数以数组传给 xdg-open，不经过 shell。
#[cfg(target_os = "linux")]
#[tauri::command]
fn open_path(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    hidden_command("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("打开失败: {e}"))?;
    Ok(format!("已打开 {path}"))
}

/// 锁定屏幕
#[cfg(windows)]
#[tauri::command]
fn lock_screen() -> Result<String, String> {
    hidden_command("rundll32.exe")
        .args(["user32.dll,LockWorkStation"])
        .spawn()
        .map_err(|e| format!("锁屏失败: {e}"))?;
    Ok("已锁屏".to_string())
}

/// 锁定屏幕（macOS）。
///
/// 首选 **CGSession -suspend**：macOS 自带的锁屏入口，**不需要辅助功能权限**。
/// 失败时才退回 System Events 发 ⌃⌘Q（那条要辅助功能权限，但作为兜底总比直接失败好）。
#[cfg(target_os = "macos")]
#[tauri::command]
fn lock_screen() -> Result<String, String> {
    const CGSESSION: &str =
        "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";
    if std::path::Path::new(CGSESSION).exists() {
        match hidden_command(CGSESSION).arg("-suspend").status() {
            Ok(_) => return Ok("已锁屏".to_string()),
            Err(e) => log_verbose(&format!("[lock] CGSession 不可用，退回 osascript: {e}")),
        }
    }
    let script =
        r#"tell application "System Events" to keystroke "q" using {command down, control down}"#;
    let out = hidden_command("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("锁屏失败: {e}"))?;
    if out.status.success() {
        Ok("已锁屏".to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            "锁屏失败".to_string()
        } else {
            format!("锁屏失败: {err}")
        })
    }
}

/// 锁定屏幕（Linux）。
///
/// 首选 loginctl lock-session：这是 logind 的公开接口，由桌面环境自己决定怎么锁，
/// 不需要提权，也不绑死 GNOME / KDE 任何一家。
/// 环境里没有 systemd-logind（非 systemd 发行版、容器）时，退回 ScreenSaver 规范的
/// org.freedesktop.ScreenSaver.Lock —— 同样是公开 D-Bus 接口。
#[cfg(target_os = "linux")]
#[tauri::command]
fn lock_screen() -> Result<String, String> {
    match hidden_command("loginctl").arg("lock-session").status() {
        Ok(s) if s.success() => return Ok("已锁屏".to_string()),
        Ok(s) => log_verbose(&format!("[lock] loginctl lock-session 退出码 {s}，改用 D-Bus")),
        Err(e) => log_verbose(&format!("[lock] loginctl 不可用，改用 D-Bus: {e}")),
    }
    let out = hidden_command("busctl")
        .args([
            "--user",
            "call",
            "org.freedesktop.ScreenSaver",
            "/ScreenSaver",
            "org.freedesktop.ScreenSaver",
            "Lock",
        ])
        .output()
        .map_err(|e| format!("锁屏失败: {e}"))?;
    if out.status.success() {
        Ok("已锁屏".to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            "锁屏失败（loginctl 与 D-Bus 都不可用）".to_string()
        } else {
            format!("锁屏失败: {err}")
        })
    }
}

/// 定时关机（分钟后）。
#[cfg(windows)]
#[tauri::command]
fn schedule_shutdown(minutes: u32) -> Result<String, String> {
    if minutes == 0 || minutes > 1440 {
        return Err("时间范围：1~1440 分钟".into());
    }
    let secs = minutes * 60;
    let output = hidden_command("shutdown")
        .args(["/s", "/t", &secs.to_string()])
        .output()
        .map_err(|e| format!("执行失败: {e}"))?;
    if output.status.success() {
        log_line(&format!("schedule_shutdown: {minutes} 分钟后关机"));
        Ok(format!("已设定 {minutes} 分钟后关机，说「取消关机」可取消"))
    } else {
        Err("关机命令执行失败".into())
    }
}

/// 取消定时关机。
#[cfg(windows)]
#[tauri::command]
fn cancel_shutdown() -> Result<String, String> {
    let output = hidden_command("shutdown")
        .args(["/a"])
        .output()
        .map_err(|e| format!("执行失败: {e}"))?;
    if output.status.success() {
        log_line("cancel_shutdown: 已取消");
        Ok("已取消定时关机".into())
    } else {
        Err("没有待取消的关机任务".into())
    }
}

/// macOS / Linux 上"待执行的关机"用代数标记：每次设定/取消都自增，
/// 定时线程醒来时代数变了就放弃执行（比 Windows 的 shutdown /a 更直接）。
#[cfg(unix)]
static SHUTDOWN_GENERATION: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 定时关机（macOS）：**应用内定时器 + AppleScript**。
///
/// 为什么不用 shutdown(8)：它要 root，提权会弹系统密码框，桌宠不该这么干。
/// 改成应用内计时，到点让 System Events 执行"关机"（免 root、免权限）。
/// 代价：**要求 Petra 在到点前保持运行**（Windows 的 shutdown /t 是系统级的，
/// 关掉应用也会执行），这点如实写进提示语里，不假装等价。
#[cfg(target_os = "macos")]
#[tauri::command]
fn schedule_shutdown(minutes: u32) -> Result<String, String> {
    use std::sync::atomic::Ordering;

    if minutes == 0 || minutes > 1440 {
        return Err("时间范围：1~1440 分钟".into());
    }
    let generation = SHUTDOWN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let delay = std::time::Duration::from_secs(minutes as u64 * 60);
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        // 期间用户取消过（代数变了）就不再执行
        if SHUTDOWN_GENERATION.load(Ordering::SeqCst) != generation {
            log_line("schedule_shutdown: 已被取消，不执行");
            return;
        }
        log_line("schedule_shutdown: 到点，执行关机");
        let script = r#"tell application "System Events" to shut down"#;
        match hidden_command("/usr/bin/osascript").args(["-e", script]).status() {
            Ok(s) if s.success() => log_line("schedule_shutdown: 关机指令已发出"),
            Ok(s) => log_line(&format!("schedule_shutdown: osascript 退出码 {s}")),
            Err(e) => log_line(&format!("schedule_shutdown: 执行失败 {e}")),
        }
    });

    log_line(&format!("schedule_shutdown: {minutes} 分钟后关机（应用内定时器）"));
    Ok(format!(
        "已设定 {minutes} 分钟后关机（需要 Petra 保持运行），说「取消关机」可以取消"
    ))
}

/// 定时关机（Linux）：**应用内定时器 + systemctl poweroff**。
///
/// 与 macOS 版同样不用 shutdown(8)：它要 root，会弹认证框。
/// 到点先调 systemctl poweroff（走 logind，活跃会话用户通常被 polkit 允许关机），
/// 失败再退到 org.freedesktop.login1.Manager.PowerOff 这条公开 D-Bus 方法
/// （b true = 允许 polkit 交互）。
/// 代价与 macOS 版相同：**要求 Petra 在到点前保持运行**（Windows 的 shutdown /t
/// 是系统级的，关掉应用也会执行），这点如实写进提示语，不假装等价。
#[cfg(target_os = "linux")]
#[tauri::command]
fn schedule_shutdown(minutes: u32) -> Result<String, String> {
    use std::sync::atomic::Ordering;

    if minutes == 0 || minutes > 1440 {
        return Err("时间范围：1~1440 分钟".into());
    }
    let generation = SHUTDOWN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let delay = std::time::Duration::from_secs(minutes as u64 * 60);
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        // 期间用户取消过（代数变了）就不再执行
        if SHUTDOWN_GENERATION.load(Ordering::SeqCst) != generation {
            log_line("schedule_shutdown: 已被取消，不执行");
            return;
        }
        log_line("schedule_shutdown: 到点，执行关机");
        match hidden_command("systemctl").arg("poweroff").status() {
            Ok(s) if s.success() => {
                log_line("schedule_shutdown: 关机指令已发出");
                return;
            }
            Ok(s) => log_line(&format!("schedule_shutdown: systemctl 退出码 {s}，改用 D-Bus")),
            Err(e) => log_line(&format!("schedule_shutdown: systemctl 不可用，改用 D-Bus: {e}")),
        }
        match hidden_command("busctl")
            .args([
                "call",
                "org.freedesktop.login1",
                "/org/freedesktop/login1",
                "org.freedesktop.login1.Manager",
                "PowerOff",
                "b",
                "true",
            ])
            .status()
        {
            Ok(s) if s.success() => log_line("schedule_shutdown: 关机指令已发出（D-Bus）"),
            Ok(s) => log_line(&format!("schedule_shutdown: D-Bus PowerOff 退出码 {s}")),
            Err(e) => log_line(&format!("schedule_shutdown: D-Bus PowerOff 失败 {e}")),
        }
    });

    log_line(&format!("schedule_shutdown: {minutes} 分钟后关机（应用内定时器）"));
    Ok(format!(
        "已设定 {minutes} 分钟后关机（需要 Petra 保持运行），说「取消关机」可以取消"
    ))
}

/// 取消定时关机（macOS / Linux）：自增代数即让定时线程放弃。
#[cfg(unix)]
#[tauri::command]
fn cancel_shutdown() -> Result<String, String> {
    SHUTDOWN_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    log_line("cancel_shutdown: 已取消");
    Ok("已取消定时关机".into())
}

/// 命令安全校验：白名单模式，只允许已知安全的查询类命令。
/// 打开软件请走 `launch_application`，不需要 shell。
#[cfg(windows)]
fn validate_shell_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("命令为空".into());
    }
    // 控制字符（含换行/回车）一律拒绝：cmd 会把内嵌换行当作语句分隔符执行，
    // 只拦 &|><` 会被 `ipconfig\n恶意命令` 这类 payload 绕过（白名单只看首 token）。
    // 同时拒绝 %（环境变量展开）、^（cmd 转义符）、;（for 等块语句分隔符）。
    if trimmed.chars().any(|c| c.is_control() || c == '%' || c == '^' || c == ';') {
        return Err("命令被拦截（不允许控制字符 / % / ^ / ;）".into());
    }
    // 链式/重定向一律拦截
    if trimmed.contains('&') || trimmed.contains('|') || trimmed.contains('>')
        || trimmed.contains('<') || trimmed.contains('`')
    {
        return Err("命令被拦截（不允许链式/重定向/反引号）".into());
    }
    // 提取首个 token（命令名），支持带路径参数的调用
    let first = trimmed.split_whitespace().next().unwrap_or("");
    let cmd = first
        .rsplit('\\')
        .next()
        .unwrap_or(first)
        .to_lowercase();
    // 白名单：仅允许安全的查询/信息类命令
    const ALLOWED: &[&str] = &[
        // 网络
        "ipconfig", "ping", "netstat", "nslookup", "tracert", "pathping",
        "arp", "getmac", "nbtstat",
        // 系统信息（只读）
        "systeminfo", "hostname", "whoami", "ver", "vol", "date", "time",
        "driverquery",
        // 进程/服务（只读查询）
        "tasklist", "tasklist.exe", "query",
        // 文件/目录（只读）
        "dir", "tree", "type", "where",
        // 其他安全
        "echo", "set", "chcp", "cls", "color", "title",
    ];
    if !ALLOWED.iter().any(|a| cmd == *a) {
        return Err(format!(
            "命令被拦截（不在白名单内：{cmd}）。小助手仅支持查询类命令，打开软件请直接说"
        ));
    }
    Ok(())
}

/// 命令安全校验（macOS / Linux）：白名单是这两个系统上常见的只读查询命令。
/// 注入防护与 Windows 版思路一致：控制字符、% ^ ; 与链式/重定向/变量展开/子 shell 一律拦截。
///
/// 白名单刻意收得很窄：凡是既能读又能改的（ifconfig / networksetup / pmset /
/// sysctl / launchctl / route / find -exec）都不放进来，避免"只读命令"被用成写命令。
/// 列表里少数 macOS 专属项（sw_vers）在 Linux 上只是"允许但执行会失败"，不放宽也不收紧。
#[cfg(unix)]
fn validate_shell_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("命令为空".into());
    }
    // 控制字符含换行/回车：sh 会把内嵌换行当作语句分隔符执行。
    if trimmed
        .chars()
        .any(|c| c.is_control() || c == '%' || c == '^' || c == ';')
    {
        return Err("命令被拦截（不允许控制字符 / % / ^ / ;）".into());
    }
    // 链式/重定向/变量展开/子 shell 一律拦截
    if trimmed.contains('&')
        || trimmed.contains('|')
        || trimmed.contains('>')
        || trimmed.contains('<')
        || trimmed.contains('\u{60}')
        || trimmed.contains('$')
        || trimmed.contains('(')
        || trimmed.contains(')')
    {
        return Err("命令被拦截（不允许链式/重定向/变量展开/子 shell）".into());
    }
    // 提取首个 token（命令名），支持 /usr/bin/xxx 这种带路径的调用
    let first = trimmed.split_whitespace().next().unwrap_or("");
    let cmd = first.rsplit('/').next().unwrap_or(first).to_lowercase();
    // 白名单：仅允许只读的查询/信息类命令
    const ALLOWED: &[&str] = &[
        // 网络（只读探测）
        "ping", "traceroute", "nslookup", "dig", "host", "netstat",
        // 系统信息（只读）
        "sw_vers", "hostname", "whoami", "id", "uname", "uptime", "date", "df", "du",
        // 进程（只读查询）
        "ps", "lsof",
        // 文件/目录（只读）
        "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat",
        // 其他安全
        "echo", "which", "whereis",
    ];
    if !ALLOWED.iter().any(|a| cmd == *a) {
        return Err(format!(
            "命令被拦截（不在白名单内：{cmd}）。小助手仅支持查询类命令，打开软件请直接说"
        ));
    }
    Ok(())
}

/// 小助手 shell 调用：执行命令（chcp 65001 切 UTF-8 避免中文乱码），返回输出；
/// 15s 超时并强制终止子进程。仅由前端在用户确认气泡允许后调用。
/// 注意：普通“打开软件”请求应走 launch_application，不要用本命令。
#[tauri::command]
fn run_shell(command: String) -> Result<String, String> {
    use std::io::Read;
    use std::time::Duration;

    validate_shell_command(&command)?;
    log_line(&format!("run_shell: {command}"));
    // Windows：chcp 65001 切 UTF-8 代码页，避免 cmd 内置命令 GBK 输出乱码
    #[cfg(windows)]
    let full = format!("chcp 65001>nul & {command}");
    #[cfg(windows)]
    let mut cmd = {
        let mut c = hidden_command("cmd");
        c.args(["/C", &full]);
        c
    };
    // macOS / Linux：交给 /bin/sh -c（白名单与注入防护已在 validate_shell_command 里做过）
    #[cfg(unix)]
    let mut cmd = {
        let mut c = hidden_command("/bin/sh");
        c.args(["-c", &command]);
        c
    };
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动失败: {e}"))?;

    // 后台线程读 stdout/stderr，避免大输出阻塞
    let (otx, orx) = std::sync::mpsc::channel();
    let mut out = child.stdout.take().ok_or("无输出")?;
    std::thread::spawn(move || {
        let mut v: Vec<u8> = Vec::new();
        let _ = out.read_to_end(&mut v);
        let _ = otx.send(v);
    });
    let (etx, erx) = std::sync::mpsc::channel();
    let mut err = child.stderr.take().ok_or("无输出")?;
    std::thread::spawn(move || {
        let mut v: Vec<u8> = Vec::new();
        let _ = err.read_to_end(&mut v);
        let _ = etx.send(v);
    });

    // 轮询结束，超时 kill
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(15) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("命令执行超时（15s）已终止".into());
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(format!("等待失败: {e}")),
        }
    }

    let ob = orx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let eb = erx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();

    let mut s = String::from_utf8_lossy(&ob).to_string();
    if !eb.is_empty() {
        s.push_str(&String::from_utf8_lossy(&eb));
    }
    Ok(s.trim().to_string())
}

/// 小助手“打开软件”专用：只接受应用名，解析（别名 → 系统应用 → 开始菜单快捷方式）
/// 后经 ShellExecuteW 启动，返回结构化结果。不接受任意 shell 表达式。
#[tauri::command]
fn launch_application(application: String) -> launch::LaunchResult {
    launch::launch_application_checked(application)
}

/// 用系统默认浏览器打开 URL（更新提示「前往下载」用）。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    launch::open_url(&url)
}

// ==================== 小助手的文件能力 ====================
//
// 这些命令是"把写磁盘的能力交给 AI"的入口，安全判定全部在 files.rs 里
// （只接受绝对路径、必须落在桌面/文档/下载之内、禁止表与 .git 一律拒绝）。
// `deny_paths` 由前端从设置里带过来（一行一个的「文件禁止目录」）。

/// 新建文件夹或文件。
#[tauri::command]
fn create_entry(
    app: AppHandle,
    path: String,
    is_dir: bool,
    content: Option<String>,
    deny_paths: Option<Vec<String>>,
) -> Result<String, String> {
    files::create_entry(&app, &path, is_dir, content, &deny_paths.unwrap_or_default())
}

/// 读文本文件（可按行区间取一段）。
#[tauri::command]
fn read_text_file(
    app: AppHandle,
    path: String,
    start_line: Option<usize>,
    max_lines: Option<usize>,
    deny_paths: Option<Vec<String>>,
) -> Result<files::ReadResult, String> {
    files::read_text_file(
        &app,
        &path,
        &deny_paths.unwrap_or_default(),
        start_line,
        max_lines,
    )
}

/// 写文件（覆盖或追加；覆盖前自动备份）。
#[tauri::command]
fn write_text_file(
    app: AppHandle,
    path: String,
    content: String,
    mode: Option<String>,
    deny_paths: Option<Vec<String>>,
) -> Result<String, String> {
    files::write_text_file(
        &app,
        &path,
        &content,
        mode.as_deref().unwrap_or("overwrite"),
        &deny_paths.unwrap_or_default(),
    )
}

/// 精确替换文件内容（old_string 必须完全一致；覆盖前自动备份）。
#[tauri::command]
fn edit_text_file(
    app: AppHandle,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
    deny_paths: Option<Vec<String>>,
) -> Result<String, String> {
    files::edit_text_file(
        &app,
        &path,
        &old_string,
        &new_string,
        replace_all.unwrap_or(false),
        &deny_paths.unwrap_or_default(),
    )
}

/// 列目录（目录在前，同类按名字排序）。
#[tauri::command]
fn list_directory(
    app: AppHandle,
    path: String,
    deny_paths: Option<Vec<String>>,
) -> Result<files::ListResult, String> {
    files::list_directory(&app, &path, &deny_paths.unwrap_or_default())
}

/// 关闭浏览器里用户指定的那个标签页（小助手「把那个 B站页面关了」用）。
///
/// 走 spawn_blocking：UI Automation 要遍历无障碍树（实测一个浏览器窗口几十到几百
/// 毫秒），同步调用会占住运行时线程 —— 与 capture_screen 同理。
///
/// 注意这里**不能加 pub**：`#[tauri::command]` 对 pub 命令会额外生成
/// `#[macro_export] macro_rules!`，而 macro_export 落在 crate 根部 —— 与紧随其后的
/// `pub use __cmd__xxx;` 同名冲突（E0255）。capture_screen 是 pub 也没事，因为它在
/// capture 模块里。lib.rs 根部的命令一律私有，与 launch_application / open_url 一致。
#[tauri::command]
async fn close_web_page(keyword: String) -> webpage::ClosePageResult {
    tauri::async_runtime::spawn_blocking(move || webpage::close_web_page(&keyword))
        .await
        .unwrap_or_else(|e| webpage::ClosePageResult::failed(format!("关网页任务异常：{e}")))
}

/// 清除移动目标（拖动/停止漫游时）。
#[tauri::command]
fn clear_pet_target(state: State<'_, PetMotion>) {
    *state.target.lock().unwrap() = None;
}

/// 16ms 循环：按目标点原生 SetWindowPos 平滑移动窗口，避免 IPC 掉帧。
/// 目标不可达或窗口隐藏时不动作。
fn spawn_pet_mover(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(16));
        let Some(motion) = app.try_state::<PetMotion>() else {
            continue;
        };
        let Some((tx, ty, speed)) = *motion.target.lock().unwrap() else {
            continue;
        };
        let Some(win) = app.get_webview_window("main") else {
            continue;
        };
        let clamp = !motion.tracking.load(std::sync::atomic::Ordering::Relaxed);
        if screen::move_window_toward(&win, tx, ty, speed, 0.016, clamp) {
            // 到位（或窗口不可见）→ 清除目标，避免空转
            *motion.target.lock().unwrap() = None;
        }
    });
}

/// 置顶看门狗：仅在窗口丢失 WS_EX_TOPMOST 样式时补回。
/// 不周期性无条件重断言 HWND_TOPMOST，避免把 Petra 反复拉到其他置顶窗口
/// （NeXus、任务管理器等）之上，破坏系统置顶层的稳定顺序。
fn spawn_topmost_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let Some(state) = app.try_state::<TopmostState>() else {
            continue;
        };
        if !state.enabled.load(Ordering::SeqCst) {
            continue;
        }
        let Some(win) = app.get_webview_window("main") else {
            continue;
        };
        if !screen::is_topmost(&win) {
            screen::set_topmost(&win, true);
        }
    });
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let outcome = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    outcome.is_ok()
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id("open-control-panel", "控制面板").build(app)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重启").build(app)?;
    let quit_label = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&settings, &separator, &restart, &quit_label])
        .build()?;

    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    let _tray = TrayIconBuilder::with_id("pet-tray")
        .icon(tray_icon)
        .tooltip("Petra")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            // 托盘「设置」：前端 boot 里 listen("open-settings") 会打开设置窗口。
            // 主窗口被隐藏过（设置里点「隐藏」/ 托盘左键隐藏）时，设置窗口会创建在
            // 一个不可见的主窗口里 —— 用户看到的就是「点了没反应」。所以先 show + focus，
            // 与全局快捷键唤起路径（assist_hotkey 回调）保持一致。
            "open-control-panel" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
                let _ = app.emit("open-control-panel", ());
            }
            "restart" => {
                app.restart();
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_window(app);
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        // 最小化的窗口 IsWindowVisible 仍返回 true：以前这里会走 hide()，再点走 show()
        // （SW_SHOW 不恢复最小化状态）—— 表现为「桌宠消失、托盘点了像没反应」，
        // 只能重新运行 exe（单实例回调里才有 unminimize）才能回来。
        let minimized = win.is_minimized().unwrap_or(false);
        if minimized {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        } else if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
}

fn get_window_scale_factor(app: &AppHandle) -> f64 {
    app.get_webview_window("main")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0)
}

/// 唯一的光标穿透决策线程。region 与光标均使用物理客户端坐标。
fn spawn_clickthrough_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut menu_outside_notified = false;
        let mut last_accepts = false; // 光标取不到时的兜底，初始仍按穿透处理
        loop {
            if let Some(win) = app.get_webview_window("main") {
                let cursor = screen::cursor_client_pos(&win);
                let native_dragging = app
                    .try_state::<DragState>()
                    .map(|s| s.active.load(std::sync::atomic::Ordering::Relaxed))
                    .unwrap_or(false);
                let (snapshot, renderer_locked) = app
                    .try_state::<InteractionState>()
                    .map(|state| {
                        (
                            state.snapshot.lock().unwrap().clone(),
                            state
                                .renderer_locked
                                .load(std::sync::atomic::Ordering::Relaxed),
                        )
                    })
                    .unwrap_or_else(|| {
                        (
                            InteractionSnapshot {
                                regions: Vec::new(),
                                initialized: false,
                                last_update: None,
                                viewport_px: None,
                            },
                            false,
                        )
                    });
                let now = std::time::Instant::now();
                let accepts_input = should_accept_input(
                    &snapshot,
                    renderer_locked,
                    native_dragging,
                    cursor,
                    now,
                    last_accepts,
                    screen::client_size(&win).map(|(w, h)| (w as u32, h as u32)),
                );
                last_accepts = accepts_input;
                // Linux：穿透写入口按会话分叉 —— Wayland 直接把"可交互矩形"写进输入区域
                // （合成器只在这些矩形内投递指针事件），X11 仍是原来的整窗开关。
                // 其余平台这一行保持原样。
                #[cfg(target_os = "linux")]
                {
                    // 前端还没上报交互区域、或上报已经过期（渲染线程可能卡住）时，
                    // 区域列表必须当成空：空输入区域 = 整块穿透。宁可少点几下宠物，
                    // 也不能拿旧矩形把 700x700 的透明窗钉在屏幕中间挡住桌面。
                    let fresh = snapshot.initialized
                        && snapshot
                            .last_update
                            .map(|t| now.duration_since(t) <= INTERACTION_STATE_STALE_AFTER)
                            .unwrap_or(false);
                    let regions: Vec<(i32, i32, i32, i32)> = if fresh {
                        snapshot
                            .regions
                            .iter()
                            .filter(|r| r.enabled && r.width > 0 && r.height > 0)
                            .map(|r| (r.x, r.y, r.width, r.height))
                            .collect()
                    } else {
                        Vec::new()
                    };
                    // 渲染锁 / 原生拖拽期间整窗可点，其余情况只让上报的矩形可点。
                    let full_window = renderer_locked || native_dragging;
                    screen::apply_clickthrough(&win, !accepts_input, &regions, full_window);
                }
                #[cfg(not(target_os = "linux"))]
                screen::set_ignore_cursor(&win, !accepts_input);

                // 菜单打开后，光标离开整个主窗口时通知前端关闭菜单。
                let menu_open = app
                    .try_state::<MenuOpen>()
                    .map(|s| s.active.load(std::sync::atomic::Ordering::Relaxed))
                    .unwrap_or(false);
                if menu_open {
                    if let (Some((x, y)), Ok(size)) = (cursor, win.inner_size()) {
                        let outside =
                            x < 0 || y < 0 || x >= size.width as i32 || y >= size.height as i32;
                        if outside && !menu_outside_notified {
                            let _ = win.eval(
                                "document.dispatchEvent(new CustomEvent('menu-hide-request'))",
                            );
                            menu_outside_notified = true;
                        } else if !outside {
                            menu_outside_notified = false;
                        }
                    }
                } else {
                    menu_outside_notified = false;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    });
}

/// 设置指定窗口的位置和大小（物理像素，主窗口待机滑动使用）
#[tauri::command]
fn set_window_pos_size(app: AppHandle, label: String, x: i32, y: i32, width: u32, height: u32) {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
        let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(width, height)));
    }
}

/// 菜单状态只用于生命周期通知，不直接修改窗口样式。
#[tauri::command]
fn set_menu_open(app: AppHandle, open: bool) {
    if let Some(m) = app.try_state::<MenuOpen>() {
        m.active.store(open, std::sync::atomic::Ordering::SeqCst);
    }
    // 菜单打开期间强制接输入：菜单的可点区域虽然上报了，但只要前端卡一下、
    // 区域快照过期，菜单就会变成"点了没反应"。
    if let Some(state) = app.try_state::<InteractionState>() {
        state
            .renderer_locked
            .store(open, std::sync::atomic::Ordering::SeqCst);
        if open {
            if let Ok(mut snapshot) = state.snapshot.lock() {
                snapshot.last_update = Some(std::time::Instant::now());
            }
        }
    }
    log_verbose(&format!("set_menu_open: open={open}"));
}

#[tauri::command]
fn set_interacting(state: State<'_, InteractionState>, active: bool) {
    state
        .renderer_locked
        .store(active, std::sync::atomic::Ordering::SeqCst);
    if active {
        if let Ok(mut snapshot) = state.snapshot.lock() {
            snapshot.last_update = Some(std::time::Instant::now());
        }
    }
    log_verbose(&format!("set_interacting: active={active}"));
}

#[cfg(test)]
mod interaction_tests {
    use super::*;

    fn region(id: &str, x: i32, y: i32, width: i32, height: i32) -> InteractiveRegion {
        InteractiveRegion {
            id: id.into(),
            x,
            y,
            width,
            height,
            enabled: true,
        }
    }

    fn fresh_snapshot(regions: Vec<InteractiveRegion>, now: std::time::Instant) -> InteractionSnapshot {
        InteractionSnapshot {
            regions,
            initialized: true,
            last_update: Some(now),
            viewport_px: None,
        }
    }

    #[test]
    fn point_in_rect_uses_half_open_edges() {
        let regions = [region("pet", 100, 100, 100, 100)];
        assert!(point_in_interactive_regions(100, 100, &regions));
        assert!(point_in_interactive_regions(199, 199, &regions));
        assert!(!point_in_interactive_regions(200, 150, &regions));
        assert!(!point_in_interactive_regions(150, 200, &regions));
    }

    #[test]
    fn multiple_regions_are_a_union_not_a_bounding_box() {
        let regions = [
            region("pet", 100, 100, 100, 100),
            region("menu", 300, 100, 100, 100),
        ];
        assert!(point_in_interactive_regions(150, 150, &regions));
        assert!(point_in_interactive_regions(350, 150, &regions));
        assert!(!point_in_interactive_regions(250, 150, &regions));
    }

    #[test]
    fn disabled_regions_are_ignored() {
        let mut disabled = region("disabled", 10, 10, 50, 50);
        disabled.enabled = false;
        assert!(!point_in_interactive_regions(20, 20, &[disabled]));
    }

    #[test]
    fn uninitialized_state_is_click_through() {
        let now = std::time::Instant::now();
        let snapshot = InteractionSnapshot {
            regions: Vec::new(),
            initialized: false,
            last_update: None,
            viewport_px: None,
        };
        assert!(!should_accept_input(&snapshot, false, false, Some((0, 0)), now, false, None));
    }

    #[test]
    fn stale_state_is_click_through() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(
            vec![region("pet", 100, 100, 100, 100)],
            now - INTERACTION_STATE_STALE_AFTER - std::time::Duration::from_millis(1),
        );
        assert!(!should_accept_input(&snapshot, false, false, Some((0, 0)), now, false, None));
    }

    #[test]
    fn renderer_lock_fails_open() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(Vec::new(), now);
        assert!(should_accept_input(&snapshot, true, false, Some((0, 0)), now, false, None));
    }

    #[test]
    fn native_drag_fails_open() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(Vec::new(), now);
        assert!(should_accept_input(&snapshot, false, true, Some((0, 0)), now, false, None));
    }

    #[test]
    fn cursor_read_failure_is_click_through() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(Vec::new(), now);
        assert!(!should_accept_input(&snapshot, false, false, None, now, false, None));
    }
}



/// 注册（或替换）小助手全局呼出快捷键。
/// shortcut 为 Tauri accelerator 字符串，如 "Ctrl+Shift+A"。
/// 注册成功后，按下该组合会向前端 emit "assistant-hotkey" 事件。
#[tauri::command]
fn register_assistant_shortcut(
    app: AppHandle,
    state: State<'_, AssistantHotkey>,
    shortcut: String,
) -> Result<(), String> {
    let trimmed = shortcut.trim().to_string();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".into());
    }
    // 先解绑上一次注册的快捷键，避免重复注册覆盖不了旧组合
    if let Some(prev) = state.shortcut.lock().unwrap().take() {
        let _ = app.global_shortcut().unregister(prev);
    }
    let sc = Shortcut::from_str(&trimmed).map_err(|e| format!("快捷键格式无效：{e}"))?;
    // on_shortcut 内部已完成注册，不要再先 register 再 on_shortcut，否则会因重复注册失败。
    app.global_shortcut()
        .on_shortcut(sc, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                // 无论窗口被托盘隐藏，还是被其它窗口挡住，都先唤出并拉到前台。
                // 按下快捷键本身是一次键盘输入，Windows 允许本进程把窗口提到最前。
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = app.emit("assistant-hotkey", ());
            }
        })
        .map_err(|e| format!("注册失败（可能已被占用）：{e}"))?;
    *state.shortcut.lock().unwrap() = Some(sc);
    Ok(())
}

/// 解绑小助手全局呼出快捷键（清除设置时调用）。
#[tauri::command]
fn unregister_assistant_shortcut(
    app: AppHandle,
    state: State<'_, AssistantHotkey>,
) -> Result<(), String> {
    if let Some(prev) = state.shortcut.lock().unwrap().take() {
        let _ = app.global_shortcut().unregister(prev);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Linux：WebKitGTK 默认**不允许网页抓麦克风**，这里把这一条放开。
///
/// 两件事缺一不可：
///   1. `enable-media-stream` —— WebKitGTK 默认是关的，关着时 `getUserMedia`
///      连权限请求都不会发出来，直接以失败告终；
///   2. `permission-request` 信号 —— 默认处理是"拒绝"，必须自己接住并 allow，
///      否则同样拿不到音频流。
///
/// 只放行**纯音频**请求：摄像头（is_for_video_device）照旧走 WebKit 的默认处理，
/// 不替用户做主；页面上目前也没有任何地方会请求摄像头。
#[cfg(target_os = "linux")]
fn allow_media_permission(window: &tauri::WebviewWindow) {
    use webkit2gtk::glib::prelude::Cast;
    use webkit2gtk::{
        PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };
    let result = window.with_webview(|wv| {
        let view = wv.inner();
        if let Some(settings) = view.settings() {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|_, req| {
            let Some(media) = req.downcast_ref::<UserMediaPermissionRequest>() else {
                return false; // 其它权限（定位 / 通知 / 指针锁…）交回默认处理
            };
            if media.is_for_audio_device() && !media.is_for_video_device() {
                media.allow();
                true
            } else {
                false
            }
        });
    });
    if let Err(e) = result {
        log_line(&format!("allow_media_permission: 挂权限回调失败: {e}"));
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    // updater 插件在 dev / release 都注册，使 tauri dev 下也能真实测试 check() 网络链路。
    // 开发版禁止实际安装由前端 import.meta.env.DEV 保护（见 UpdateManager.performUpdate）。
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二次启动：把主窗口拉到前台
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AudioState {
            enabled: Arc::new(AtomicBool::new(true)),
        })
        .manage(TopmostState {
            enabled: Arc::new(AtomicBool::new(true)),
        })
        .manage(PetMotion {
            target: std::sync::Mutex::new(None),
            tracking: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(MenuOpen {
            active: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(AssistantHotkey {
            shortcut: std::sync::Mutex::new(None),
        })
        .manage(InteractionState {
            snapshot: std::sync::Mutex::new(InteractionSnapshot {
                regions: Vec::new(),
                initialized: false,
                last_update: None,
                viewport_px: None,
            }),
            renderer_locked: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(DragState {
            active: std::sync::atomic::AtomicBool::new(false),
            offset: std::sync::Mutex::new((0, 0)),
            locked_y: std::sync::Mutex::new(None),
            model_bounds: std::sync::Mutex::new((0, 0, 700, 700)),
        })
        .invoke_handler(tauri::generate_handler![
            trash_files, work_area_at, cursor_pos, hide_pet, set_topmost, is_topmost, show_pet,
            quit_app, restart_app, debug_mark, debug_panic_test, debug_log_error, debug_log_warn, app_heartbeat, read_file_bytes, save_psd,
            export_text_to_desktop,
            read_psd, list_models, read_model_manifest, read_builtin_psd,
            model_resource_path, delete_imported_model, set_audio_enabled,
            set_pet_target, set_pet_target_speed, set_pet_tracking, clear_pet_target,
            drag_start, set_model_bounds, drag_end, set_window_size,
            run_shell, launch_application, open_url, close_web_page, active_window_title,
            create_entry, read_text_file, write_text_file, edit_text_file, list_directory,
            get_idle_seconds, get_system_proxy,
            set_api_key, get_api_key, send_feedback, export_feedback, feedback_text,
            get_autostart, set_autostart, sync_interaction_regions,
            set_interacting, set_menu_open, set_window_pos_size,
            set_volume, send_notification, get_weather, fetch_lyrics,
            list_installed_apps, open_path, lock_screen,
            save_chat_history, load_chat_history,
            schedule_shutdown, cancel_shutdown,
            register_assistant_shortcut, unregister_assistant_shortcut,
            tts_synthesize, set_tts_key, get_tts_key,
            asr_transcribe, set_asr_key, get_asr_key, asr_key_ready, asr_model_name, asr_key_info,
            get_mic_permission, set_mic_permission,
            capture_screen,
            panel::panel_prepare, panel::panel_push_settings, panel::panel_url, panel::panel_running,
        ])
        .setup(|app| {
            let log_dir = LOG_DIR.get_or_init(|| {
                let dir = resolve_log_dir(app.handle());
                // 旧版本把日志放在用户数据目录：第一次启动时搬到「程序根目录/logs」
                if let Ok(legacy) = app.path().app_data_dir() {
                    migrate_old_logs(&legacy.join("logs"), &dir);
                }
                dir
            });
            // ERROR 日志要推给前端弹提示，这里登记 AppHandle
            let _ = LOG_EVENT_HANDLE.set(app.handle().clone());
            // 先归档上次日志再取偏移：顺序不能反，否则偏移会指向已经被归档走的旧文件
            archive_logs(log_dir);
            // 详细日志开关：debug 构建或 PETRA_VERBOSE_LOG=1 时记录高频埋点
            let verbose = verbose_log_enabled();
            VERBOSE_LOG.store(verbose, Ordering::Relaxed);
            // 记录本次启动日志起始偏移（反馈只附本次启动后的日志）
            let offset = std::fs::metadata(log_dir.join("lasted.log"))
                .map(|m| m.len())
                .unwrap_or(0);
            LOG_START_OFFSET.get_or_init(|| offset);
            log_line(&format!(
                "=== pet started v{} ({}{}) ===",
                app.package_info().version,
                if cfg!(debug_assertions) { "debug" } else { "release" },
                if verbose { "，详细日志开" } else { "" }
            ));
            log_environment();

            // 崩溃也要落日志：后端线程 panic 时日志里原本一个字都没有，
            // 只能靠"功能突然不工作"去猜。这里把 panic 内容和文件:行号写进 pet.log，
            // 同时保留默认输出（stderr + RUST_BACKTRACE），不影响原有排查方式。
            {
                let previous = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    let location = info
                        .location()
                        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                        .unwrap_or_else(|| "未知位置".to_string());
                    let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
                        (*s).to_string()
                    } else if let Some(s) = info.payload().downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "非字符串 panic".to_string()
                    };
                    let line = format!("[panic] {payload} @ {location}");
                    // hook 里再 panic 会直接 abort，兜一层
                    let _ = std::panic::catch_unwind(|| log_write_ex("ERROR", false, &line, false));
                    previous(info);
                }));
            }

            // 盲区观测：上次是否正常退出 + 前端心跳看门狗 + 内存采样
            log_previous_run_state();
            spawn_heartbeat_watchdog(app.handle().clone());
            spawn_memory_sampler();
            if let Some((working, private)) = current_memory_mb() {
                log_line(&format!("[mem] 启动时工作集 {working} MB / 私有 {private} MB"));
            }

            // 开发自测：PETRA_PANEL_AUTOSTART=1 时开机就把控制面板服务拉起来，并把带 token
            // 的地址写进日志 —— 这样不用点菜单也能用 curl 验接口（也方便反复调试面板）。
            // 只在 debug 构建里存在，打包版没有这条路径。
            #[cfg(debug_assertions)]
            if std::env::var("PETRA_PANEL_AUTOSTART").ok().as_deref() == Some("1") {
                match panel::ensure_started(app.handle()) {
                    Ok(url) => log_line(&format!("[panel] 控制面板已就绪：{url}")),
                    Err(e) => log_line(&format!("[panel] 控制面板启动失败：{e}")),
                }
            }

            // macOS / Linux：work_area_at 这个命令只有坐标、没有窗口句柄，需要一个
            // AppHandle 才能查显示器工作区，这里先登记一份。
            #[cfg(unix)]
            screen::remember_app(app.handle().clone());

            // Linux：放开 WebKitGTK 的麦克风（语音输入用），必须在页面调用
            // getUserMedia 之前挂好，所以放在 setup 里、窗口刚建出来的时候。
            #[cfg(target_os = "linux")]
            if let Some(win) = app.get_webview_window("main") {
                allow_media_permission(&win);
            }

            let handle = app.handle().clone();
            setup_tray(app)?;
            spawn_clickthrough_watcher(handle.clone());
            spawn_pet_mover(handle.clone());
            spawn_drag_follower(handle.clone());
            // 置顶：先按落盘的选择校准窗口与看门狗状态，再启动看门狗。
            // 顺序不能反 —— 看门狗看到 enabled=true 会立刻把窗口推回置顶。
            let topmost = load_topmost_pref(app.handle()).unwrap_or(true);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_always_on_top(topmost);
                screen::set_topmost(&win, topmost);
            }
            app.state::<TopmostState>()
                .enabled
                .store(topmost, Ordering::SeqCst);
            spawn_topmost_watcher(handle.clone());

            // 正在播放媒体信息（SMTC）：与播放器窗口是否可见无关
            let media_handle = app.handle().clone();
            std::thread::spawn(move || media::start_media_poller(media_handle));

            let state = app.state::<AudioState>();
            let enabled = state.enabled.clone();
            std::thread::spawn(move || audio::start_loopback_capture(handle, enabled));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_handle, event| {
        // 正常退出标记：下次启动据此判断上次是正常关闭还是崩溃/被强杀
        if let tauri::RunEvent::Exit = event {
            log_line("=== pet exit normal ===");
            save_run_state(false);
        }
    });
}

#[cfg(test)]
mod smtp_tests {
    use super::*;

    fn cfg_with(to_email: &str, to_email2: &str) -> SmtpConfig {
        SmtpConfig {
            smtp_server: "smtp.example.com".into(),
            port: 465,
            username: "sender@example.com".into(),
            auth_code: "code".into(),
            to_email: to_email.into(),
            to_email2: to_email2.into(),
        }
    }

    #[test]
    fn single_recipient_goes_into_envelope() {
        let cfg = cfg_with("a@example.com", "");
        let mail = build_feedback_email(&cfg, "s".into(), "b".into()).expect("应能组装");
        let env = mail.envelope();
        assert_eq!(env.to().len(), 1, "只配一个收件人时信封里应只有他");
        assert_eq!(env.to()[0].to_string(), "a@example.com");
        // 空白的第二收件人不能被当成有效地址
        let cfg2 = cfg_with("a@example.com", "   ");
        let mail2 = build_feedback_email(&cfg2, "s".into(), "b".into()).expect("应能组装");
        assert_eq!(mail2.envelope().to().len(), 1);
    }

    #[test]
    fn second_recipient_gets_a_copy_but_is_hidden() {
        let cfg = cfg_with("a@example.com", "b@example.com");
        let mail = build_feedback_email(&cfg, "标题".into(), "正文".into()).expect("应能组装");
        // 信封（= SMTP 的 RCPT TO 列表）里两个人都要有，否则第二个人收不到
        let env = mail.envelope();
        let tos: Vec<String> = env.to().iter().map(|a| a.to_string()).collect();
        assert_eq!(tos.len(), 2, "两个收件人都必须进信封：{tos:?}");
        assert!(tos.contains(&"a@example.com".to_string()));
        assert!(tos.contains(&"b@example.com".to_string()));
        // 但 Bcc 不会出现在正文头里：收件人互相看不到对方地址
        let raw = String::from_utf8_lossy(&mail.formatted()).to_string();
        assert!(raw.contains("a@example.com"), "To 头应保留第一个收件人");
        assert!(!raw.contains("b@example.com"), "Bcc 不应出现在邮件头里");
    }

    #[test]
    fn invalid_recipient_reports_which_one() {
        let cfg = cfg_with("不是邮箱", "");
        let err = build_feedback_email(&cfg, "s".into(), "b".into()).expect_err("应报错");
        assert!(err.contains("不是邮箱"), "错误信息要指出是哪个地址：{err}");
    }

    #[test]
    fn no_recipient_is_an_error() {
        let cfg = cfg_with("", "");
        assert!(build_feedback_email(&cfg, "s".into(), "b".into()).is_err());
    }
}

#[cfg(test)]
mod weather_tests {
    use super::*;

    #[test]
    fn locale_maps_to_expected_country() {
        assert_eq!(locale_expected_country("zh-CN"), Some("China"));
        assert_eq!(locale_expected_country("zh-Hans-CN"), Some("China"));
        assert_eq!(locale_expected_country("en-US"), Some("United States"));
        assert_eq!(locale_expected_country("ja-JP"), Some("Japan"));
        // 认不出的区域不能瞎猜，否则会给用户误报"定位可疑"
        assert_eq!(locale_expected_country("xx-YY"), None);
        assert_eq!(locale_expected_country(""), None);
    }

    #[test]
    fn suspect_when_ip_country_differs_from_locale() {
        // 实测：开着梯子时 wttr.in 按出口 IP 返回 Japan/Tokyo
        assert!(weather_location_suspect("zh-CN", "Japan"));
        assert!(weather_location_suspect("zh-CN", "United States"));
        assert!(!weather_location_suspect("zh-CN", "China"));
        assert!(!weather_location_suspect("en-US", "United States"));
        // 国家拿不到 / 区域认不出时都不判可疑
        assert!(!weather_location_suspect("zh-CN", ""));
        assert!(!weather_location_suspect("xx-YY", "Japan"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧版存的是"一整串 Key"：第一次读到某个供应商时把它领走，之后只属于那个供应商。
    #[test]
    fn api_key_store_adopts_legacy_on_first_read() {
        let mut map = api_key_store_parse("sk-legacy-123");
        // 槽位是空的
        assert_eq!(api_key_store_lookup(&map, "deepseek"), None);
        // 读取时领走
        assert_eq!(api_key_store_adopt_legacy(&mut map, "deepseek").as_deref(), Some("sk-legacy-123"));
        assert_eq!(api_key_store_lookup(&map, "deepseek").as_deref(), Some("sk-legacy-123"));
        // 只领一次：别的供应商拿不到了（不会把旧 Key 发给别家）
        assert_eq!(api_key_store_adopt_legacy(&mut map, "openai"), None);
        assert_eq!(api_key_store_lookup(&map, "openai"), None);
    }

    /// 分供应商保存：互不覆盖，读各自的那一份。
    #[test]
    fn api_key_store_keeps_providers_separate() {
        let mut map = ApiKeyStore::new();
        api_key_store_apply(&mut map, "deepseek", "sk-ds");
        api_key_store_apply(&mut map, "openai", "sk-oa");
        assert_eq!(api_key_store_lookup(&map, "deepseek").as_deref(), Some("sk-ds"));
        assert_eq!(api_key_store_lookup(&map, "openai").as_deref(), Some("sk-oa"));
        assert_eq!(api_key_store_lookup(&map, "qwen"), None);
        // 序列化后能原样读回
        let raw = api_key_store_serialize(&map).unwrap();
        let back = api_key_store_parse(&raw);
        assert_eq!(back, map);
    }

    /// 给某个供应商保存 Key 时**不能**动旧版单 Key：否则用户先配了别家，
    /// 还没被读过的旧 Key 就被永久删了（真实踩过的数据丢失）。
    #[test]
    fn api_key_store_save_never_drops_legacy() {
        let mut map = api_key_store_parse("sk-legacy-123");
        api_key_store_apply(&mut map, "openai", "sk-new");
        assert_eq!(api_key_store_lookup(&map, "openai").as_deref(), Some("sk-new"));
        // legacy 还在，等它自己的供应商来领
        assert_eq!(api_key_store_adopt_legacy(&mut map, "deepseek").as_deref(), Some("sk-legacy-123"));
        assert_eq!(api_key_store_lookup(&map, "deepseek").as_deref(), Some("sk-legacy-123"));
    }

    /// 保存空串 = 清空该供应商的槽位，不影响其它供应商。
    #[test]
    fn api_key_store_clear_only_removes_one_slot() {
        let mut map = ApiKeyStore::new();
        api_key_store_apply(&mut map, "deepseek", "sk-ds");
        api_key_store_apply(&mut map, "openai", "sk-oa");
        api_key_store_apply(&mut map, "deepseek", "   ");
        assert_eq!(api_key_store_lookup(&map, "deepseek"), None);
        assert_eq!(api_key_store_lookup(&map, "openai").as_deref(), Some("sk-oa"));
    }

    /// sanitize_psd_name 必须剥离目录部分并强制 .psd 后缀（路径穿越第一道防线）。
    #[test]
    fn sanitize_strips_directory_and_dots() {
        assert_eq!(sanitize_psd_name(r"..\..\evil.psd"), "evil.psd");
        assert_eq!(sanitize_psd_name("../../evil.psd"), "evil.psd");
        assert_eq!(sanitize_psd_name("seethrough_output_1.psd"), "seethrough_output_1.psd");
        assert!(sanitize_psd_name("model").ends_with(".psd"));
        // 目录部分（正斜杠/反斜杠）一律剥离，只保留文件名——路径穿越防护
        assert_eq!(sanitize_psd_name("a/b/c.psd"), "c.psd");
        assert_eq!(sanitize_psd_name("a\\b\\c.psd"), "c.psd");
    }

    /// 正常删除：模型目录内的 .psd 文件被删除。
    #[test]
    fn delete_removes_psd_file() {
        let dir = std::env::temp_dir().join(format!("pet_delete_test1_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("test_model.psd");
        std::fs::write(&f, b"psd").unwrap();
        let r = delete_model_file(&dir, "test_model.psd");
        assert!(r.is_ok(), "删除应成功: {r:?}");
        assert!(!f.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 非 .psd 后缀被拒绝，文件保留。
    #[test]
    fn delete_rejects_non_psd_and_keeps_file() {
        let dir = std::env::temp_dir().join(format!("pet_delete_test2_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("evil.txt");
        std::fs::write(&f, b"x").unwrap();
        let r = delete_model_file(&dir, "evil.txt");
        assert!(r.is_err());
        assert!(f.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 文件不存在：返回明确错误（幂等，可重试）。
    #[test]
    fn delete_rejects_missing_file() {
        let dir = std::env::temp_dir().join(format!("pet_delete_test3_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let r = delete_model_file(&dir, "missing.psd");
        assert!(r.is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 任意绝对路径：sanitize 会剥离目录只保留文件名，且只在模型目录内解析，
    /// 外部文件绝不可能被删除。
    #[test]
    fn delete_never_touches_outside_file() {
        let dir = std::env::temp_dir().join(format!("pet_delete_test4_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let outside = std::env::temp_dir().join("pet_outside_target.bin");
        std::fs::write(&outside, b"x").unwrap();
        let r = delete_model_file(&dir, &outside.to_string_lossy());
        assert!(r.is_err());
        assert!(outside.exists(), "外部文件不应被删除");
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_file(&outside).ok();
    }

    /// run_shell 白名单校验：换行/控制字符/% /^/; 及链式重定向必须拦截；
    /// 正常查询命令放行（防止 cmd /C 把内嵌换行当语句分隔符执行）。
    /// 这条用 Windows 命令行（ipconfig / dir / type）验证白名单，只在 Windows 上跑。
    #[cfg(windows)]
    #[test]
    fn shell_validation_blocks_newline_and_metachars() {
        assert!(validate_shell_command("ipconfig").is_ok());
        assert!(validate_shell_command("dir C:\\Users\\me").is_ok());
        assert!(validate_shell_command("ping 8.8.8.8 -n 4").is_ok());
        assert!(validate_shell_command("type C:\\secret.txt").is_ok());
        assert!(validate_shell_command("ipconfig\ncalc").is_err(), "换行注入必须拦截");
        assert!(validate_shell_command("echo a\r\nb").is_err(), "CRLF 注入必须拦截");
        assert!(validate_shell_command("echo %PATH%").is_err(), "环境变量展开必须拦截");
        assert!(validate_shell_command("dir ^| type C:\\x").is_err(), "cmd 转义符必须拦截");
        assert!(validate_shell_command("echo a;b").is_err(), "分号必须拦截");
        assert!(validate_shell_command("echo a & calc").is_err(), "链式必须拦截");
        assert!(validate_shell_command("dir | type C:\\x").is_err(), "管道必须拦截");
        assert!(validate_shell_command("shutdown /s").is_err(), "非白名单命令必须拦截");
    }
}

#[cfg(test)]
mod window_state_tests {
    use super::*;

    #[test]
    fn topmost_reads_persisted_bool() {
        assert_eq!(topmost_from_json(r#"{"topmost": false}"#), Some(false));
        assert_eq!(topmost_from_json(r#"{"topmost": true}"#), Some(true));
    }

    #[test]
    fn topmost_missing_or_corrupt_is_none() {
        // 缺字段 / 空文件 / 坏 JSON / 类型不对 → None，不 panic、不误判成置顶
        assert_eq!(topmost_from_json("{}"), None);
        assert_eq!(topmost_from_json(""), None);
        assert_eq!(topmost_from_json("not json"), None);
        assert_eq!(topmost_from_json(r#"{"topmost": "yes"}"#), None);
        // 其它窗口状态字段存在也不影响
        assert_eq!(
            topmost_from_json(r#"{"x": 1, "topmost": false}"#),
            Some(false)
        );
    }
}