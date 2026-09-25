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

/// 会话内容分级：决定这条 SMTC 会话是否当作"歌曲"用于歌词。
/// 数字越大越优先；0 = 视频/非音乐，应忽略（不弹歌词气泡）。
///
/// 设计取舍：
/// - 桌面端音乐播放器（网易云/QQ音乐/酷狗…）一定是歌，给最高分；
///   这样"音乐 App 在放歌 + 浏览器在放视频"时永远选音乐 App。
/// - 浏览器一条 SMTC 会话里拿不到网址，只能靠标签标题猜：
///   只有标题明确像音乐站（网易云音乐/QQ音乐/YouTube Music…）才当音乐；
///   其余浏览器会话（B站、YouTube、爱奇艺…）一律按视频处理，宁可不显示歌词。
fn session_rank(app_id: &str, title: &str) -> u8 {
    let app = app_id.to_lowercase();
    let t = title.trim().to_lowercase();

    // 1) 桌面音乐播放器：一定是音乐，优先级最高。
    const MUSIC_APPS: &[&str] = &[
        "cloudmusic", "netease", "qqmusic", "kugou", "kuwo", "foobar", "aimp",
        "musicbee", "spotify", "itunes", "apple music", "lx music", "lxmusic",
        "yesplaymusic", "dopamine", "hxmusic", "listen1", "lx-music",
    ];
    if MUSIC_APPS.iter().any(|k| app.contains(k)) {
        return 3;
    }

    // 2) 浏览器：拿不到网址，只能凭标题猜。
    const BROWSERS: &[&str] = &[
        "chrome", "msedge", "edge", "firefox", "brave", "opera", "vivaldi",
        "arc", "webview2",
    ];
    let is_browser = BROWSERS.iter().any(|k| app.contains(k));
    if is_browser {
        // 标题里明确是音乐站 → 当音乐。
        const MUSIC_SITES: &[&str] = &[
            "网易云音乐", "netease cloud", "music.163", "qq音乐", "qq music",
            "酷狗音乐", "酷我音乐", "youtube music", "spotify", "apple music",
            "music.apple", "咪咕音乐", "豆瓣fm", "joox",
        ];
        if MUSIC_SITES.iter().any(|k| t.contains(k)) {
            return 2;
        }
        // 否则当视频，不显示歌词。
        return 0;
    }

    // 3) 未知来源（含 VLC 等通用播放器）：保守当音乐，保持旧行为。
    1
}

/// 在所有会话里挑"最像音乐"的那条。
/// 返回 (rank, 会话快照)；播放中的会话优先于暂停的。
fn pick_best_session(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
) -> Option<(u8, NowPlaying)> {
    let list = manager.GetSessions().ok()?;
    let count = list.Size().unwrap_or(0);
    let mut best_playing: Option<(u8, NowPlaying)> = None;
    let mut best_paused: Option<(u8, NowPlaying)> = None;
    let consider = |slot: &mut Option<(u8, NowPlaying)>, s: &GlobalSystemMediaTransportControlsSession| {
        let np = read_session(s);
        if np.title.is_empty() && np.app_id.is_empty() {
            return;
        }
        let rank = session_rank(&np.app_id, &np.title);
        let take = match slot.as_ref() {
            Some((r, _)) => rank > *r,
            None => true,
        };
        if take {
            *slot = Some((rank, np));
        }
    };
    for i in 0..count {
        let Ok(s) = list.GetAt(i) else { continue };
        let is_playing = s
            .GetPlaybackInfo()
            .ok()
            .and_then(|info| info.PlaybackStatus().ok())
            .map(|st| st == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
            .unwrap_or(false);
        if is_playing {
            consider(&mut best_playing, &s);
        } else {
            consider(&mut best_paused, &s);
        }
    }
    // 兜底：列表里没有可用会话时，回退到系统"当前会话"（旧行为）。
    if best_playing.is_none() && best_paused.is_none() {
        if let Ok(cur) = manager.GetCurrentSession() {
            consider(&mut best_paused, &cur);
        }
    }
    best_playing.or(best_paused)
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
        let mut last_identity = String::new();
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
                    // 不再"拿第一个播放中的会话"，而是按内容分级挑最像音乐的那条：
                    // 音乐 App(3) > 浏览器音乐站(2) > 未知(1) > 浏览器视频(0，忽略)。
                    let picked = pick_best_session(&manager);
                    match picked {
                        Some((rank, np)) if rank > 0 => {
                            let identity = format!("{}|{}|{}", np.title, np.artist, np.app_id);
                            if identity != last_identity {
                                last_identity = identity;
                                crate::log_warn(&format!(
                                    "[media] 选中会话 rank={} app={} title={:?}",
                                    rank, np.app_id, np.title
                                ));
                            }
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
                        // 只有视频会话（rank=0）或根本没有会话：当作"没在放音乐"，不弹歌词。
                        _ => {
                            if last_key != "__none__" {
                                last_key = String::from("__none__");
                                last_identity = String::new();
                                let _ = app.emit("media:nowplaying", NowPlaying::default());
                            }
                        }
                    }
                }
                Err(e) => {
                    fail_streak += 1;
                    if fail_streak == 1 || fail_streak % 30 == 0 {
                        crate::log_warn(&format!("[media] SMTC 不可用：{e}"));
                    }
                }
            }
            std::thread::sleep(interval);
        }
    });
}
