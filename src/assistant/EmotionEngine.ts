/**
 * 情感引擎：零 token 本地情感反馈系统。
 * - 规则关键词分类用户/AI 文本 → 情绪标签（不调用任何 LLM）
 * - 情绪 → 表情参数 + 动作映射，驱动 Live2D 角色反馈
 * - 心情状态机：互动增减、随时间回归基线、持久化
 */
import type { EmotionExpression } from "../live2d/PetDriver";

export type EmotionTag =
  | "happy" | "sad" | "angry" | "surprised" | "shy"
  | "tired" | "love" | "worried" | "neutral";

interface MoodState {
  happiness: number; // 0..1，0.5 基线
  energy: number;    // 0..1
  updatedAt: number;
}

const MOOD_KEY = "petra-mood";
const HAPPINESS_BASELINE = 0.5;
const ENERGY_BASELINE = 0.3;
const REACT_MIN_INTERVAL_MS = 4000; // 表情/动作反应最小间隔
const PERSIST_MIN_INTERVAL_MS = 30000; // 心情持久化最小间隔

let mood: MoodState | null = null;
let reactor: ((tag: EmotionTag) => void) | null = null;
let lastReactAt = 0;
let lastPersistAt = 0;

/** 关键词规则：按优先级排列，先命中先算（生气 > 难过 > 疲惫 > 担心 > 爱意 > 害羞 > 惊讶 > 开心） */
const EMOTION_RULES: Array<{ tag: EmotionTag; pattern: RegExp }> = [
  { tag: "angry",     pattern: /生气|气死|气人|可恶|讨厌|烦死|烦人|怒了|愤怒|火大|滚开|闭嘴|😠|😡|🤬/ },
  { tag: "sad",       pattern: /难过|伤心|委屈|想哭|哭了|哭哭|失落|郁闷|沮丧|好惨|难受|呜呜|嘤嘤|😢|😭|😞|😔|💔/ },
  { tag: "tired",     pattern: /好累|累死|好困|困死|疲惫|熬夜|没睡|想睡|犯困|没精神|🥱|😪|😴/ },
  { tag: "worried",   pattern: /担心|焦虑|紧张|害怕|好怕|心慌|不安|怎么办|压力好大|压力大|😰|😨|😱|😓/ },
  { tag: "love",      pattern: /爱你|喜欢你|想你|亲亲|么么|抱抱|贴贴|比心|❤|💕|💖|🥰|😘/ },
  { tag: "shy",       pattern: /害羞|脸红|不好意思|羞羞|😳/ },
  { tag: "surprised", pattern: /震惊|惊讶|天哪|天呐|居然|竟然|哇塞|卧槽|我靠|😲|😮|🤯|？！/ },
  { tag: "happy",     pattern: /哈哈|嘻嘻|嘿嘿|开心|高兴|太好了|太棒|真棒|好耶|耶！|谢谢|谢啦|喜欢|😄|😆|😁|😺|👍|🎉|✌/ },
];

export function classifyEmotion(text: string): EmotionTag {
  if (!text) return "neutral";
  for (const { tag, pattern } of EMOTION_RULES) {
    if (pattern.test(text)) return tag;
  }
  return "neutral";
}

/**
 * 面向"桌宠自己说话"的规则：AI 回复大多是功能性句子（"好的"、"已经帮你打开了"），
 * 用上面那套"用户情绪"规则几乎命中不了，所以单独放宽：
 * 关心安慰、抱歉、娇嗔、成功语气、人设语气词（～/啦/呀/！结尾）都算情绪。
 */
