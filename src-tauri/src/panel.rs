//! 控制面板：内置的本地 HTTP 服务 + 浏览器页面。
//!
//! 为什么是「自己写个最小 HTTP 服务」而不是引 axum/actix：
//! 本项目只用标准库就能完成 GET/POST + JSON，加一个 web 框架会给三平台构建都添
//! 一堆新 crate（构建机还得能联网拉）。这里总共不到 300 行，够用且零新依赖。
//!
//! 数据流（**单一事实源仍在 WebView 的 localStorage**）：
//!   WebView ──panel_push_settings──▶ Rust 内存副本 ──GET /api/state──▶ 浏览器页面
//!   浏览器页面 ──POST /api/settings──▶ Rust 深合并 ──emit("panel:apply")──▶ WebView 应用改动
//!   浏览器页面 ──POST /api/action────▶ Rust ──emit("panel:action")──────▶ WebView 跑原菜单回调
//! 这样面板既能「填参数」，也能复用右键菜单那套已经在跑的功能项，不用在前端重写一遍。
//!
//! 安全：只绑 127.0.0.1；每次启动随机 token（URL 片段 #t= 传入，不落服务端日志），
//! 除首页 HTML 外的所有接口都要求 `x-panel-token` 头与 token 一致。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// 面板页面（单文件，随二进制一起内嵌；改完页面要重新编译 Rust）
const PANEL_HTML: &str = include_str!("../panel/index.html");

/// 首选端口：固定好记，用户还能收藏；被占用时退回系统分配
const PREFERRED_PORT: u16 = 47188;

struct Panel {
    port: u16,
    token: String,
    /// WebView 最近一次推上来的完整设置（面板读取的就是这份）
    settings: Mutex<Value>,
    /// 面板要渲染的元数据：版本、模型列表、动作清单等
    meta: Mutex<Value>,
    seq: Mutex<u64>,
}

static PANEL: OnceLock<Arc<Panel>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

fn make_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ nanos;
    for b in std::process::id().to_le_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^= nanos.rotate_left(17);
    format!("{:016x}", h)
}

/// 启动（或复用）面板服务，返回浏览器要打开的完整 URL。
pub fn ensure_started(app: &AppHandle) -> Result<String, String> {
    let _ = APP.set(app.clone());
    if let Some(p) = PANEL.get() {
        return Ok(format!("http://127.0.0.1:{}/#t={}", p.port, p.token));
    }

    let listener = TcpListener::bind(("127.0.0.1", PREFERRED_PORT))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| format!("控制面板端口绑定失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("取端口失败：{e}"))?
        .port();

    let panel = Arc::new(Panel {
        port,
        token: make_token(),
        settings: Mutex::new(json!({})),
        meta: Mutex::new(json!({})),
        seq: Mutex::new(0),
    });
    // 已存在时 set 会失败 —— 说明另一个线程先抢到了，用那一份就行
    if PANEL.set(panel.clone()).is_err() {
        if let Some(p) = PANEL.get() {
            return Ok(format!("http://127.0.0.1:{}/#t={}", p.port, p.token));
        }
    }

    // 告诉前端「服务起来了，该把当前设置推上来了」。
    // 注意时序：setup 里（开机自启的调试路径）发这条时页面还没注册监听，会丢；
    // 所以前端 boot 还会主动 invoke 一次 panel_running 兜底。
    if let Some(app) = APP.get() {
        let _ = app.emit("panel:ready", json!({ "port": port }));
    }

    let thread_panel = panel.clone();
    std::thread::Builder::new()
        .name("petra-control-panel".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let p = thread_panel.clone();
                // 每连接一个线程：面板只有本地一个浏览器在用，连接数个位数
                std::thread::spawn(move || {
                    let _ = handle_conn(stream, &p);
                });
            }
        })
        .map_err(|e| format!("控制面板线程启动失败：{e}"))?;

    Ok(format!("http://127.0.0.1:{}/#t={}", port, panel.token))
}

