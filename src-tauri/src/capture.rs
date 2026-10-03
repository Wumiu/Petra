//! 屏幕截图：把当前屏幕拍下来，编码成 PNG 的 base64 返回给前端。
//!
//! 用途是桌宠的"识图"能力 —— 用户要看屏幕时，前端把这个字符串按 OpenAI 兼容的
//! `image_url` 内容块塞进对话请求（DeepSeek 的 `deepseek-flash` 支持图片输入）。
//!
//! 实现走 `xcap`（跨平台截图库：Windows 走 Graphics Capture，macOS 走 Core Graphics）。
//!
//! ⚠️ **Linux 不在支持范围内**：xcap 在 Linux 上需要 libxcb / libxrandr / libpipewire /
//! libdbus / libwayland / libegl / libclang 等一批系统开发包，而本项目在 Linux 上
//! 刻意保持"不新增 crate、不需要用户装系统库"（见 Cargo.toml 顶部注释）。
//! 所以 xcap 只在**非 Linux** 平台引入，Linux 侧是 `capture_linux.rs` 里的桩 ——
//! 与 audio / launch / media / screen / trash 的平台分叉做法一致。

use std::io::Cursor;

use base64::Engine as _;

/// 抓主显示器，返回 **PNG 的 base64**（不带 `data:` 前缀）。
pub fn capture_png_base64() -> Result<String, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    if monitors.is_empty() {
        return Err("没有找到可用的显示器".into());
    }
    // 优先主显示器；拿不到主显标记时退回第一个
    let idx = monitors
        .iter()
        .position(|m| m.is_primary().unwrap_or(false))
        .unwrap_or(0);

    let shot = monitors[idx]
        .capture_image()
        .map_err(|e| format!("截屏失败: {e}"))?;

    let mut buf: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(shot)
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

/// 前端入口：截一张当前屏幕，返回 PNG 的 base64。
///
/// 走 `spawn_blocking`：截图要调系统 API，在 4K 屏上会明显阻塞，
/// 直接放在 async 上下文里同步调用会卡住运行时。
#[tauri::command]
pub async fn capture_screen() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(capture_png_base64)
        .await
        .map_err(|e| format!("截图任务异常: {e}"))?
}