const ASSISTANT_EMOTION_RULES: Array<{ tag: EmotionTag; pattern: RegExp }> = [
  { tag: "worried",   pattern: /别担心|不用担心|没事的|会好起来|注意身体|早点休息|早点睡|别熬夜|少熬夜|多喝水|多休息|照顾好自己|小心点|辛苦了|辛苦啦|加油|摸摸头|我陪着你|有我在|心疼/ },
  { tag: "love",      pattern: /爱你|最喜欢你|想你|亲亲|么么|抱抱|贴贴|比心|❤|💕|💖|🥰|😘/ },
  { tag: "sad",       pattern: /抱歉|对不起|不好意思|没能|没帮上|可惜|遗憾|呜呜|难过|😢|🥺/ },
  { tag: "angry",     pattern: /哼[！!～~]?|讨厌啦|坏蛋|不理你了|生气了|气死我了|😠|😤/ },
  { tag: "surprised", pattern: /咦|诶|欸|哦？|喔？|哇[！!～~]?|居然|竟然|原来|天哪|天呐|没想到|😲|😮/ },
  { tag: "shy",       pattern: /害羞|脸红|羞羞|别夸我|哪有|😳/ },
  { tag: "tired",     pattern: /好困|困了|想睡|睡啦|熬夜|好累|😪|😴|🥱/ },
  { tag: "happy",     pattern: /哈哈|嘻嘻|嘿嘿|开心|高兴|太好了|太棒|真棒|好耶|没问题|当然|乐意|交给我|包在我身上|好嘞|好的呀|搞定|完成啦|好啦|这就去|马上[就去]|😊|😄|😆|😁|🎉|✌|[～~]$|[呀啦呢]$|[！!]$/ },
];

/** 桌宠回复的情绪识别：先用"说话侧"规则，再退回通用规则 */
export function classifyAssistantEmotion(text: string): EmotionTag {
  if (!text) return "neutral";
  const t = text.trim();
  for (const { tag, pattern } of ASSISTANT_EMOTION_RULES) {
    if (pattern.test(t)) return tag;
  }
  return classifyEmotion(t);
}

/** 情绪 → 气泡 emoji 前缀 */
export function emotionEmoji(tag: EmotionTag): string {
  switch (tag) {
    case "happy": return "😊";
    case "sad": return "😢";
    case "angry": return "😠";
    case "surprised": return "😲";
    case "shy": return "😳";
    case "tired": return "🥱";
    case "love": return "💕";
    case "worried": return "😥";
    default: return "";
  }
}

/** 情绪 → 动作库动作（null = 不播放动作，只用表情） */
export function emotionToAction(tag: EmotionTag): string | null {
  switch (tag) {
    case "happy": return "happy";
    case "sad": return "tilt";
    case "angry": return "shake";
    case "surprised": return "surprised";
    case "shy": return "wink";
    case "tired": return "yawn";
    case "love": return "wink";
    case "worried": return "lookSide";
    default: return null;
  }
}

/** 情绪 → 表情参数（Rigged2DView.setExpression 用） */
export function emotionExpression(tag: EmotionTag): EmotionExpression {
  switch (tag) {
    case "happy":     return { brow: 0.35, mouthForm: 0.9, closeL: 0.05, closeR: 0.05 };
    case "sad":       return { brow: -0.45, mouthForm: -0.3, eyeY: -0.25, closeL: 0.15, closeR: 0.15 };
    case "angry":     return { brow: -0.8, mouthForm: -0.55, mouthOpen: 0.05 };
    case "surprised": return { mouthOpen: 0.65, irisScale: -0.2, eyeY: 0.1 };
    case "shy":       return { brow: 0.55, mouthForm: 0.6, closeL: 0.45, closeR: 0.45, tilt: 0.1 };
    case "tired":     return { mouthOpen: 0.85, closeL: 0.12, closeR: 0.12, tilt: 0.03 };
    case "love":      return { mouthForm: 0.7, closeL: 1, closeR: 0 };
    case "worried":   return { brow: 0.6, mouthOpen: 0.5, eyeX: -0.3, tilt: 0.08 };
    default:          return {};
  }
}

