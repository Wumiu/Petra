//! Linux 窗口 / 光标 / 显示器操作。
//!
//! Wayland 会话下的三项能力缺口全部由 wayland_linux.rs 负责补齐，本文件只做"会话分叉"：
//!
//! ① 输入区域（点击穿透）：
//!    X11 走 tao → GTK 的 input shape（SHAPE 扩展），与 macOS 的
//!    NSWindow.ignoresMouseEvents 等价，不需要 Windows 版那套补偿逻辑。
//!    Wayland 走 wayland_linux::apply_input_region：同一个 GDK 入口
//!    （gdk_window_input_shape_combine_region → wl_surface.set_input_region），
//!    但能表达"只有前端上报的那几块矩形可点"，而不是只能整窗开/关。
//!    注意真值是"输入区域"本身：窗口在 Wayland 下不会因为透明就穿透。
//!
//! ② 窗口位置：
//!    X11 可以用绝对坐标（tao set_position / GTK move）配合 16ms 循环平滑移动。
//!    Wayland 不允许应用设置 xdg_toplevel 的绝对位置，本文件把这一路交给
//!    wayland_linux（有合成器位置接口时才生效；否则返回"已到位"，即不空转）。
//!
//! ③ 光标：
//!    X11 用 tao 的 cursor_position；Wayland 交给 wayland_linux 的来源链
//!    （Hyprland 全局光标 → GDK 窗内指针 → 都没有则返回 0）。
//!
//! 所有 Wayland 分支都是"探测成功才启用"，任何一步失败都退回本文件原有的 X11 行为，
//! 不会因为拿不到 Wayland 句柄而让应用起不来。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow};

use crate::wayland_linux;
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

/// 降级提示只打一次，避免 16ms 循环把日志刷爆。
static WARNED_MOVE: AtomicBool = AtomicBool::new(false);
static WARNED_CURSOR: AtomicBool = AtomicBool::new(false);

/// 当前是不是 Wayland 会话（判断逻辑与理由见 wayland_linux.rs）。
fn is_wayland() -> bool {
    wayland_linux::is_wayland()
}

/// 光标在虚拟桌面里的物理坐标。
/// Wayland 下 tao 固定返回 (0,0)：协议不提供全局光标查询，只有合成器私有接口
/// （见 wayland_linux.rs）才能给出真值。
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
    if is_wayland() {
        if !wayland_linux::global_cursor_available() && !WARNED_CURSOR.swap(true, Ordering::Relaxed)
        {
            crate::log_warn(
                "[screen] Wayland 下没有可用的全局光标来源，视线跟随退回\"窗内指针相对位置\"",
            );
        }
        return wayland_linux::cursor_pos(app);
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

/// 整窗穿透开关（X11 的写入口，也是 Wayland 上拿不到 GdkWindow 时的兜底）。
///
/// X11：tao 走 GTK 的 input shape（SHAPE 扩展），行为与 macOS 的
/// NSWindow.ignoresMouseEvents 等价。
/// Wayland：tao 同样落到 GDK 的 input shape → wl_surface.set_input_region，
/// 所以调用是有效的；但它只能表达"整窗可点"或"除左上角 1x1 外整窗穿透"，
/// 无法表达"只有宠物身体可点"，那种精度由 apply_clickthrough 走矩形区域实现。
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

/// 唯一的光标穿透写入口（lib.rs 的 16ms 决策线程调用）。
///
/// ignore 是"整窗是否穿透"的布尔结论（非 Wayland 用）；
/// regions 是前端上报的可交互矩形（物理像素，窗口客户端坐标）；
/// full_window 表示这段期间整窗都要可点（渲染锁 / 原生拖拽中）。
///
/// Wayland 下不按光标位置切开关，而是直接把矩形列表写进输入区域：
/// 合成器只把指针事件投递给区域内的 surface，既解决了"透明窗整块吃鼠标"，
/// 又保住了"只有宠物身体可点"。非 Wayland 保持原有整窗开关行为。
pub fn apply_clickthrough(
    win: &tauri::WebviewWindow,
    ignore: bool,
    regions: &[wayland_linux::Rect],
    full_window: bool,
) {
    if is_wayland() {
        wayland_linux::apply_input_region(win, regions, full_window);
        return;
    }
    set_ignore_cursor(win, ignore);
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
    // Wayland：位置由合成器决定，只有拿到合成器位置接口时才可能移动；
    // 拿不到就返回"已到位"，让 lib.rs 清掉目标，不再每 16ms 发无效请求。
    if is_wayland() {
        if !wayland_linux::global_cursor_available() && !WARNED_MOVE.swap(true, Ordering::Relaxed) {
            crate::log_warn("[screen] Wayland 不提供绝对定位，漫游/原生移动已降级");
        }
        return wayland_linux::move_window_toward(win, tx, ty, max_speed, clamp);
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
/// Wayland 下只有拿到合成器位置接口（Hyprland）才算得出来；否则返回 None，
/// 于是 lib.rs 的 drag_start 不会进入 8ms 原生跟随模式，拖动交给前端自身的
/// pointermove 路径（那条不需要全局坐标）。
pub fn drag_offset(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    if is_wayland() {
        return wayland_linux::drag_offset(win);
    }
    let app = app_of(win);
    let (cx, cy) = cursor_physical(&app)?;
    let pos = win.outer_position().ok()?;
    Some((cx - pos.x, cy - pos.y))
}

/// 拖动跟随一步：窗口移到"当前鼠标 - 抓取偏移"。
/// locked_y 为待机边缘滑动：y 锁定该值（物理），只随鼠标水平移动；锁定时不 clamp y（边缘可能在屏外）。
/// 由 8ms 线程调用，无每帧 IPC 延迟。Wayland 下交给 wayland_linux（同样需要合成器接口）。
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
        wayland_linux::drag_follow(win, off_x, off_y, locked_y, model_bounds);
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
/// Wayland 返回 None（核心协议不提供全局光标，没有可信的来源）；
/// 让上层把它当"光标未知"，而不是拿 (0,0) 算出"在窗口外"从而错误地把整个窗口设成穿透。
/// 穿透判定在 Wayland 下不依赖这个值（见 apply_clickthrough）。
pub fn cursor_client_pos(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    if is_wayland() {
        return None;
    }
    let app = app_of(win);
    let (cx, cy) = cursor_physical(&app)?;
    let pos = win.outer_position().ok()?;
    Some((cx - pos.x, cy - pos.y))
}
