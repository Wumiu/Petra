const KEY = "live2d-pet-settings";

export type ActivityLevel = "low" | "mid" | "high";
export type AssistantProvider =
  | "deepseek"
  | "openai"
  | "moonshot"
  | "zhipu"
  | "qwen"
  | "siliconflow"
  | "openrouter"
  | "groq"
  | "ollama"
  | "custom";

export interface BoundsPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 结构化人设：控制面板「人设」页那几栏。
 * 最终仍会拼成一段文本写回 `assistant.persona` —— 下游（对话/日记/抽卡/麻将搭话）
 * 都只认 persona 一个字段，这里只是给它一个更好填的编辑器。
 */
export interface PersonaFields {
  /** 它是谁（名字） */
  name: string;
  age: string;
  /** 身份 / 职业 */
  identity: string;
  /** 时代 / 世界观 */
  world: string;
  /** 核心欲望 / 动机 */
  desire: string;
  /** 性格关键词 */
  traits: string;
  /** 说话方式 */
  speech: string;
  /** 口头禅 */
  catchphrase: string;
  /** 喜欢用的表情 / 动作 */
  emoji: string;
}

/**
 * 一组可复用的 API 配置（参考酒馆的"预设"）。
 *
 * 只存非敏感字段：**API Key 不进 settings**（settings 是 localStorage 明文），
 * Key 按 `preset:<id>` 存进 Rust 侧（DPAPI / Keychain / Secret Service）。
 */
export interface AssistantPreset {
  id: string;
  /** 用户可改的名字（重命名） */
  name: string;
  provider: AssistantProvider;
  customBaseUrl: string;
  model: string;
}

export interface AssistantSettings {
  enabled: boolean;
  provider: AssistantProvider;
  model: string;
  /** 最终生效的人设文本（由结构化字段 + 自由补充拼成，下游只读这个） */
  persona: string;
  /** 用户自己写的自由人设（不参与结构化拼装，单独存） */
  personaFree: string;
  /** 结构化人设字段 */
  personaFields: PersonaFields;
  customBaseUrl: string;
  /** 保存的预设列表 */
  presets: AssistantPreset[];
  /** 当前应用的预设 id；手动改供应商/端点时会清空，Key 作用域随之回退到 provider */
  activePresetId: string;
  /** 持久化对话历史所属的输出语言（用于"换语言就清历史"，重启后不再误判） */
  historyLang: string;
  /** 主动问候间隔时间（分钟） */
  greetInterval: number;
  /** 对用户的称呼（如"主人"），空则让 AI 自行决定 */
  nickname: string;
  /** 全局呼出快捷键（Tauri accelerator 字符串，如 "Ctrl+Shift+A"）；空表示未设置 */
  shortcut: string;
  /** AI 输出语言（explicit_language 代码），空=自动 */
  outputLanguage: string;
}

export interface DiarySettings {
  enabled: boolean;
  autoGenerate: boolean;
}

export interface DailyCardSettings {
  enabled: boolean;
}

