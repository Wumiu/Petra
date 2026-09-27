//! Linux 音频回环捕获：占位实现（与 macOS 版同样降级）。
//!
//! Windows 版用 WASAPI 的 AUDCLNT_STREAMFLAGS_LOOPBACK 抓系统默认输出设备的波形，
//! 切块后通过 audio:pcm 事件推给前端做律动。
//!
//! Linux 上其实有公开的等价通路：PipeWire / PulseAudio 的 monitor 源
//! （pactl list short sources 里以 .monitor 结尾的那一条）就是本机输出的镜像，
//! 用 pacat --record -d <monitor> 或 pw-record 能直接读到 PCM，
//! 不需要装虚拟声卡，也不需要 root。
//!
//! 本轮不做，理由不是"没有能力"，而是取舍：
//!   1. 本产品在 Linux 上只保留「歌词气泡」，「跟随音乐（回环跟唱）」入口已从前端菜单移除；
//!   2. 要做就得同时处理 PipeWire 与 PulseAudio 两套栈的探测、采样率/声道协商，
//!      以及 monitor 源随默认输出设备切换而失效后的重连，是独立一块工程量；
//!   3. 前端对"收不到 audio:pcm"本来就有兜底（不显示律动），留空不会影响其它功能。
//!
//! TODO(audio): 将来若要补回环，先用 pactl list short sources 找 .monitor 源，
//! 再用 pacat --record --raw --format=s16le --rate=<rate> --channels=2 -d <monitor>
//! 起子进程读 PCM，最后按 Windows 版相同的事件名与字节格式（audio:pcm）推给前端。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::AppHandle;

/// Linux 上暂不实现系统回环捕获（原因见模块注释）。
pub fn start_loopback_capture(_app: AppHandle, _enabled: Arc<AtomicBool>) {
    crate::log_line("[audio] Linux 暂不实现系统回环录音（monitor 源采集未纳入本轮），已跳过");
}
