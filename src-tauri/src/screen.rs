use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::Manager;
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, ScreenToClient, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SetWindowPos,
    GWL_EXSTYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOREDRAW, SWP_NOZORDER,
    SWP_NOSIZE, WS_EX_TRANSPARENT,
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
pub fn set_ignore_cursor(win: &tauri::WebviewWindow, ignore: bool) {
    let Some(hwnd) = hwnd_of(win) else {
        return;
    };
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    let transparent = style & (WS_EX_TRANSPARENT.0 as isize) != 0;
    if transparent == ignore {
        return;
    }

    let _ = win.set_ignore_cursor_events(ignore);
    // 验证 WS_EX_TRANSPARENT 是否真正生效（WebView2 可能静默失败），不一致则重试
    let mut verified = false;
    for _ in 0..3 {
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
        let transparent = style & (WS_EX_TRANSPARENT.0 as isize) != 0;
        if transparent == ignore {
            verified = true;
            break;
        }
        // 用 Tauri API 重试（内部会维护 tao flags）
        let _ = win.set_ignore_cursor_events(ignore);
    }
    if !verified {
        crate::log_line(&format!(
            "ignore_cursor: {ignore} 设置后未生效！style={:#x}",
            unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
        ));
    }
}

pub fn move_window_toward(
    win: &tauri::WebviewWindow,
    tx: f64,
    ty: f64,
    max_speed: f64,
    dt: f64,
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

        // 安全夹紧：按窗口实际尺寸确保窗口都在显示器工作区内
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        const EDGE_PAD: i32 = 4;
        let area = crate::screen::work_area_at(nx, ny);
        let clamped_x = nx.max(area.left + EDGE_PAD).min(area.left + area.width - w - EDGE_PAD);
        let clamped_y = ny.max(area.top + EDGE_PAD).min(area.top + area.height - h - EDGE_PAD);

        let _ = SetWindowPos(
            hwnd,
            None,
            clamped_x,
            clamped_y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOREDRAW,
        );
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
            if ny + bt < area.top - 60 { ny = area.top - 60 - bt; }
            if ny + bb > area.top + area.height { ny = area.top + area.height - bb; }
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
