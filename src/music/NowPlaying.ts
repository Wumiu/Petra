/**
 * 正在播放 → 歌词气泡：把 SMTC 元数据、本地时钟、歌词串联起来。
 *
 * 数据流：
 *   Rust SMTC 轮询 → media:nowplaying → 换歌/状态变化 → 本模块
 *   主循环音频能量 → noteAudioLevel() → 时钟锚点（起播/循环/失准）
 *   每 500ms tick → 当前行号 → 歌词气泡
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LyricClock } from "./LyricClock";
import { lineIndexAt, lookupTranslation, cleanTitle, lyricQueryPosition, sourceForPlayer, type LyricLine } from "./LrcParser";
import { LyricFollower } from "./LyricFollow";
import { loadSettings, saveSettings } from "../utils/settings";
import { getLyrics } from "./Lyrics";
import {
  showLyricLine,
  showLyricHint,
  showSongBubble,
  clearLyricBubbles,
  setLyricBubbleEnabled,
} from "./LyricBubble";

export interface MediaPayload {
  hasSession: boolean;
  title: string;
  artist: string;
  album: string;
  appId: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
}

/** 轮询间隔：越小行切换越准（500ms 会带来平均 ~250ms 的"慢半拍"） */
const TICK_MS = 200;
/**
 * 歌词提前量：LRC 时间戳普遍略滞后于人声，且轮询本身有 ≤TICK_MS 的延迟，
 * 因此按"提前 200ms"判定当前行，抵消这两部分偏差。
 */
const LYRIC_LEAD_MS = 200;

/** 最近一次音频能量（0~1）：用于判断换歌瞬间是否处在"两首之间的静音空隙" */
let lastAudioLevel = 0;
/** 跟唱节流：只有真的显示了才记账，被节流的行下个 tick 补（见 LyricFollow） */
const follower = new LyricFollower();

let clock: LyricClock | null = null;
let lines: LyricLine[] | null = null;
/** 中文译文（与原文同时间戳） */
let transLines: LyricLine[] | null = null;
/** 翻译开关（启动时读设置，菜单切换后立即生效） */
let translateOn = true;
/**
 * 本首的同步微调（毫秒，正数=歌词提前）。
 * 按歌从设置里读一次缓存住 —— tick 每 200ms 跑一次，不能每次都去解析设置 JSON。
 */
let lyricOffsetMs = 0;
/** 微调步长：一次点按调整这么多（3 下≈1 秒，够快也够细） */
export const LYRIC_OFFSET_STEP_MS = 300;
let currentKey = "";
/** 播放器是否在播放（用于"跟唱"状态） */
let playing = false;
/** 本首已确认没有歌词（纯音乐 / 库里没有）→ 静默不跟唱，也不再提示 */
let noLyrics = false;
let driftNotified = false;
let missingNotified = false;
let tickTimer: number | null = null;
let unlisten: UnlistenFn | null = null;
let running = false;

/** 接口失败时的静默重试（LRCLIB 有突发限流，用户不该看到"没有歌词"） */
let retryTimer: number | null = null;
let retryCount = 0;
const MAX_RETRIES = 3;
/** 失败退避：20s → 45s → 90s（两个来源都失败时才会走到这里） */
const RETRY_DELAYS_MS = [20000, 45000, 90000];

function resetTrackState(): void {
  clock = null;
  lines = null;
  currentKey = "";
  follower.reset();
  playing = false;
  noLyrics = false;
  driftNotified = false;
  missingNotified = false;
  retryCount = 0;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  clearLyricBubbles();
}

/** 取歌词：成功则启用；接口失败则后台重试；确认无歌词/纯音乐才提示一次 */
function loadLyricsFor(
  key: string,
  title: string,
  artist: string,
  durationMs: number,
  preferredSource: string | null,
  force = false,
): void {
  void getLyrics(title, artist, durationMs, force, preferredSource).then((res) => {
    if (currentKey !== key) return; // 已换歌，丢弃结果

    if (res.lines && res.lines.length > 0) {
      lines = res.lines;
      transLines = res.trans ?? null;
      retryCount = 0;
      return;
    }

    if (res.reason === "error") {
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
        retryCount++;
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          if (currentKey === key) loadLyricsFor(key, title, artist, durationMs, preferredSource);
        }, delay);
        return;
      }
      if (!missingNotified) {
        missingNotified = true;
        showLyricHint("⚠️ 歌词接口暂时不可用，切歌后会自动重试", 6000);
      }
      return;
    }

    // 两个来源都没有：不跟唱。纯音乐完全静默；其余给一次轻提示（否则用户无法判断是坏了还是没有）
    noLyrics = true;
    lines = null;
    transLines = null;
    if (res.reason !== "instrumental" && !missingNotified) {
      missingNotified = true;
      showLyricHint("🎵 这首歌找不到可用的歌词", 4000);
    }
  });
}

