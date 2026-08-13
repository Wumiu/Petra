mod audio;
mod launch;
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

/// 拖动状态：开始后由 8ms 线程直接 GetCursorPos 跟随（零每帧 IPC）。
/// locked_y 为待机边缘滑动：y 锁定在该值（物理），只随鼠标水平移动。
pub struct DragState {
    pub active: std::sync::atomic::AtomicBool,
    pub offset: std::sync::Mutex<(i32, i32)>,
    pub locked_y: std::sync::Mutex<Option<i32>>,
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
        screen::drag_follow(&win, off.0, off.1, locked);
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

/// 命令安全校验：拦截危险/破坏性命令与链式多命令，降低 RCE 风险。
fn validate_shell_command(command: &str) -> Result<(), String> {    let lower = command.trim().to_lowercase();
    const DANGEROUS: &[&str] = &[
        "format", "diskpart", "shutdown", "taskkill", "reg delete", "rd /s", "rmdir /s",
        "del /s", "del /f", "deltree", "cipher", "fsutil", "bcdedit", "takeown", "vssadmin",
        "powershell -enc", "mshta", "wscript", "cscript",
    ];
    for d in DANGEROUS {
        if lower.contains(d) {
            return Err(format!("命令被拦截（含危险操作 {d}）"));
        }
    }
    if command.contains('&') || command.contains('|') || command.contains('>') || command.contains('<') {
        return Err("命令被拦截（不允许 & | > < 链式/重定向）".into());
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
        .tooltip("Live2D Pet")
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
        .manage(DragState {
            active: std::sync::atomic::AtomicBool::new(false),
            offset: std::sync::Mutex::new((0, 0)),
            locked_y: std::sync::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            trash_files,
            work_area_at,
            cursor_pos,
            hide_pet,
            show_pet,
            quit_app,
            restart_app,
            debug_mark,
            read_file_bytes,
            save_psd,
            read_psd,
            list_models,
            set_audio_enabled,
            set_pet_target,
            set_pet_target_speed,
            clear_pet_target,
            drag_start,
            drag_end,
            run_shell,
            launch_application,
            open_url,
            active_window_title,
            set_api_key,
            get_api_key,
            send_feedback,
            export_feedback,
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
