//! macOS 正在播放媒体信息：用 AppleScript 读 Apple Music / Spotify。
//!
//! 为什么不走私有框架：macOS 的等价能力是 MediaRemote（"正在播放"面板用的那套），
//! 属未公开 API、随系统版本变动；公开的 MPNowPlayingInfoCenter 只能读本进程自己登记的
//! 信息。所以这里走**公开的 AppleScript 自动化**：Apple Music 和 Spotify 的脚本字典
//! 都能给出歌名/歌手/专辑/播放进度/状态，覆盖绝大多数本地听歌场景。
//!
//! 代价与前提：
//!   1. 首次调用会弹一次「自动化」权限申请（按被控制的应用分别授权）。拒绝后本模块
//!      一直上报「没有会话」，其它功能不受影响。
//!   2. 只覆盖 Apple Music 与 Spotify；浏览器里放歌（YouTube/B站）读不到。
//!   3. 进度用浮点秒上报，精度足够歌词时钟锚定；前端 LyricClock 会在两次事件之间本地插值。
//!
//! 轮询频率按状态自适应（见下方常量）：osascript 每次调用要起一个进程（约 100ms），
//! 所以"没在放歌"时尽量少打扰 CPU。

use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const POLL_PLAYING_MS: u64 = 1500;
const POLL_PAUSED_MS: u64 = 3000;
const POLL_IDLE_MS: u64 = 5000;

/// 一次采样得到的"正在播放"快照（字段与 Windows 版完全一致）。
#[derive(Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    /// 是否存在活跃媒体会话
    pub has_session: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 来源应用（Windows 上是 cloudmusic.exe 这种，这里是 bundle id）
    pub app_id: String,
    pub playing: bool,
    /// 播放器上报的进度（毫秒）；0 表示不提供
    pub position_ms: i64,
    /// 曲目总时长（毫秒）；0 表示不提供
    pub duration_ms: i64,
}

/// 查询脚本：输出一行、tab 分隔的 7 个字段
/// （appId / 歌名 / 歌手 / 专辑 / 播放位置秒 / 时长 / 状态）。
///
/// 两个要点：
///   · 必须先判 `is running`，否则 `tell application "Music"` 会把没在运行的应用**启动**起来；
///   · 整个脚本不抛异常给外层，任何失败都返回空串（外层按"没有会话"处理）。
fn query_script() -> &'static str {
    r#"
set FS to (ASCII character 9)
set out to ""
try
  if application "Music" is running then
    tell application "Music"
      if player state is playing or player state is paused then
        set out to "com.apple.Music" & FS & (name of current track) & FS & (artist of current track) & FS & (album of current track) & FS & (player position) & FS & (duration of current track) & FS & (player state as text)
      end if
    end tell
  end if
end try
if out is "" then
  try
    if application "Spotify" is running then
      tell application "Spotify"
        if player state is playing or player state is paused then
          set out to "com.spotify.client" & FS & (name of current track) & FS & (artist of current track) & FS & (album of current track) & FS & (player position) & FS & (duration of current track) & FS & (player state as text)
        end if
      end tell
    end if
  end try
end if
return out
"#
}

/// 采样一次（失败/无会话都返回默认空快照）。
fn sample_now_playing() -> NowPlaying {
    let output = match Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(query_script())
        .stdin(Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            crate::log_verbose(&format!("[media] osascript 启动失败: {e}"));
            return NowPlaying::default();
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();
    if line.is_empty() {
        // 没有会话，或者用户拒绝了「自动化」权限（脚本内部 try 吃掉了错误）。
        // 真机排查靠这几行日志：osascript 的 stderr 会说明是权限问题还是脚本字典问题。
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if err.contains("not allowed") || err.contains("Not authorized") {
                crate::log_line("[media] 读取播放器被拒绝（系统设置 → 隐私与安全性 → 自动化）");
            } else if !err.is_empty() {
                crate::log_verbose(&format!("[media] osascript 报错: {err}"));
            }
        }
        return NowPlaying::default();
    }

    // splitn 保证第 7 段拿到剩余内容（歌名里万一有 tab 也不会把字段整体错位太多）
    let parts: Vec<&str> = line.splitn(7, '\t').collect();
    if parts.len() < 7 {
        return NowPlaying::default();
    }
    let app_id = parts[0].trim().to_string();
    let position_sec: f64 = parts[4].trim().parse().unwrap_or(0.0);
    let raw_duration: f64 = parts[5].trim().parse().unwrap_or(0.0);
    // 单位差异：Music 的 duration 是"秒"，Spotify 的是"毫秒"（它的脚本字典就是这个坑）
    let duration_ms = if app_id == "com.spotify.client" {
        raw_duration as i64
    } else {
        (raw_duration * 1000.0) as i64
    };

    NowPlaying {
        has_session: true,
        title: parts[1].trim().to_string(),
        artist: parts[2].trim().to_string(),
        album: parts[3].trim().to_string(),
        app_id,
        playing: parts[6].trim().eq_ignore_ascii_case("playing"),
        position_ms: (position_sec * 1000.0).max(0.0) as i64,
        duration_ms: duration_ms.max(0),
    }
}

/// 轮询线程：有会话就持续上报（前端靠它重新锚定歌词时钟），会话消失时补发一次空快照。
pub fn start_media_poller(app: AppHandle) {
    // 先发一次空快照，保证前端初始状态与「系统里没有媒体会话」一致
    let _ = app.emit("media:nowplaying", NowPlaying::default());

    std::thread::spawn(move || {
        crate::log_line("[media] macOS 走 AppleScript 读 Apple Music / Spotify");
        let mut had_session = false;
        loop {
            let np = sample_now_playing();
            let interval = if np.has_session {
                if np.playing {
                    POLL_PLAYING_MS
                } else {
                    POLL_PAUSED_MS
                }
            } else {
                POLL_IDLE_MS
            };
            // 有会话就每轮上报；没会话时只在"刚从有到无"的那一次补发
            if np.has_session || had_session {
                let _ = app.emit("media:nowplaying", np.clone());
            }
            had_session = np.has_session;
            std::thread::sleep(Duration::from_millis(interval));
        }
    });
}
