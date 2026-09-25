/**
 * 聊天情绪微表情（头部侧边小动画）。
 *
 * 需求：和桌宠对话时，记录 AI 情绪，在模型头部左/右上角随机冒出对应情绪的小动画
 * （像漫画微表情）。仅在对话输入栏打开（用户正在和桌宠聊天）时可见，其余时间完全不显示。
 *
 * 实现：纯 DOM 叠加层（position: fixed），与气泡同一坐标系（窗口内坐标）。
 * - 情绪 → 内置 emoji 微符号（提前准备好，无需联网/无素材文件）
 * - 方向随机：每次只在头部左边或右边出现
 * - 每次冒 2~3 个，错落排列、依次浮现，更醒目
 * - 尺寸：基于模型包围盒宽度估算（可调 SIZE_RATIO / SIZE_MIN / SIZE_MAX）
 * - 生命周期：冒出后先停留片刻让人看清，再上浮淡出，约 1.8~3 秒后自动移除 DOM
 */
import type { EmotionTag } from "./EmotionEngine";

interface ModelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 情绪 → 内置微表情符号（简洁易懂的漫画风） */
const EMOJI_MAP: Record<Exclude<EmotionTag, "neutral">, string> = {
  happy: "❤️",      // 高兴：红色小爱心
  love: "💖",       // 喜爱：跳动的爱心
  angry: "💢",      // 生气：漫画怒气符号
  sad: "💧",        // 难过：泪珠
  surprised: "❗",   // 惊讶：惊叹号
  shy: "🌸",        // 害羞：冒小花
  tired: "💤",      // 困：zzz
  worried: "💭",    // 担心：思考泡
};

/**
 * 图标尺寸相对模型宽度的比例。
 * 头宽约为模型宽度的一半，这里取 0.15 ≈ 头宽的 1/3，保证一眼能看清。
 */
const SIZE_RATIO = 0.15;
/** 图标尺寸上下限（px），防止模型特别大/特别小时失控 */
const SIZE_MIN = 28;
const SIZE_MAX = 60;
/** 每次冒出几个微表情（2 或 3 个） */
const MIN_COUNT = 2;
const MAX_COUNT = 3;
/** 多个图标之间的错落间距（相对图标尺寸的倍数） */
const SPREAD = 1.05;
/** 多个图标依次浮现的间隔（ms） */
const STAGGER_MS = 130;
/** 动画总时长随机范围（ms）：冒出来后先停留看清楚，再上浮飘走 */
const LIFE_MIN = 1800;
const LIFE_MAX = 3000;

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container && container.isConnected) return container;
  container = document.createElement("div");
  container.id = "emotion-popups";
  container.setAttribute("aria-hidden", "true");
  document.body.appendChild(container);
  return container;
}

/**
 * 是否处于"和桌宠聊天"状态：对话输入栏可见即为聊天中。
 * 主动问候 / 抽卡点评 / 摸头 / 待机时输入栏都是 hidden，动画不会出现。
 */
function isChatOpen(): boolean {
  const bar = document.getElementById("as-inputbar");
  return !!bar && !bar.classList.contains("hidden");
}

/**
 * 在模型头部侧边冒出一个情绪微表情。
 * 由 main.ts 的情绪反应器在每次情绪变化时调用。
 * @param tag 识别到的情绪标签
 * @param rect getModelRect() 返回的角色包围盒（窗口内 CSS 像素坐标）
 */
export function showEmotionPopup(tag: EmotionTag, rect: ModelRect): void {
  if (tag === "neutral") return;
  if (!isChatOpen()) return; // 非聊天状态：直接忽略，不创建任何 DOM
  const emo = EMOJI_MAP[tag];
  if (!emo) return;
  if (!rect || rect.width <= 0 || rect.height <= 0) return;

  const c = ensureContainer();

  // 尺寸：基于模型宽度，钳制在合理范围
  const size = Math.round(Math.max(SIZE_MIN, Math.min(SIZE_MAX, rect.width * SIZE_RATIO)));
  // 方向随机且单次：本次只取左边或右边
  const side: "left" | "right" = Math.random() < 0.5 ? "left" : "right";
  // 本次冒几个
  const count = MIN_COUNT + Math.floor(Math.random() * (MAX_COUNT - MIN_COUNT + 1));

  // 头部位置估算：卡通角色头约在包围盒上部，头宽 ≈ 模型宽的一半
  const headCx = rect.left + rect.width / 2;
  const headW = rect.width * 0.5;
  // 锚点：头部侧角（左边 = 头左缘，右边 = 头右缘），垂直贴头顶附近
  const anchorX = side === "left" ? headCx - headW / 2 : headCx + headW / 2;
  const anchorY = rect.top + rect.height * 0.06;

  for (let i = 0; i < count; i++) {
    // 多个图标错落：以锚点为中心垂直排开，水平轻微外偏
    const offset = i - (count - 1) / 2; // 居中偏移
    const x = anchorX + offset * size * 0.35;
    const y = anchorY + offset * size * SPREAD;
    const dur = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);

    // 依次浮现：错峰出现
    window.setTimeout(() => {
      const el = document.createElement("div");
      el.className = "emotion-pop";
      el.textContent = emo;
      el.style.fontSize = `${size}px`;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.dataset.side = side;
      el.style.animationDuration = `${Math.round(dur)}ms`;
      c.appendChild(el);
      window.setTimeout(() => el.remove(), dur + 100);
    }, i * STAGGER_MS);
  }
}

/** 关闭对话时清理所有未播完的动画（保险用，正常靠动画自然结束） */
export function clearEmotionPopups(): void {
  if (container) container.innerHTML = "";
}
