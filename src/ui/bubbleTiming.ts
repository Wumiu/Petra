/**
 * 气泡停留时长 —— "够不够看完"这件事只在这里定义。
 *
 * 以前所有回复一律 8 秒就淡出，长回复根本来不及看；鼠标悬停也不管用。
 * 现在按字数给时间，并且悬停会暂停倒计时（见 AssistantPanel.scheduleFade）。
 * 纯函数，单测见 tests/assistant-tools.test.js（npm run test:assistant）
 */

/** 最短停留 */
export const BUBBLE_HOLD_MIN_MS = 5000;
/** 最长停留（长回复也不会赖着不走；鼠标悬停可随时暂停慢慢看） */
export const BUBBLE_HOLD_MAX_MS = 16000;
/** 每个字符额外给的阅读时间 */
export const BUBBLE_HOLD_PER_CHAR_MS = 60;

/**
 * 按文本长度算停留时间：短句 5 秒起，按字数加时，封顶 16 秒。
 * 例：50 字 → 8 秒；100 字 → 11 秒；200 字以上 → 16 秒。
 * 反正鼠标移上去会暂停，所以不用给太长。
 */
export function readingHoldMs(text: string, base: number = BUBBLE_HOLD_MIN_MS): number {
  const len = (text ?? "").trim().length;
  const ms = base + len * BUBBLE_HOLD_PER_CHAR_MS;
  return Math.min(BUBBLE_HOLD_MAX_MS, Math.max(BUBBLE_HOLD_MIN_MS, ms));
}
