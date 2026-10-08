//! close_web_page（Linux）：如实说明不支持。
//!
//! 和 active_window_title 在 Linux 上的处境一样（见 lib.rs 里那段说明）：
//!  - Wayland 下合成器根本不向普通客户端暴露"谁开着哪些窗口/标签页"，连枚举窗口
//!    都做不到，更不用说找到某个标签页的关闭按钮；
//!  - X11 下虽然可以自己读窗口树，但要精确点到浏览器标签页的关闭按钮，能用的只有
//!    浏览器自己的调试接口（各家实现不同）或 xdotool 这类需要额外安装的工具，
//!    后者违反本项目"Linux 零新增系统库"的约定（见 Cargo.toml 里的 Linux 段）。
//!
//! 所以这里不给假承诺：直接回一句"做不到"，让小助手如实告诉用户。

use serde::Serialize;

/// 关闭结果（与 Windows / macOS 版同形，前端三边通用）。
#[derive(Serialize, Default)]
pub struct ClosePageResult {
    pub success: bool,
    pub message: String,
    pub closed: Option<String>,
    pub candidates: Vec<String>,
}

impl ClosePageResult {
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            closed: None,
            candidates: Vec::new(),
        }
    }
}

/// Linux 上不支持的实现：说明原因，并建议用户手动关。
pub fn close_web_page(_keyword: &str) -> ClosePageResult {
    ClosePageResult::failed(
        "Linux 版暂不支持关闭网页：Wayland 下拿不到窗口列表，X11 下要额外依赖才能点到标签页。请手动关闭该页面。",
    )
}