fn handle_conn(mut stream: TcpStream, panel: &Panel) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let mut parts = line.trim_end().split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let target = parts.next().unwrap_or("/").to_string();

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    let query = parse_query(&query);

    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut l = String::new();
        if reader.read_line(&mut l)? == 0 {
            break;
        }
        let t = l.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some((k, v)) = t.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    // 上限 96MB：面板传 PSD 模型时是整份二进制直接 POST 上来的
    const MAX_BODY: usize = 96 * 1024 * 1024;
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return json_resp(&mut stream, 413, json!({"ok": false, "error": "文件太大"}));
    }
    let mut body_bytes = vec![0u8; len];
    if !body_bytes.is_empty() {
        reader.read_exact(&mut body_bytes)?;
    }
    let body = String::from_utf8_lossy(&body_bytes).to_string();

    // 首页不校验 token（浏览器导航没法带自定义头）；它本身不含任何数据
    if path == "/" || path == "/index.html" {
        return respond(&mut stream, 200, "text/html; charset=utf-8", PANEL_HTML.as_bytes(), true);
    }
    if path == "/favicon.ico" {
        return respond(&mut stream, 204, "text/plain", b"", false);
    }

    let given = headers
        .get("x-panel-token")
        .cloned()
        .or_else(|| query.get("t").cloned())
        .unwrap_or_default();
    if given != panel.token {
        return respond(
            &mut stream,
            401,
            "application/json; charset=utf-8",
            br#"{"ok":false,"error":"token"}"#,
            false,
        );
    }

    match (method.as_str(), path.as_str()) {
        ("GET", "/api/ping") => {
            let seq = *panel.seq.lock().unwrap();
            json_resp(&mut stream, 200, json!({"ok": true, "seq": seq}))
        }
        ("GET", "/api/state") => {
            let seq = *panel.seq.lock().unwrap();
            let settings = panel.settings.lock().unwrap().clone();
            let meta = panel.meta.lock().unwrap().clone();
            json_resp(
                &mut stream,
                200,
                json!({"ok": true, "seq": seq, "settings": settings, "meta": meta}),
            )
        }
        ("POST", "/api/settings") => {
            let parsed: Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(e) => {
                    return json_resp(&mut stream, 400, json!({"ok": false, "error": e.to_string()}))
                }
            };
            // 允许两种形状：{"patch":{...}} 或直接就是补丁对象
            let patch = parsed.get("patch").cloned().unwrap_or(parsed);
            {
                let mut settings = panel.settings.lock().unwrap();
                deep_merge(&mut settings, &patch);
            }
            let seq = {
                let mut s = panel.seq.lock().unwrap();
                *s += 1;
                *s
            };
            if let Some(app) = APP.get() {
                let _ = app.emit("panel:apply", json!({ "patch": patch, "seq": seq }));
            }
            json_resp(&mut stream, 200, json!({"ok": true, "seq": seq}))
        }
        ("POST", "/api/import") => {
            // 浏览器里选中的 PSD：直接二进制 POST 上来，落到与「拖进窗口」完全相同的目录，
            // 然后由前端走一遍正常的切换/重载流程（不在 Rust 里碰 localStorage）。
            let name = query.get("name").cloned().unwrap_or_default();
            if !name.to_ascii_lowercase().ends_with(".psd") || body_bytes.is_empty() {
                return json_resp(&mut stream, 400, json!({"ok": false, "error": "只支持 .psd 文件"}));
            }
            let Some(app) = APP.get() else {
                return json_resp(&mut stream, 500, json!({"ok": false, "error": "桌宠已退出"}));
            };
            let file_name = crate::sanitize_psd_name(&name);
            let dir = match crate::models_dir(app) {
                Ok(d) => d,
                Err(e) => return json_resp(&mut stream, 500, json!({"ok": false, "error": e})),
            };
            if let Err(e) = std::fs::write(dir.join(&file_name), &body_bytes) {
                return json_resp(&mut stream, 500, json!({"ok": false, "error": e.to_string()}));
            }
            let _ = app.emit("panel:model-imported", json!({ "name": file_name }));
            json_resp(&mut stream, 200, json!({"ok": true, "name": file_name}))
        }
        ("POST", "/api/action") => {
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let Some(id) = parsed.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
                return json_resp(&mut stream, 400, json!({"ok": false, "error": "missing id"}));
            };
            // payload：面板带参数的动作（填 API Key、发反馈、录快捷键…）都靠它把值送到前端
            let payload = parsed.get("payload").cloned().unwrap_or(Value::Null);
            if let Some(app) = APP.get() {
                let _ = app.emit("panel:action", json!({ "id": id, "payload": payload }));
            }
            json_resp(&mut stream, 200, json!({"ok": true}))
        }
        _ => json_resp(&mut stream, 404, json!({"ok": false, "error": "not found"})),
    }
}

