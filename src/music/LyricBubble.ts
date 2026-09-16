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
