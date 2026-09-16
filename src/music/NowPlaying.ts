/**
 * 正在播放 → 歌词气泡：把 SMTC 元数据、本地时钟、歌词串联起来。
 *
 * 数据流：
 *   Rust SMTC 轮询 → media:nowplaying → 换歌/状态变化 → 本模块
 *   主循环音频能量 → noteAudioLevel() → 时钟锚点（起播/循环/失准）
 *   每 500ms tick → 当前行号 → 歌词气泡
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LyricClock } from "./LyricClock";
import { lineIndexAt, lookupTranslation, cleanTitle, type LyricLine } from "./LrcParser";
import { loadSettings } from "../utils/settings";
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
/** 换行气泡最小间隔：歌词密集时不刷屏，"时不时跳一下" */
const MIN_BUBBLE_GAP_MS = 2500;

let clock: LyricClock | null = null;
let lines: LyricLine[] | null = null;
/** 中文译文（与原文同时间戳） */
let transLines: LyricLine[] | null = null;
/** 翻译开关（启动时读设置，菜单切换后立即生效） */
let translateOn = true;
let currentKey = "";
let lastIndex = -1;
/** 播放器是否在播放（用于"跟唱"状态） */
let playing = false;
/** 本首已确认没有歌词（纯音乐 / 库里没有）→ 静默不跟唱，也不再提示 */
let noLyrics = false;
let lastBubbleAt = 0;
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
  lastIndex = -1;
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
function loadLyricsFor(key: string, title: string, artist: string, durationMs: number, force = false): void {
  void getLyrics(title, artist, durationMs, force).then((res) => {
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
          if (currentKey === key) loadLyricsFor(key, title, artist, durationMs);
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
    lastIndex = -1;
    noLyrics = false;
    driftNotified = false;
    missingNotified = false;
    clearLyricBubbles();
    showSongBubble(title, artist);
    if (p.durationMs > 0 && p.positionMs > 0) clock.setServerPosition(p.positionMs);

    loadLyricsFor(key, title, artist, p.durationMs);
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

  const idx = lineIndexAt(lines, c.positionMs() + LYRIC_LEAD_MS);
  if (idx < 0 || idx === lastIndex) return;
  lastIndex = idx;

  const now = Date.now();
  if (now - lastBubbleAt < MIN_BUBBLE_GAP_MS) return;
  lastBubbleAt = now;
  const line = lines[idx];
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
