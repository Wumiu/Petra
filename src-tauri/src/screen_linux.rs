//! Linux 窗口 / 光标 / 显示器操作：全部走 Tauri（tao → GTK3）的跨平台 API。
//!
//! ============================ Wayland 下的两条硬约束 ============================
//!
//! ① 点击穿透取决于"输入区域"，GTK 这条路在 Wayland 上不通：
//!    Tauri 的 set_ignore_cursor_events 在 Linux 上最终落到 GTK3 的
//!    gdk_window_input_shape_combine_region（见 tao 的 linux event_loop 实现）。
//!    GDK 只在 X11 后端把输入形状交给 SHAPE 扩展；Wayland 后端并没有把这个调用
//!    映射到 wl_surface.set_input_region，所以它在 Wayland 会话里大概率不生效 ——
//!    透明窗口会整块吃下鼠标事件（虽然看得见桌面，但点不到）。
//!    TODO(wayland-clickthrough): 真正的解法是用 layer-shell（zwlr_layer_shell_v1）
//!    创建表面，然后直接对 wl_surface.set_input_region 传交互区域（空区域 = 整体穿透）。
//!    这需要在 GTK 之外自建窗口，和 tao 的窗口模型冲突，属于独立一轮的工作。
//!
//! ② Wayland 不允许应用设置自己的绝对位置，也不暴露全局指针坐标：
//!    tao 在 Wayland 下让 cursor_position() 直接返回 (0,0)（协议里没有"查询全局鼠标位置"
//!    这种状态），而 set_outer_position 只是给合成器发一个移动请求，合成器通常会忽略 ——
//!    窗口放在哪里由合成器全权决定。
//!    所以所有依赖"绝对定位 + 全局光标"的功能都必须降级：
//!      · move_window_toward（漫游 / 边缘滑动）→ 视为已到位，不再每 16ms 发无效请求；
//!      · drag_offset / drag_follow（8ms 原生拖拽跟随）→ 放弃，交给前端自身的 pointermove；
//!      · cursor_pos / cursor_client_pos（视线跟随、穿透判定）→ 尽力而为，
//!        Wayland 下拿到的是 (0,0)，不能据此做穿透决策。
//!    TODO(wayland-position): 需要"贴边待机 / 漫游"时，用 layer-shell 的 anchor + margin
//!    （协议允许应用声明相对锚点和边距）替代绝对坐标；视线跟随只能退化成
//!    "窗口内部指针相对位置"（WebView 自己的 pointermove 事件）。
//! ==============================================================================

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow};

use crate::{CursorPos, WorkArea};

/// 当前是不是 Wayland 会话。
/// tao 内部用的是 GDK 的实际后端（gdk::Display::backend()），Rust 侧拿不到，
/// 这里只能按同一口径从环境推断：
///   · GDK_BACKEND 显式指定时以它为准（用户可以用 GDK_BACKEND=x11 强制走 XWayland）；
///   · 否则只要设了 WAYLAND_DISPLAY 就算 Wayland（XWayland 下 GDK 也默认选 Wayland）；
///   · 再退一步看 XDG_SESSION_TYPE。
/// 这个判断只用于"降级"，猜错的代价是少做一次无效调用，不会误伤功能。
fn is_wayland() -> bool {
    if let Ok(b) = std::env::var("GDK_BACKEND") {
        let b = b.to_lowercase();
        if b.contains("wayland") {
            return true;
        }
        if b.contains("x11") {
            return false;
        }
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return true;
    }
    std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
}

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

/// 降级提示只打一次，避免 16ms 循环把日志刷爆。
static WARNED_MOVE: AtomicBool = AtomicBool::new(false);
static WARNED_IGNORE: AtomicBool = AtomicBool::new(false);
static WARNED_CURSOR: AtomicBool = AtomicBool::new(false);

/// 光标在虚拟桌面里的物理坐标。
/// Wayland 下 tao 固定返回 (0,0)：协议不提供全局光标查询，只能当"未知"。
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
    if is_wayland() && !WARNED_CURSOR.swap(true, Ordering::Relaxed) {
        crate::log_warn(
            "[screen] Wayland 不提供全局光标坐标，cursor_pos 只能返回 (0,0)，视线跟随已降级",
        );
    }
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

