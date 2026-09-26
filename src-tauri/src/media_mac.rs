//! macOS 正在播放媒体信息：占位实现（功能降级）。
//!
//! Windows 版读 SMTC（GlobalSystemMediaTransportControlsSessionManager），
//! 与播放器窗口是否可见无关。macOS 上等价的能力是私有框架 MediaRemote
//! （MRMediaRemoteGetNowPlayingInfo）：属未公开 API，随系统版本变动，
//! 且在沙箱 / 上架审核下不可靠。公开的 MPNowPlayingInfoCenter 只能读「本进程
//! 自己」登记的播放信息，拿不到别的 App 在放什么。
//!
//! 因此 mac 版只上报一次「没有会话」的空快照，前端据 hasSession=false
//! 不显示歌词气泡；接口形态与 Windows 版保持一致。

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 一次采样得到的"正在播放"快照（字段与 Windows 版完全一致）。
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    /// 是否存在活跃媒体会话
    pub has_session: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 来源应用（Windows 上是 cloudmusic.exe 这种）
    pub app_id: String,
    pub playing: bool,
    /// 播放器上报的进度（毫秒）；0 表示不提供
    pub position_ms: i64,
    /// 曲目总时长（毫秒）；0 表示不提供
    pub duration_ms: i64,
}

/// macOS 上暂不实现媒体会话轮询（原因见模块注释）。
/// 只发一次空快照，保证前端状态与「系统里没有媒体会话」时一致。
pub fn start_media_poller(app: AppHandle) {
    crate::log_line("[media] macOS 暂不支持系统媒体会话（SMTC 为 Windows 专有），上报空会话");
    let _ = app.emit("media:nowplaying", NowPlaying::default());
}
