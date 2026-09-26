//! macOS 窗口 / 光标 / 显示器操作：全部走 Tauri（tao → Cocoa）的跨平台 API。
//!
//! 与 Windows 版的差异：
//!   * 没有 WS_EX_TOPMOST 这种可直接读的窗口样式，用 Tauri 的 is_always_on_top()
//!     反查（tao 自己维护这个标志，而本应用是唯一的写入方）；
//!   * 鼠标穿透直接用 tao 的 set_ignore_cursor_events（macOS 上是
//!     NSWindow.ignoresMouseEvents），没有 Win32 那种异步落盘后回读旧值的问题；
//!   * 工作区用 Monitor::work_area()（已排除菜单栏和 Dock）。

use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow};

use crate::{CursorPos, WorkArea};

/// work_area_at(x, y) 这个命令只有坐标、没有窗口句柄，而查显示器必须要
/// AppHandle。setup 时登记一份，后台线程拿窗口时也会顺手补登记（幂等）。
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 登记 AppHandle（由 lib.rs 的 setup 调用）。
pub fn remember_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// 从窗口取 AppHandle，并顺手登记，保证 work_area_at 能查到显示器。
fn app_of(win: &WebviewWindow) -> AppHandle {
    let app = win.app_handle().clone();
    let _ = APP.set(app.clone());
    app
}

/// 光标在虚拟桌面里的物理坐标。
fn cursor_physical(app: &AppHandle) -> Option<(i32, i32)> {
    app.cursor_position()
        .ok()
        .map(|p| (p.x.round() as i32, p.y.round() as i32))
}

fn monitor_to_work_area(mon: &tauri::window::Monitor) -> WorkArea {
    let area = mon.work_area();
    WorkArea {
        left: area.position.x,
        top: area.position.y,
        width: area.size.width as i32,
        height: area.size.height as i32,
    }
}

pub fn cursor_pos(app: &tauri::AppHandle) -> CursorPos {
    remember_app(app.clone());
    let (x, y) = cursor_physical(app).unwrap_or((0, 0));
    // 光标相对真实窗口中心的偏移（物理像素）：窗口位置由 Rust 权威管理，
    // 直接基于窗口实际位置计算，避免前端引擎本地积分位置与窗口实际位置漂移。
    let mut rx = 0;
    let mut ry = 0;
    let mut left = 0;
    let mut top = 0;
    if let Some(win) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
            rx = x - (pos.x + size.width as i32 / 2);
            ry = y - (pos.y + size.height as i32 / 2);
            left = pos.x;
            top = pos.y;
        }
    }
    CursorPos {
        x,
        y,
        rx,
        ry,
        left,
        top,
    }
}

/// 获取包含 (x, y) 的显示器工作区（排除菜单栏和 Dock）。
pub fn work_area_at(x: i32, y: i32) -> WorkArea {
    if let Some(app) = APP.get() {
        if let Ok(Some(mon)) = app.monitor_from_point(x as f64, y as f64) {
            return monitor_to_work_area(&mon);
        }
        // 光标可能落在显示器之间的空隙里，退回主显示器
        if let Ok(Some(mon)) = app.primary_monitor() {
            return monitor_to_work_area(&mon);
        }
    }
    // 还没有 AppHandle（极早期调用）或查不到显示器：与 Windows 版的兜底一致
    WorkArea {
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
    }
}

/// 上一次写入的穿透状态。
/// Tauri 只有 set_ignore_cursor_events，没有 getter，所以自己记一份：
/// 与 Windows 版"目标状态没变就不调写接口"的优化一致，避免 16ms 循环
/// 每帧都往主线程投递一次窗口操作。
static LAST_IGNORE: Mutex<Option<bool>> = Mutex::new(None);

/// 唯一的 native 穿透写入口。
/// macOS 上 tao 内部就是设置 NSWindow.ignoresMouseEvents，不需要 Windows 版
/// 那套「回读 GWL_EXSTYLE + 重试」的补偿逻辑。
pub fn set_ignore_cursor(win: &tauri::WebviewWindow, ignore: bool) {
    {
        let mut last = LAST_IGNORE.lock().unwrap();
        if *last == Some(ignore) {
            return;
        }
        *last = Some(ignore);
    }
    if win.set_ignore_cursor_events(ignore).is_err() {
        // 写入失败就把缓存清掉，下一轮重试
        *LAST_IGNORE.lock().unwrap() = None;
    }
}

/// 窗口当前是否置顶。
pub fn is_topmost(win: &tauri::WebviewWindow) -> bool {
    win.is_always_on_top().unwrap_or(false)
}

