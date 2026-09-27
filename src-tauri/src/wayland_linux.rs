//! Wayland 会话下的窗口能力补齐（仅 Linux 编译；Windows / macOS 不引用本模块，行为不受影响）。
//!
//! ============================== 三条协议事实 ==============================
//!
//! ① 输入区域（点击穿透）本来就是核心协议能力，缺的只是把它接出来。
//!    wl_surface.set_input_region 的语义是：
//!      · NULL      → 输入区域无限大（整个 surface 都吃指针事件）
//!      · 空 region → 整块穿透
//!      · 矩形列表  → 只有列出的矩形接收指针事件
//!    GTK3 的 GDK Wayland 后端已经实现了这条映射：
//!    gdk_window_input_shape_combine_region() → gdk_wayland_window_sync_input_region()
//!    → wl_surface_set_input_region()（GTK 3.24 gdk/wayland/gdkwindow-wayland.c 的
//!    1540-1562 行与 3923-3943 行，vfunc 注册在 5141 行）。
//!    所以这里不自己写 Wayland 协议、不引入额外系统库，只把"可交互矩形"喂给 GDK。
//!    坐标系是 GDK 窗口坐标（逻辑像素），前端上报的是物理像素，按 scale 换算。
//!    子窗口也要单独设一遍：GDK 在 Wayland 下把子 GdkWindow 映射成 sub-surface，
//!    合成器按"最内层命中"投递指针事件，只设顶层会让 webview 那块继续吃事件。
//!
//! ② 窗口位置：xdg_toplevel 只能"请求"移动，合成器有权忽略；Wayland 也没有查询
//!    窗口位置、查询全局光标的核心协议。这类能力只能借助合成器私有 IPC：
//!    Hyprland 的 hyprctl 提供 cursorpos（全局光标）、-j clients（按 pid 找到窗口的
//!    位置 / 尺寸 / address / floating）和 movewindowpixel（按 address 移动窗口）。
//!    KWin 的脚本 API 有 workspace.cursorPos（Plasma / KWin MR !3134），但脚本没有
//!    文件读写，位置只能靠"重新 loadScript 传参"或自建 D-Bus 服务送出来，对每帧查询
//!    代价过高，所以这一版不启用 KDE 路径（见报告）。
//!
//! ③ GDK 能给出"指针在哪个 GdkWindow 上"以及它在该窗口内的坐标：
//!    gdk_device_get_window_at_position()（GTK 3.24 gdk/wayland/gdkdevice-wayland.c
//!    982-1004 行，vfunc 注册在 1025 行），并且 wl_pointer.leave 时 GDK 会把
//!    pointer_info.focus 置空（同文件 1759-1760 行），所以返回 None 就代表
//!    "指针不在我们任何窗口上"。它给不出全局坐标，但"光标相对窗口中心"这一项
//!    对所有合成器都成立，足够支撑视线跟随。GDK 只能在主线程访问，因此这里用
//!    "主线程采样 + 缓存"的方式，调用方（16ms 循环 / IPC 线程）永远不阻塞。
//!
//! ============================== 降级 ==============================
//! 每一层都只在探测成功时启用，任何失败都退回调用方原有行为：
//!   · 输入区域：拿不到 GtkWindow / GdkWindow → 退回 tao 的 set_ignore_cursor_events
//!     （它同样落到 GDK 输入形状，只是只能表达"整窗"或"除左上角 1x1 外整窗"）。
//!   · 移动：没有合成器 IPC → move_window_toward 直接返回"已到位"（＝现状），
//!     不发无效请求、不阻塞、不空转。
//!   · 光标：Hyprland 全局光标 → GDK 窗内指针 → 都没有就给 0（＝现状）。
//! 所有探测与调用都不 panic，也不会阻止应用启动。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewWindow};

// gtk::prelude 同时带出 gdk 的 trait（WidgetExt::window / DeviceExt::window_at_position /
// SeatExt::pointer / DeviceManagerExt::default_seat）。gdk 与 cairo 直接用 gtk 的再导出，
// 这样 Cargo.toml 只需声明一个 gtk 依赖，版本与 tauri/tao 依赖的完全一致。
use gtk::prelude::*;

