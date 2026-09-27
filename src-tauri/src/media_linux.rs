//! Linux 正在播放媒体信息：走 MPRIS（org.mpris.MediaPlayer2.*）D-Bus 接口。
//!
//! 为什么是 MPRIS：Wayland 下没有"读别的窗口/全局状态"这种能力，
//! 而 MPRIS 是播放器**主动公开**的标准接口 —— Firefox/Chromium、mpv、VLC、Spotify、
//! 网易云音乐等桌面客户端都实现它，既不需要辅助功能权限，也不依赖 X11。
//!
//! 为什么不直接连 D-Bus：那需要 zbus/dbus 之类的新依赖。这里用 playerctl
//! （MPRIS 的官方命令行工具，格式串稳定，并且能用 -a 把多条会话汇总成一行行输出），
//! 探测方式就是"进程起不来 / 退出码非零" —— 不带额外依赖，也不需要 dbus 开发头文件。
//! 代价：用户没装 playerctl 时读不到，此时按"没有媒体会话"降级（见 start_media_poller）。
//!
//! 单位：MPRIS 规范的 mpris:length 与 position 都是**微秒**，这里统一换算成毫秒，
//! 与 Windows / macOS 版的 positionMs / durationMs 字段语义对齐。
//!
//! TODO(mpris): 若要摆脱对 playerctl 的依赖，可以走 busctl --user（systemd 自带）：
//! 先 ListNames 找 org.mpris.MediaPlayer2.*，再 Get 各属性。但 busctl 输出是 GVariant
//! 文本，需要自己解析 variant / 数组 / 字典，本轮没有 Linux 真机可回归，先不引入这块复杂度。

use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const POLL_PLAYING_MS: u64 = 1500;
const POLL_PAUSED_MS: u64 = 3000;
const POLL_IDLE_MS: u64 = 5000;

/// playerctl 的格式串，字段顺序与 parse_line 一一对应：
/// 状态 / 播放器名 / 歌名 / 歌手 / 专辑 / 总时长(微秒) / 播放位置(微秒)。
/// 用 mpris:length 这个原始元数据键而不是某个简写别名，避免不同 playerctl 版本的别名差异。
const FORMAT: &str = "{{status}}\t{{playerName}}\t{{xesam:title}}\t{{xesam:artist}}\t{{xesam:album}}\t{{mpris:length}}\t{{position}}";

/// 一次采样得到的"正在播放"快照（字段与 Windows / macOS 版完全一致）。
#[derive(Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    /// 是否存在活跃媒体会话
    pub has_session: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 来源应用（Windows 上是 cloudmusic.exe，这里是 MPRIS 的 bus name）
    pub app_id: String,
    pub playing: bool,
    /// 播放器上报的进度（毫秒）；0 表示不提供
    pub position_ms: i64,
    /// 曲目总时长（毫秒）；0 表示不提供
    pub duration_ms: i64,
}

/// 微秒（MPRIS 的单位）→ 毫秒。playerctl 对不支持的字段会输出空串，按 0 处理。
fn micros_to_ms(raw: &str) -> i64 {
    raw.trim()
        .parse::<f64>()
        .ok()
        .map(|v| (v / 1000.0).round() as i64)
        .unwrap_or(0)
        .max(0)
}

/// 解析 playerctl 的一行输出。返回 (优先级, 快照)；None 表示这行不算有效会话。
fn parse_line(line: &str) -> Option<(u8, NowPlaying)> {
    // splitn 保证第 7 段拿到剩余内容，歌名里万一有 tab 也不会把字段整体错位太多
    let parts: Vec<&str> = line.splitn(7, '\t').collect();
    if parts.len() < 7 {
        return None;
    }
    let title = parts[2].trim().to_string();
    if title.is_empty() {
        return None;
    }
    let status = parts[0].trim().to_ascii_lowercase();
    let rank = match status.as_str() {
        "playing" => 2u8,
        "paused" => 1u8,
        // Stopped：播放器可能还列着上一首，按"没有会话"处理，避免歌词气泡挂着旧歌
        _ => return None,
    };
    let player = parts[1].trim();
    // MPRIS 的 bus name 是 org.mpris.MediaPlayer2.<playerName>
    let app_id = if player.is_empty() {
        String::new()
    } else {
        format!("org.mpris.MediaPlayer2.{player}")
    };
    Some((
        rank,
        NowPlaying {
            has_session: true,
            title,
            artist: parts[3].trim().to_string(),
            album: parts[4].trim().to_string(),
            app_id,
            playing: status == "playing",
            // parts[5] 是 mpris:length（总时长），parts[6] 才是 position，不要写反
            duration_ms: micros_to_ms(parts[5]),
            position_ms: micros_to_ms(parts[6]),
        },
    ))
}

/// 采样一次。第二个返回值表示 playerctl 是否可用（起不来 = 没装）。
fn sample_now_playing() -> (NowPlaying, bool) {
    // -a/--all-players：多开播放器（浏览器 + 本地播放器）时每行一条，好挑在播的那个
    let output = match Command::new("playerctl")
        .args(["-a", "metadata", "--format", FORMAT])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            crate::log_verbose(&format!("[media] playerctl 启动失败: {e}"));
            return (NowPlaying::default(), false);
        }
    };
    if !output.status.success() {
        // 没有播放器时 playerctl 以非零退出，这是"没有会话"而不是故障
        return (NowPlaying::default(), true);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut best: Option<(u8, NowPlaying)> = None;
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((rank, np)) = parse_line(line) else {
            continue;
        };
        // 在播的会话优先于暂停的；同优先级保留第一行（playerctl 的输出顺序稳定）
        if best.as_ref().map(|(r, _)| rank > *r).unwrap_or(true) {
            best = Some((rank, np));
        }
    }
    match best {
        Some((_, np)) => (np, true),
        None => (NowPlaying::default(), true),
    }
}

/// 轮询线程：有会话就持续上报（前端靠它重新锚定歌词时钟），会话消失时补发一次空快照。
pub fn start_media_poller(app: AppHandle) {
    // 先发一次空快照，保证前端初始状态与「系统里没有媒体会话」一致
    let _ = app.emit("media:nowplaying", NowPlaying::default());

    std::thread::spawn(move || {
        crate::log_line("[media] Linux 走 MPRIS（playerctl）读取正在播放");
        let mut had_session = false;
        let mut reported_missing = false;
        loop {
            let (np, available) = sample_now_playing();
            if !available && !reported_missing {
                reported_missing = true;
                crate::log_line(
                    "[media] 未找到 playerctl，读不到 MPRIS，已降级为「无媒体会话」（歌词气泡不显示）",
                );
            }
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