/// 设置窗口置顶/取消置顶（不激活、不移动、不改变尺寸）。
pub fn set_topmost(win: &tauri::WebviewWindow, on: bool) {
    let _ = win.set_always_on_top(on);
}

pub fn move_window_toward(
    win: &tauri::WebviewWindow,
    tx: f64,
    ty: f64,
    max_speed: f64,
    dt: f64,
    clamp: bool,
) -> bool {
    if !win.is_visible().unwrap_or(false) {
        return true;
    }
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return false;
    };
    // 目标点即窗口左上角（前端计算时已含 300x300 偏移）
    let dx = tx - pos.x as f64;
    let dy = ty - pos.y as f64;
    let dist = (dx * dx + dy * dy).sqrt();
    if dist < 1.0 {
        return true;
    }
    let step = (max_speed * dt).min(dist);
    let nx = (pos.x as f64 + dx / dist * step).round() as i32;
    let ny = (pos.y as f64 + dy / dist * step).round() as i32;

    // 安全夹紧（clamp=true 时限制在工作区内；clamp=false 允许探出屏幕）
    let (fx, fy) = if clamp {
        let w = size.width as i32;
        let h = size.height as i32;
        const EDGE_PAD: i32 = 4;
        let area = work_area_at(nx, ny);
        (
            nx.max(area.left + EDGE_PAD)
                .min(area.left + area.width - w - EDGE_PAD),
            ny.max(area.top + EDGE_PAD)
                .min(area.top + area.height - h - EDGE_PAD),
        )
    } else {
        (nx, ny)
    };

    let _ = win.set_position(Position::Physical(PhysicalPosition::new(fx, fy)));
    false
}

/// 拖动抓取偏移：当前鼠标 - 窗口左上角（物理像素）。
/// 拖动开始调用一次，之后窗口跟随"当前鼠标 - 偏移"。
pub fn drag_offset(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    let app = app_of(win);
    let (cx, cy) = cursor_physical(&app)?;
    let pos = win.outer_position().ok()?;
    Some((cx - pos.x, cy - pos.y))
}

/// 拖动跟随一步：窗口移到"当前鼠标 - 抓取偏移"。
/// locked_y 为待机边缘滑动：y 锁定该值（物理），只随鼠标水平移动；锁定时不 clamp y（边缘可能在屏外）。
/// 由 8ms 线程调用，无每帧 IPC 延迟。
pub fn drag_follow(
    win: &tauri::WebviewWindow,
    off_x: i32,
    off_y: i32,
    locked_y: Option<i32>,
    model_bounds: Option<(i32, i32, i32, i32)>,
    _scale: f64,
) {
    if !win.is_visible().unwrap_or(false) {
        return;
    }
    let app = app_of(win);
    let Some((cx, cy)) = cursor_physical(&app) else {
        return;
    };
    let mut nx = cx - off_x;
    let mut ny = locked_y.unwrap_or(cy - off_y);
    // 模型边界夹紧（前端已转物理像素，直接用）
    if let Some((bl, bt, br, bb)) = model_bounds {
        let (cw, ch) = win
            .outer_size()
            .map(|s| (s.width as i32, s.height as i32))
            .unwrap_or((0, 0));
        let area = work_area_at(nx + cw / 2, ny + ch / 2);
        if nx + bl < area.left {
            nx = area.left - bl;
        }
        if nx + br > area.left + area.width {
            nx = area.left + area.width - br;
        }
        // y 仅在自由拖拽（locked_y=None）时夹紧；待机滑动 y 由 locked_y 固定，
        // 否则夹紧会把窗口从贴边待机位置拽出来（"一拽就出来了一点"）
        if locked_y.is_none() {
            if ny + bt < area.top - 60 {
                ny = area.top - 60 - bt;
            }
            if ny + bb > area.top + area.height {
                ny = area.top + area.height - bb;
            }
        }
    }
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(nx, ny)));
}

/// 程序化改窗口尺寸（物理像素）。
pub fn set_window_size(win: &tauri::WebviewWindow, width: i32, height: i32) {
    let _ = win.set_size(Size::Physical(PhysicalSize::new(
        width.max(1) as u32,
        height.max(1) as u32,
    )));
}

/// 当前光标在主窗口客户端区内的物理像素坐标。
/// 窗口是 decorations:false，客户端区左上角就等于窗口左上角，所以直接相减。
pub fn cursor_client_pos(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    let app = app_of(win);
    let (cx, cy) = cursor_physical(&app)?;
    let pos = win.outer_position().ok()?;
    Some((cx - pos.x, cy - pos.y))
}