async function onMedia(p: MediaPayload): Promise<void> {
  const rawTitle = p.title || "";
  const title = cleanTitle(rawTitle);
  const artist = (p.artist || "").trim();

  if (!p.hasSession || !title) {
    if (currentKey) resetTrackState();
    return;
  }

  const key = title + "|" + artist;
  if (key !== currentKey) {
    currentKey = key;
    clock = new LyricClock();
    clock.setTrack(title, artist);
    // 处在两首歌之间的静音空隙时，用"第一声"把 0 秒锚准；否则保持发现时刻计时
    clock.markPendingOnset(lastAudioLevel < 0.03);
    lines = null;
    transLines = null;
    // 每首歌的歌词时间戳偏差都不一样：这首的微调从设置里取（没有就是 0）
    lyricOffsetMs = loadSettings().lyricOffsets?.[key] ?? 0;
    // 换歌立刻允许显示新歌的第一行（旧代码在这里没清节流时间戳，新歌首行常被吃掉）
    follower.reset();
    noLyrics = false;
    driftNotified = false;
    missingNotified = false;
    clearLyricBubbles();
    showSongBubble(title, artist);
    if (p.durationMs > 0 && p.positionMs > 0) clock.setServerPosition(p.positionMs);

    // 优先用"正在播放的那个播放器自家"的歌词：它和正在响的音频是同一次对齐，
    // 跨来源混用会让整首歌偏掉（用户报的"有时候快有时候慢"里最普遍的一条）
    loadLyricsFor(key, title, artist, p.durationMs, sourceForPlayer(p.appId));
  }

  playing = p.playing === true;
  if (clock) {
    clock.setPlaying(p.playing);
    if (p.positionMs > 0) clock.setServerPosition(p.positionMs);
  }
}

/**
 * 是否处于"跟唱"状态：正在播放 + 这首歌有歌词 + 时钟可信且未失准。
 * 渲染层据此跳过音乐随机单眼眨眼（那个 0.35 秒脉冲会被缓动吃掉大半，看起来像"眨眼不完全"）。
 */
export function isSinging(): boolean {
  if (!running || noLyrics || !playing || !clock) return false;
  if (!lines || lines.length === 0) return false;
  return clock.trusted;
}

function tick(): void {
  const c = clock;
  if (!c || !lines || lines.length === 0) return;

  if (c.drift) {
    if (!driftNotified) {
      driftNotified = true;
      clearLyricBubbles();
      showLyricHint("🔄 检测到进度跳转，本首歌先不显示歌词了（下一首自动恢复）", 6000);
    }
    return;
  }

  const idx = lineIndexAt(lines, lyricQueryPosition(c.positionMs(), LYRIC_LEAD_MS, lyricOffsetMs));
  const show = follower.next(idx, Date.now(), c.generationCount);
  if (show === null) return;
  const line = lines[show];
  const trans = translateOn && transLines ? lookupTranslation(transLines, line.timeMs) : null;
  showLyricLine(line.text, trans);
}

/** 启动：订阅媒体事件 + 定时推导当前行 */
export function startMusicLyrics(): void {
  if (running) return;
  running = true;
  translateOn = loadSettings().lyricsTranslate !== false;
  setLyricBubbleEnabled(true);
  void listen<MediaPayload>("media:nowplaying", (e) => {
    void onMedia(e.payload);
  }).then((un) => {
    if (!running) {
      un();
      return;
    }
    unlisten = un;
  });
  tickTimer = window.setInterval(tick, TICK_MS);
}

export function stopMusicLyrics(): void {
  running = false;
  setLyricBubbleEnabled(false);
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  resetTrackState();
}

/** 翻译开关（菜单切换后调用，立即生效） */
export function setLyricsTranslate(on: boolean): void {
  translateOn = on;
}

/** 当前这首歌的同步微调（毫秒，正数=提前） */
export function getLyricOffsetMs(): number {
  return lyricOffsetMs;
}

/**
 * 调整当前这首歌的歌词同步：delta 为正 = 歌词提前，为 0 = 复位。
 *
 * 为什么是"按歌记"：在线歌词来自社区（LRCLIB），同一首歌的时间戳可能整体偏半秒，
 * 换一首又刚好准 —— 一个全局提前量永远救不全。用户按歌调一次，之后这首歌一直准。
 * 返回调整后的值（毫秒）。
 */
export function adjustLyricOffset(deltaMs: number): number {
  const key = currentKey;
  if (!key) {
    showLyricHint("先在放一首歌，再调同步", 2500);
    return 0;
  }
  const next = deltaMs === 0 ? 0 : Math.max(-10000, Math.min(10000, lyricOffsetMs + deltaMs));
  lyricOffsetMs = next;
  const s = loadSettings();
  if (!s.lyricOffsets) s.lyricOffsets = {};
  if (next === 0) delete s.lyricOffsets[key];
  else s.lyricOffsets[key] = next;
  saveSettings(s);
  // 立刻按新偏移重画这一行，别等下一句
  follower.reset();
  tick();
  showLyricHint(
    next === 0
      ? "🎯 歌词同步已复位（本首）"
      : `🎯 歌词${next > 0 ? "提前" : "延后"} ${(Math.abs(next) / 1000).toFixed(1)}s（本首记住）`,
    2500,
  );
  return next;
}

/** 主循环喂入音频能量（0~1）与帧间隔，用于起播/循环/失准判定 */
export function noteAudioLevel(level: number, dtMs: number): void {
  lastAudioLevel = level;
  if (!running || !clock) return;
  clock.noteAudio(level, dtMs);
}

/** 供调试/测试：当前推算进度与可信度 */
export function debugState(): { key: string; positionMs: number; trusted: boolean; lines: number } {
  if (!clock) return { key: "", positionMs: 0, trusted: true, lines: 0 };
  return {
    key: clock.trackKey,
    positionMs: clock.positionMs(),
    trusted: clock.trusted,
    lines: lines ? lines.length : 0,
  };
}
