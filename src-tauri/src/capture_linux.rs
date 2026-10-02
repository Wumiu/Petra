//! Linux 侧的屏幕截图：**暂不提供**，只给一个保持 API 一致的桩。
//!
//! 为什么不实现：跨平台截图库 xcap 在 Linux 上需要 libxcb / libxrandr / libpipewire /
//! libdbus / libwayland / libegl / libclang 一批系统开发包，而本项目在 Linux 上刻意
//! 保持"不新增 crate、不需要用户额外装系统库"（见 Cargo.toml 顶部注释）。
//! 因此 xcap 只在非 Linux 平台引入，这里返回"不支持"，前端会拿到一条明确的错误。
//!
//! 后续要支持 Linux 时可以在这里补：X11 下直接用 xcb 抓屏，Wayland 下走 xdg-desktop-portal
//! 的 Screenshot 接口（两者都比引入 xcap 更贴合本项目的依赖策略）。
//!
//! 与 `audio_linux.rs` / `launch_linux.rs` 同样是"平台桩"的做法。

/// 前端入口：Linux 上暂不支持，返回明确的错误信息。
///
/// ⚠️ 这条字符串会**直接显示给用户**（前端 toast 里），所以别带源码路径之类的开发者信息。
/// 实现细节的说明都在上面的模块注释里。
#[tauri::command]
pub async fn capture_screen() -> Result<String, String> {
    Err("Linux 版暂不支持屏幕截图".into())
}
