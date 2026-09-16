/**
 * 歌词获取（LRCLIB，经 Rust 侧 fetch_lyrics 命令）+ localStorage 缓存。
 *
 * 返回结果区分三种"没有歌词"的情况，避免把"这首歌本来没歌词"误报成故障：
 *   - notfound     ：接口正常，但库里没有这首歌
 *   - instrumental ：接口正常，标为纯音乐（无歌词）
 *   - error        ：接口/网络失败（不写负缓存，下次还能再试）
 */
import { invoke } from "@tauri-apps/api/core";
import { parseLrc, pickBestLyrics, stripTitleLines, normalizeKey, type LyricLine, type LrclibItem } from "./LrcParser";

// v2：缓存里同时保存译文
const CACHE_KEY = "petra-lyrics-cache-v2";
const HIT_TTL_MS = 30 * 86400000; // 命中缓存 30 天
const MISS_TTL_MS = 6 * 3600000; // 确认"没有歌词"后 6 小时内不重复请求
const MAX_ENTRIES = 60;

export type LyricsMissReason = "notfound" | "instrumental" | "error";

export interface LyricsResult {
  lines: LyricLine[] | null;
  /** 中文译文（按时间戳对齐；没有则为空） */
  trans?: LyricLine[] | null;
  reason?: LyricsMissReason;
  detail?: string;
}

interface CacheEntry {
  lines: LyricLine[];
  trans?: LyricLine[];
  at: number;
  miss?: "notfound" | "instrumental";
}
type CacheMap = Record<string, CacheEntry>;

function loadCache(): CacheMap {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as CacheMap) : {};
  } catch {
    return {};
  }
}

function saveCache(cache: CacheMap): void {
  try {
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => cache[a].at - cache[b].at);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 忽略 */
  }
}

export function clearLyricsCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 忽略 */
  }
}

export async function getLyrics(
  title: string,
  artist: string,
  durationMs = 0,
  force = false,
): Promise<LyricsResult> {
  const key = normalizeKey(title) + "|" + normalizeKey(artist);
  if (key === "|") return { lines: null, reason: "notfound" };

  const now = Date.now();
  const cache = loadCache();
  const hit = force ? undefined : cache[key];
  if (hit) {
    if (!hit.miss && now - hit.at < HIT_TTL_MS) return { lines: hit.lines, trans: hit.trans ?? null };
    if (hit.miss && now - hit.at < MISS_TTL_MS) return { lines: null, reason: hit.miss };
  }

  let raw = "";
  try {
    raw = await invoke<string>("fetch_lyrics", { title, artist, album: "" });
  } catch (err) {
    // 接口失败：不写负缓存，换歌/下次播放还会再试
    const detail = err instanceof Error ? err.message : String(err);
    if (import.meta.env.DEV) console.warn("[lyrics] 接口失败", detail);
    return { lines: null, reason: "error", detail };
  }

  let items: LrclibItem[] = [];
  try {
    // 防御性去掉可能存在的 UTF-8 BOM（PowerShell 写文件时可能带上）
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as LrclibItem | LrclibItem[];
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    return { lines: null, reason: "error", detail: "歌词数据解析失败" };
  }

  const best = pickBestLyrics(items, title, artist, durationMs);
  if (best && best.syncedLyrics) {
    const lines = stripTitleLines(parseLrc(best.syncedLyrics), title);
    if (lines.length > 0) {
      // 译文（网易云 tlyric）：与原文同时间戳，逐行对齐
      const trans = best.translatedLyrics ? parseLrc(best.translatedLyrics) : [];
      cache[key] = { lines, trans: trans.length > 0 ? trans : undefined, at: now };
      saveCache(cache);
      return { lines, trans: trans.length > 0 ? trans : null };
    }
  }

  const instrumental = items.some((it) => it && it.instrumental === true);
  const reason: "notfound" | "instrumental" = instrumental ? "instrumental" : "notfound";
  cache[key] = { lines: [], at: now, miss: reason };
  saveCache(cache);
  return { lines: null, reason };
}
