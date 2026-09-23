/**
 * 整点播报：每到整点让桌宠报一次时间。
 * 文案全部本地生成（零 token），也可以随时关掉或进入免打扰时段。
 *
 * 纯逻辑部分（时段划分 / 文案 / 免打扰 / 距下一个整点）抽成纯函数，方便单测：
 * tests/hourly.test.js（npm run test:hourly）
 */

/** 小时数归一到 0~23 */
export function normalizeHour(hour: number): number {
  const h = Math.round(Number.isFinite(hour) ? hour : 0) % 24;
  return h < 0 ? h + 24 : h;
}

/** 在 0~23 之间步进（往上越过 23 回到 0，往下越过 0 回到 23） */
export function stepHour(hour: number, delta: number): number {
  return normalizeHour(normalizeHour(hour) + delta);
}

/**
 * 免打扰区间文案。
 * compact=true 时给菜单里显示（"23→08"），否则给面板/提示用（"23:00 – 08:00"）。
 */
export function formatQuietRange(start: number, end: number, compact = false): string {
  const pad = (n: number) => String(normalizeHour(n)).padStart(2, "0");
  return compact ? `${pad(start)}→${pad(end)}` : `${pad(start)}:00 – ${pad(end)}:00`;
}

export interface ChimeOptions {
  /** 免打扰开始小时（含），默认 23 */
  quietStart?: number;
  /** 免打扰结束小时（不含），默认 8 */
  quietEnd?: number;
}

export const DEFAULT_CHIME_OPTIONS: Required<ChimeOptions> = { quietStart: 23, quietEnd: 8 };

/** 时段：决定整点文案的口气 */
export type DayPart = "dawn" | "morning" | "noon" | "afternoon" | "evening" | "night" | "latenight";

export function dayPartOf(hour: number): DayPart {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 12) return "morning";
  if (hour >= 12 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  if (hour >= 22) return "night";
  return "latenight"; // 0~4 点
}

/** 每个时段几句备选，避免每个整点都说同一句；{h} 会替换成 12 小时制的钟点 */
const LINES: Record<DayPart, string[]> = {
  dawn: ["{h} 点啦，天快亮了～", "清晨 {h} 点，起得真早呀"],
  morning: ["上午 {h} 点，专心做一会儿事吧～", "{h} 点了，记得喝口水"],
  noon: ["{h} 点了，该吃饭啦！", "中午 {h} 点，别忘了歇一会儿"],
  afternoon: ["下午 {h} 点，让眼睛休息一下～", "{h} 点了，再加把劲哦"],
  evening: ["晚上 {h} 点，今天辛苦啦", "{h} 点啦，晚上好～"],
  night: ["已经 {h} 点了，别太晚哦", "夜里 {h} 点，我陪着你～"],
  latenight: ["{h} 点啦…该睡了哦", "凌晨 {h} 点，早点休息好不好"],
};

/** 12 小时制的钟点（0 点读作 12 点） */
export function clockHour(hour: number): number {
  const h = hour % 12;
  return h === 0 ? 12 : h;
}

/** 某个整点的播报文案；rand 可注入，便于测试与多样化 */
export function chimeLine(hour: number, rand: () => number = Math.random): string {
  const pool = LINES[dayPartOf(hour)];
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  return pool[idx].replace("{h}", String(clockHour(hour)));
}

/**
 * 是否处于免打扰。
 * quietStart === quietEnd 表示"永不免打扰"（菜单关掉免打扰时用这个表达）。
 */
export function isQuietHour(hour: number, opts: ChimeOptions = {}): boolean {
  const { quietStart, quietEnd } = { ...DEFAULT_CHIME_OPTIONS, ...opts };
  if (quietStart === quietEnd) return false;
  return quietStart < quietEnd
    ? hour >= quietStart && hour < quietEnd
    : hour >= quietStart || hour < quietEnd; // 跨零点，例如 23 → 8
}

/**
 * 距离下一个整点的毫秒数。
 * 正好在整点上（例如 10:00:00.000）时返回整一小时，
 * 这样"刚启动就整点"不会立刻播报，而是等下一个整点。
 */
export function msUntilNextHour(now: Date = new Date()): number {
  const elapsed = now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
  return 3600000 - elapsed;
}

let timer: number | null = null;

/** 启动整点播报（已在运行则返回 false）。onChime 收到文案与当时的小时数 */
export function startHourlyChime(
  onChime: (line: string, hour: number) => void,
  opts: ChimeOptions = {},
): boolean {
  if (timer !== null) return false;
  const arm = () => {
    timer = window.setTimeout(() => {
      const now = new Date();
      if (!isQuietHour(now.getHours(), opts)) {
        onChime(chimeLine(now.getHours()), now.getHours());
      }
      arm();
    }, msUntilNextHour());
  };
  arm();
  return true;
}

export function stopHourlyChime(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

export function isHourlyChimeRunning(): boolean {
  return timer !== null;
}