use crate::CursorPos;

/// 可交互矩形：物理像素，窗口客户端坐标（与前端 sync_interaction_regions 的口径一致）。
pub type Rect = (i32, i32, i32, i32);

/// 取锁：中毒时沿用内部值，避免别处 panic 让这里连锁 panic。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ============================== 会话探测 ==============================

/// 当前是不是 Wayland 会话。
/// tao 内部用 GDK 的真实后端判断，Rust 侧拿不到，这里按同一口径从环境推断：
///   · GDK_BACKEND 显式指定时以它为准（可以 GDK_BACKEND=x11 强制走 XWayland）；
///   · 否则只要设了 WAYLAND_DISPLAY 就算 Wayland（XWayland 下 GDK 也默认选 Wayland）；
///   · 再退一步看 XDG_SESSION_TYPE。
/// 猜错的代价只是多做/少做一次降级分支，不会误伤功能。
pub fn is_wayland() -> bool {
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

// ============================== ① 输入区域 ==============================

/// 已投递到主线程、但可能还没执行的请求（去重，避免 16ms 循环堆积主线程任务）。
static PENDING: Mutex<Option<(bool, Vec<Rect>)>> = Mutex::new(None);
/// 已经真正写进 GDK 的状态（bool = 整窗，Vec = 矩形，i32 = 当时的 scale×1000）。
static APPLIED: Mutex<Option<(bool, Vec<Rect>, i32)>> = Mutex::new(None);
static WARNED_INPUT: AtomicBool = AtomicBool::new(false);

/// 把"可交互矩形"写进 Wayland 输入区域。
/// full = true 表示整窗可点（渲染锁 / 原生拖拽期间）；full = false 且 rects 为空表示整块穿透。
/// 可以从任意线程调用：真正的 GDK 调用被投递到主线程，状态没变则完全不投递。
pub fn apply_input_region(win: &WebviewWindow, rects: &[Rect], full: bool) {
    let key = (full, rects.to_vec());
    {
        let mut pending = lock(&PENDING);
        if pending.as_ref() == Some(&key) {
            return;
        }
        *pending = Some(key.clone());
    }
    let app = win.app_handle().clone();
    let posted = win.run_on_main_thread(move || {
        let Some(w) = app.get_webview_window("main") else {
            *lock(&PENDING) = None;
            return;
        };
        let scale = w.scale_factor().unwrap_or(1.0);
        let scale_key = if scale.is_finite() && scale > 0.0 {
            (scale * 1000.0).round() as i32
        } else {
            1000
        };
        {
            let applied = lock(&APPLIED);
            if applied.as_ref() == Some(&(key.0, key.1.clone(), scale_key)) {
                return;
            }
        }
        if apply_region_now(&w, &key.1, key.0, scale).is_ok() {
            *lock(&APPLIED) = Some((key.0, key.1, scale_key));
        } else {
            // 主线程这条路暂时不可用（窗口还没 realize、不是 GTK 窗口等）：
            // 退回 tao 的整窗开关，并清缓存等下一轮窗口就绪后再试。
            *lock(&PENDING) = None;
            *lock(&APPLIED) = None;
            if !WARNED_INPUT.swap(true, Ordering::Relaxed) {
                crate::log_warn(
                    "[wayland] 拿不到 GdkWindow，输入区域退回整窗开关（穿透精度下降，功能不受影响）",
                );
            }
            let _ = w.set_ignore_cursor_events(key.1.is_empty() && !key.0);
        }
    });
    if posted.is_err() {
        // 主线程投递失败（事件循环还没起来 / 已退出）：清缓存，下一轮重试。
        *lock(&PENDING) = None;
    }
}

/// 在主线程把物理像素矩形换算成逻辑像素并写进 GDK。
fn apply_region_now(win: &WebviewWindow, rects: &[Rect], full: bool, scale: f64) -> Result<(), ()> {
    let gtk_win = win.gtk_window().map_err(|_| ())?;
    let gdk_win = gtk_win.window().ok_or(())?;
    if gdk_win.is_destroyed() {
        return Err(());
    }
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let mut logical: Vec<gtk::cairo::RectangleInt> = Vec::with_capacity(rects.len());
    for &(x, y, w, h) in rects {
        if w <= 0 || h <= 0 {
            continue;
        }
        // 物理 → 逻辑用"下取整左上、上取整右下"，宁可多覆盖半像素也不要漏掉宠物边缘。
        let x0 = (f64::from(x) / scale).floor() as i32;
        let y0 = (f64::from(y) / scale).floor() as i32;
        let x1 = (f64::from(x.saturating_add(w)) / scale).ceil() as i32;
        let y1 = (f64::from(y.saturating_add(h)) / scale).ceil() as i32;
        if x1 > x0 && y1 > y0 {
            logical.push(gtk::cairo::RectangleInt::new(x0, y0, x1 - x0, y1 - y0));
        }
    }
    apply_region_to_tree(&gdk_win, 0, 0, &logical, full, 0);
    Ok(())
}

/// 递归写输入区域：顶层 GdkWindow 和它的子窗口（Wayland 下是 sub-surface）都要设。
/// off_x / off_y 是本窗口左上角在顶层窗口坐标系里的偏移。
fn apply_region_to_tree(
    w: &gtk::gdk::Window,
    off_x: i32,
    off_y: i32,
    rects: &[gtk::cairo::RectangleInt],
    full: bool,
    depth: u32,
) {
    if w.is_destroyed() {
        return;
    }
    let ww = w.width().max(0);
    let wh = w.height().max(0);
    let region = gtk::cairo::Region::create();
    if full {
        if ww > 0 && wh > 0 {
            let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(0, 0, ww, wh));
        }
    } else {
        for r in rects {
            let x0 = (r.x() - off_x).clamp(0, ww);
            let y0 = (r.y() - off_y).clamp(0, wh);
            let x1 = (r.x() + r.width() - off_x).clamp(0, ww);
            let y1 = (r.y() + r.height() - off_y).clamp(0, wh);
            if x1 > x0 && y1 > y0 {
                let _ = region.union_rectangle(&gtk::cairo::RectangleInt::new(
                    x0,
                    y0,
                    x1 - x0,
                    y1 - y0,
                ));
            }
        }
    }
    // GDK 的 gdk_window_input_shape_combine_region 只接受非空 region 指针，所以"整窗"
    // 用覆盖整窗的矩形表达，"穿透"用空 region 表达（Wayland 后端分别落到带矩形的
    // wl_region 与空 wl_region，后者就是 wl_surface.set_input_region 的"整块穿透"）。
    w.input_shape_combine_region(&region, 0, 0);
    // 输入区域是双缓冲状态，GDK 要等到 end_paint 才会把 pending region 同步成
    // wl_surface.set_input_region 并提交，所以这里排一次重绘。只有区域真的变了
    // 才会走到这里（上层去重），不构成每帧开销。
    if w.is_visible() {
        w.invalidate_rect(None, false);
    }
    if depth < 8 {
        for child in w.children() {
            if child.is_destroyed() {
                continue;
            }
            let (cx, cy) = child.position();
            apply_region_to_tree(&child, off_x + cx, off_y + cy, rects, full, depth + 1);
        }
    }
}

