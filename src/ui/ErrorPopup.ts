/**
 * 桌宠模型上方的错误提示条。
 *
 * 用途：把"用户必须看到"的错误从日志里拉出来 —— 日志再全，用户不会去翻。
 *
 * 规则（刻意保守，避免变成"弹窗地狱"）：
 *   - ERROR 级别日志 → 红色；HTTP 请求失败 → 黄色（由调用方区分）；
 *   - 每条显示 10 秒，右上角 ✕ 可手动关闭；
 *   - 相同内容 60 秒内只提示一次；两条提示之间至少间隔 6 秒；
 *   - 10 分钟内最多 20 条，超出只写日志不再弹；
 *   - 窗口不可见（隐藏/最小化）时不弹，但日志里明确记一笔"未显示"；
 *   - 成功弹出、被抑制、被手动关闭都会写日志（[popup] ...），
 *     避免"以为弹了其实没弹"，也方便事后核对。
 *
 * 交互：元素带 data-petra-interactive，main.ts 的交互区域同步会把它纳入
 * 窗口形状，因此 ✕ 点得到（桌宠窗口其余部分仍是点击穿透的）。
 */

export type ErrorPopupKind = "error" | "http";

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ErrorPopupOptions {
  /** 模型当前占用的矩形（CSS 像素），用于把提示条摆在模型正上方 */
  getModelRect: () => Rect;
  /** 窗口可见区域，用于钳制位置、避免弹出屏幕 */
  getVisibleRect: () => Rect;
  /** 写日志（会进 lasted.log） */
  log: (message: string) => void;
  /** 功能开关（保留给设置项用，默认开） */
  isEnabled?: () => boolean;
}

const SHOW_MS = 10_000;
const DEDUPE_MS = 60_000;
const MIN_GAP_MS = 6_000;
const MAX_PER_WINDOW = 20;
const WINDOW_MS = 10 * 60_000;

let options: ErrorPopupOptions | null = null;
let el: HTMLElement | null = null;
let hideTimer = 0;
let lastShownAt = 0;
let lastSuppressLogAt = 0;
let windowHits: number[] = [];
let recent: Array<{ text: string; at: number }> = [];

export function initErrorPopup(opts: ErrorPopupOptions): void {
  options = opts;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function ensureElement(): HTMLElement {
  if (el && el.isConnected) return el;
  const host = document.createElement("div");
  host.id = "pet-error-popup";
  host.setAttribute("data-petra-interactive", "true");
  host.style.cssText = [
    "position:fixed",
    "z-index:260",
    "max-width:340px",
    "min-width:160px",
    "padding:9px 30px 9px 11px",
    "border-radius:10px",
    "color:#fff",
    "font-size:12.5px",
    "line-height:1.5",
    "box-shadow:0 6px 20px rgba(0,0,0,.28)",
    "display:none",
    "pointer-events:auto",
    "word-break:break-word",
  ].join(";");

  const label = document.createElement("div");
  label.className = "pet-error-popup-label";
  label.style.cssText = "font-size:11px;opacity:.85;margin-bottom:2px;";
  const body = document.createElement("div");
  body.className = "pet-error-popup-body";
  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "关闭提示";
  close.style.cssText =
    "position:absolute;top:4px;right:6px;background:transparent;border:0;color:#fff;font-size:13px;cursor:pointer;padding:2px 4px;opacity:.9;";
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    hide("用户关闭");
  });
  host.append(label, body, close);
  document.body.appendChild(host);
  el = host;
  return host;
}

function hide(reason: string): void {
  if (!el || el.style.display === "none") return;
  el.style.display = "none";
  window.clearTimeout(hideTimer);
  hideTimer = 0;
  options?.log(`[popup] 已关闭（${reason}）`);
}

function place(host: HTMLElement): void {
  if (!options) return;
  try {
    const model = options.getModelRect();
    const visible = options.getVisibleRect();
    const width = host.offsetWidth || 260;
    const height = host.offsetHeight || 54;
    let left = (model.left + model.right) / 2 - width / 2;
    left = Math.max(visible.left + 6, Math.min(visible.right - width - 6, left));
    let top = model.top - height - 8;
    if (top < visible.top + 6) {
      // 模型顶到上边缘了：改放到模型上方可见区以内，实在不行放到模型下方
      top = Math.min(visible.bottom - height - 6, model.bottom + 8);
    }
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(Math.max(visible.top + 6, top))}px`;
  } catch {
    host.style.left = "12px";
    host.style.top = "12px";
  }
}

/**
 * 弹一条错误提示。返回是否真的显示出来了（被去重/限流/不可见时返回 false）。
 */
export function showErrorPopup(kind: ErrorPopupKind, text: string): boolean {
  if (!options) return false;
  if (options.isEnabled && !options.isEnabled()) return false;

  const message = normalize(text);
  if (!message) return false;
  const now = Date.now();

  if (document.hidden) {
    options.log(`[popup] 未显示（窗口不可见）：${message}`);
    return false;
  }

  const duplicated = recent.some((r) => r.text === message && now - r.at < DEDUPE_MS);
  const tooSoon = now - lastShownAt < MIN_GAP_MS;
  windowHits = windowHits.filter((t) => now - t < WINDOW_MS);
  const tooMany = windowHits.length >= MAX_PER_WINDOW;

  if (duplicated || tooSoon || tooMany) {
    // 抑制也要留痕，但一分钟最多记一条，避免日志被刷
    if (now - lastSuppressLogAt > 60_000) {
      lastSuppressLogAt = now;
      const why = duplicated ? "内容重复" : tooSoon ? "两条间隔太短" : "单位时间条数超限";
      options.log(`[popup] 已抑制（${why}）：${message}`);
    }
    return false;
  }

  const host = ensureElement();
  const labelEl = host.querySelector(".pet-error-popup-label") as HTMLElement | null;
  const bodyEl = host.querySelector(".pet-error-popup-body") as HTMLElement | null;
  if (!labelEl || !bodyEl) return false;

  host.style.background = kind === "error" ? "#dc2f3d" : "#c47a08";
  labelEl.textContent = kind === "error" ? "出错了" : "请求失败";
  bodyEl.textContent = message;
  host.style.display = "block";
  place(host);

  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => hide("超时自动收起"), SHOW_MS);

  lastShownAt = now;
  windowHits.push(now);
  recent.push({ text: message, at: now });
  if (recent.length > 30) recent = recent.slice(-30);

  // 关键：确认"提示确实显示出来了"之后才写这条日志，
  // 这样事后能区分"错误没提示"和"提示了但用户没看到"。
  options.log(`[popup] 已提示（${kind === "error" ? "红色" : "黄色"}，10 秒，可关闭）：${message}`);
  return true;
}

/** HTTP 请求失败专用（黄色） */
export function notifyHttpError(text: string): boolean {
  return showErrorPopup("http", text);
}
