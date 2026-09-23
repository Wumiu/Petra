/**
 * 日记事件采集器
 * 静默收集当天"主人做了什么"，写入 localStorage，供日记生成使用。
 *
 * 分两类存：
 *  1. 事件列表（聊天/提醒/问候/摸头/小游戏）—— 有时序，保留最近 100 条
 *  2. 用量统计（前台应用时长、听过的歌）—— 按 key 聚合，不占事件条数，
 *     否则每 5 分钟一条的应用采样会把聊天记录挤出去
 * 都保留最近 90 天，日记写完即清。
 */

import { loadSettings } from "../../utils/settings";

/** 日记功能关掉时不再采集：既不占 localStorage，也不留隐私记录 */
function trackingEnabled(): boolean {
  try {
    return loadSettings().diary?.enabled !== false;
  } catch {
    return true;
  }
}

export type DiaryEventType = "chat" | "reminder_done" | "greeting" | "interaction" | "game";

export interface DiaryEvent {
  type: DiaryEventType;
  summary: string;
  timestamp: number;
}

export interface AppUsage {
  app: string;
  minutes: number;
}

export interface MusicTrack {
  label: string;
  count: number;
}

const MAX_EVENTS_PER_DAY = 100;
/** 一天最多记几个应用（多了也写不进日记，还会撑爆 localStorage） */
const MAX_APPS_PER_DAY = 12;
/** 一天最多记几首歌 */
const MAX_TRACKS_PER_DAY = 40;
const RETENTION_DAYS = 90;

/** 本地日期字符串 YYYY-MM-DD（统一用本地时区） */
function localDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayKey(): string {
  return localDateStr(new Date());
}

function storageKey(date?: string): string {
  return `petra-diary-events-${date ?? todayKey()}`;
}

function appsKey(date?: string): string {
  return `petra-diary-apps-${date ?? todayKey()}`;
}

function musicKey(date?: string): string {
  return `petra-diary-music-${date ?? todayKey()}`;
}

/** 安全截断：避免截断半个 emoji 或 UTF-16 代理对 */
function safeSlice(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  // Array.from 正确处理 Unicode 码点
  return Array.from(str).slice(0, maxLen).join("");
}

/** 读一个 JSON 对象（失败给空对象） */
function readMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 清理过期 key（事件 + 用量统计，保留最近 RETENTION_DAYS 天） */
export function cleanupOldEvents(): void {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = localDateStr(cutoff);
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith("petra-diary-")) continue;
      const date = key.replace(/^petra-diary-(events|apps|music)-/, "");
      if (date && date < cutoffStr) toRemove.push(key);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch { /* 忽略 */ }
}

/** 读取指定日期的事件列表 */
export function getEvents(date?: string): DiaryEvent[] {
  try {
    const raw = localStorage.getItem(storageKey(date));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** 记录一条事件 */
export function trackEvent(event: Omit<DiaryEvent, "timestamp">): void {
  if (!trackingEnabled()) return;
  try {
    const key = storageKey();
    const events: DiaryEvent[] = getEvents();
    events.push({
      ...event,
      summary: safeSlice(event.summary, 80),
      timestamp: Date.now(),
    });
    localStorage.setItem(key, JSON.stringify(events.slice(-MAX_EVENTS_PER_DAY)));
  } catch { /* 忽略 */ }
}

/** 记录用户交互（点击/拖拽），增量更新计数器 */
export function incrementInteractionCount(): void {
  if (!trackingEnabled()) return;
  try {
    const key = storageKey();
    const events: DiaryEvent[] = getEvents();
    const existing = events.find(e => e.type === "interaction");
    if (existing) {
      const match = existing.summary.match(/(\d+)/);
      const count = match ? parseInt(match[1], 10) + 1 : 1;
      existing.summary = `被摸了${count}次头`;
      existing.timestamp = Date.now();
    } else {
      events.push({ type: "interaction", summary: "被摸了1次头", timestamp: Date.now() });
    }
    localStorage.setItem(key, JSON.stringify(events.slice(-MAX_EVENTS_PER_DAY)));
  } catch { /* 忽略 */ }
}

/**
 * 前台应用采样：主循环隔一段时间采样一次"当前窗口属于哪个软件"，
 * 按分钟累加到当天用量里（不是每采样一次就记一条事件）。
 */
export function trackAppUse(app: string, minutes: number): void {
  const name = app.trim();
  if (!trackingEnabled() || !name || minutes <= 0) return;
  try {
    const key = appsKey();
    const map = readMap<number>(key);
    map[name] = (map[name] ?? 0) + minutes;
    // 超上限时丢掉用时最少的那个，避免无限增长
    const entries = Object.entries(map);
    if (entries.length > MAX_APPS_PER_DAY) {
      entries.sort((a, b) => b[1] - a[1]);
      const kept: Record<string, number> = {};
      for (const [k, v] of entries.slice(0, MAX_APPS_PER_DAY)) kept[k] = v;
      localStorage.setItem(key, JSON.stringify(kept));
      return;
    }
    localStorage.setItem(key, JSON.stringify(map));
  } catch { /* 忽略 */ }
}

/** 某天的应用用量（用时从多到少） */
export function getAppUsage(date?: string): AppUsage[] {
  const map = readMap<number>(appsKey(date));
  return Object.entries(map)
    .map(([app, minutes]) => ({ app, minutes: Math.round(minutes) }))
    .filter(u => u.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
}

/** 记录今天听过的一首歌（同一首重复听只累加次数） */
export function trackMusic(title: string, artist: string): void {
  const t = title.trim();
  if (!trackingEnabled() || !t) return;
  try {
    const label = artist.trim() ? `${safeSlice(t, 30)} - ${safeSlice(artist.trim(), 20)}` : safeSlice(t, 40);
    const key = musicKey();
    const map = readMap<number>(key);
    map[label] = (map[label] ?? 0) + 1;
    const entries = Object.entries(map);
    if (entries.length > MAX_TRACKS_PER_DAY) {
      entries.sort((a, b) => b[1] - a[1]);
      const kept: Record<string, number> = {};
      for (const [k, v] of entries.slice(0, MAX_TRACKS_PER_DAY)) kept[k] = v;
      localStorage.setItem(key, JSON.stringify(kept));
      return;
    }
    localStorage.setItem(key, JSON.stringify(map));
  } catch { /* 忽略 */ }
}

/** 某天听过的歌（次数从多到少） */
export function getMusicTracks(date?: string): MusicTrack[] {
  const map = readMap<number>(musicKey(date));
  return Object.entries(map)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/** 删除指定日期的采集数据（日记生成后调用以节省空间） */
export function clearEvents(date?: string): void {
  try {
    localStorage.removeItem(storageKey(date));
    localStorage.removeItem(appsKey(date));
    localStorage.removeItem(musicKey(date));
  } catch { /* 忽略 */ }
}
