use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::Manager;
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, ScreenToClient, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SetWindowLongPtrW,
    SetWindowPos, GWL_EXSTYLE, HWND_NOTOPMOST, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOREDRAW, SWP_NOZORDER, SWP_NOSIZE, WS_EX_LAYERED, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT,
};

use crate::{CursorPos, WorkArea};

fn hwnd_of(win: &tauri::WebviewWindow) -> Option<HWND> {
    let handle = win.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => Some(HWND(h.hwnd.get() as *mut core::ffi::c_void)),
        _ => None,
    }
}

pub fn cursor_pos(app: &tauri::AppHandle) -> CursorPos {
    let mut pt = POINT::default();
    let _ = unsafe { GetCursorPos(&mut pt) };
    // 光标相对真实窗口中心的偏移（物理像素）：窗口位置由 Rust 权威管理，
    // 直接基于 GetWindowRect 计算，避免前端引擎本地积分位置与窗口实际位置漂移。
    let mut rx = 0;
    let mut ry = 0;
    let mut left = 0;
    let mut top = 0;
    if let Some(win) = app.get_webview_window("main") {
        if let Some(hwnd) = hwnd_of(&win) {
            let mut rect = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut rect).is_ok() } {
                rx = pt.x - (rect.left + (rect.right - rect.left) / 2);
                ry = pt.y - (rect.top + (rect.bottom - rect.top) / 2);
                left = rect.left;
                top = rect.top;
            }
        }
    }
    CursorPos {
        x: pt.x,
        y: pt.y,
        rx,
        ry,
        left,
        top,
    }
}

/// 获取包含 (x, y) 的显示器工作区（排除任务栏）。
pub fn work_area_at(x: i32, y: i32) -> WorkArea {
    let monitor = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) };
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(monitor, &mut info).as_bool() } {
        let r = info.rcWork;
        WorkArea {
            left: r.left,
            top: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
        }
    } else {
        WorkArea {
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
        }
    }
}

/// 唯一的 native 穿透写入口。
/// 目标状态与真实 WS_EX_TRANSPARENT 一致时，不再调用任何写接口。
///
/// Tauri/tao 的 `set_ignore_cursor_events` 会把设置投递到窗口事件线程异步执行，
/// 立即回读 GWL_EXSTYLE 常常还是旧值，导致“设置后未生效”的误报。
/// 因此这里在调用 Tauri API 保持其内部 WindowFlags 同步后，再直接同步写
/// GWL_EXSTYLE（与 tao 一致：置位/清除 WS_EX_TRANSPARENT | WS_EX_LAYERED），
/// 确保穿透状态立即生效且可验证。
pub fn set_ignore_cursor(win: &tauri::WebviewWindow, ignore: bool) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST_LOG_AT: AtomicU64 = AtomicU64::new(0);
    let Some(hwnd) = hwnd_of(win) else {
        return;
    };
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    let transparent = style & (WS_EX_TRANSPARENT.0 as isize) != 0;
    if transparent == ignore {
        return;
    }

    // 1) 通知 Tauri/tao 更新内部 WindowFlags（异步，但必须调用，避免后续 apply_diff
    //    用旧 flags 覆盖我们的直接设置）。
    let _ = win.set_ignore_cursor_events(ignore);

    // 2) 直接同步修改窗口样式，使 WS_EX_TRANSPARENT 立即生效。
    let mask = (WS_EX_TRANSPARENT.0 as isize) | (WS_EX_LAYERED.0 as isize);
    let new_style = if ignore {
        style | mask
    } else {
        style & !mask
    };
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style);
        // SWP_FRAMECHANGED 让新样式立即生效（尤其是清除 WS_EX_TRANSPARENT 后需要重绘）。
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }

    // 3) 验证；若仍不一致，等待 Tauri 异步任务落地后重试一次。
    let mut verified = false;
    for attempt in 0..5 {
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
        let transparent = style & (WS_EX_TRANSPARENT.0 as isize) != 0;
        if transparent == ignore {
            verified = true;
            break;
        }
        if attempt == 0 {
            // 给 tao 事件线程一点时间处理第 1 步的异步请求
            std::thread::sleep(std::time::Duration::from_millis(2));
        } else {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    if !verified {
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let last = LAST_LOG_AT.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) > 10000 {
            LAST_LOG_AT.store(now_ms, Ordering::Relaxed);
            crate::log_line(&format!(
            "ignore_cursor: {ignore} 设置后未生效！style={:#x}",
            unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
            ));
        }
    }
}

/// 窗口当前是否带有 WS_EX_TOPMOST 样式。
pub fn is_topmost(win: &tauri::WebviewWindow) -> bool {
    let Some(hwnd) = hwnd_of(win) else {
        return false;
    };
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    style & (WS_EX_TOPMOST.0 as isize) != 0
}

