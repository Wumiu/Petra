const KEY = "live2d-pet-settings";

export type ActivityLevel = "low" | "mid" | "high";

export interface Settings {
  audioEnabled: boolean;
  activity: ActivityLevel;
  mouseTrack: boolean;
}

const DEFAULTS: Settings = {
  audioEnabled: true,
  activity: "low",
  mouseTrack: false,
};

/** 活动频率因子：越大活动越少（表情间隔/漫游小憩/移动半径都受它影响） */
const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  low: 3.5,
  mid: 1.8,
  high: 1,
};

let currentFactor = ACTIVITY_FACTOR[DEFAULTS.activity];

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const s: Settings = { ...DEFAULTS, ...parsed };
    currentFactor = ACTIVITY_FACTOR[s.activity] ?? ACTIVITY_FACTOR.mid;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  currentFactor = ACTIVITY_FACTOR[s.activity] ?? ACTIVITY_FACTOR.mid;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}

/** 各渲染器/引擎每帧读取的活动因子（模块级缓存，零开销） */
export function getActivityFactor(): number {
  return currentFactor;
}

export function nextActivity(s: Settings): ActivityLevel {
  const order: ActivityLevel[] = ["low", "mid", "high"];
  const i = order.indexOf(s.activity);
  return order[(i + 1) % order.length];
}

export const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  low: "低",
  mid: "中",
  high: "高",
};