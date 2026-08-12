use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SetWindowLongPtrW,
    SetWindowPos, GWL_EXSTYLE, SWP_NOZORDER, SWP_NOSIZE, SWP_NOACTIVATE, SWP_NOREDRAW,
    WS_EX_TRANSPARENT,
};

use crate::{CursorPos, WorkArea};

use std::sync::Mutex;
use std::time::{Duration, Instant};

static LAST_TC_TOGGLE: Mutex<Option<Instant>> = Mutex::new(None);
const TC_COOLDOWN: Duration = Duration::from_millis(150);

fn hwnd_of(win: &tauri::WebviewWindow) -> Option<HWND> {
    let handle = win.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => Some(HWND(h.hwnd.get() as *mut core::ffi::c_void)),
        _ => None,
    }
}

pub fn cursor_pos() -> CursorPos {
    let mut pt = POINT::default();
    let _ = unsafe { GetCursorPos(&mut pt) };
    CursorPos {
        x: pt.x,
        y: pt.y,
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

/// 依据光标与窗口矩形的关系，动态增删 WS_EX_TRANSPARENT。
pub fn keep_clickthrough_synced(win: &tauri::WebviewWindow) {
    let Some(hwnd) = hwnd_of(win) else {
        return;
    };

    unsafe {
        if IsWindowVisible(hwnd).as_bool() {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return;
            }
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            let inside = pt.x >= rect.left
                && pt.x <= rect.right
                && pt.y >= rect.top
                && pt.y <= rect.bottom;
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let transparent = style & (WS_EX_TRANSPARENT.0 as isize) != 0;
            if (inside && transparent) || (!inside && !transparent) {
                let now = Instant::now();
                let mut last = LAST_TC_TOGGLE.lock().unwrap();
                if last.map_or(true, |t| now.duration_since(t) >= TC_COOLDOWN) {
                    *last = Some(now);
                    let next = if inside {
                        style & !(WS_EX_TRANSPARENT.0 as isize)
                    } else {
                        style | (WS_EX_TRANSPARENT.0 as isize)
                    };
                    let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
                }
            }
        }
    }
}

/// 窗口向目标点平滑移动一步（mover 线程每 16ms 调用）。
/// max_speed 单位 px/s；到位后返回 true（由调用方清目标）。
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

        // 安全夹紧：确保整个 300×300 窗口都在显示器工作区内
        const WIN_SIZE: i32 = 300;
        const EDGE_PAD: i32 = 4;
        let area = crate::screen::work_area_at(nx, ny);
        let clamped_x = nx.max(area.left + EDGE_PAD).min(area.left + area.width - WIN_SIZE - EDGE_PAD);
        let clamped_y = ny.max(area.top + EDGE_PAD).min(area.top + area.height - WIN_SIZE - EDGE_PAD);

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