// ============================== ③ 窗内指针 ==============================

/// 窗内指针采样：物理像素，相对窗口左上角；w / h 是窗口尺寸（物理像素）。
#[derive(Clone, Copy)]
struct PointerSample {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

static POINTER: Mutex<Option<PointerSample>> = Mutex::new(None);
static POINTER_PENDING: AtomicBool = AtomicBool::new(false);

/// 请求刷新"窗内指针"缓存。非阻塞：真正读 GDK 的闭包投递到主线程执行，
/// 调用方本次读到的仍是上一次的采样值（下一次调用就能拿到新的）。
fn request_pointer_sample(win: &WebviewWindow) {
    if POINTER_PENDING.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = win.app_handle().clone();
    let posted = win.run_on_main_thread(move || {
        POINTER_PENDING.store(false, Ordering::Relaxed);
        if let Some(w) = app.get_webview_window("main") {
            let sample = sample_pointer(&w);
            *lock(&POINTER) = sample;
        }
    });
    if posted.is_err() {
        POINTER_PENDING.store(false, Ordering::Relaxed);
    }
}

/// 读一次"指针在哪个窗口上、坐标多少"。只在主线程调用。
#[allow(deprecated)]
fn sample_pointer(win: &WebviewWindow) -> Option<PointerSample> {
    let gtk_win = win.gtk_window().ok()?;
    let gdk_win = gtk_win.window()?;
    if gdk_win.is_destroyed() {
        return None;
    }
    let device = gtk_win.display().default_seat()?.pointer()?;
    // GDK Wayland 给的是"指针所在的 GdkWindow + 该窗口内坐标"；指针离开时 focus 被置空。
    let (target, x, y) = device.window_at_position();
    let mut cur = target?;
    let mut ox = x;
    let mut oy = y;
    // 沿父链把坐标累加到顶层窗口；中途断链说明指针不在我们窗口上，视为未知。
    let mut depth = 0;
    while cur != gdk_win {
        if depth > 16 {
            return None;
        }
        let (px, py) = cur.position();
        ox += px;
        oy += py;
        cur = cur.parent()?;
        depth += 1;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    Some(PointerSample {
        x: (f64::from(ox) * scale).round() as i32,
        y: (f64::from(oy) * scale).round() as i32,
        w: (f64::from(gdk_win.width().max(0)) * scale).round() as i32,
        h: (f64::from(gdk_win.height().max(0)) * scale).round() as i32,
    })
}

// ============================== ② 合成器位置接口（Hyprland） ==============================

/// Hyprland 报给我们的窗口信息。
#[derive(Clone, Default)]
struct HyprWindow {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    address: String,
    floating: bool,
}

#[derive(Default)]
struct HyprCache {
    window: Option<HyprWindow>,
    window_at: Option<Instant>,
    cursor: Option<(i32, i32)>,
    cursor_at: Option<Instant>,
    tick: u32,
}

struct Hypr {
    bin: PathBuf,
    pid: u32,
    data: Mutex<HyprCache>,
}

/// 探测结果缓存：None 表示"这台机器上没有可用的 Hyprland IPC"，同样只探测一次。
static HYPR: OnceLock<Option<Hypr>> = OnceLock::new();
/// 需求标记：只有最近有调用（光标查询 / 移动）时才后台轮询，空闲时不产生子进程。
static DEMAND: Mutex<Option<Instant>> = Mutex::new(None);
/// 移动节流：hyprctl 是外部进程，不能按 16ms 频率起。
static LAST_MOVE: Mutex<Option<Instant>> = Mutex::new(None);
static WARNED_MOVE: AtomicBool = AtomicBool::new(false);
const MOVE_MIN_INTERVAL: Duration = Duration::from_millis(55);
const DRAG_MIN_INTERVAL: Duration = Duration::from_millis(45);

/// 取 Hyprland 接口（进程级只探测一次）。
fn hypr() -> Option<&'static Hypr> {
    HYPR.get_or_init(|| {
        if !is_wayland() {
            return None;
        }
        // HYPRLAND_INSTANCE_SIGNATURE 是 Hyprland 给会话内进程的环境变量；
        // 没有它要么不是 Hyprland，要么 hyprctl 根本连不上 socket，两种情况都该降级。
        if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
            return None;
        }
        let bin = find_in_path("hyprctl")?;
        let ok = Command::new(&bin)
            .arg("version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return None;
        }
        let h = Hypr {
            bin,
            pid: std::process::id(),
            data: Mutex::new(HyprCache::default()),
        };
        spawn_poller();
        Some(h)
    })
    .as_ref()
}

