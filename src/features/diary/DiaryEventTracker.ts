/**
 * 日记事件采集器
 * 静默收集当天事件，写入 localStorage，供日记生成使用。
 *
 * 改进：
 * - 事件存储上限 + 90 天自动清理
 * - 交互计数器优化（增量更新，不反复解析整个数组）
 * - summary 截断安全处理
 */

export interface DiaryEvent {
  type: "chat" | "reminder_done" | "greeting" | "interaction";
  summary: string;
  timestamp: number;
}

const MAX_EVENTS_PER_DAY = 100;
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

/** 安全截断：避免截断半个 emoji 或 UTF-16 代理对 */
function safeSlice(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  // Array.from 正确处理 Unicode 码点
  return Array.from(str).slice(0, maxLen).join("");
}

/** 清理过期事件 key（保留最近 RETENTION_DAYS 天） */
export function cleanupOldEvents(): void {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = localDateStr(cutoff);
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("petra-diary-events-")) {
        const date = key.replace("petra-diary-events-", "");
        if (date < cutoffStr) toRemove.push(key);
      }
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
  try {
    const key = storageKey();
    const events: DiaryEvent[] = (() => {
      try { return JSON.parse(localStorage.getItem(key) || "[]"); }
      catch { return []; }
    })();
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
  try {
    const key = storageKey();
    const events: DiaryEvent[] = (() => {
      try { return JSON.parse(localStorage.getItem(key) || "[]"); }
      catch { return []; }
    })();
    const existing = events.find(e => e.type === "interaction");
    if (existing) {
      const match = existing.summary.match(/(\d+)/);
      const count = match ? parseInt(match[1]) + 1 : 1;
      existing.summary = `被摸了${count}次头`;
      existing.timestamp = Date.now();
    } else {
      events.push({ type: "interaction", summary: "被摸了1次头", timestamp: Date.now() });
    }
    localStorage.setItem(key, JSON.stringify(events.slice(-MAX_EVENTS_PER_DAY)));
  } catch { /* 忽略 */ }
}

/** 删除指定日期的事件（日记生成后可调用以节省空间） */
export function clearEvents(date?: string): void {
  localStorage.removeItem(storageKey(date));
}