/// 获取包含 (x, y) 的显示器工作区（已排除面板/Dock 一类的保留区域）。
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
///
/// X11：tao 走 GTK 的 input shape（SHAPE 扩展），行为与 macOS 的
/// NSWindow.ignoresMouseEvents 等价，不需要 Windows 版那套补偿逻辑。
/// Wayland：GDK 没有把 input shape 映射到 wl_surface.set_input_region，
/// 调用不生效，所以这里直接跳过 —— 宁可窗口"整块可点"，也不要每 16ms 发一次
/// 无效请求把日志刷满。真正的穿透留给 layer-shell 方案（见文件头 TODO）。
pub fn set_ignore_cursor(win: &tauri::WebviewWindow, ignore: bool) {
    {
        let mut last = LAST_IGNORE.lock().unwrap();
        if *last == Some(ignore) {
            return;
        }
        *last = Some(ignore);
    }
    if is_wayland() {
        if !WARNED_IGNORE.swap(true, Ordering::Relaxed) {
            crate::log_warn(
                "[screen] Wayland 下 GTK 不实现 input shape，鼠标穿透本轮不生效（待 layer-shell + set_input_region）",
            );
        }
        return;
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
/// Wayland 没有让客户端声明"置顶"的协议，GTK 会把它变成 keep-above 请求，
/// 合成器有权忽略；这里仍然调用，因为 X11 后端能生效，且失败没有副作用。
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
    // Wayland：位置由合成器决定，继续算下去只会每 16ms 发一次无效的移动请求，
    // 所以直接当"已到位"返回，让 lib.rs 的目标点被清除。
    if is_wayland() {
        if !WARNED_MOVE.swap(true, Ordering::Relaxed) {
            crate::log_warn(
                "[screen] Wayland 不允许应用设置窗口绝对位置，漫游/原生移动已降级（待 layer-shell anchor）",
            );
        }
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
///
/// Wayland 下没有全局光标，算出来只会是 (0,0) 减窗口位置这种噪声，
/// 所以返回 None：lib.rs 的 drag_start 因此不会进入 8ms 原生跟随模式，
/// 拖动交给前端自身的 pointermove 路径（那条不需要全局坐标）。
pub fn drag_offset(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    if is_wayland() {
        return None;
    }
    let app = app_of(win);
    let (cx, cy) = cursor_physical(&app)?;
    let pos = win.outer_position().ok()?;
    Some((cx - pos.x, cy - pos.y))
}

/// 拖动跟随一步：窗口移到"当前鼠标 - 抓取偏移"。
/// locked_y 为待机边缘滑动：y 锁定该值（物理），只随鼠标水平移动；锁定时不 clamp y（边缘可能在屏外）。
/// 由 8ms 线程调用，无每帧 IPC 延迟。Wayland 下直接不动作（原因同上）。
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
    if is_wayland() {
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
        // 否则夹紧会把窗口从贴边待机位置拽出来
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

/// 程序化改窗口尺寸（物理像素）。Wayland 下同样是请求，但合成器一般接受由客户端发起的尺寸变更。
pub fn set_window_size(win: &tauri::WebviewWindow, width: i32, height: i32) {
    let _ = win.set_size(Size::Physical(PhysicalSize::new(
        width.max(1) as u32,
        height.max(1) as u32,
    )));
}

/// 当前光标在主窗口客户端区内的物理像素坐标。
/// 窗口是 decorations:false，客户端区左上角就等于窗口左上角，所以直接相减。
///
/// Wayland 返回 None（拿不到全局光标）：让上层把它当"光标未知"，
/// 而不是拿 (0,0) 算出"在窗口外"从而错误地把整个窗口设成穿透。
pub fn cursor_client_pos(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    if is_wayland() {
        return None;
    }
    let app = app_of(win);
    let (cx, cy) = cursor_physical(&app)?;
    let pos = win.outer_position().ok()?;
    Some((cx - pos.x, cy - pos.y))
}