/// 是否有可用的"全局光标 + 窗口位置"来源（目前只有 Hyprland 的私有 IPC 能做到）。
/// 上层据此选择提示哪一级降级：有它 = 与 Windows 等价的坐标语义；
/// 没有 = 只剩"窗内指针相对位置"，全局坐标只能给 0。
pub fn global_cursor_available() -> bool {
    hypr().is_some()
}

/// 在 PATH 里找可执行文件（不引入额外依赖）。
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// 告诉后台轮询线程"最近有人要用位置/光标"。
fn poke() {
    *lock(&DEMAND) = Some(Instant::now() + Duration::from_secs(5));
}

fn demand_active() -> bool {
    let mut d = lock(&DEMAND);
    match *d {
        Some(until) if until > Instant::now() => true,
        Some(_) => {
            *d = None;
            false
        }
        None => false,
    }
}

/// 后台轮询：光标每次刷新，窗口几何降频刷新（起进程是主要开销）。
fn spawn_poller() {
    let spawned = std::thread::Builder::new()
        .name("petra-wayland-poll".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(60));
            if !demand_active() {
                continue;
            }
            let Some(h) = hypr() else { continue };
            let with_clients = {
                let d = lock(&h.data);
                d.window.is_none() || d.tick % 4 == 0
            };
            h.refresh(with_clients);
            let mut d = lock(&h.data);
            d.tick = d.tick.wrapping_add(1);
        });
    if spawned.is_err() {
        crate::log_warn("[wayland] 位置轮询线程创建失败，窗口定位与全局光标降级");
    }
}