// ==================== 心情状态机 ====================

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function loadMood(): MoodState {
  try {
    const raw = localStorage.getItem(MOOD_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.happiness === "number" && typeof p.energy === "number") {
        return { happiness: clamp01(p.happiness), energy: clamp01(p.energy), updatedAt: p.updatedAt ?? Date.now() };
      }
    }
  } catch { /* 忽略 */ }
  return { happiness: HAPPINESS_BASELINE, energy: ENERGY_BASELINE, updatedAt: Date.now() };
}

function persistMood(now: number, force = false) {
  if (!force && now - lastPersistAt < PERSIST_MIN_INTERVAL_MS) return;
  lastPersistAt = now;
  try { localStorage.setItem(MOOD_KEY, JSON.stringify(mood)); } catch { /* 忽略 */ }
}

/** 推进时间衰减：心情向基线回归（时间常数 2h），精力向基线回归（1.5h）。每帧调用开销极小。 */
function tickMood(now = Date.now()): MoodState {
  if (!mood) mood = loadMood();
  const dt = (now - mood.updatedAt) / 1000;
  if (dt > 1) {
    mood.happiness += (HAPPINESS_BASELINE - mood.happiness) * (1 - Math.exp(-dt / 7200));
    mood.energy += (ENERGY_BASELINE - mood.energy) * (1 - Math.exp(-dt / 5400));
    mood.updatedAt = now;
    if (now - lastPersistAt > 60000) persistMood(now);
  }
  return mood;
}

/** 读取当前心情（渲染层每帧读 driver.mood 用） */
export function getMood(): { happiness: number; energy: number } {
  const m = tickMood();
  return { happiness: clamp01(m.happiness), energy: clamp01(m.energy) };
}

/** 心情 → -1..1 渲染通道值（低=低落，高=开心） */
export function getMoodDriverValue(): number {
  return getMood().happiness * 2 - 1;
}

export type MoodBoostKind = "chat" | "petting" | "reminder_done" | "greeting_sent" | EmotionTag;

/** 互动增减心情 */
export function boostMood(kind: MoodBoostKind): void {
  const m = tickMood();
  const now = Date.now();
  switch (kind) {
    case "petting":      m.happiness += 0.08; m.energy += 0.05; break;
    case "chat":         m.happiness += 0.05; m.energy += 0.03; break;
    case "reminder_done": m.happiness += 0.06; m.energy += 0.02; break;
    case "greeting_sent": m.happiness += 0.02; break;
    case "happy": case "love": case "surprised":
      m.happiness += 0.04; m.energy += 0.05; break;
    case "sad":          m.happiness -= 0.06; break;
    case "angry":        m.happiness -= 0.05; m.energy += 0.05; break;
    case "tired":        m.energy -= 0.08; break;
    case "worried":      m.happiness -= 0.03; break;
    case "shy":          m.happiness += 0.02; break;
    default: break;
  }
  m.happiness = clamp01(m.happiness);
  m.energy = clamp01(m.energy);
  m.updatedAt = now;
  persistMood(now, true);
}

// ==================== 反应器接线 ====================

/** 注册情绪反应器：main.ts 接入 view（表情 + 动作） */
export function registerEmotionReactor(cb: (tag: EmotionTag) => void): void {
  reactor = cb;
}

/** 触发情绪反应。关键游戏事件可 force 抢占普通节流，确保表情/动作与事件对应。 */
export function reactNow(tag: EmotionTag, force = false): void {
  if (!reactor || tag === "neutral") return;
  const now = Date.now();
  if (!force && now - lastReactAt < REACT_MIN_INTERVAL_MS) return;
  lastReactAt = now;
  reactor(tag);
}

/** 分析文本并触发反应；返回识别到的情绪 */
export function reactToText(text: string): EmotionTag {
  const tag = classifyEmotion(text);
  reactNow(tag);
  return tag;
}

/** 摸头互动：心情上升 + 30% 概率开心/爱意反应 */
export function reactToTouch(): void {
  boostMood("petting");
  if (Math.random() < 0.35) {
    reactNow(Math.random() < 0.5 ? "happy" : "love");
  }
}
