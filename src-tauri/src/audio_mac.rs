//! macOS 音频回环捕获：占位实现（功能降级）。
//!
//! Windows 版用 WASAPI 的 AUDCLNT_STREAMFLAGS_LOOPBACK 抓系统默认输出设备的
//! 波形，切块后通过 audio:pcm 事件推给前端做律动。
//!
//! macOS 没有等价的公开 API：
//!   * CoreAudio 的「进程内音频」需要 macOS 14.4+ 的 AudioHardwareCreateProcessTap
//!     （还得自己写 FFI 绑定）；
//!   * 老办法（Soundflower / BlackHole）要求用户额外安装虚拟声卡驱动。
//!
//! 为了不引入新依赖、也不给用户添安装步骤，mac 版先不提供系统回环录音。
//! 前端收不到 audio:pcm 事件时会自动降级（不显示律动），其它功能不受影响。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::AppHandle;

/// macOS 上暂不实现系统回环捕获（原因见模块注释）。
pub fn start_loopback_capture(_app: AppHandle, _enabled: Arc<AtomicBool>) {
    crate::log_line("[audio] macOS 暂不支持系统回环录音（无 WASAPI 等价 API），已跳过");
}