fn json_resp(stream: &mut TcpStream, status: u16, v: Value) -> std::io::Result<()> {
    let body = v.to_string();
    respond(
        stream,
        status,
        "application/json; charset=utf-8",
        body.as_bytes(),
        false,
    )
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    ctype: &str,
    body: &[u8],
    no_store: bool,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "OK",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if no_store {
        head.push_str("Cache-Control: no-store\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn parse_query(q: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in q.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(k.to_string(), v.to_string());
    }
    map
}

/// JSON 深合并：对象递归、其余类型直接覆盖（数组整体替换）
fn deep_merge(dst: &mut Value, patch: &Value) {
    match (dst, patch) {
        (Value::Object(d), Value::Object(p)) => {
            for (k, v) in p {
                deep_merge(d.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (d, p) => *d = p.clone(),
    }
}

// ==================== Tauri 命令 ====================

/// 启动面板服务并返回地址；真正打开浏览器由前端调 open_url（
/// 这样托盘、右键菜单、快捷键三条入口共用同一段前端逻辑，失败时还能回退到内置设置窗）。
#[tauri::command]
pub fn panel_prepare(app: AppHandle) -> Result<String, String> {
    ensure_started(&app)
}

/// 前端把最新设置与元数据推上来（面板每次读的都是这份）
#[tauri::command]
pub fn panel_push_settings(settings: String, meta: Option<String>) -> Result<(), String> {
    let Some(panel) = PANEL.get() else {
        // 面板没起来就还没人看，不用留副本
        return Ok(());
    };
    let parsed: Value = serde_json::from_str(&settings).map_err(|e| format!("设置不是合法 JSON：{e}"))?;
    *panel.settings.lock().unwrap() = parsed;
    if let Some(meta) = meta {
        if let Ok(v) = serde_json::from_str::<Value>(&meta) {
            *panel.meta.lock().unwrap() = v;
        }
    }
    Ok(())
}

/// 面板服务是否已经起来（返回端口）；前端 boot 用它决定要不要补一次「推设置」
#[tauri::command]
pub fn panel_running() -> Option<u16> {
    PANEL.get().map(|p| p.port)
}

/// 面板当前地址（不开浏览器）；已启动时给回同一个 URL
#[tauri::command]
pub fn panel_url(app: AppHandle) -> Result<String, String> {
    ensure_started(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    fn new_panel(token: &str) -> Arc<Panel> {
        Arc::new(Panel {
            port: 0,
            token: token.to_string(),
            settings: Mutex::new(json!({"modelScale": 1.0, "tts": {"enabled": false}})),
            meta: Mutex::new(json!({"version": "test"})),
            seq: Mutex::new(0),
        })
    }

    /// 起一次性服务器（只接一个连接），返回端口
    fn serve_once(panel: Arc<Panel>) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                let _ = handle_conn(stream, &panel);
            }
        });
        port
    }

    fn request(port: u16, raw: &str) -> String {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = Read::read_to_string(&mut c, &mut out);
        out
    }

    #[test]
    fn serves_panel_html_without_token() {
        let port = serve_once(new_panel("abc"));
        let res = request(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(res.starts_with("HTTP/1.1 200"), "{res}");
        assert!(res.contains("PETRA"));
    }

    #[test]
    fn rejects_api_without_token() {
        let port = serve_once(new_panel("abc"));
        let res = request(port, "GET /api/state HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(res.starts_with("HTTP/1.1 401"), "{res}");
    }

    #[test]
    fn returns_state_with_token() {
        let port = serve_once(new_panel("abc"));
        let res = request(
            port,
            "GET /api/state HTTP/1.1\r\nHost: x\r\nx-panel-token: abc\r\n\r\n",
        );
        assert!(res.starts_with("HTTP/1.1 200"), "{res}");
        assert!(res.contains("\"modelScale\":1.0"), "{res}");
        assert!(res.contains("\"version\":\"test\""), "{res}");
    }

    #[test]
    fn patch_is_deep_merged_and_bumps_seq() {
        let panel = new_panel("abc");
        let port = serve_once(panel.clone());
        let body = r#"{"patch":{"tts":{"enabled":true}}}"#;
        let res = request(
            port,
            &format!(
                "POST /api/settings HTTP/1.1\r\nHost: x\r\nx-panel-token: abc\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            ),
        );
        assert!(res.starts_with("HTTP/1.1 200"), "{res}");
        // 深合并：只改 tts.enabled，别的键与 tts 的其它键都还在
        let stored = panel.settings.lock().unwrap().clone();
        assert_eq!(stored["tts"]["enabled"], json!(true));
        assert_eq!(stored["modelScale"], json!(1.0));
        assert_eq!(*panel.seq.lock().unwrap(), 1);
    }

    #[test]
    fn action_requires_id() {
        let port = serve_once(new_panel("abc"));
        let body = "{}";
        let res = request(
            port,
            &format!(
                "POST /api/action HTTP/1.1\r\nHost: x\r\nx-panel-token: abc\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            ),
        );
        assert!(res.starts_with("HTTP/1.1 400"), "{res}");
    }
}
