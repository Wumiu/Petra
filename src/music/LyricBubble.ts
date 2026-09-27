/**
 * 歌词气泡：显示"正在播放"与当前歌词行。
 * 独立容器（不与小助手气泡共用 trimBubbles，避免互相挤掉），
 * 且不在交互区域列表里 —— 纯展示，点击照常穿透到下层窗口。
 */
const HOLD_LINE_MS = 9000;
const HOLD_SONG_MS = 5000;

let box: HTMLElement | null = null;
let current: HTMLElement | null = null;
let hideTimer: number | null = null;
let enabled = true;

function ensureBox(): HTMLElement {
  if (box && box.isConnected) return box;
  box = document.createElement("div");
  box.id = "lyric-bubbles";
  box.className = "as-bubbles lyric-bubbles";
  document.body.appendChild(box);
  return box;
}

/**
 * 歌词气泡定位：默认由 CSS 固定在左上角（left:12px; top:40px）。
 * 但「对话记录」面板（#chat-history-panel）打开时，面板可能弹在左上角区域，
 * 歌词气泡必须挪到面板正下方，绝不遮挡面板内容；下方放不下则退到面板上方。
 */
function positionBox(): void {
  if (!box || !box.isConnected) return;
  const historyPanel = document.getElementById("chat-history-panel") as HTMLElement | null;
  if (historyPanel && historyPanel.isConnected) {
    const pr = historyPanel.getBoundingClientRect();
    const w = box.offsetWidth || 250;
    const h = box.offsetHeight || 40;
    const gap = 8;
    let top = pr.bottom + gap;
    if (top + h > window.innerHeight - 8) top = pr.top - h - gap;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    const left = Math.min(Math.max(pr.left, 8), Math.max(8, window.innerWidth - w - 8));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.bottom = "auto";
  } else {
    // 面板关闭：交还 CSS 默认位置（左上角）
    box.style.left = "";
    box.style.top = "";
    box.style.bottom = "";
  }
}

function fadeOut(el: HTMLElement, ms: number): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (!el.isConnected) return;
    el.style.transition = "opacity 0.5s ease";
    el.style.opacity = "0";
    window.setTimeout(() => el.remove(), 520);
    if (current === el) current = null;
  }, ms);
}

function show(text: string, holdMs: number, kind: "line" | "song" | "hint", trans?: string | null): void {
  if (!enabled || !text.trim()) return;
  const host = ensureBox();
  if (current && current.isConnected) current.remove();
  const b = document.createElement("div");
  b.className = "as-bubble as-lyric as-lyric-" + kind;
  if (trans && trans.trim()) {
    // 译文单独一行放在原文下方（不跟在原文后面）
    const orig = document.createElement("div");
    orig.className = "as-lyric-orig";
    orig.textContent = text;
    const tr = document.createElement("div");
    tr.className = "as-lyric-trans";
    tr.textContent = trans.trim();
    b.append(orig, tr);
  } else {
    b.textContent = text;
  }
  host.appendChild(b);
  current = b;
  positionBox(); // 若对话记录面板打开，把歌词气泡挪到面板下方不遮挡
  fadeOut(b, holdMs);
}

export function setLyricBubbleEnabled(on: boolean): void {
  enabled = on;
  if (!on) clearLyricBubbles();
}

export function clearLyricBubbles(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (box) box.textContent = "";
  current = null;
}

/** 换歌提示：🎵 《歌名》 - 艺人 */
export function showSongBubble(title: string, artist: string): void {
  const label = artist ? "🎵 《" + title + "》 - " + artist : "🎵 《" + title + "》";
  show(label, HOLD_SONG_MS, "song");
}

/** 当前歌词行（译文可选，显示在原文下方） */
export function showLyricLine(text: string, trans?: string | null, holdMs = HOLD_LINE_MS): void {
  show(text, holdMs, "line", trans);
}

/** 提示（未找到歌词 / 进度失准等） */
export function showLyricHint(text: string, holdMs = 5000): void {
  show(text, holdMs, "hint");
}

/** 外部触发重定位（例如对话记录面板打开/关闭时）：让歌词气泡避开面板 */
export function repositionLyricBubble(): void {
  positionBox();
}
