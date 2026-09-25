mod audio;
mod launch;
mod media;
mod proxy;
mod screen;
mod trash;

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Windows GUI 子系统中启动控制台程序（powershell/cmd/reg/shutdown）时，
/// 默认会弹出一个新的控制台窗口。加 CREATE_NO_WINDOW 避免窗口闪现。
const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

fn hidden_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW_FLAG);
    cmd
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
}

pub struct InteractionState {
    snapshot: std::sync::Mutex<InteractionSnapshot>,
    renderer_locked: std::sync::atomic::AtomicBool,
}

const INTERACTION_STATE_STALE_AFTER: std::time::Duration =
    std::time::Duration::from_millis(2500);

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

/// 日志文件上限：超过就在启动时轮转成 pet.log.1（只留一份备份）。
/// 之前只增不减，实测一个月就 500KB+，且 74% 是交互噪声。
const LOG_MAX_BYTES: u64 = 1_000_000;
/// 反馈邮件/导出里附带的日志上限（超长只保留开头 + 结尾）
const LOG_ATTACH_MAX_CHARS: usize = 120_000;

/// 本地时间戳：日志是给人看的，用可读时间而不是 unix 秒。
fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 写一行日志：`[时间] [级别] 内容`。verbose 行只在「详细日志」开启时落盘。
fn log_write(level: &str, verbose: bool, s: &str) {
    if verbose && !VERBOSE_LOG.load(Ordering::Relaxed) {
        return;
    }
    println!("[pet-debug][{level}] {s}");
    if let Some(dir) = LOG_DIR.get() {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("pet.log"))
        {
            let _ = writeln!(f, "[{}] [{level}] {s}", stamp());
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
fn log_warn(s: &str) {
    log_write("WARN", false, s);
}

/// 出错了
fn log_error(s: &str) {
    log_write("ERROR", false, s);
}

/// 启动时轮转：pet.log 超过上限就改名成 pet.log.1（覆盖上一份备份）
fn rotate_log(dir: &std::path::Path) {
    let path = dir.join("pet.log");
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size <= LOG_MAX_BYTES {
        return;
    }
    let backup = dir.join("pet.log.1");
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(&path, &backup);
}

/// 「详细日志」开关：默认 debug 构建开、release 关；
/// 需要时可用环境变量 PETRA_VERBOSE_LOG=1 临时打开（support 排查用）。
fn verbose_log_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var("PETRA_VERBOSE_LOG").map(|v| v == "1").unwrap_or(false)
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
    fn rotate_log_only_when_too_big() {
        let dir = std::env::temp_dir().join(format!("petra-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 小文件不轮转
        std::fs::write(dir.join("pet.log"), b"small").unwrap();
        rotate_log(&dir);
        assert!(dir.join("pet.log").exists());
        assert!(!dir.join("pet.log.1").exists());

        // 超过上限则轮转，旧备份被覆盖
        std::fs::write(dir.join("pet.log"), vec![b'a'; (LOG_MAX_BYTES + 1) as usize]).unwrap();
        std::fs::write(dir.join("pet.log.1"), b"old").unwrap();
        rotate_log(&dir);
        assert!(!dir.join("pet.log").exists(), "pet.log 被改名");
        assert_eq!(std::fs::metadata(dir.join("pet.log.1")).unwrap().len(), LOG_MAX_BYTES + 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

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

/// 启动时打印环境信息，帮助定位 WebView2 加载问题。
fn log_environment() {
    log_line(&format!("OS_VAR: {}", std::env::var("OS").unwrap_or_default()));
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
        return false;
    };
    point_in_interactive_regions(x, y, &snapshot.regions)
}

#[tauri::command]
fn sync_interaction_regions(
    state: State<'_, InteractionState>,
    regions: Vec<InteractiveRegion>,
) -> Result<(), String> {
    if regions.len() > 128 {
        return Err("交互区域数量超过上限".into());
    }
    for region in &regions {
        if region.id.is_empty() || region.id.len() > 128 {
            return Err("交互区域 id 无效".into());
        }
        if region.width <= 0 || region.height <= 0 {
            return Err(format!("交互区域尺寸无效: {}", region.id));
        }
        if region.x.unsigned_abs() > 100_000
            || region.y.unsigned_abs() > 100_000
            || region.width > 100_000
            || region.height > 100_000
        {
            return Err(format!("交互区域坐标超出范围: {}", region.id));
        }
    }
    let mut snapshot = state.snapshot.lock().unwrap();
    snapshot.regions = regions;
    snapshot.initialized = true;
    snapshot.last_update = Some(std::time::Instant::now());
    Ok(())
}

#[tauri::command]
fn hide_pet(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn set_topmost(app: AppHandle, state: State<'_, TopmostState>, on: bool) -> bool {
    if let Some(win) = app.get_webview_window("main") {
        // 同步 Tauri 内部标志，避免后续其它窗口操作覆盖
        let _ = win.set_always_on_top(on);
        // 直接 Win32 立即生效
        screen::set_topmost(&win, on);
        state.enabled.store(on, Ordering::SeqCst);
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


#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

fn sanitize_psd_name(name: &str) -> String {
    const MAX_NAME_LEN: usize = 64;
    let base = std::path::Path::new(name)
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

fn models_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
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
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(8));
        let Some(drag) = app.try_state::<DragState>() else {
            continue;
        };
        if !drag.active.load(Ordering::SeqCst) {
            continue;
        }
        let Some(win) = app.get_webview_window("main") else {
            continue;
        };
        let off = *drag.offset.lock().unwrap();
        let locked = *drag.locked_y.lock().unwrap();
        let bounds = *drag.model_bounds.lock().unwrap();
        let scale = get_window_scale_factor(&app);
        screen::drag_follow(&win, off.0, off.1, locked, Some(bounds), scale);
    });
}

/// 小助手主动问候：取当前前台窗口标题 + 进程名，供 AI 判断用户在做什么。
#[tauri::command]
fn active_window_title() -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return String::new();
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

/// 读取 updater 可用的系统代理 URL（只读，不修改系统代理，不记录凭据）。
/// 优先环境变量 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY，其次 WinINET 系统代理。
/// 无代理或失败返回 None，绝不导致启动失败。
#[tauri::command]
fn get_system_proxy() -> Option<String> {
    proxy::get_system_proxy()
}

/// 返回用户空闲秒数（鼠标键盘无输入的时间）。
/// 主动问候场景触发用：空闲太久回来时打招呼、久坐提醒等。
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

/// 用 Windows DPAPI 加密数据（绑定当前用户，无需额外密钥）。
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

fn api_key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("api_key.bin"))
}

/// 存储 API Key（DPAPI 加密到应用数据目录，不明文存 localStorage）。
#[tauri::command]
fn set_api_key(app: AppHandle, api_key: String) -> Result<(), String> {
    let enc = dpapi_protect(api_key.as_bytes())?;
    std::fs::write(api_key_path(&app)?, enc).map_err(|e| e.to_string())
}

/// 读取 API Key（DPAPI 解密）。
#[tauri::command]
fn get_api_key(app: AppHandle) -> Result<String, String> {
    let path = api_key_path(&app)?;
    let enc = std::fs::read(&path).map_err(|_| "未设置 API Key".to_string())?;
    let dec = dpapi_unprotect(&enc)?;
    String::from_utf8(dec).map_err(|e| e.to_string())
}

/// 本次启动日志的起始偏移（setup 时记录 pet.log 现有大小，反馈只取本次启动后的日志）。
static LOG_START_OFFSET: OnceLock<u64> = OnceLock::new();

/// 收集环境信息。
fn collect_env_info(app: &AppHandle) -> String {
    let mut out = String::new();
    out.push_str(&format!("时间: {}\n", chrono_now()));
    out.push_str(&format!("OS: {}\n", std::env::var("OS").unwrap_or_default()));
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
    let path = dir.join("pet.log");
    let Ok(bytes) = std::fs::read(&path) else {
        return "（无日志）\n".into();
    };
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
        }
    }
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

/// 发送反馈邮件：用户问题描述 + 环境信息 + 本次启动日志，直达开发者邮箱。
#[tauri::command]
fn send_feedback(app: AppHandle, message: String) -> Result<String, String> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::transport::smtp::client::{Tls, TlsParameters};
    use lettre::{Message, SmtpTransport, Transport};

    let cfg = SmtpConfig::load();
    let body = compose_feedback_text(&app, &message);
    let subject = format!("[桌宠反馈] v{} {}", app.package_info().version, chrono_now());

    let email = Message::builder()
        .from(
            format!("<{}>", cfg.username)
                .parse::<lettre::message::Mailbox>()
                .map_err(|e| e.to_string())?,
        )
        .to(
            format!("<{}>", cfg.to_email)
                .parse::<lettre::message::Mailbox>()
                .map_err(|e| e.to_string())?,
        )
        .subject(subject)
        .body(body)
        .map_err(|e| e.to_string())?;

    let creds = Credentials::new(cfg.username.clone(), cfg.auth_code.clone());
    let tls_params = TlsParameters::builder(cfg.smtp_server.clone())
        .build()
        .map_err(|e| format!("TLS 参数失败: {e}"))?;
    let mailer = SmtpTransport::builder_dangerous(&cfg.smtp_server)
        .port(cfg.port)
        .tls(Tls::Wrapper(tls_params))
        .credentials(creds)
        .build();

    log_line(&format!(
        "send_feedback: {} -> {} via {}:{}",
        cfg.username, cfg.to_email, cfg.smtp_server, cfg.port
    ));
    match mailer.send(&email) {
        Ok(_) => {
            log_line("send_feedback: 已投递");
            Ok("反馈已发送".into())
        }
        Err(e) => {
            // 失败也要留痕：以前这里只把错误抛给前端，日志里什么都没有，
            // 邮箱授权码失效这种问题完全查不到。
            let raw = e.to_string();
            log_error(&format!("send_feedback 失败（{}:{}）：{raw}", cfg.smtp_server, cfg.port));
            Err(describe_smtp_error(&raw))
        }
    }
}

fn chrono_now() -> String {
    // 毫秒级时间戳，避免同秒多次导出互相覆盖
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("ts{ms}")
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
    let desktop = std::env::var("USERPROFILE")
        .map(|p| std::path::PathBuf::from(p).join("Desktop"))
        .unwrap_or_else(|_| std::env::temp_dir());
    let path = desktop.join(&safe);
    log_line(&format!("导出到桌面: {}", path.display()));
    std::fs::write(&path, text).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 导出反馈文本到桌面文件（含用户描述 + 环境信息 + 本次启动日志），返回文件路径。
#[tauri::command]
fn export_feedback(app: AppHandle, message: String) -> Result<String, String> {
    let text = compose_feedback_text(&app, &message);
    let desktop = std::env::var("USERPROFILE")
        .map(|p| std::path::PathBuf::from(p).join("Desktop"))
        .unwrap_or_else(|_| std::env::temp_dir());
    let name = format!("live2d-pet-反馈_{}.txt", chrono_now());
    let path = desktop.join(&name);
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ==================== 小助手扩展工具 ====================

/// 设置系统音量（0-100），或静音/取消静音。
/// mute=true 设音量为 0（静音），mute=false 恢复到 level（默认 50）。
/// level 和 mute 可同时使用（如 level=30, mute=true → 静音，记住 30）。
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

/// 获取当前天气信息（调用 wttr.in 纯文本接口，无需 API Key）。
/// 发送 Windows 托盘通知（用 NotifyIcon 气泡，不依赖 WinRT AUMID）
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
    crate::log_line(&format!("send_notification: {title} | {body}"));
}

/// 天气查询脚本。`@PROXY@=0` 时绕过系统代理直连。
/// 为什么要直连：开着梯子（系统代理）时 wttr.in 按**出口 IP** 定位，
/// 实测出口在日本时返回的是 Tokyo/Sarugakcho —— 信息板就会显示梯子地区的天气。
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

/// 查询参数百分号编码（避免引入额外依赖；只用于歌词接口的 query string）
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
                    "[lyrics] 直连未取到（enc={} errs={}），改用系统代理重试：{t} - {a}",
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
            crate::log_error(&format!("[lyrics] 取歌词失败 {t} - {a}（{mode}）：{detail}"));
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
            "[lyrics] {t} - {a} → {} 字节，{}，来源{}（{mode}，命中 {} 条）",
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
/// 列出开始菜单里可启动的软件（供小助手回答"你能打开什么"并按正确名称调用）
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

/// 用系统默认程序打开文件或文件夹（路径必须存在，避免误开未知目标）
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

/// 锁定屏幕
#[tauri::command]
fn lock_screen() -> Result<String, String> {
    hidden_command("rundll32.exe")
        .args(["user32.dll,LockWorkStation"])
        .spawn()
        .map_err(|e| format!("锁屏失败: {e}"))?;
    Ok("已锁屏".to_string())
}

/// 定时关机（分钟后）。
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

/// 命令安全校验：白名单模式，只允许已知安全的查询类命令。
/// 打开软件请走 `launch_application`，不需要 shell。
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

/// 小助手 shell 调用：执行命令（chcp 65001 切 UTF-8 避免中文乱码），返回输出；
/// 15s 超时并强制终止子进程。仅由前端在用户确认气泡允许后调用。
/// 注意：普通“打开软件”请求应走 launch_application，不要用本命令。
#[tauri::command]
fn run_shell(command: String) -> Result<String, String> {
    use std::io::Read;
    use std::time::Duration;

    validate_shell_command(&command)?;
    log_line(&format!("run_shell: {command}"));
    // chcp 65001 切 UTF-8 代码页，避免 cmd 内置命令 GBK 输出乱码
    let full = format!("chcp 65001>nul & {command}");
    let mut child = hidden_command("cmd")
        .args(["/C", &full])
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
    let toggle = MenuItemBuilder::with_id("toggle", "显示 / 隐藏 (Alt+P)")
        .accelerator("Alt+P")
        .build(app)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重启").build(app)?;
    let quit_label = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle, &separator, &restart, &quit_label])
        .build()?;

    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    let _tray = TrayIconBuilder::with_id("pet-tray")
        .icon(tray_icon)
        .tooltip("Petra")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_window(app),
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
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
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
                            },
                            false,
                        )
                    });
                let accepts_input = should_accept_input(
                    &snapshot,
                    renderer_locked,
                    native_dragging,
                    cursor,
                    std::time::Instant::now(),
                );
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
        };
        assert!(!should_accept_input(&snapshot, false, false, Some((0, 0)), now));
    }

    #[test]
    fn stale_state_is_click_through() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(
            vec![region("pet", 100, 100, 100, 100)],
            now - INTERACTION_STATE_STALE_AFTER - std::time::Duration::from_millis(1),
        );
        assert!(!should_accept_input(&snapshot, false, false, Some((0, 0)), now));
    }

    #[test]
    fn renderer_lock_fails_open() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(Vec::new(), now);
        assert!(should_accept_input(&snapshot, true, false, Some((0, 0)), now));
    }

    #[test]
    fn native_drag_fails_open() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(Vec::new(), now);
        assert!(should_accept_input(&snapshot, false, true, Some((0, 0)), now));
    }

    #[test]
    fn cursor_read_failure_is_click_through() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(Vec::new(), now);
        assert!(!should_accept_input(&snapshot, false, false, None, now));
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
pub fn run() {
    let builder = tauri::Builder::default();
    // updater 插件在 dev / release 都注册，使 tauri dev 下也能真实测试 check() 网络链路。
    // 开发版禁止实际安装由前端 import.meta.env.DEV 保护（见 UpdateManager.performUpdate）。
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
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
            quit_app, restart_app, debug_mark, read_file_bytes, save_psd,
            export_text_to_desktop,
            read_psd, list_models, read_model_manifest, read_builtin_psd,
            model_resource_path, delete_imported_model, set_audio_enabled,
            set_pet_target, set_pet_target_speed, set_pet_tracking, clear_pet_target,
            drag_start, set_model_bounds, drag_end, set_window_size,
            run_shell, launch_application, open_url, active_window_title,
            get_idle_seconds, get_system_proxy,
            set_api_key, get_api_key, send_feedback, export_feedback, feedback_text,
            get_autostart, set_autostart, sync_interaction_regions,
            set_interacting, set_menu_open, set_window_pos_size,
            set_volume, send_notification, get_weather, fetch_lyrics,
            list_installed_apps, open_path, lock_screen,
            schedule_shutdown, cancel_shutdown,
            register_assistant_shortcut, unregister_assistant_shortcut,
        ])
        .setup(|app| {
            let log_dir = LOG_DIR.get_or_init(|| {
                let dir = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("pet-logs"))
                    .join("logs");
                let _ = std::fs::create_dir_all(&dir);
                dir
            });
            // 先轮转再取偏移：顺序不能反，否则偏移会指向已经被改名走的旧文件
            rotate_log(log_dir);
            // 详细日志开关：debug 构建或 PETRA_VERBOSE_LOG=1 时记录高频埋点
            let verbose = verbose_log_enabled();
            VERBOSE_LOG.store(verbose, Ordering::Relaxed);
            // 记录本次启动日志起始偏移（反馈只附本次启动后的日志）
            let offset = std::fs::metadata(log_dir.join("pet.log"))
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

            let handle = app.handle().clone();
            setup_tray(app)?;
            spawn_clickthrough_watcher(handle.clone());
            spawn_pet_mover(handle.clone());
            spawn_drag_follower(handle.clone());
            spawn_topmost_watcher(handle.clone());

            // 正在播放媒体信息（SMTC）：与播放器窗口是否可见无关
            let media_handle = app.handle().clone();
            std::thread::spawn(move || media::start_media_poller(media_handle));

            let state = app.state::<AudioState>();
            let enabled = state.enabled.clone();
            std::thread::spawn(move || audio::start_loopback_capture(handle, enabled));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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