export interface Settings {
  audioEnabled: boolean;
  /** 麻将等小游戏的事件音效；与跟随音乐、动画和桌宠互动相互独立。 */
  gameSound: boolean;
  /** 游戏音效音量，范围 0～1。 */
  gameSoundVolume: number;
  /** 麻将对局与结算音乐开关。 */
  gameMusic: boolean;
  /** 麻将音乐音量，范围 0～1。 */
  gameMusicVolume: number;
  activity: ActivityLevel;
  mouseTrack: boolean;
  idleMode: boolean;
  modelScale: number;
  /** 每个模型单独记录的大小（key = 模型名，用户调整过才记录） */
  modelScales: Record<string, number>;
  /** 天气城市名（中文），空则用 API 返回的英文名 */
  weatherCity: string;
  /** 天气气泡：点桌宠时弹出的信息面板（天气/待办/陪伴时间）；关掉后一律不弹 */
  weatherBubble: boolean;
  /**
   * 每个模型单独记录的角色边界松紧（key = 模型名）。
   *
   * 边界松紧本质上是「这个 PSD 的透明留白有多大」，换模型就该换一套；
   * 以前是全局单值，在模型 A 上拖过滑条再切到 B，B 的绿框/点击区/气泡位置就全偏了。
   */
  boundsPaddings: Record<string, BoundsPadding>;
  /** 旧版的全局边界松紧：只用于首次迁移，新代码请用 boundsPaddings */
  boundsPadding: BoundsPadding;
  passthrough: boolean;
  /** 免确认 shell（持久化，重启后保持） */
  allowAllShell: boolean;
  /** 免确认写文件（持久化）：勾过确认气泡里的「以后不再确认」就置真 */
  allowAllFileWrite: boolean;
  /**
   * 文件禁止目录（一行一个，支持 # 注释）。
   * 小助手只能读写 桌面/文档/下载，这里是**额外**拉黑的目录 —— 例如把项目源码目录
   * 加进来，免得它改到自己头上。内置敏感项（AppData/.ssh/.git…）不依赖这项。
   */
  fileDenyPaths: string[];
  assistant: AssistantSettings;
  diary: DiarySettings;
  dailyCard: DailyCardSettings;
  /** 模型调节参数（per-model，key=模型名） */
  modelParams: Record<string, Record<string, number>>;
  /** 模型自动行为开关（per-model） */
  modelAuto: Record<string, Record<string, boolean>>;
  /** 歌词气泡：识别正在播放的歌并时不时弹出当前歌词（本地/在线歌词，无 token 消耗） */
  musicLyrics: boolean;
  /** 歌词翻译：在原文下方显示中文翻译（来源提供译文时才显示） */
  lyricsTranslate: boolean;
  /**
   * 歌词同步微调（**按歌记忆**）：键 = `标题|歌手`，值 = 毫秒，正数表示"歌词提前"。
   * 在线歌词是社区贡献的，不同歌的时间戳本身就参差不齐（同一首歌也可能偏半秒），
   * 全局提前量救不了这种差异，只能让用户按歌校准一次、之后一直准。
   */
  lyricOffsets: Record<string, number>;
  /** 麻将桌上的 AI 实时互动（需要配置 API Key；有节流与每局/每场上限） */
  gameTalk: boolean;
  /** 整点播报：每到整点让桌宠报一次时间（本地文案，零 token） */
  hourlyChime: boolean;
  /** 整点播报免打扰开关（时段由下面两个字段决定） */
  hourlyChimeQuiet: boolean;
  /** 免打扰开始小时（含），0~23，默认 23 */
  hourlyQuietStart: number;
  /** 免打扰结束小时（不含），0~23，默认 8 */
  hourlyQuietEnd: number;
  /** TTS 语音输出配置 */
  tts: {
    enabled: boolean;
    apiKey: string;
    speakerId: string;
  };
  /** 语音识别（输入）配置 */
  asr: {
    /**
     * 是否优先用云端模型识别（默认 true）。
     * 开：麦克风直接走硅基流动的 XingChen ASR，识别质量比 Windows 系统识别稳；
     * 关：Windows 上先试浏览器原生 SpeechRecognition，失败再降级到云端。
     */
    cloudFirst: boolean;
    /**
     * 麦克风权限开关（应用内，立即生效）。
     * 关掉后点 🎤 直接提示权限已关闭、不会去开麦克风；
     * 同时在「🎤 语音识别设置」里会一并同步到 Windows 的麦克风隐私设置。
     */
    micAllowed: boolean;
  };
}

