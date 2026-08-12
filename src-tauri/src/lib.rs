mod audio;
mod screen;
mod trash;

use serde::Serialize;
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
fn cursor_pos() -> CursorPos {
    screen::cursor_pos()
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

fn sanitize_psd_name(name: &str) -> String {
    const MAX_NAME_LEN: usize = 64;
    let base = std::path::Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let clean: String = base
        .chars()
        .take(MAX_NAME_LEN)
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
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
        screen::move_window_toward(&win, tx, ty, speed, 0.016);
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
    let quit_label = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&toggle, &separator, &quit_label])
        .build()?;

    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    let _tray = TrayIconBuilder::with_id("pet-tray")
        .icon(tray_icon)
        .tooltip("Live2D Pet")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_window(app),
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

/// 每 16ms 轮询光标位置，光标进入窗口矩形时取消点击穿透（可交互），
/// 离开时恢复 WS_EX_TRANSPARENT。16ms 保证拖文件划过窗口时及时响应。
fn spawn_clickthrough_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(win) = app.get_webview_window("main") {
            screen::keep_clickthrough_synced(&win);
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Rust panic 也进诊断通道
    std::panic::set_hook(Box::new(|info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        log_line(&format!("PANIC: {loc} {info}"));
    }));

    tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![
            trash_files,
            work_area_at,
            cursor_pos,
            hide_pet,
            show_pet,
            quit_app,
            debug_mark,
            read_file_bytes,
            save_psd,
            read_psd,
            list_models,
            set_audio_enabled,
            set_pet_target,
            set_pet_target_speed,
            clear_pet_target,
            get_autostart,
            set_autostart,
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
            log_line("=== pet started ===");
            log_environment();

            let handle = app.handle().clone();
            setup_tray(app)?;
            spawn_clickthrough_watcher(handle.clone());
            spawn_pet_mover(handle.clone());

            if let Some(win) = app.get_webview_window("main") {
                spawn_diag_probe(win);
            }

            let state = app.state::<AudioState>();
            let enabled = state.enabled.clone();
            std::thread::spawn(move || audio::start_loopback_capture(handle, enabled));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}