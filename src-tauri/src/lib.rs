mod audio;
mod launch;
mod screen;
mod trash;

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

pub struct AudioState {
    pub enabled: Arc<AtomicBool>,
}

/// 窗口移动目标：前端只发目标点（10Hz），Rust 线程原生平滑移动（60fps）。
/// (x, y, speed)：speed 为移动速度 px/s（漫游 340，拖动 3000）。
pub struct PetMotion {
    pub target: std::sync::Mutex<Option<(f64, f64, f64)>>,
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

/// 诊断通道：stdout（tauri dev 可见）+ 日志文件（打包后兜底）。
fn log_line(s: &str) {
    println!("[pet-debug] {s}");
    if let Some(dir) = LOG_DIR.get() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("pet.log"))
        {
            let _ = writeln!(f, "[{ts}] {s}");
        }
    }
}

fn read_reg_value(subkey: &str, value: &str) -> String {
    std::process::Command::new("reg")
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
    log_line(&format!("WinINET ProxyEnable: {sys}"));
    log_line(&format!(
        "HTTP_PROXY env: '{}'",
        std::env::var("HTTP_PROXY").unwrap_or_default()
    ));
    log_line(&format!(
        "HTTPS_PROXY env: '{}'",
        std::env::var("HTTPS_PROXY").unwrap_or_default()
    ));
    log_line(&format!(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '{}'",
        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default()
    ));
    if let Some(dir) = LOG_DIR.get() {
        log_line(&format!("LOG_DIR: {}", dir.display()));
    }
}

/// 诊断探针：延时注入 JS，把 WebView2 视角的加载状态打回日志。
/// 报告 __BOOT__ / readyState / #dbg 文本 / 资源加载摘要（transferSize=0 = 拿到 200 但无内容）。
fn spawn_diag_probe(win: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        for delay in [3u64, 10, 20] {
            std::thread::sleep(std::time::Duration::from_secs(delay));
            let js = concat!(
                "window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke('debug_mark',",
                "{msg: 'PROBE:' + JSON.stringify({boot: !!window.__BOOT__, state: document.readyState,",
                " title: document.title, dbg: (document.getElementById('dbg')||{}).textContent || '',",
                " scripts: [].map.call(document.scripts, function(s){return (s.type||'?')+':'+(s.src.split('/').pop()||'inline');}),",
                " res: performance.getEntriesByType('resource').slice(-14).map(function(e){",
                " return (e.transferSize===0?'ZERO':'ok')+':'+(e.name.split('/').pop()||e.name)+':'+Math.round(e.duration)+'ms';})}})}"
            );
            if let Err(e) = win.eval(js) {
                log_line(&format!("PROBE EVAL FAILED({delay}s): {e}"));
            } else {
                log_line(&format!("PROBE EVAL OK({delay}s)"));
            }
        }
    });
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
    if !snapshot.initialized || renderer_locked || native_dragging {
        return true;
    }
    let Some(last_update) = snapshot.last_update else {
        return true;
    };
    if now.duration_since(last_update) > INTERACTION_STATE_STALE_AFTER {
        return true;
    }
    let Some((x, y)) = cursor else {
        return true;
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
            log_line(&format!("read_model_manifest: {}", p.display()));
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
            log_line(&format!("model_resource_path: {file} -> {}", p.display()));
            return Ok(p.to_string_lossy().to_string());
        }
    }
    log_line(&format!("model_resource_path: {file} 未找到，尝试: {}", tried.join("; ")));
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
            log_line(&format!("delete_imported_model: 删除 {file_name} 失败: {e}"));
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
fn set_pet_target_speed(state: State<'_, PetMotion>, x: f64, y: f64, speed: f64) {
    *state.target.lock().unwrap() = Some((x, y, speed.max(100.0)));
}

/// 更新拖拽时的模型边界（前端每帧调用，用于拖拽时夹紧窗口不让模型出屏）
#[tauri::command]
fn set_model_bounds(state: State<'_, DragState>, left: i32, top: i32, right: i32, bottom: i32) {
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
            log_line(&format!(
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
        log_line("drag:end");
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
    String::from_utf8_lossy(&bytes[start..]).to_string()
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
                58, 117, 27, 44, 2, 37, 40, 21, 19, 15, 53, 6, 16, 73, 34, 42,
            ]),
            to_email: xdecrypt(&[
                65, 10, 69, 110, 65, 91, 65, 71, 103, 94, 37, 0, 18, 81, 12, 63, 79,
            ]),
        }
    }
}

/// 发送反馈邮件：用户问题描述 + 环境信息 + 本次启动日志，直达开发者邮箱。
#[tauri::command]
fn send_feedback(app: AppHandle, message: String) -> Result<String, String> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::transport::smtp::client::{Tls, TlsParameters};
    use lettre::{Message, SmtpTransport, Transport};

    let cfg = SmtpConfig::load();
    let msg = message.trim();
    let body = format!(
        "用户反馈：\n{}\n\n{}\n=== 本次启动日志 ===\n{}",
        if msg.is_empty() { "（未填写问题描述）" } else { msg },
        collect_env_info(&app),
        collect_session_log(),
    );
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
        Ok(_) => Ok("反馈已发送".into()),
        Err(e) => Err(format!("发送失败: {e}")),
    }
}

fn chrono_now() -> String {
    // 简单时间戳，避免额外依赖
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("ts{secs}")
}