/// 直接设置窗口置顶/取消置顶（不激活、不移动、不改变尺寸）。
/// 相比只依赖 Tauri 的 set_always_on_top，这里直接用 Win32 立即生效，
/// 供置顶看门狗在窗口丢失 WS_EX_TOPMOST 时补回。
pub fn set_topmost(win: &tauri::WebviewWindow, on: bool) {
    let Some(hwnd) = hwnd_of(win) else {
        return;
    };
    let topmost = HWND_TOPMOST;
    let notopmost = HWND_NOTOPMOST;
    let insert_after: Option<&HWND> = if on {
        Some(&topmost)
    } else {
        Some(&notopmost)
    };
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

pub fn move_window_toward(
    win: &tauri::WebviewWindow,
    tx: f64,
    ty: f64,
    max_speed: f64,
    dt: f64,
    clamp: bool,
) -> bool {
    let Some(hwnd) = hwnd_of(win) else {
        return false;
    };
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return true;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        // 目标点即窗口左上角（前端计算时已含 300x300 偏移）
        let dx = tx - rect.left as f64;
        let dy = ty - rect.top as f64;
        let dist = (dx * dx + dy * dy).sqrt();
        if dist < 1.0 {
            return true;
        }
        let step = (max_speed * dt).min(dist);
        let nx = (rect.left as f64 + dx / dist * step).round() as i32;
        let ny = (rect.top as f64 + dy / dist * step).round() as i32;

        // 安全夹紧（clamp=true 时限制在工作区内；clamp=false 允许探出屏幕）
        let (fx, fy) = if clamp {
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            const EDGE_PAD: i32 = 4;
            let area = crate::screen::work_area_at(nx, ny);
            (nx.max(area.left + EDGE_PAD).min(area.left + area.width - w - EDGE_PAD),
             ny.max(area.top + EDGE_PAD).min(area.top + area.height - h - EDGE_PAD))
        } else {
            (nx, ny)
        };

        let _ = SetWindowPos(hwnd, None, fx, fy, 0, 0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOREDRAW);
        false
    }
}

/// 拖动抓取偏移：当前鼠标 - 窗口左上角（物理像素）。
/// 拖动开始调用一次，之后窗口跟随"当前鼠标 - 偏移"。
pub fn drag_offset(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    let hwnd = hwnd_of(win)?;
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        Some((pt.x - rect.left, pt.y - rect.top))
    }
}

/// 拖动跟随一步：窗口移到"当前鼠标 - 抓取偏移"。
/// locked_y 为待机边缘滑动：y 锁定该值（物理），只随鼠标水平移动；锁定时不 clamp y（边缘可能在屏外）。
/// 由 8ms 线程调用，无每帧 IPC 延迟，像素级连续跟随。
pub fn drag_follow(
    win: &tauri::WebviewWindow,
    off_x: i32,
    off_y: i32,
    locked_y: Option<i32>,
    model_bounds: Option<(i32, i32, i32, i32)>,
    _scale: f64,
) {
    let Some(hwnd) = hwnd_of(win) else {
        return;
    };
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return;
        }
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let mut nx = pt.x - off_x;
        let mut ny = locked_y.unwrap_or(pt.y - off_y);
        // 模型边界夹紧（前端已转物理像素，直接用）
        if let Some((bl, bt, br, bb)) = model_bounds {
            let mut rect = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            let cw = rect.right - rect.left;
            let ch = rect.bottom - rect.top;
            let area = work_area_at(nx + cw / 2, ny + ch / 2);
            if nx + bl < area.left { nx = area.left - bl; }
            if nx + br > area.left + area.width { nx = area.left + area.width - br; }
            // y 仅在自由拖拽（locked_y=None）时夹紧；待机滑动 y 由 locked_y 固定，
            // 否则夹紧会把窗口从贴边待机位置拽出来（"一拽就出来了一点"）
            if locked_y.is_none() {
                if ny + bt < area.top - 60 { ny = area.top - 60 - bt; }
                if ny + bb > area.top + area.height { ny = area.top + area.height - bb; }
            }
        }
        let _ = SetWindowPos(
            hwnd,
            None,
            nx,
            ny,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOREDRAW,
        );
    }
}

/// 程序化改窗口尺寸（物理像素）。绕开 Tauri setSize 在 resizable:false 下可能失效的限制。
pub fn set_window_size(win: &tauri::WebviewWindow, width: i32, height: i32) {
    let Some(hwnd) = hwnd_of(win) else {
        return;
    };
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            width,
            height,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

/// 当前光标在主窗口客户端区内的物理像素坐标。
/// 前端 CSS logical rect 乘一次窗口 scale factor 后与这里处于同一坐标系。
pub fn cursor_client_pos(win: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    let hwnd = hwnd_of(win)?;
    let mut pt = POINT::default();
    unsafe {
        GetCursorPos(&mut pt).ok()?;
        if !ScreenToClient(hwnd, &mut pt).as_bool() {
            return None;
        }
    }
    Some((pt.x, pt.y))
}