const DEFAULTS: Settings = {
  audioEnabled: true,
  gameSound: true,
  gameSoundVolume: 0.3,
  gameMusic: true,
  gameMusicVolume: 0.18,
  activity: "low",
  mouseTrack: false,
  idleMode: false,
  modelScale: 1,
  modelScales: {},
  weatherCity: "",
  weatherBubble: true,
  boundsPaddings: {},
  boundsPadding: { left: 0, right: 0, top: 0, bottom: 0 },
  passthrough: false,
  allowAllShell: false,
  allowAllFileWrite: false,
  fileDenyPaths: [],
  assistant: {
    enabled: false,
    provider: "deepseek",
    model: "",
    persona: "",
    personaFree: "",
    personaFields: {
      name: "",
      age: "",
      identity: "",
      world: "",
      desire: "",
      traits: "",
      speech: "",
      catchphrase: "",
      emoji: "",
    },
    customBaseUrl: "",
    presets: [],
    activePresetId: "",
    historyLang: "",
    greetInterval: 20,
    nickname: "",
    shortcut: "",
    outputLanguage: "",
  },
  diary: {
    enabled: true,
    autoGenerate: true,
  },
  dailyCard: {
    enabled: true,
  },
  modelParams: {},
  modelAuto: {},
  musicLyrics: true,
  lyricsTranslate: true,
  lyricOffsets: {},
  gameTalk: false,
  hourlyChime: true,
  hourlyChimeQuiet: true,
  hourlyQuietStart: 23,
  hourlyQuietEnd: 8,
  tts: {
    enabled: false,
    apiKey: "",
    speakerId: "",
  },
  asr: {
    cloudFirst: true,
    micAllowed: true,
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

/**
 * 结构化人设 → 一段提示词。
 * 只拼非空项；自由人设放在最后，方便用户写「补充说明」。
 */
export function composePersona(a: AssistantSettings): string {
  const f = a.personaFields ?? DEFAULTS.assistant.personaFields;
  const lines: string[] = [];
  if (f.name?.trim()) lines.push(`你的名字是「${f.name.trim()}」。`);
  if (f.age?.trim()) lines.push(`年龄：${f.age.trim()}`);
  if (f.identity?.trim()) lines.push(`身份：${f.identity.trim()}`);
  if (f.world?.trim()) lines.push(`所处世界：${f.world.trim()}`);
  if (f.desire?.trim()) lines.push(`你真正想要的：${f.desire.trim()}`);
  if (f.traits?.trim()) lines.push(`性格：${f.traits.trim()}`);
  if (f.speech?.trim()) lines.push(`说话方式：${f.speech.trim()}`);
  if (f.catchphrase?.trim()) lines.push(`口头禅：${f.catchphrase.trim()}`);
  if (f.emoji?.trim()) lines.push(`喜欢用的表情/动作：${f.emoji.trim()}`);
  const free = (a.personaFree ?? "").trim();
  if (free) lines.push(free);
  return lines.join("\n");
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    // 嵌套对象深合并：旧版本存档缺少新字段时回退默认值
    const s: Settings = {
      ...DEFAULTS,
      ...parsed,
      assistant: {
        ...DEFAULTS.assistant,
        ...(parsed.assistant ?? {}),
        // 旧存档只有 persona：把它当作「自由人设」，别让用户升级后看到空白
        personaFree:
          (parsed.assistant?.personaFree ?? parsed.assistant?.persona ?? "") as string,
        personaFields: { ...DEFAULTS.assistant.personaFields, ...(parsed.assistant?.personaFields ?? {}) },
      },
      diary: { ...DEFAULTS.diary, ...(parsed.diary ?? {}) },
      dailyCard: { ...DEFAULTS.dailyCard, ...(parsed.dailyCard ?? {}) },
      tts: { ...DEFAULTS.tts, ...(parsed.tts ?? {}) },
      asr: { ...DEFAULTS.asr, ...(parsed.asr ?? {}) },
    };
    s.gameSound = s.gameSound !== false;
    s.gameSoundVolume = Math.max(0, Math.min(1, Number.isFinite(Number(s.gameSoundVolume)) ? Number(s.gameSoundVolume) : DEFAULTS.gameSoundVolume));
    s.gameMusic = s.gameMusic !== false;
    s.gameMusicVolume = Math.max(0, Math.min(1, Number.isFinite(Number(s.gameMusicVolume)) ? Number(s.gameMusicVolume) : DEFAULTS.gameMusicVolume));
    // 禁止目录：存档可能被手改坏，这里兜一层类型
    s.fileDenyPaths = Array.isArray(s.fileDenyPaths)
      ? s.fileDenyPaths.filter((p): p is string => typeof p === "string" && p.trim() !== "")
      : [];
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