/// 导出反馈文本到桌面文件（含用户描述 + 环境信息 + 本次启动日志），返回文件路径。
#[tauri::command]
fn export_feedback(app: AppHandle, message: String) -> Result<String, String> {
    let text = format!(
        "用户反馈：\n{}\n\n{}\n=== 本次启动日志 ===\n{}",
        if message.trim().is_empty() { "（未填写问题描述）" } else { message.trim() },
        collect_env_info(&app),
        collect_session_log()
    );
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
    let _ = std::process::Command::new("powershell")
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
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    crate::log_line(&format!("send_notification: {title} | {body}"));
}

#[tauri::command]
fn get_weather() -> Result<String, String> {
    use std::io::Read;
    // 用 wttr.in JSON API 获取详细天气数据
    let mut child = std::process::Command::new("powershell")
        .args([
            "-NoProfile", "-Command",
            r#"try {
                $r = Invoke-WebRequest -Uri 'https://wttr.in/?format=j1&lang=zh' -TimeoutSec 10 -UseBasicParsing;
                $j = $r.Content | ConvertFrom-Json;
                $c = $j.current_condition[0];
                $w = $j.weather[0];
                $loc = $j.nearest_area[0].areaName[0].value;
                $desc = $c.weatherDesc[0].value;
                $temp = $c.temp_C;
                $max = $w.maxtempC;
                $min = $w.mintempC;
                $rain = $w.hourly[4].chanceofrain; # 中午时段降雨概率
                "$loc|$desc|$temp|$max|$min|$rain"
            } catch { "获取失败|天气获取失败|—|—|—|—" }"#,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动失败: {e}"))?;
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    let _ = child.wait();
    Ok(out.trim().to_string())
}

/// 定时关机（分钟后）。
#[tauri::command]
fn schedule_shutdown(minutes: u32) -> Result<String, String> {
    if minutes == 0 || minutes > 1440 {
        return Err("时间范围：1~1440 分钟".into());
    }
    let secs = minutes * 60;
    let output = std::process::Command::new("shutdown")
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
    let output = std::process::Command::new("shutdown")
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
    let mut child = std::process::Command::new("cmd")
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
        if screen::move_window_toward(&win, tx, ty, speed, 0.016) {
            // 到位（或窗口不可见）→ 清除目标，避免空转
            *motion.target.lock().unwrap() = None;
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
    log_line(&format!("set_menu_open: open={open}"));
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
    log_line(&format!("set_interacting: active={active}"));
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
    fn uninitialized_state_fails_open() {
        let now = std::time::Instant::now();
        let snapshot = InteractionSnapshot {
            regions: Vec::new(),
            initialized: false,
            last_update: None,
        };
        assert!(should_accept_input(&snapshot, false, false, Some((0, 0)), now));
    }

    #[test]
    fn stale_state_fails_open() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(
            vec![region("pet", 100, 100, 100, 100)],
            now - INTERACTION_STATE_STALE_AFTER - std::time::Duration::from_millis(1),
        );
        assert!(should_accept_input(&snapshot, false, false, Some((0, 0)), now));
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
    fn cursor_read_failure_fails_open() {
        let now = std::time::Instant::now();
        let snapshot = fresh_snapshot(Vec::new(), now);
        assert!(should_accept_input(&snapshot, false, false, None, now));
    }
}



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(not(debug_assertions))]
    { builder = builder.plugin(tauri_plugin_updater::Builder::new().build()); }
    builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AudioState {
            enabled: Arc::new(AtomicBool::new(true)),
        })
        .manage(PetMotion {
            target: std::sync::Mutex::new(None),
        })
        .manage(MenuOpen {
            active: std::sync::atomic::AtomicBool::new(false),
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
            trash_files, work_area_at, cursor_pos, hide_pet, show_pet,
            quit_app, restart_app, debug_mark, read_file_bytes, save_psd,
            read_psd, list_models, read_model_manifest, read_builtin_psd,
            model_resource_path, delete_imported_model, set_audio_enabled,
            set_pet_target, set_pet_target_speed, clear_pet_target,
            drag_start, set_model_bounds, drag_end, set_window_size,
            run_shell, launch_application, open_url, active_window_title,
            get_idle_seconds,
            set_api_key, get_api_key, send_feedback, export_feedback,
            get_autostart, set_autostart, sync_interaction_regions,
            set_interacting, set_menu_open, set_window_pos_size,
            set_volume, send_notification, get_weather,
            schedule_shutdown, cancel_shutdown,
        ])
        .setup(|app| {
            LOG_DIR.get_or_init(|| {
                let dir = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("pet-logs"))
                    .join("logs");
                let _ = std::fs::create_dir_all(&dir);
                dir
            });
            // 记录本次启动日志起始偏移（反馈只附本次启动后的日志）
            let offset = LOG_DIR
                .get()
                .and_then(|d| std::fs::metadata(d.join("pet.log")).ok().map(|m| m.len()))
                .unwrap_or(0);
            LOG_START_OFFSET.get_or_init(|| offset);
            log_line("=== pet started ===");
            log_environment();

            let handle = app.handle().clone();
            setup_tray(app)?;
            spawn_clickthrough_watcher(handle.clone());
            spawn_pet_mover(handle.clone());
            spawn_drag_follower(handle.clone());

            if cfg!(debug_assertions) {
                if let Some(win) = app.get_webview_window("main") {
                    spawn_diag_probe(win);
                }
            }

            let state = app.state::<AudioState>();
            let enabled = state.enabled.clone();
            std::thread::spawn(move || audio::start_loopback_capture(handle, enabled));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
}