impl Hypr {
    /// 跑一次 hyprctl，成功返回 stdout。
    fn run(&self, args: &[&str]) -> Option<String> {
        let out = Command::new(&self.bin)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn refresh(&self, with_clients: bool) {
        if let Some(text) = self.run(&["cursorpos"]) {
            if let Some(c) = parse_cursor(&text) {
                let mut d = lock(&self.data);
                d.cursor = Some(c);
                d.cursor_at = Some(Instant::now());
            }
        }
        if with_clients {
            if let Some(text) = self.run(&["-j", "clients"]) {
                if let Some(w) = parse_clients(&text, self.pid) {
                    let mut d = lock(&self.data);
                    d.window = Some(w);
                    d.window_at = Some(Instant::now());
                }
            }
        }
    }

    fn cursor_cached(&self) -> Option<(i32, i32)> {
        lock(&self.data).cursor
    }

    fn window_cached(&self) -> Option<HyprWindow> {
        lock(&self.data).window.clone()
    }

    /// 光标：缓存过期就同步刷新一次（调用方必须是后台线程）。
    fn cursor_fresh(&self, max_age: Duration) -> Option<(i32, i32)> {
        let stale = {
            let d = lock(&self.data);
            d.cursor_at.map(|t| t.elapsed() > max_age).unwrap_or(true)
        };
        if stale {
            self.refresh(false);
        }
        self.cursor_cached()
    }

    /// 窗口几何：缓存过期就同步刷新一次（调用方必须是后台线程）。
    fn window_fresh(&self, max_age: Duration) -> Option<HyprWindow> {
        let stale = {
            let d = lock(&self.data);
            d.window_at.map(|t| t.elapsed() > max_age).unwrap_or(true)
        };
        if stale {
            self.refresh(true);
        }
        self.window_cached()
    }
}

/// hyprctl cursorpos 输出形如 "1920, 1080"。
fn parse_cursor(text: &str) -> Option<(i32, i32)> {
    let mut it = text.trim().split(',');
    let x: f64 = it.next()?.trim().parse().ok()?;
    let y: f64 = it.next()?.trim().parse().ok()?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some((x.round() as i32, y.round() as i32))
}

/// 从 hyprctl -j clients 的 JSON 里挑出我们自己的窗口（按 pid），
/// 同 pid 有多个时取面积最大的那个（避开托盘一类的辅助窗口）。
fn parse_clients(text: &str, pid: u32) -> Option<HyprWindow> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut best: Option<HyprWindow> = None;
    for c in v.as_array()? {
        if c.get("pid").and_then(|p| p.as_u64()) != Some(u64::from(pid)) {
            continue;
        }
        if c.get("mapped").and_then(|m| m.as_bool()) == Some(false) {
            continue;
        }
        let (Some(at), Some(size)) = (
            c.get("at").and_then(|a| a.as_array()),
            c.get("size").and_then(|s| s.as_array()),
        ) else {
            continue;
        };
        let (Some(x), Some(y), Some(w), Some(h)) = (
            at.first().and_then(|n| n.as_i64()),
            at.get(1).and_then(|n| n.as_i64()),
            size.first().and_then(|n| n.as_i64()),
            size.get(1).and_then(|n| n.as_i64()),
        ) else {
            continue;
        };
        let cand = HyprWindow {
            x: x as i32,
            y: y as i32,
            w: w as i32,
            h: h as i32,
            address: c
                .get("address")
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_string(),
            floating: c.get("floating").and_then(|f| f.as_bool()).unwrap_or(false),
        };
        let better = match &best {
            None => true,
            Some(b) => i64::from(cand.w) * i64::from(cand.h) > i64::from(b.w) * i64::from(b.h),
        };
        if better {
            best = Some(cand);
        }
    }
    best
}

