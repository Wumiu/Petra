//! 正在播放媒体信息（Windows SMTC / 系统媒体会话）。
//! 只读取系统媒体会话的元数据与播放状态：不要求播放器窗口可见、不需要第三方插件。
//! 注意：部分播放器（实测网易云）不提供时间轴，Position/EndTime 恒为 0，
//! 此时前端会回退到"音频锚点 + 本地计时"。

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::HSTRING;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// 一次采样得到的"正在播放"快照
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    /// 是否存在活跃媒体会话
    pub has_session: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 来源应用（如 cloudmusic.exe）
    pub app_id: String,
    pub playing: bool,
    /// 播放器上报的进度（毫秒）；0 表示不提供
    pub position_ms: i64,
    /// 曲目总时长（毫秒）；0 表示不提供
    pub duration_ms: i64,
}

fn hstr(h: &HSTRING) -> String {
    String::from_utf16_lossy(h.as_wide())
}

/// 读取一个会话的当前信息（任何字段读取失败都不影响其它字段）
fn read_session(session: &GlobalSystemMediaTransportControlsSession) -> NowPlaying {
    let mut np = NowPlaying {
        has_session: true,
        ..Default::default()
    };
    np.app_id = session
        .SourceAppUserModelId()
        .map(|h| hstr(&h))
        .unwrap_or_default();

    if let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) {
        np.title = props.Title().map(|h| hstr(&h)).unwrap_or_default();
        np.artist = props.Artist().map(|h| hstr(&h)).unwrap_or_default();
        np.album = props.AlbumTitle().map(|h| hstr(&h)).unwrap_or_default();
    }

    if let Ok(info) = session.GetPlaybackInfo() {
        if let Ok(st) = info.PlaybackStatus() {
            np.playing = st == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
        }
    }

    if let Ok(tl) = session.GetTimelineProperties() {
        if let Ok(p) = tl.Position() {
            np.position_ms = p.Duration / 10_000; // 100ns → ms
        }
        if let Ok(e) = tl.EndTime() {
            np.duration_ms = e.Duration / 10_000;
        }
    }
    np
}

/// 后台线程：每秒轮询当前媒体会话，关键字段变化时通过 media:nowplaying 推送。
/// 连续失败后退避到 5 秒一次，避免在不支持 SMTC 的系统上空转。
pub fn start_media_poller(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let mut last_key = String::from("__init__");
        let mut fail_streak: u32 = 0;
        loop {
            // 500ms 轮询：换歌发现得越早，"起播锚点"越准（SMTC 不提供进度时全靠它）
            let interval = if fail_streak >= 3 {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(500)
            };

            match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
                .and_then(|op| op.get())
            {
                Ok(manager) => {
                    fail_streak = 0;
                    match manager.GetCurrentSession() {
                        Ok(session) => {
                            let np = read_session(&session);
                            let key = format!(
                                "{}|{}|{}|{}|{}",
                                np.title,
                                np.artist,
                                if np.playing { 1 } else { 0 },
                                np.position_ms / 1000,
                                np.app_id
                            );
                            if key != last_key {
                                last_key = key;
                                let _ = app.emit("media:nowplaying", np);
                            }
                        }
                        Err(_) => {
                            if last_key != "__none__" {
                                last_key = String::from("__none__");
                                let _ = app.emit("media:nowplaying", NowPlaying::default());
                            }
                        }
                    }
                }
                Err(e) => {
                    fail_streak += 1;
                    if fail_streak == 1 || fail_streak % 30 == 0 {
                        crate::log_line(&format!("[media] SMTC 不可用：{e}"));
                    }
                }
            }
            std::thread::sleep(interval);
        }
    });
}
