const KEY = "live2d-pet-settings";

export type ActivityLevel = "low" | "mid" | "high";
export type AssistantProvider = "deepseek" | "custom";

export interface AssistantSettings {
  enabled: boolean;
  provider: AssistantProvider;
  model: string;
  persona: string;
  customBaseUrl: string;
}

export interface Settings {
  audioEnabled: boolean;
  activity: ActivityLevel;
  mouseTrack: boolean;
  idleMode: boolean;
  modelScale: number;
  assistant: AssistantSettings;
}

const DEFAULTS: Settings = {
  audioEnabled: true,
  activity: "low",
  mouseTrack: false,
  idleMode: false,
  modelScale: 1,
  assistant: {
    enabled: false,
    provider: "deepseek",
    model: "",
    persona: "",
    customBaseUrl: "",
  },
};

/** 活动频率表情因子：越大表情/活动越少（渲染器用） */
const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  low: 4,
  mid: 2,
  high: 1,
};

let currentFactor = ACTIVITY_FACTOR[DEFAULTS.activity];
let currentLevel: ActivityLevel = DEFAULTS.activity;

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const s: Settings = { ...DEFAULTS, ...parsed };
    currentFactor = ACTIVITY_FACTOR[s.activity] ?? ACTIVITY_FACTOR.mid;
    currentLevel = s.activity ?? DEFAULTS.activity;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  currentFactor = ACTIVITY_FACTOR[s.activity] ?? ACTIVITY_FACTOR.mid;
  currentLevel = s.activity ?? DEFAULTS.activity;
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

/** 当前活动频率档位（动作池分级用） */
export function getActivityLevel(): ActivityLevel {
  return currentLevel;
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