/// 按 address 移动窗口。窗口是平铺状态时先让它浮动（movewindowpixel 只对浮动窗口生效）。
fn move_to(h: &Hypr, x: i32, y: i32) -> bool {
    let (address, floating) = {
        let d = lock(&h.data);
        match d.window.as_ref() {
            Some(w) if !w.address.is_empty() => (w.address.clone(), w.floating),
            _ => return false,
        }
    };
    if !floating {
        let selector = format!("address:{address}");
        let _ = h.run(&["dispatch", "togglefloating", selector.as_str()]);
    }
    let dispatch_ok = |s: &str| {
        h.run(&["dispatch", "movewindowpixel", s])
            .map(|out| out.contains("ok"))
            .unwrap_or(false)
    };
    // 优先用 exact（表示绝对像素坐标），老版本不接受时退回不带 exact 的写法。
    let exact = format!("exact {x} {y},address:{address}");
    let plain = format!("{x} {y},address:{address}");
    let ok = dispatch_ok(&exact) || dispatch_ok(&plain);
    if ok {
        // 乐观更新缓存，避免"移动 → 查询"之间窗口位置跳回旧值造成抖动。
        let mut d = lock(&h.data);
        if let Some(w) = d.window.as_mut() {
            w.x = x;
            w.y = y;
        }
    }
    ok
}

// ============================== 对外：光标 / 移动 / 拖拽 ==============================

/// Wayland 下的光标信息。
/// 有合成器接口时（Hyprland）能给出与 Windows 等价的全局坐标 + 窗内偏移；
/// 否则退回"GDK 窗内指针"，只能给出相对窗口中心的偏移（x / y / left / top 为 0）。
pub fn cursor_pos(app: &AppHandle) -> CursorPos {
    if let Some(h) = hypr() {
        poke();
        if let (Some((cx, cy)), Some(w)) = (h.cursor_cached(), h.window_cached()) {
            let ccx = w.x + w.w / 2;
            let ccy = w.y + w.h / 2;
            return CursorPos {
                x: cx,
                y: cy,
                rx: cx - ccx,
                ry: cy - ccy,
                left: w.x,
                top: w.y,
            };
        }
    }
    if let Some(win) = app.get_webview_window("main") {
        request_pointer_sample(&win);
    }
    if let Some(p) = *lock(&POINTER) {
        return CursorPos {
            x: 0,
            y: 0,
            rx: p.x - p.w / 2,
            ry: p.y - p.h / 2,
            left: 0,
            top: 0,
        };
    }
    CursorPos {
        x: 0,
        y: 0,
        rx: 0,
        ry: 0,
        left: 0,
        top: 0,
    }
}

/// Wayland 下的窗口移动（漫游 / 贴边）。返回 true 表示"已到位"（或无法移动，等同到位）。
/// 没有可用合成器接口时直接返回 true：这正是本文件引入前的行为，不会空转。
pub fn move_window_toward(
    win: &WebviewWindow,
    tx: f64,
    ty: f64,
    max_speed: f64,
    clamp: bool,
) -> bool {
    let Some(h) = hypr() else {
        if !WARNED_MOVE.swap(true, Ordering::Relaxed) {
            crate::log_warn(
                "[wayland] 没有可用的合成器位置接口，漫游/绝对定位降级（窗口位置由合成器决定）",
            );
        }
        return true;
    };
    poke();
    let now = Instant::now();
    let mut elapsed = Duration::from_millis(16);
    {
        // 先取快照再重新加锁写回：避免在 match 的 scrutinee 借用期间改同一个 Mutex。
        let prev = *lock(&LAST_MOVE);
        match prev {
            Some(t) => {
                let e = now.duration_since(t);
                if e < MOVE_MIN_INTERVAL {
                    // 还没到下一次允许发请求的时刻：目标保留，上层下一轮继续。
                    return false;
                }
                *lock(&LAST_MOVE) = Some(now);
                elapsed = e;
            }
            None => {
                *lock(&LAST_MOVE) = Some(now);
            }
        }
    }
    let dt = elapsed.as_secs_f64().clamp(0.001, 0.25);
    let Some(w) = h.window_fresh(Duration::from_millis(80)) else {
        return false;
    };
    let pw = w.w.max(1);
    let ph = w.h.max(1);
    let dx = tx - f64::from(w.x);
    let dy = ty - f64::from(w.y);
    let dist = (dx * dx + dy * dy).sqrt();
    if dist < 1.0 {
        return true;
    }
    let step = (max_speed * dt).min(dist);
    let nx = (f64::from(w.x) + dx / dist * step).round() as i32;
    let ny = (f64::from(w.y) + dy / dist * step).round() as i32;
    let (fx, fy) = if clamp {
        const EDGE_PAD: i32 = 4;
        let area = crate::screen::work_area_at(nx, ny);
        (
            nx.max(area.left + EDGE_PAD)
                .min(area.left + area.width - pw - EDGE_PAD),
            ny.max(area.top + EDGE_PAD)
                .min(area.top + area.height - ph - EDGE_PAD),
        )
    } else {
        (nx, ny)
    };
    if !move_to(h, fx, fy) {
        return false;
    }
    let _ = win;
    false
}

/// 拖动抓取偏移：当前光标 - 窗口左上角。
/// Wayland 只有拿得到合成器光标与窗口位置时才有意义，否则返回 None（沿用前端自己的指针路径）。
pub fn drag_offset(win: &WebviewWindow) -> Option<(i32, i32)> {
    let h = hypr()?;
    poke();
    let (cx, cy) = h.cursor_fresh(Duration::from_millis(50))?;
    let w = h.window_fresh(Duration::from_millis(80))?;
    let _ = win;
    Some((cx - w.x, cy - w.y))
}

/// 拖动跟随一步：窗口移到"当前光标 - 抓取偏移"。
/// locked_y 为待机边缘滑动时锁定的 y；model_bounds 与 X11 版一致，是模型包围盒（物理像素）。
pub fn drag_follow(
    win: &WebviewWindow,
    off_x: i32,
    off_y: i32,
    locked_y: Option<i32>,
    model_bounds: Option<(i32, i32, i32, i32)>,
) {
    let Some(h) = hypr() else { return };
    let now = Instant::now();
    {
        let prev = *lock(&LAST_MOVE);
        if let Some(t) = prev {
            if now.duration_since(t) < DRAG_MIN_INTERVAL {
                return;
            }
        }
        *lock(&LAST_MOVE) = Some(now);
    }
    let Some((cx, cy)) = h.cursor_fresh(Duration::from_millis(25)) else {
        return;
    };
    let Some(w) = h.window_cached() else {
        return;
    };
    let mut nx = cx - off_x;
    let mut ny = locked_y.unwrap_or(cy - off_y);
    if let Some((bl, bt, br, bb)) = model_bounds {
        let area = crate::screen::work_area_at(nx + w.w / 2, ny + w.h / 2);
        if nx + bl < area.left {
            nx = area.left - bl;
        }
        if nx + br > area.left + area.width {
            nx = area.left + area.width - br;
        }
        if locked_y.is_none() {
            if ny + bt < area.top - 60 {
                ny = area.top - 60 - bt;
            }
            if ny + bb > area.top + area.height {
                ny = area.top + area.height - bb;
            }
        }
    }
    let _ = move_to(h, nx, ny);
    let _ = win;
}
