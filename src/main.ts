import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { AudioAnalyzer } from "./audio/AudioAnalyzer";
import { BehaviorEngine } from "./autonomous/BehaviorEngine";
import { idleDriver, type PetDriver, type PetView } from "./live2d/PetDriver";
import { Rigged2DView } from "./live2d/psd/Rigged2DView";
import { listActions } from "./live2d/actions";
import { setupTrashDrop } from "./features/trash/TrashHandler";
import { setupContextMenu } from "./ui/ContextMenu";
import { trackEvent, incrementInteractionCount, trackAppUse, trackMusic } from "./features/diary/DiaryEventTracker";
import { checkAndGenerateDiary, takeDiaryStorageWarning } from "./features/diary/DiaryManager";
import { formatWeatherHtml } from "./features/weather/WeatherFormat";
import { toggleDiaryPanel } from "./features/diary/DiaryPanel";
import { hasDrawnToday } from "./features/card/DailyCardManager";
import { toggleDailyCardPanel } from "./features/card/DailyCardPanel";

import { toast } from "./ui/Toast";
import { copyText } from "./ui/clipboard";
import { setVisibleRect } from "./ui/visible";
import { clamp } from "./utils/math";
import { loadSettings, saveSettings, type Settings, type AssistantProvider } from "./utils/settings";
import { ACTIVITY_LABEL, nextActivity, type ActivityLevel } from "./utils/settings";
import { astrobotOn } from "./bridges/astrobot";
import { openAssistant } from "./assistant/AssistantPanel";
import { setLifecycle, triggerProactive, closeAssistant, clearBubbles, clearApiKeyCache, clearHistory, isAssistantBusy, sayPetLine, setModelRectProvider } from "./assistant/AssistantPanel";
import { startHourlyChime, stopHourlyChime, formatQuietRange } from "./features/hourly/HourlyChime";
import { buildHourlyQuietMenuItems } from "./features/hourly/HourlyQuietRows";
import { listModels, PROVIDERS, getUsageStats, resetUsageStats } from "./assistant/AssistantClient";
import { registerEmotionReactor, reactToTouch, getMoodDriverValue, getMood, emotionExpression, emotionToAction } from "./assistant/EmotionEngine";
import { showEmotionPopup } from "./assistant/EmotionPopups";
import { listMiniGames, openMiniGame, closeMiniGame, isMiniGameOpen, activeMiniGameId, setMiniGameLifecycle } from "./games/host";
import { startMusicLyrics, stopMusicLyrics, noteAudioLevel, isSinging, setLyricsTranslate } from "./music/NowPlaying";
import { registerRiichiGame } from "./games/riichi";
import { clearPetTalkKeyCache } from "./games/riichi/petTalk";
import { RIICHI_SOUND_SETTINGS_EVENT } from "./games/riichi/sound";
import { getUnreadAnnouncement, markAnnounced } from "./features/Announcement";
import { checkForUpdate, performUpdate, UpdateCheckErrorExt } from "./updater/UpdateManager";
import { setupReminder, getReminders, removeReminder, openReminderModal, fmtReminderTime } from "./ui/ReminderPanel";
import {
  logicalRectToPhysicalRegion,
  regionFingerprint,
  type LogicalRect,
  type PhysicalInteractiveRegion,
} from "./input/regions";


// ---------- 性能优化工具函数 ----------
/** 防抖函数：在指定时间内多次调用只执行最后一次 */
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: number | null = null;
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      func(...args);
      timeout = null;
    }, wait);
  };
}

/** 节流函数：在指定时间内最多执行一次 */
function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => { inThrottle = false; }, limit);
    }
  };
}

// 优化后的IPC调用
const setInteractingDebounced = debounce((active: boolean) => {
  invoke("set_interacting", { active }).catch(() => {});
}, 50);

const setModelBoundsThrottled = throttle((bounds: {
  left: number; top: number; right: number; bottom: number;
}) => {
  invoke("set_model_bounds", bounds).catch(() => {});
}, 100);// 禁用页面滚动（桌宠窗口内容不应滚动）
document.documentElement.style.overflow = "hidden";
document.body.style.overflow = "hidden";

const WIN = 700;


// ---------- 陪伴时间 ----------
const COMPANION_KEY = "petra-companion-start";
const companionStart = (() => {
  const saved = localStorage.getItem(COMPANION_KEY);
  if (saved) return parseInt(saved, 10);
  const now = Date.now();
  localStorage.setItem(COMPANION_KEY, String(now));
  return now;
})();

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}天${hours % 24}小时`;
  if (hours > 0) return `${hours}小时`;
  return `${Math.floor(ms / 60000)}分钟`;
}

// ---------- 待办提醒：模型头顶大气泡 + 提示音 ----------
/** 播放提示音（两个短哔声，Web Audio 生成） */
function playReminderSound() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = i === 0 ? 880 : 660;
      const gain = ctx.createGain();
      const start = t + i * 0.25;
      gain.gain.setValueAtTime(0.35, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    }
    setTimeout(() => ctx.close(), 1500);
  } catch { /* 忽略 */ }
}

/** 模型头顶大 toast（2 秒消失） */
function showBigReminder(text: string) {
  const el = document.createElement("div");
  el.className = "big-toast";
  el.textContent = text;
  document.body.appendChild(el);
  // 定位：模型顶部上方居中
  const mr = getModelRect();
  el.style.left = `${Math.round(mr.left + mr.width / 2)}px`;
  el.style.bottom = `${Math.round(window.innerHeight - mr.top + 14)}px`;
  el.style.transform = "translateX(-50%)";
  // 2 秒消失
  setTimeout(() => {
    el.classList.add("bye");
    setTimeout(() => el.remove(), 300);
  }, 2000);
  playReminderSound();
}

// 待办到期 → 大气泡 + 提示音
document.addEventListener("reminder-due", ((e: CustomEvent) => {
  showBigReminder((e.detail as any).text ?? "提醒时间到！");
}) as EventListener);

// 交互时间常量（ms）
const PROACTIVE_GREET_INTERVAL = 20 * 60 * 1000; // 小助手主动问候间隔
const DRAG_SUSPEND_MS = 30000; // 拖拽暂停自主漫游时长
const IDLE_AFTER_DRAG_MS = 1500; // 拖拽后恢复漫游的休息时长
const FIRST_ROAM_DELAY = 5000; // 首次漫游延迟
const UPDATE_CHECK_DELAY = 5000; // 启动后检查更新延迟
const BUBBLE_FADE_MS = 8000; // 更新气泡自动消失时间
// 启动自动检查的 timer 句柄：用户手动检查时清除它，避免 5 秒后重复自动检查
let startupUpdateTimer: ReturnType<typeof setTimeout> | null = null;
const PSD_KEY = "live2d-pet-psd";
const BUILTIN_KEY = "live2d-pet-builtin-model"; // 当前选中的内置模型（manifest files 内）
const POS_KEY = "live2d-pet-position"; // 桌宠位置持久化

/** 保存桌宠位置到 localStorage（逻辑坐标） */
function savePetPosition(x: number, y: number) {
  try { localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y), t: Date.now() })); } catch {}
}

/** 读取上次保存的位置（逻辑坐标），无记录返回 null */
function loadPetPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
  } catch {}
  return null;
}

// 启动标记：模块求值成功即置位（诊断/探测器判据）
declare global {
  interface Window {
    __BOOT__?: boolean;
  }
}
window.__BOOT__ = true;

import * as PIXI from "pixi.js";

class PIXIApp {
  readonly app: PIXI.Application;
  constructor() {
    this.app = new PIXI.Application({
      width: WIN,
      height: WIN,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      powerPreference: "high-performance",
    });
    document.getElementById("stage")!.appendChild(this.app.view as unknown as Node);
  }
}

const app = new PIXIApp();
let view!: PetView;
let settings: Settings = loadSettings();
window.addEventListener(RIICHI_SOUND_SETTINGS_EVENT, () => {
  const saved = loadSettings();
  settings.gameSound = saved.gameSound;
  settings.gameSoundVolume = saved.gameSoundVolume;
  settings.gameMusic = saved.gameMusic;
  settings.gameMusicVolume = saved.gameMusicVolume;
});
let engine!: BehaviorEngine;
let scaleFactor = 1; // 物理↔逻辑坐标转换（系统缩放）
let winSize = WIN; // 当前窗口边长（模型缩放时跟随，默认 300）
// 调试边框（红线勾勒窗口边界）
let debugBorderVisible = false;
// 调试模型边框（绿框勾勒角色边界，验证"模型不出屏"）
let debugModelBoundsVisible = false;
// 交互模式：左键摸头后进入"不穿透"，再次摸头恢复自动穿透
// 当前实际模型来源（面板高亮用）
let currentModel: { type: "import" | "manifest" | "live2d"; name?: string } = {
  type: "manifest",
  name: "",
};
// 动作试玩面板：选完动作后隐藏，等左键点击恢复
let actionDebugHidden = false;

function attachView(v: PetView) {
  const stage = document.getElementById("stage")!;
  v.attachTo(stage, app.app.stage);
}

/** 应用模型缩放：窗口固定 700x700，模型显示大小按基准 300px 缩放 */
async function applyModelScale(s: number, record = false) {
  const clamped = clamp(s, 0.2, 2.0);
  settings.modelScale = clamped;
  // 用户调整时按模型记录（切换模型时恢复各自大小）
  if (record) {
    const key = currentModel.name ?? "";
    if (key) settings.modelScales[key] = clamped;
  }
  saveSettings(settings);
  const modelW = Math.round(300 * clamped); // 模型视觉大小以 300 为基准
  winSize = WIN; // 窗口始终 700x700
  engine.setWindowSize(WIN);
  view.setScale(modelW);
}

/** 调试边框开关（红线勾勒窗口边界，观察窗口出屏与模型偏移） */
function toggleDebugBorder() {
  debugBorderVisible = !debugBorderVisible;
  const el = document.getElementById("debug-border");
  el?.classList.toggle("hidden", !debugBorderVisible);
}

/** 调试模型边框开关（绿框勾勒角色边界，验证"模型不出屏"） */
function toggleModelBounds() {
  debugModelBoundsVisible = !debugModelBoundsVisible;
  const el = document.getElementById("model-bounds");
  el?.classList.toggle("hidden", !debugModelBoundsVisible);
}

/** 每帧更新模型边框绿框位置（窗口坐标 = modelOffset + 角色边界） */
function updateModelBounds(bounds?: { left: number; top: number; right: number; bottom: number } | null) {
  const el = document.getElementById("model-bounds");
  if (!el || !debugModelBoundsVisible) {
    engine.lastBoundsOnScreen = null;
    return;
  }
  if (!bounds) {
    el.classList.add("hidden");
    engine.lastBoundsOnScreen = null;
    return;
  }
  el.classList.remove("hidden");
  const ox = engine.modelOffset.x;
  const oy = engine.modelOffset.y;
  const l = Math.round(ox + bounds.left);
  const t = Math.round(oy + bounds.top);
  const w = Math.round(bounds.right - bounds.left);
  const h = Math.round(bounds.bottom - bounds.top);
  el.style.left = `${l}px`;
  el.style.top = `${t}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  engine.lastBoundsOnScreen = { left: l, top: t, right: l + w, bottom: t + h };
}

/** 检查鼠标事件是否在模型区域内（绿框内），不是则忽略 */
function isInsideModel(e: { clientX: number; clientY: number }): boolean {
  const r = getModelRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

/** 获取模型在窗口中的矩形（不依赖 DOM，始终可用） */
function getModelRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const cb = view.getCharacterBounds?.();
  if (!cb) return { left: 200, top: 200, right: 500, bottom: 500, width: 300, height: 300 };
  const ox = engine.modelOffset.x;
  const oy = engine.modelOffset.y;
  return {
    left: ox + cb.left,
    top: oy + cb.top,
    right: ox + cb.right,
    bottom: oy + cb.bottom,
    width: cb.right - cb.left,
    height: cb.bottom - cb.top,
  };
}

/** 窗口在屏幕工作区内的可见区域（窗口本地坐标），供菜单/面板往屏幕内侧定位 */
function getWindowVisibleRect(): { left: number; top: number; right: number; bottom: number } {
  const a = engine.workArea;
  const wx = engine.windowScreenPos.x;
  const wy = engine.windowScreenPos.y;
  if (!a) return { left: 0, top: 0, right: winSize, bottom: winSize };
  return {
    left: Math.max(0, a.left - wx),
    top: Math.max(0, a.top - wy),
    right: Math.min(winSize, a.left + a.width - wx),
    bottom: Math.min(winSize, a.top + a.height - wy),
  };
}

/** 气泡/toasts 贴边自适应：钳制到窗口可见区；上方放不下翻到模型下方 */
function positionFloatingUi(
  toasts: HTMLElement | null,
  bubbles: HTMLElement | null,
  lyric: HTMLElement | null,
  mr: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  vr: { left: number; top: number; right: number; bottom: number },
) {
  /** 小助手气泡占用的高度（歌词气泡要叠到它上方，避免互相遮挡） */
  let bubblesHeight = 0;
  if (toasts && toasts.children.length > 0) {
    // bottom 是相对窗口底部的距离：可见范围 [innerHeight - vr.bottom, innerHeight - vr.top]
    const minBottom = window.innerHeight - vr.bottom + 8;
    const maxBottom = window.innerHeight - vr.top - 8;
    const bottom = Math.max(minBottom, Math.min(window.innerHeight - mr.bottom - 10, maxBottom));
    const cx = Math.max(vr.left + 4, Math.min(mr.left + mr.width / 2, vr.right - 4));
    toasts.style.left = `${Math.round(cx)}px`;
    toasts.style.bottom = `${Math.round(bottom)}px`;
    toasts.style.transform = "translateX(-50%)";
  }
  if (bubbles && bubbles.children.length > 0) {
    // 限制气泡宽度不超过可见区域，防止贴边时被截断
    const visibleW = vr.right - vr.left - 8;
    bubbles.style.maxWidth = `${Math.max(80, visibleW)}px`;
    const bw = bubbles.offsetWidth || 214;
    const bh = bubbles.offsetHeight || 60;
    // 计算气泡中心位置（transform: translateX(-50%) 使气泡居中于 cx）
    const idealCx = mr.left + mr.width / 2;
    const minCx = vr.left + bw / 2 + 4; // 左边界：气泡左边缘不超出可见区
    const maxCx = vr.right - bw / 2 - 4; // 右边界：气泡右边缘不超出可见区
    let cx: number;
    if (minCx <= maxCx) {
      // 正常情况：可见区足够宽，钳制到范围内
      cx = Math.max(minCx, Math.min(idealCx, maxCx));
    } else {
      // 可见区太窄：居中显示（允许少量溢出）
      cx = (vr.left + vr.right) / 2;
    }
    let top = mr.top - bh - 12; // 模型上方
    if (top < vr.top) top = mr.bottom + 12; // 上方放不下 → 翻到模型下方
    if (top + bh > vr.bottom) top = Math.max(vr.top, vr.bottom - bh - 4); // 仍放不下 → 钳制
    bubbles.style.left = `${Math.round(cx)}px`;
    bubbles.style.top = `${Math.round(top)}px`;
    bubbles.style.bottom = "auto";
    bubbles.style.transform = "translateX(-50%)";
    bubblesHeight = bh + 6;
  }
  if (lyric && lyric.children.length > 0) {
    // 歌词气泡：优先贴在模型上方；小助手气泡也在时叠到它上面
    const visibleW = vr.right - vr.left - 8;
    lyric.style.maxWidth = `${Math.max(80, visibleW)}px`;
    const lw = lyric.offsetWidth || 250;
    const lh = lyric.offsetHeight || 44;
    const idealCx = mr.left + mr.width / 2;
    const minCx = vr.left + lw / 2 + 4;
    const maxCx = vr.right - lw / 2 - 4;
    const cx = minCx <= maxCx ? Math.max(minCx, Math.min(idealCx, maxCx)) : (vr.left + vr.right) / 2;
    let top = mr.top - lh - 12 - bubblesHeight; // 模型上方（叠在小助手气泡之上）
    if (top < vr.top) top = mr.top - lh - 12; // 叠层放不下 → 紧贴模型上方
    if (top < vr.top) top = mr.bottom + 12; // 上方放不下 → 翻到模型下方
    if (top + lh > vr.bottom) top = Math.max(vr.top, vr.bottom - lh - 4); // 仍放不下 → 钳制可见区
    lyric.style.left = `${Math.round(cx)}px`;
    lyric.style.top = `${Math.round(top)}px`;
    lyric.style.bottom = "auto";
    lyric.style.transform = "translateX(-50%)";
  }
}

/** 将面板定位到模型旁边：往屏幕内侧（空间大的方向），不挡住模型、不出屏 */
function positionPanelNearModel(panel: HTMLElement) {
  panel.style.position = "fixed"; // 确保 fixed 定位
  const mr = getModelRect();
  const vr = getWindowVisibleRect();
  // 可见区尺寸下限保护（贴边/几乎出屏时不出现负值或 0）
  const maxW = Math.max(60, vr.right - vr.left - 40);
  const maxH = Math.max(60, vr.bottom - vr.top - 40);
  // 先让面板按自身内容撑开
  panel.style.maxWidth = `${maxW}px`;
  panel.style.maxHeight = `${maxH}px`;
  let pw = panel.offsetWidth || 230;
  let ph = panel.offsetHeight || 200;
  // 面板比可见区大则缩小
  if (pw > maxW || ph > maxH) {
    panel.style.maxWidth = `${maxW}px`;
    panel.style.maxHeight = `${maxH}px`;
    pw = Math.min(pw, maxW);
    ph = Math.min(ph, maxH);
  }

  // 屏幕中心（逻辑坐标）
  const a = engine.workArea;
  const screenCx = a ? a.left + a.width / 2 : window.innerWidth / 2;
  const screenCy = a ? a.top + a.height / 2 : window.innerHeight / 2;
  // 窗口中心（屏幕坐标）
  const winCx = engine.windowScreenPos.x + winSize / 2;
  const winCy = engine.windowScreenPos.y + winSize / 2;
  // 屏幕内侧：窗口在左半 → 往右；右半 → 往左；上半 → 往下；下半 → 往上
  const preferRight = winCx <= screenCx;
  const preferBottom = winCy <= screenCy;

  // 候选位置按屏幕内侧优先排序
  const candidates: { left: number; top: number }[] = [];
  const hor = preferRight
    ? [
        { left: mr.right + 10, top: mr.top },
        { left: mr.left - pw - 10, top: mr.top },
      ]
    : [
        { left: mr.left - pw - 10, top: mr.top },
        { left: mr.right + 10, top: mr.top },
      ];
  const ver = preferBottom
    ? [
        { left: mr.left + (mr.width - pw) / 2, top: mr.bottom + 10 },
        { left: mr.left + (mr.width - pw) / 2, top: mr.top - ph - 10 },
      ]
    : [
        { left: mr.left + (mr.width - pw) / 2, top: mr.top - ph - 10 },
        { left: mr.left + (mr.width - pw) / 2, top: mr.bottom + 10 },
      ];
  candidates.push(...hor, ...ver);

  // 选第一个完整落在可见区内的位置
  for (const c of candidates) {
    const l = Math.round(c.left);
    const t = Math.round(c.top);
    if (l >= vr.left && l + pw <= vr.right && t >= vr.top && t + ph <= vr.bottom) {
      panel.style.left = `${l}px`;
      panel.style.top = `${t}px`;
      panel.style.bottom = "auto";
      panel.style.transform = "none";
      return;
    }
  }

  // 兜底：clamp 到可见区
  const left = Math.max(vr.left, Math.min(preferRight ? mr.right + 10 : mr.left - pw - 10, vr.right - pw));
  const top = Math.max(vr.top, Math.min(preferBottom ? mr.bottom + 10 : mr.top - ph - 10, vr.bottom - ph));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.bottom = "auto";
  panel.style.transform = "none";
}

/** 将通知定位到模型头顶（不挡住模型） */
function positionAboveModel(el: HTMLElement) {
  const mr = getModelRect();
  el.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
  el.style.bottom = `${Math.round(window.innerHeight - mr.top + 10)}px`;
  el.style.top = "auto";
  el.style.transform = "translateX(-50%)";
}

/** 换模型后重置边界到默认（view 可能还没初始化，安全检查） */
function resetBoundsOnModelSwitch() {
  settings.boundsPadding = { left: 0, right: 0, top: 0, bottom: 0 };
  saveSettings(settings);
  if (view) (view as any).setBoundsPadding?.(settings.boundsPadding);
}

async function makePsdView(bytes: Uint8Array): Promise<Rigged2DView> {
  const v = await Rigged2DView.create(bytes);
  v.warnings.forEach((w) => toast(w, "warn"));
  return v;
}

async function createView(): Promise<PetView> {
  // 1) 已导入的 PSD（数据目录）
  const imported = localStorage.getItem(PSD_KEY);
  if (imported) {
    try {
      const bytes = await invoke<number[]>("read_psd", { name: imported });
      currentModel = { type: "import", name: imported };
      return await makePsdView(new Uint8Array(bytes));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[模型切换] 导入 PSD "${imported}" 加载失败：`, err);
      toast(`模型 "${imported}" 加载失败，已回退内置：${msg}`, "warn");
      localStorage.removeItem(PSD_KEY);
    }
  }
  // 2) 打包的 PSD 模型（public/models/<file>）
  try {
    const m = await invoke<string>("read_model_manifest")
      .then((s) => JSON.parse(s as string))
      .catch(() => null);
    if (m?.type === "psd" && m.file) {
      // 默认模型：优先用用户上次选择的内置模型（须在 files 列表内）
      const saved = localStorage.getItem(BUILTIN_KEY);
      const file = saved && Array.isArray(m.files) && m.files.includes(saved) ? saved : m.file;
      try {
        // 统一走 Rust 命令读取（dev/release 都通过 exe/resource 目录找文件）
        const bytes = await invoke<number[]>("read_builtin_psd", { name: file });
        currentModel = { type: "manifest", name: file };
        resetBoundsOnModelSwitch();
        return await makePsdView(new Uint8Array(bytes));
      } catch (err) {
        console.error(`内置模型 ${file} 加载失败:`, err);
      }
    }
    if (m?.active) {
      // 动态 import：pixi-live2d-display 有模块级 runtime 检查，隔离避免拖垮主链
      const { Live2DController } = await import("./live2d/Live2DController");
      const v = await Live2DController.create();
      if (v) {
        currentModel = { type: "live2d", name: m.active };
        return v;
      }
    }
  } catch {
    /* 无 manifest 或不是 PSD 模式 */
  }
  // 3) 标准 Live2D（model3.json）
  try {
    const { Live2DController } = await import("./live2d/Live2DController");
    const l2d = await Live2DController.create();
    if (l2d) {
      currentModel = { type: "live2d", name: "model3" };
      return l2d;
    }
  } catch (err) {
    console.error(`live2d 加载失败: ${err}`);
  }
  // 默认模型（deepseek.psd）加载失败：不允许回退占位，直接抛错
  throw new Error("模型加载失败（manifest 未配置或 deepseek.psd 缺失）");
}

async function importPsdBytes(name: string, bytes: Uint8Array) {
  try {
    const saved = await invoke<string>("save_psd", { name, bytes });
    localStorage.setItem(PSD_KEY, saved);
    resetBoundsOnModelSwitch();
    await reloadView();
  } catch (err) {
    toast(`导入失败：${err}`, "warn");
  }
}

async function importPsdFromPath(path: string) {
  try {
    const bytes = await invoke<number[]>("read_file_bytes", { path });
    const name = path.split(/[\\/]/).pop() ?? "model.psd";
    await importPsdBytes(name, new Uint8Array(bytes));
  } catch (err) {
    toast(`读取失败：${err}`, "warn");
  }
}

async function mountView() {
  view = await createView();
  view.setSwayEnabled(settings.audioEnabled);
  (view as any).setBoundsPadding?.(settings.boundsPadding);
  attachView(view);
  // 恢复模型调节参数
  if (view instanceof Rigged2DView) {
    const modelName = currentModel.name ?? "default";
    const params = settings.modelParams[modelName] ?? {};
    for (const [k, v] of Object.entries(params)) {
      (view as Rigged2DView).setParam(k, v);
    }
    const auto = settings.modelAuto[modelName] ?? {};
    for (const [k, v] of Object.entries(auto)) {
      (view as Rigged2DView).setAutoOption(k as any, v);
    }
  }
}

async function reloadView() {
  view.unmount();
  await mountView();
  // 切换模型：恢复该模型自己的大小（无记录用默认 100%）
  const key = currentModel.name ?? "";
  const scale = settings.modelScales[key] ?? 1;
  void applyModelScale(scale, false);
}

// ---------- 小助手全局呼出快捷键 ----------
/** 前端监听 Rust 发出的全局快捷键事件名 */
const ASSISTANT_HOTKEY_EVENT = "assistant-hotkey";
/** 捕获快捷键时的临时提示条 */
let hotkeyCaptureEl: HTMLElement | null = null;

function removeHotkeyCapture() {
  hotkeyCaptureEl?.remove();
  hotkeyCaptureEl = null;
}

function showHotkeyCapture() {
  removeHotkeyCapture();
  const el = document.createElement("div");
  el.className = "hotkey-capture";
  el.textContent = "请按下新的快捷键组合…（Esc 取消）";
  document.body.appendChild(el);
  hotkeyCaptureEl = el;
}

/** 把浏览器按键归一成 Tauri 全局快捷键加速器里的键名（字母/数字/功能键/常用命名键） */
function normalizeShortcutKey(e: KeyboardEvent): string | null {
  const key = e.key;
  // 单个字母/数字直接可用（字母统一小写，加速器解析不区分大小写）
  if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) {
    return /[a-zA-Z]/.test(key) ? key.toLowerCase() : key;
  }
  const named: Record<string, string> = {
    " ": "Space",
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    CapsLock: "CapsLock",
  };
  if (named[key]) return named[key];
  // 功能键 F1~F24
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  return null;
}

/** 由一次按键事件拼出 accelerator 字符串，如 "Ctrl+Shift+A" */
function buildAccelerator(e: KeyboardEvent, key: string): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return [...mods, key].join("+");
}

/** 捕获一个新的呼出快捷键（返回 accelerator；Esc 或异常返回 null） */
function captureAssistantHotkey(): Promise<string | null> {
  return new Promise((resolve) => {
    showHotkeyCapture();
    const finish = (result: string | null) => {
      document.removeEventListener("keydown", onKey);
      removeHotkeyCapture();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      // 单独按修饰键不算，继续等完整组合
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
        return;
      }
      const key = normalizeShortcutKey(e);
      if (!key) return;
      e.preventDefault();
      finish(buildAccelerator(e, key));
    };
    // 下一帧再挂监听：避免把「点击菜单项」这次事件意外卷入
    requestAnimationFrame(() => document.addEventListener("keydown", onKey));
  });
}

/** 调 Rust 注册/替换全局快捷键，返回是否成功 */
async function registerAssistantHotkey(acc: string): Promise<boolean> {
  try {
    await invoke("register_assistant_shortcut", { shortcut: acc });
    return true;
  } catch (e) {
    console.error("register_assistant_shortcut failed:", e);
    return false;
  }
}

/** 菜单项：进入捕获模式设置快捷键 */
async function setAssistantHotkey() {
  const acc = await captureAssistantHotkey();
  if (!acc) {
    toast("已取消设置快捷键", "info");
    return;
  }
  settings.assistant.shortcut = acc;
  saveSettings(settings);
  const ok = await registerAssistantHotkey(acc);
  toast(ok ? `呼出快捷键已设为 ${acc}` : `快捷键 ${acc} 注册失败，可换个组合试试`, ok ? "info" : "warn");
}

/** 菜单项：清除已设置的快捷键 */
async function clearAssistantHotkey() {
  settings.assistant.shortcut = "";
  saveSettings(settings);
  try {
    await invoke("unregister_assistant_shortcut");
  } catch (e) {
    console.error("unregister_assistant_shortcut failed:", e);
  }
  toast("已清除呼出快捷键");
}

/** 监听 Rust 全局快捷键事件 + 启动时恢复上次设置的快捷键（跨重启保持） */
async function setupAssistantHotkeyListener() {
  await listen(ASSISTANT_HOTKEY_EVENT, async () => {
    const s = loadSettings();
    if (!s.assistant.enabled) {
      toast("小助手模式没开，先右键开启再唤出", "warn");
      return;
    }
    // 待机模式下：不弹对话框，改为在模型旁弹出"待机模式 开/关 + 睡着啦"小菜单
    if (s.idleMode) {
      const mr = getModelRect();
      window.dispatchEvent(new CustomEvent("petra:show-menu", {
        detail: { x: mr.left + mr.width / 2, y: mr.top },
      }));
      return;
    }
    // Rust 侧在按下快捷键时已把窗口 show+focus 到前台，这里只需弹出对话框并聚焦输入框
    openAssistant(getModelRect());
  });
  const saved = loadSettings().assistant.shortcut;
  if (saved) {
    await registerAssistantHotkey(saved);
  }
}

async function boot() {
  try {
    await mountView();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(`模型加载失败：${msg}`, "warn");
    return;
  }

  // 同步 Rust 侧音频开关到持久化设置
  void invoke("set_audio_enabled", { enabled: settings.audioEnabled });

  const win = getCurrentWindow();
  scaleFactor = await win.scaleFactor().catch(() => 1);
  void win.onScaleChanged(({ payload }) => {
    scaleFactor = payload.scaleFactor;
    engine?.setScale(scaleFactor);
    requestInteractionRegionSync(true);
  });
  window.addEventListener("resize", () => requestInteractionRegionSync(true));
  // 恢复上次保存的位置（优先），否则用系统报告的当前位置
  const savedPos = loadPetPosition();
  let pos = await currentLogicalPos(win);
  if (savedPos) {
    pos = savedPos;
    void win.setPosition(new LogicalPosition(pos.x, pos.y));
  }

  engine = new BehaviorEngine(pos);
  engine.setScale(scaleFactor);
  engine.setActivityLevel(settings.activity);
  engine.setTracking(settings.mouseTrack);
  // 应用持久化模型缩放（窗口尺寸 + canvas + 引擎窗口边长）
  void applyModelScale(settings.modelScale);
  if (import.meta.env.DEV) {
    // 红框/绿框只在 dev 构建创建，release 不显示调试边界。
    const border = document.createElement("div");
    border.id = "debug-border";
    border.className = "hidden";
    document.body.appendChild(border);
    const mb = document.createElement("div");
    mb.id = "model-bounds";
    mb.className = "hidden";
    document.body.appendChild(mb);
  }
  // 气泡按桌宠当前位置摆放（放它上方），别把桌宠挡住
  setModelRectProvider(getModelRect);
  // 小助手对话期间桌宠静止，关闭后恢复漫游
  setLifecycle(
    () => engine.suspend(3600_000),
    () => engine.suspend(IDLE_AFTER_DRAG_MS),
  );
  // 小游戏打开：暂停漫游、收起对话气泡；关闭：恢复正常漫游
  setMiniGameLifecycle(
    () => {
      engine.suspend(3600_000);
      closeAssistant();
      clearBubbles();
      // 日记素材：今天陪你玩过什么
      const id = activeMiniGameId();
      const def = listMiniGames().find((g) => g.id === id);
      const label = def ? `${def.emoji}${def.name}` : "小游戏";
      trackEvent({ type: "game", summary: `陪你玩了${label}` });
    },
    () => {
      engine.suspend(IDLE_AFTER_DRAG_MS);
    },
  );
  // 情感引擎 → 角色表现：AI/用户情绪驱动表情 + 动作（本地规则，零 token）
  registerEmotionReactor((tag) => {
    if (view instanceof Rigged2DView) {
      view.setExpression(emotionExpression(tag), 2.6);
    }
    const action = emotionToAction(tag);
    if (action) view.playAction(action, false);
    // 聊天时：在模型头部左/右随机一侧冒出情绪微表情（仅对话输入栏打开时可见）
    try { showEmotionPopup(tag, getModelRect()); } catch { /* 不影响主流程 */ }
    if (import.meta.env.DEV) {
      document.dispatchEvent(new CustomEvent("petra-emotion-reacted", { detail: { tag, action } }));
    }
  });
  // 启动一律正常站立（不自动恢复待机）
  if (settings.idleMode) {
    settings.idleMode = false;
    saveSettings(settings);
  }
  // 延迟首次漫游（low 档完全静止，不触发首次移动）
  if (settings.activity !== "low") {
    setTimeout(() => void engine.teleportRandom(), FIRST_ROAM_DELAY);
  }

  // 小助手主动问候：每 20 分钟，若开启且空闲则智能打招呼（识别当前窗口）
  // 主动问候：场景触发（替代固定 20 分钟）
  let lastGreetAt = 0;
  let activeStartAt = Date.now();   // 当前连续活跃段的起始时间
  let lastActiveAt = Date.now();    // 最近一次检测到用户活跃的时间
  let wasIdle = false;              // 上次检查时是否处于空闲

  // 每 5 分钟检查一次场景
  setInterval(async () => {
    if (!settings.assistant.enabled) return;
    if (settings.idleMode) return; // 待机期间不弹主动问候/对话框
    let idleSec = 0;
    try { idleSec = await invoke<number>("get_idle_seconds"); } catch {}

    const now = Date.now();
    const isIdle = idleSec > 300; // 空闲超过 5 分钟才算"离开"

    if (isIdle) {
      // 用户离开了
      if (!wasIdle) {
        // 刚离开，记录
        wasIdle = true;
      }
    } else {
      // 用户活跃
      if (wasIdle) {
        // 从离开状态回来 → 重置活跃段
        activeStartAt = now;
        wasIdle = false;
        // 回归问候：离开超过 15 分钟才触发
        const awayMs = now - lastActiveAt;
        if (awayMs > 15 * 60 * 1000 && now - lastGreetAt > 15 * 60 * 1000) {
          lastGreetAt = now;
          void triggerProactive();
          trackEvent({ type: "greeting", summary: "主动问候了用户" });
          return;
        }
      }
      lastActiveAt = now;
    }

    const sinceGreet = now - lastGreetAt;
    const activeMs = now - activeStartAt; // 连续活跃时长
    const hour = new Date().getHours();

    // 久坐提醒：连续活跃超过 90 分钟且没离开过
    // 获取用户设置的问候间隔（分钟转毫秒）
    const greetIntervalMs = (settings.assistant.greetInterval ?? 20) * 60 * 1000;

    if (activeMs > 90 * 60 * 1000 && sinceGreet > greetIntervalMs * 3 && !wasIdle) {
      lastGreetAt = now;
      void triggerProactive();
          trackEvent({ type: "greeting", summary: "主动问候了用户" });
      return;
    }

    // 熬夜关怀（23 点至凌晨 5 点）
    if ((hour >= 23 || hour < 5) && sinceGreet > 30 * 60 * 1000) {
      lastGreetAt = now;
      void triggerProactive();
          trackEvent({ type: "greeting", summary: "深夜关心了还在熬夜的用户" });
      return;
    }

    // 心情低谷关怀：宠物心情很低（用户最近情绪低落）→ 触发安慰型问候
    if (getMood().happiness < 0.35 && sinceGreet > 45 * 60 * 1000) {
      lastGreetAt = now;
      void triggerProactive();
          trackEvent({ type: "greeting", summary: "察觉主人心情低落，主动安慰了用户" });
      return;
    }

    // 早晨首次
    if (hour >= 6 && hour < 10 && lastGreetAt === 0) {
      lastGreetAt = now;
      void triggerProactive();
          trackEvent({ type: "greeting", summary: "主动问候了用户" });
      return;
    }

    // 兜底
    if (sinceGreet > 60 * 60 * 1000) {
      lastGreetAt = now;
      void triggerProactive();
          trackEvent({ type: "greeting", summary: "主动问候了用户" });
    }
  }, 5 * 60 * 1000);

  // 光标/工作区轮询：独立定时器，避免渲染热路径 await IPC
  setInterval(() => void engine.pollCursor(), 60);
  setInterval(() => void engine.pollArea(), 2500);

  // ---------- 音频 ----------
  const analyzer = new AudioAnalyzer();
  let breathingPhase = 0; // 呼吸累积相位（支持 BPM 同步平滑切换）
  const startAudio = async () => {
    if (!settings.audioEnabled) return;
    try {
      await analyzer.start();
    } catch (err) {
      /* 忽略 */
    }
    await analyzer.ctx.resume().catch(() => {});
  };
  // 启动后自动检查一次更新（静默，非阻塞——fire-and-forget，不等待）
  startupUpdateTimer = setTimeout(() => {
    startupUpdateTimer = null;
    void checkUpdate(false);
  }, UPDATE_CHECK_DELAY);

  listen<string | object>("audio:error", (e) => {
    toast(`音频走丢了：${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`, "warn");
    toggleAudio(false);
  });
  void startAudio();

  // 歌词气泡（SMTC 识别正在播放 + 在线歌词）
  if (settings.musicLyrics) startMusicLyrics();

  // ---------- 交互 ----------
  setupTrashDrop(() => view, win, (path) => void importPsdFromPath(path));
  setupReminder();

  setupContextMenu(
    () => buildMenu(engine),
    onMenuOpen,
    () => getWindowVisibleRect(),
    (x: number, y: number) => isInsideModel({ clientX: x, clientY: y }),
    () => getModelRect(),
  );
  startInteractionRegionSync();
  void setupAssistantHotkeyListener();

  // 左键：按住可拖动桌宠；轻点（<6px 未拖）算"摸头"反应或打开小助手。
  // 非待机：拖动走 Rust 原生跟随线程（GetCursorPos → SetWindowPos，8ms，零每帧 IPC）。
  // 待机中：拖动沿边缘水平滑动（Rust 锁 y 跟随，只移动待机位置，不退出；退出仅靠右键菜单）。
  let drag: { sx: number; sy: number; wx: number; wy: number; moved: boolean; mode: "idleSlide" | "free" } | null = null;
  let nativeDragStart: Promise<unknown> | null = null;
  let uiPointerLocked = false;
  let dragLastMove = 0;
  let dragOutsideFrames = 0; // 拖拽看门狗：光标连续出窗帧数
  document.addEventListener("pointerdown", (e) => {
    void analyzer.ctx.resume();
    if (e.button !== 0) return;
    // UI 按压期间也临时锁定，保证 slider/scroll/pointer capture 越出 rect 后不中断。
    if ((e.target as HTMLElement).closest?.("#menu, .model-panel, #info-panel, #update-bubble, #as-inputbar, #as-bubbles, .rm-modal-box, [data-petra-interactive]")) {
      uiPointerLocked = true;
      setInteractingDebounced(true);
      return;
    }
    // 绿框外区域不响应（穿透到下层）
    if (!isInsideModel(e)) return;
    if (actionDebugHidden) {
      actionDebugHidden = false;
      const panel = document.getElementById("action-debug") as HTMLElement | null;
      panel?.classList.remove("hidden");
      return;
    }
    // 按下宠物后锁住输入，直到 pointerup/cancel/blur；拖出原 petRect 也不会中断。
    setInteractingDebounced(true);
    const p = engine.position;
      drag = { sx: e.clientX, sy: e.clientY, wx: p.x, wy: p.y, moved: false, mode: "free" };
    engine.suspend(DRAG_SUSPEND_MS);
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      if (settings.idleMode) {
        // 待机中：用原生拖动 + locked_y，8ms 跟随无抖动
        drag.mode = "idleSlide";
        nativeDragStart = invoke("drag_start", { lockedY: Math.round(engine.idleTarget.y * scaleFactor) }).catch(() => {});
      } else {
        drag.mode = "free";
        // 一次性启动 Rust 原生拖动（此后窗口由 8ms 线程直接跟随鼠标）
        nativeDragStart = invoke("drag_start", {}).catch(() => {});
      }
    }
    const now = performance.now();
    if (now - dragLastMove < 16) return;
    dragLastMove = now;
    if (drag.mode === "idleSlide") {
      // 待机滑动：原生拖动 8ms 线程直接跟随（locked_y 锁定边缘），无需前端设位置
    } else {
      let nx = Math.round(drag.wx + dx);
      let ny = Math.round(drag.wy + dy);
      // 先设位置，再算 offset，再约束（同一帧内完成，不留时序差）
      engine.setPos(nx, ny);
      const cb = view.getCharacterBounds?.() ?? null;
      engine.syncModelOffset(cb ?? undefined);
      engine.constrainPosition();
      // 实时发送模型边界（含 offset）给 Rust drag_follow，8ms 原生夹紧
      {
        const ox = engine.rawOffset.x;
        const oy = engine.rawOffset.y;
        const fallback = { left: 200, top: 200, right: 500, bottom: 500 };
        const b = cb ?? fallback;
        const s = scaleFactor || 1;
        void invoke("set_model_bounds", {
          left: Math.round((ox + b.left) * s),
          top: Math.round((oy + b.top) * s),
          right: Math.round((ox + b.right) * s),
          bottom: Math.round((oy + b.bottom) * s),
        });
      }
    }
  });
  const endDrag = (cancelled = false) => {
    if (!drag) return;
    const clicked = !cancelled && !drag.moved;
    const clickX = drag.sx; const clickY = drag.sy;
    if (drag.moved) {
      const start = nativeDragStart ?? Promise.resolve();
      void start.finally(() => {
        invoke("drag_end").catch(() => {});
        // 拖拽结束：把引擎位置同步到实际窗口位置（原生 8ms 跟随可能在屏边夹紧，
        // 自由拖拽与待机滑动同样适用，避免恢复漫游时从失真的 pos 起跳）
        void getCurrentWindow().outerPosition().then(p => {
          engine.setPos(p.x / scaleFactor, p.y / scaleFactor);
        });
      });
    }
    nativeDragStart = null;
    drag = null;
    // 保存桌宠位置（供重启恢复）
    void getCurrentWindow().outerPosition().then(p => { savePetPosition(p.x / scaleFactor, p.y / scaleFactor); });
    if (clicked) {
      if (settings.idleMode) {
        // 待机中：点击只弹"待机模式 开/关"小菜单，不弹对话框/天气栏，其余一概不响应
        window.dispatchEvent(new CustomEvent("petra:show-menu", { detail: { x: clickX, y: clickY } }));
      } else {
        view.playClick();
        reactToTouch();
        incrementInteractionCount();
        showInfoPanel();
        if (settings.assistant.enabled) {
          openAssistant(getModelRect());
        }
      }
      }
    setInteractingDebounced(false);
    requestInteractionRegionSync(true);
    engine.suspend(1500); // 拖完原地歇一会再乱逛
  };
  const releasePointerInteraction = (cancelled: boolean) => {
    if (uiPointerLocked) {
      uiPointerLocked = false;
      setInteractingDebounced(false);
      requestInteractionRegionSync(true);
    }
    endDrag(cancelled);
  };
  document.addEventListener("pointerup", () => releasePointerInteraction(false));
  document.addEventListener("pointercancel", () => releasePointerInteraction(true));
  window.addEventListener("blur", () => releasePointerInteraction(true));
  // 光标移出窗口时立即结束拖拽（WebView 收不到窗口外的 pointerup，会导致拖拽永久卡死）
  document.addEventListener("mouseleave", () => {
    if (drag) releasePointerInteraction(true);
  });

  // ---------- Astrobot 预留钩子 ----------
  astrobotOn((msg) => {
    if (msg.type === "emote" || msg.type === "gesture") {
      view.playClick();
      incrementInteractionCount();
    }
    if (msg.type === "speak") view.playGobble();
    if (msg.type === "move") {
      void engine.teleportRandom();
    }
  });

  
  // 整点播报（本地文案，零 token；免打扰时段自动跳过）
  applyHourlyChime();

  // 日记素材：前台应用用量 + 听过的歌（开着日记才采集）
  if (settings.diary?.enabled !== false) {
    startActivitySampling();
    startMusicJournaling();
  }

  if (settings.diary?.enabled !== false) {
    checkAndGenerateDiary().then(list => {
      if (list.length === 1) toast("📖 昨天的日记写好啦~");
      else if (list.length > 1) toast(`📖 补写了 ${list.length} 篇日记~`);
      const warn = takeDiaryStorageWarning();
      if (warn) toast(warn, "warn");
    }).catch(() => {});
    // 跨天自动补写：整天开着应用跨过午夜，日期变化后自动为刚结束的那天写日记
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const dayKey = () => {
      const n = new Date();
      return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
    };
    let lastDay = dayKey();
    setInterval(() => {
      const cur = dayKey();
      if (cur === lastDay) return;
      lastDay = cur;
      checkAndGenerateDiary().then(list => {
        if (list.length > 0) toast(`📖 昨天的日记写好啦~`);
      }).catch(() => {});
    }, 60 * 1000);
  }
/** 显示更新公告弹窗 */
function showAnnouncement(title: string, lines: string[], version: string) {
  const panel = document.createElement("div");
  panel.id = "announcement-panel";
  panel.className = "model-panel";
  panel.style.width = "300px";

  const titleEl = document.createElement("div");
  titleEl.className = "mp-title";
  titleEl.textContent = title;
  panel.appendChild(titleEl);

  for (const line of lines) {
    if (!line) {
      const spacer = document.createElement("div");
      spacer.style.height = "6px";
      panel.appendChild(spacer);
      continue;
    }
    const p = document.createElement("div");
    p.style.cssText = "font-size:12.5px;color:#5a4a65;line-height:1.7;padding:2px 0;";
    // 分节标题（【新增】/【优化】/【未来计划】/【作者的话】）加粗并上色，方便一眼扫过
    if (/^【.+】$/.test(line)) {
      p.style.cssText = "font-size:12.5px;font-weight:700;color:#b0658f;line-height:1.7;padding:4px 0 1px;";
    }
    p.textContent = line;
    panel.appendChild(p);
  }

  const btns = document.createElement("div");
  btns.className = "as-set-btns";
  btns.style.marginTop = "12px";
  const okBtn = document.createElement("button");
  okBtn.className = "as-btn as-btn-primary";
  okBtn.textContent = "知道了";
  okBtn.addEventListener("click", () => {
    markAnnounced(version, lines);
    panel.remove();
  });
  btns.appendChild(okBtn);
  panel.appendChild(btns);

  document.body.appendChild(panel);
  positionPanelNearModel(panel);
}

  // ---------- 更新公告（模型加载完成后弹出） ----------
  setTimeout(() => {
    const ann = getUnreadAnnouncement();
    if (ann) showAnnouncement(ann.title, ann.lines, ann.version);
  }, 3000);

// ---------- 主循环 ----------
  const driver: PetDriver = idleDriver();
  let lastNow = performance.now();
  app.app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;

    analyzer.tick();

    // syncModelOffset 先于 update（constrainPosition 在 update 内，需要最新 offset）
    const cb = view.getCharacterBounds?.() ?? null;
    engine.syncModelOffset(cb ?? undefined);
    engine.update(now, dt);
    // 仅拖拽期间同步给 Rust drag follower；穿透判定使用独立 regions。
    if (drag?.moved && drag.mode !== "idleSlide") {
      const ox = engine.rawOffset.x;
      const oy = engine.rawOffset.y;
      // 有 characterBounds → 精确边界；无 → 窗口中心 300x300 作为 fallback
      const fallback = { left: 200, top: 200, right: 500, bottom: 500 };
      const b = cb ?? fallback;
      const s = scaleFactor || 1;
      void invoke("set_model_bounds", {
        left: Math.round((ox + b.left) * s),
        top: Math.round((oy + b.top) * s),
        right: Math.round((ox + b.right) * s),
        bottom: Math.round((oy + b.bottom) * s),
      });
    }
    // 拖拽看门狗：原生跟随期间光标离开窗口（屏边夹紧 / 待机锁 y 拖出）后 WebView
    // 收不到 pointerup，拖拽状态会永久卡死。连续检测到光标出窗约 100ms 即强制结束。
    if (drag && drag.moved) {
      const half = winSize / 2 + 12;
      const cursorOutside =
        Math.abs(engine.cursorRelative.x) > half || Math.abs(engine.cursorRelative.y) > half;
      if (cursorOutside) {
        dragOutsideFrames++;
        if (dragOutsideFrames > 6) {
          dragOutsideFrames = 0;
          releasePointerInteraction(true);
        }
      } else {
        dragOutsideFrames = 0;
      }
    } else {
      dragOutsideFrames = 0;
    }
    updateModelBounds(cb);
    // 歌词时钟：喂入音频能量（起播/循环/失准判定），不消耗 token
    if (settings.musicLyrics) {
      noteAudioLevel(Math.max(analyzer.bass, analyzer.mid, analyzer.treble), dt * 1000);
    }
    driver.bass = analyzer.bass;
    driver.mid = analyzer.mid;
    driver.treble = analyzer.treble;
    driver.beat = analyzer.beat;
    driver.bpm = analyzer.bpm;
    driver.bob = engine.bob;
    driver.vx = engine.vx;
    driver.cursorDx = engine.cursorDx;
    driver.cursorDy = engine.cursorDy;
    // 呼吸同步化：有音乐时跟随 BPM（一次呼吸 = 4 拍），无音乐时默认速率
    const breathSpeed = analyzer.bpm > 40
      ? (analyzer.bpm / 60) * Math.PI * 2 / 4
      : (engine.isIdle ? 0.18 : 0.42) * Math.PI * 2;
    breathingPhase += dt * breathSpeed;
    driver.breathing = breathingPhase;
    driver.excited = engine.excitementValue;
    driver.mood = getMoodDriverValue();
    driver.singing = isSinging();
    driver.idleTop = engine.isIdleTop;
    driver.idle = engine.isIdle;
    driver.dragging = !!drag && drag.moved;
    driver.dragVelX = clamp(engine.cursorVx / 800, -1, 1);
    driver.pressed = !!drag;
    driver.modelOffsetX = engine.modelOffset.x;
    driver.modelOffsetY = engine.modelOffset.y;
    // 通知区域跟随模型位置（绿框下方）；气泡/通知贴边自适应钳制到可见区
    const mr = getModelRect();
    const vr = getWindowVisibleRect();
    setVisibleRect(vr);
    const toasts = document.getElementById("toasts");
    const bubbles = document.getElementById("as-bubbles");
    const lyricBubbles = document.getElementById("lyric-bubbles");
    if (!drag || !drag.moved) {
      positionFloatingUi(toasts, bubbles, lyricBubbles, mr, vr);
    }
    // 拖拽中所有打开的面板跟随模型位置
    if (drag && drag.moved) {
      // 输入框：默认在模型下方，放不下翻到上方，避开信息板，钳制可见区
      const ib = document.getElementById("as-inputbar");
      if (ib && !ib.classList.contains("hidden")) {
        const ih = ib.offsetHeight || 60;
        const iw = ib.offsetWidth || 185;
        const infoEl = document.getElementById("info-panel");
        const ir = infoEl && !infoEl.classList.contains("hidden")
          ? infoEl.getBoundingClientRect()
          : null;
        const collides = (l: number, t: number) =>
          ir !== null &&
          l < ir.right && l + iw > ir.left &&
          t < ir.bottom && t + ih > ir.top;
        const tops = [mr.bottom + 10, vr.bottom - ih, mr.top - ih - 10]; // 贴底时钳到可见区底部（允许盖住模型下半部分）
        let top = tops[0];
        for (const t of tops) {
          if (!collides(mr.left, t) && t >= vr.top && t + ih <= vr.bottom) {
            top = t;
            break;
          }
        }
        top = Math.max(vr.top, Math.min(top, vr.bottom - ih));
        ib.style.left = `${Math.round(Math.max(vr.left, Math.min(mr.left, vr.right - iw)))}px`;
        ib.style.top = `${Math.round(top)}px`;
        ib.style.bottom = "auto";
      }
      positionFloatingUi(toasts, bubbles, lyricBubbles, mr, vr);
      // 其他面板（model-panel、chat-history 等）
      document.querySelectorAll(".model-panel:not(.hidden), #chat-history-panel").forEach(el => {
        positionPanelNearModel(el as HTMLElement);
      });
    }

    // 调试日志仅 dev 构建输出
    if (import.meta.env.DEV && Math.round(now) % 2000 < 20 && (driver.bass > 0.001 || driver.mid > 0.001)) {
      console.log(`[driver] → bass=${driver.bass.toFixed(3)} mid=${driver.mid.toFixed(3)} sway=${settings.audioEnabled ? "on" : "OFF"}`);
    }
    view.update(driver, dt);
  });
}

async function currentLogicalPos(win: Awaited<ReturnType<typeof getCurrentWindow>>) {
  try {
    const scale = await win.scaleFactor();
    const p = await win.outerPosition();
    // outerPosition 返回物理像素 → 转逻辑（引擎内部全逻辑坐标）
    return { x: p.x / scale, y: p.y / scale };
  } catch {
    return { x: 100, y: 100 };
  }
}


/** 清空元素内容（安全方式） */
function clearElement(el: HTMLElement) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

// ---------- 右键菜单 ----------
let autostartCache = false;
let topmostCache = false;

async function onMenuOpen() {
  // 右键打开菜单时暂停移动
  engine.suspend(60000);
  void invoke("clear_pet_target").catch(() => {});
  // 菜单渲染前先拉取真实状态，避免“开机自启：关”但实际为开这类显示错误
  try {
    autostartCache = await invoke<boolean>("get_autostart");
  } catch {
    autostartCache = false;
  }
  try {
    topmostCache = await invoke<boolean>("is_topmost");
  } catch {
    topmostCache = false;
  }
  requestInteractionRegionSync(true);
}

const INTERACTION_UI_SELECTORS: ReadonlyArray<readonly [string, string]> = [
  ["menu", "#menu"],
  ["model-panel", ".model-panel"],
  ["info-add", ".info-rm-add"],
  ["info-delete", ".info-rm-del"],
  ["reminder-dialog", ".rm-modal-box"],
  ["assistant-input", "#as-inputbar"],
  ["assistant-bubble", "#as-bubbles > .as-bubble"],
  ["update", "#update-bubble"],
  ["custom", "[data-petra-interactive]"],
];

let interactionSyncRunning = false;
let interactionSyncPending = false;
let interactionSyncForce = false;
let lastInteractionFingerprint = "";
let lastInteractionSyncAt = 0;
let interactionSyncStarted = false;

function visibleElementRect(element: Element): LogicalRect | null {
  const el = element as HTMLElement;
  if (!el.isConnected || el.hidden || el.classList.contains("hidden")) return null;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || style.opacity === "0") return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function collectInteractionRegions(): PhysicalInteractiveRegion[] {
  const scale = scaleFactor || window.devicePixelRatio || 1;
  const clientPhysicalWidth = Math.round(window.innerWidth * scale);
  const clientPhysicalHeight = Math.round(window.innerHeight * scale);
  const regions: PhysicalInteractiveRegion[] = [];

  const pet = getModelRect();
  const petRegion = logicalRectToPhysicalRegion(
    "pet",
    pet,
    scale,
    clientPhysicalWidth,
    clientPhysicalHeight,
  );
  if (petRegion) regions.push(petRegion);

  const seen = new Set<Element>();
  for (const [kind, selector] of INTERACTION_UI_SELECTORS) {
    document.querySelectorAll(selector).forEach((element, index) => {
      if (seen.has(element)) return;
      const rect = visibleElementRect(element);
      if (!rect) return;
      seen.add(element);
      const el = element as HTMLElement;
      const customId = el.dataset.petraInteractive;
      const id = `ui:${customId || el.id || `${kind}-${index}`}`;
      const region = logicalRectToPhysicalRegion(
        id,
        rect,
        scale,
        clientPhysicalWidth,
        clientPhysicalHeight,
        2,
      );
      if (region) regions.push(region);
    });
  }
  return regions;
}

function requestInteractionRegionSync(force = false) {
  interactionSyncPending = true;
  interactionSyncForce ||= force;
  if (interactionSyncRunning) return;
  void flushInteractionRegions();
}

async function flushInteractionRegions() {
  interactionSyncRunning = true;
  try {
    while (interactionSyncPending) {
      interactionSyncPending = false;
      const force = interactionSyncForce;
      interactionSyncForce = false;
      const regions = collectInteractionRegions();
      const fingerprint = regionFingerprint(regions);
      const now = performance.now();
      if (!force && fingerprint === lastInteractionFingerprint && now - lastInteractionSyncAt < 1000) {
        continue;
      }
      await invoke("sync_interaction_regions", { regions });
      lastInteractionFingerprint = fingerprint;
      lastInteractionSyncAt = now;
    }
  } catch (err) {
    if (import.meta.env.DEV) console.warn("interaction region sync failed", err);
  } finally {
    interactionSyncRunning = false;
    if (interactionSyncPending) requestInteractionRegionSync();
  }
}

function startInteractionRegionSync() {
  if (interactionSyncStarted) return;
  interactionSyncStarted = true;
  new MutationObserver(() => requestInteractionRegionSync()).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "data-petra-interactive"],
  });
  // 模型边界需要周期同步，但 30Hz 的完整 DOM 扫描 + IPC 会在首次点击创建
  // 信息面板时放大卡顿。10Hz 对穿透区域已足够及时，状态变化仍由 observer
  // 立即触发同步。
  window.setInterval(() => requestInteractionRegionSync(), 100);
  requestInteractionRegionSync(true);
}

document.addEventListener("menu-closed", () => { engine.suspend(0); requestInteractionRegionSync(true); });
function hiddenPsdInput(): HTMLInputElement {
  let input = document.getElementById("psd-input") as HTMLInputElement | null;
  if (!input) {
    input = document.createElement("input");
    input.id = "psd-input";
    input.type = "file";
    input.accept = ".psd";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const f = input!.files?.[0];
      if (f) void f.arrayBuffer().then((buf) => importPsdBytes(f.name, new Uint8Array(buf)));
      input!.value = "";
    });
    document.body.appendChild(input);
  }
  return input;
}

// ---------- 模型设置面板 ----------
async function toggleModelPanel() {
  const panel = document.getElementById("model-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  let models: string[] = [];
  try {
    models = await invoke<string[]>("list_models");
  } catch {
    /* 忽略 */
  }
  // 内置模型列表（manifest 配置：files 列表，兼容单 file）
  let builtinNames: string[] = [];
  try {
    const m = await invoke<string>("read_model_manifest")
      .then((s) => JSON.parse(s as string))
      .catch(() => null);
    if (m?.type === "psd" && Array.isArray(m.files) && m.files.length) builtinNames = m.files;
    else if (m?.type === "psd" && m.file) builtinNames = [m.file];
    else if (m?.active) builtinNames = [m.active];
  } catch {
    /* 无 manifest */
  }

  // 动作库仅 PSD 角色支持，标准 Live2D 模型提示
  if (currentModel.type === "live2d") {
    toast("动作库暂仅支持 PSD 角色（当前为标准 Live2D 模型）", "warn");
  }

  const render = (host: HTMLElement) => {
    clearElement(host);
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "模型设置";
    host.appendChild(title);

    const mk = (label: string, apply: () => void, active: boolean) => {
      const row = document.createElement("div");
      row.className = `mp-item${active ? " active" : ""}`;
      const span = document.createElement("span");
      span.textContent = label;
      row.appendChild(span);
      if (active) {
        const tag = document.createElement("b");
        tag.textContent = "使用中";
        row.appendChild(tag);
      }
      row.addEventListener("click", async () => {
        apply();
        host.classList.add("hidden");
        await reloadView();
      });
      host.appendChild(row);
    };

    // 内置模型（manifest / 打包）：多个内置模型可切换
    for (const f of builtinNames) {
      const label = f.replace(/\.psd$/i, "");
      mk(`内置 · ${label}`, () => {
        localStorage.setItem(BUILTIN_KEY, f);
        localStorage.removeItem(PSD_KEY);
      }, currentModel.type === "manifest" && currentModel.name === f);
    }
    // 已导入 PSD——带删除按钮（内置模型不可删）
    for (const m of models) {
      const label = m.replace(/\.psd$/i, "");
      const active = currentModel.type === "import" && currentModel.name === m;
      const row = document.createElement("div");
      row.className = `mp-item${active ? " active" : ""}`;
      const span = document.createElement("span");
      span.textContent = `已导入 · ${label}`;
      row.appendChild(span);
      if (active) {
        const tag = document.createElement("b");
        tag.textContent = "使用中";
        row.appendChild(tag);
      }
      // 删除按钮：点击只触发删除，不切换模型
      const del = document.createElement("button");
      del.className = "mp-del";
      del.textContent = "删除";
      del.title = "删除该模型（删除后需重新导入才能恢复）";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        showDeleteConfirm(host, m, label, active);
      });
      row.appendChild(del);
      row.addEventListener("click", async () => {
        localStorage.setItem(PSD_KEY, m);
        host.classList.add("hidden");
        await reloadView();
      });
      host.appendChild(row);
    }
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = "（无已导入模型）";
      host.appendChild(empty);
    }
    // 模型调节入口（仅 PSD 模型）
    if (currentModel.type !== "live2d") {
      const adjRow = document.createElement("div");
      adjRow.className = "mp-item";
      const adjSpan = document.createElement("span");
      adjSpan.textContent = "🎨 模型调节（测试）";
      adjRow.appendChild(adjSpan);
      adjRow.addEventListener("click", () => {
        host.classList.add("hidden");
        toggleModelAdjustPanel();
      });
      host.appendChild(adjRow);
    }

    // 导入入口
    const importRow = document.createElement("div");
    importRow.className = "mp-item";
    const imp = document.createElement("span");
    imp.textContent = "＋ 导入 PSD 模型";
    importRow.appendChild(imp);
    importRow.addEventListener("click", () => {
      host.classList.add("hidden");
      hiddenPsdInput().click();
    });
    host.appendChild(importRow);

    // 返回按钮
    const backRow = document.createElement("div");
    backRow.className = "as-set-btns";
    const backBtn = document.createElement("button");
    backBtn.className = "as-btn";
    backBtn.textContent = "返回";
    backBtn.addEventListener("click", () => {
      host.classList.add("hidden");
    });
    backRow.appendChild(backBtn);
    host.appendChild(backRow);
  };

  // 删除确认面板：二次确认后才真正删除，杜绝误触
  const showDeleteConfirm = (
    host: HTMLElement,
    file: string,
    label: string,
    isCurrent: boolean,
  ) => {
    document.getElementById("del-confirm")?.remove();
    const panel = document.createElement("div");
    panel.id = "del-confirm";
    panel.className = "model-panel";
    panel.style.zIndex = "160"; // 高于模型面板(150)，避免被盖住
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "删除模型？";
    panel.appendChild(title);
    const hint = document.createElement("div");
    hint.className = "mp-hint";
    hint.textContent = `确定删除「${label}」吗？删除后需要重新导入 PSD 才能恢复。`;
    panel.appendChild(hint);
    const btns = document.createElement("div");
    btns.className = "as-set-btns";
    const cancel = document.createElement("button");
    cancel.className = "as-btn";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => panel.remove());
    const ok = document.createElement("button");
    ok.className = "as-btn as-btn-danger";
    ok.textContent = "删除";
    ok.addEventListener("click", async () => {
      panel.remove();
      await deleteModel(host, file, label, isCurrent);
    });
    btns.append(cancel, ok);
    panel.appendChild(btns);
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(panel);
  };

  // 删除后重新拉取列表并重渲染
  const refreshModels = async (host: HTMLElement) => {
    try {
      models = await invoke<string[]>("list_models");
    } catch {
      models = [];
    }
    render(host);
  };

  // 核心删除逻辑：
  // 1) 删除当前使用模型时，先切回内置模型并确认加载成功，再删文件
  // 2) 删除失败时回滚持久化状态并保留原条目
  // 3) 成功后刷新列表
  const deleteModel = async (
    host: HTMLElement,
    file: string,
    label: string,
    isCurrent: boolean,
  ) => {
    const wasCurrent = isCurrent || localStorage.getItem(PSD_KEY) === file;
    // 若删除的是当前使用模型：先切回内置（清空 PSD_KEY），并确认内置加载成功
    if (wasCurrent) {
      localStorage.removeItem(PSD_KEY);
      try {
        await reloadView();
      } catch (err) {
        // 内置模型加载失败：回滚，保留原模型与条目
        localStorage.setItem(PSD_KEY, file);
        console.error("删除时切回内置模型失败:", err);
        await reloadView().catch(() => {});
        toast("内置模型加载失败，删除已取消", "warn");
        return;
      }
    }
    // 真正删除文件（后端已做路径安全校验）
    try {
      await invoke("delete_imported_model", { name: file });
    } catch (err) {
      // 删除失败：恢复原模型（若刚才已切回），保留条目
      if (wasCurrent) {
        localStorage.setItem(PSD_KEY, file);
        await reloadView().catch(() => {});
      }
      console.error("delete_imported_model 失败:", err);
      toast("删除模型失败，请重试", "warn");
      return;
    }
    // 成功：刷新列表
    await refreshModels(host);
    toast(`已删除 ${label}`);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "model-panel";
    p.className = "model-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
    positionPanelNearModel(p);
    // 强制完整显示：底部超出可见区则翻到模型上方
    const pr = p.getBoundingClientRect();
    const vr2 = getWindowVisibleRect();
    if (pr.bottom > vr2.bottom || pr.top < vr2.top) {
      const mr2 = getModelRect();
      // 优先模型上方
      let nt = mr2.top - pr.height - 10;
      if (nt < vr2.top) nt = mr2.bottom + 10;
      nt = Math.max(vr2.top + 4, Math.min(nt, vr2.bottom - pr.height - 4));
      p.style.top = `${Math.round(nt)}px`;
      p.style.left = `${Math.round(mr2.left + (mr2.width - pr.width) / 2)}px`;
    }
  }
}

function buildMenu(engine: BehaviorEngine) {
  // 待机模式下：菜单只保留"待机模式 开/关"这一条，其余内容一律不显示。
  if (settings.idleMode) {
    return [
      { id: "idle", label: "待机模式", state: "开", onPick: () => void toggleIdle() },
      { id: "idle-hint", label: "睡着啦，喊我起来吧", hint: true },
    ];
  }
  return [
    {
      id: "model",
      label: "模型",
      submenu: [
        {
          id: "models",
          label: "模型设置",
          onPick: () => void toggleModelPanel(),
        },
        {
          id: "size",
          label: "模型大小",
          onPick: () => void toggleSizePanel(),
        },
        {
          id: "bounds",
          label: "调整模型边界",
          onPick: () => void toggleBoundsPanel(),
        },
        {
          id: "border",
          label: "显示边框",
          state: debugBorderVisible ? "开" : "关",
          onPick: () => toggleDebugBorder(),
        },
        {
          id: "model-bounds-toggle",
          label: "显示模型边框",
          state: debugModelBoundsVisible ? "开" : "关",
          onPick: () => toggleModelBounds(),
        },
      ],
    },
    {
      id: "interact",
      label: "交互",
      submenu: [
        {
          id: "audio",
          label: "跟随音乐",
          state: settings.audioEnabled ? "开" : "关",
          submenu: [
            {
              id: "audio-follow",
              label: "跟随音乐（未完善）",
              state: settings.audioEnabled ? "开" : "关",
              onPick: () => toggleAudio(!settings.audioEnabled),
            },
            {
              id: "lyrics-bubble",
              label: "歌词气泡",
              state: settings.musicLyrics ? "开" : "关",
              onPick: () => {
                settings.musicLyrics = !settings.musicLyrics;
                saveSettings(settings);
                if (settings.musicLyrics) {
                  startMusicLyrics();
                  toast("歌词气泡已开启");
                } else {
                  stopMusicLyrics();
                  toast("歌词气泡已关闭");
                }
              },
            },
            {
              id: "lyrics-translate",
              label: "歌词翻译",
              state: settings.lyricsTranslate ? "开" : "关",
              onPick: () => {
                settings.lyricsTranslate = !settings.lyricsTranslate;
                saveSettings(settings);
                setLyricsTranslate(settings.lyricsTranslate);
                toast(settings.lyricsTranslate ? "歌词显示中文翻译" : "歌词不再显示翻译");
              },
            },
          ],
        },
        {
          id: "activity",
          label: "活动频率",
          state: ACTIVITY_LABEL[settings.activity],
          onPick: () => {
            const next: ActivityLevel = nextActivity(settings);
            settings.activity = next;
            saveSettings(settings);
            engine.setActivityLevel(next);
            toast(`活动频率：${ACTIVITY_LABEL[next]}`);
          },
        },
        {
          id: "idle",
          label: "待机模式",
          state: settings.idleMode ? "开" : "关",
          onPick: () => void toggleIdle(),
        },
        {
          id: "track",
          label: "逗猫棒",
          state: settings.mouseTrack ? "开" : "关",
          onPick: () => {
            settings.mouseTrack = !settings.mouseTrack;
            saveSettings(settings);
            engine.setTracking(settings.mouseTrack);
            if (settings.mouseTrack && settings.activity === "low") {
              toast("低活动频率下桌宠保持静止，逗猫棒不生效");
            } else {
              toast(settings.mouseTrack ? "逗猫棒来啦～" : "收起逗猫棒");
            }
          },
        },
        {
          id: "action-debug",
          label: "动作试玩",
          onPick: () => void toggleActionDebug(),
        },
        {
          id: "hourly",
          label: "⏰ 整点播报",
          submenu: [
            {
              id: "hourly-on",
              label: "整点播报",
              state: settings.hourlyChime ? "开" : "关",
              onPick: () => {
                settings.hourlyChime = !settings.hourlyChime;
                saveSettings(settings);
                applyHourlyChime();
                toast(settings.hourlyChime ? "每到整点，桌宠会报一下时间" : "已关闭整点播报");
              },
            },
            ...buildHourlyQuietMenuItems(
              // 传"读取函数"而不是快照：▲▼ 点完要立刻显示新值
              () => ({
                enabled: settings.hourlyChimeQuiet !== false,
                start: settings.hourlyQuietStart ?? 23,
                end: settings.hourlyQuietEnd ?? 8,
              }),
              (patch) => {
                if (patch.enabled !== undefined) settings.hourlyChimeQuiet = patch.enabled;
                if (patch.start !== undefined) settings.hourlyQuietStart = patch.start;
                if (patch.end !== undefined) settings.hourlyQuietEnd = patch.end;
                saveSettings(settings);
                applyHourlyChime();
                // 只在开关那一下提示，▲▼ 连点时不刷屏
                if (patch.enabled !== undefined) {
                  toast(
                    settings.hourlyChimeQuiet
                      ? `免打扰时段：${formatQuietRange(settings.hourlyQuietStart ?? 23, settings.hourlyQuietEnd ?? 8)}`
                      : "免打扰已关闭，每个整点都会播报",
                  );
                }
              },
            ),
          ],
        },
      ],
    },

    {
      id: "assistant",
      label: "小助手模式",
      state: settings.assistant.enabled ? "开" : "关",
      onPick: () => {
        settings.assistant.enabled = !settings.assistant.enabled;
        saveSettings(settings);
        if (!settings.assistant.enabled) {
          closeAssistant();
          clearBubbles();
        }
        toast(settings.assistant.enabled ? "小助手已开启" : "小助手已关闭");
      },
    },
    {
      id: "assistant-hotkey",
      label: "呼出快捷键",
      state: settings.assistant.shortcut ? settings.assistant.shortcut : "未设置",
      onPick: () => void setAssistantHotkey(),
    },
    {
      id: "assistant-hotkey-clear",
      label: "清除呼出快捷键",
      onPick: () => void clearAssistantHotkey(),
    },
    {
      id: "assistant-settings",
      label: "小助手设置",
      onPick: () => void toggleAssistantSettings(),
    },
    {
      id: "chat-history",
      label: "对话记录",
      onPick: () => toggleChatHistory(),
    },
    {
      id: "diary",
      label: "📖 日记本",
      submenu: [
        { id: "diary-open", label: "打开日记本", onPick: () => toggleDiaryPanel() },
        {
          id: "diary-auto",
          label: "自动生成",
          state: settings.diary.autoGenerate ? "开" : "关",
          onPick: () => {
            settings.diary.autoGenerate = !settings.diary.autoGenerate;
            saveSettings(settings);
            toast(
              settings.diary.autoGenerate
                ? "每天第一次打开时会自动写昨天的日记"
                : "不再自动写日记，可在日记本里手动补写",
            );
          },
        },
        {
          id: "diary-track",
          label: "记录互动",
          state: settings.diary.enabled ? "开" : "关",
          onPick: () => {
            settings.diary.enabled = !settings.diary.enabled;
            saveSettings(settings);
            toast(
              settings.diary.enabled
                ? "开始记录聊天/提醒/互动，第二天写成日记"
                : "已停止记录互动（已有日记保留）",
            );
          },
        },
      ],
    },
    { id: "daily-card", label: "🎴 今日抽卡", state: hasDrawnToday() ? "已抽" : "未抽", onPick: () => toggleDailyCardPanel() },
    {
      id: "minigames",
      label: "🎮 小游戏",
      state: isMiniGameOpen() ? "进行中" : undefined,
      submenu: [
        ...listMiniGames().map((g) => ({
          id: "mg-" + g.id,
          label: g.emoji + " " + g.name,
          onPick: () => {
            if (openMiniGame(g.id)) toast("开局！和桌宠来一把～");
          },
        })),
        {
          id: "mg-talk",
          label: "麻将 AI 互动",
          state: settings.gameTalk ? "开" : "关",
          onPick: () => {
            settings.gameTalk = !settings.gameTalk;
            saveSettings(settings);
            toast(
              settings.gameTalk
                ? "麻将桌上的桌宠会实时点评牌况（需要 API Key）"
                : "麻将桌改为只用固定台词（零 token）",
            );
          },
        },
        {
          id: "mg-sound",
          label: "麻将游戏音效",
          state: settings.gameSound ? `${Math.round(settings.gameSoundVolume * 100)}%` : "关",
          onPick: () => {
            settings.gameSound = !settings.gameSound;
            saveSettings(settings);
            window.dispatchEvent(new Event(RIICHI_SOUND_SETTINGS_EVENT));
            toast(settings.gameSound ? `麻将音效已开启（${Math.round(settings.gameSoundVolume * 100)}%）` : "麻将音效已关闭");
          },
        },
        {
          id: "mg-music",
          label: "麻将对局音乐",
          state: settings.gameMusic ? `${Math.round(settings.gameMusicVolume * 100)}%` : "关",
          onPick: () => {
            settings.gameMusic = !settings.gameMusic;
            saveSettings(settings);
            window.dispatchEvent(new Event(RIICHI_SOUND_SETTINGS_EVENT));
            toast(settings.gameMusic ? `麻将音乐已开启（${Math.round(settings.gameMusicVolume * 100)}%）` : "麻将音乐已关闭");
          },
        },
        { id: "mg-close", label: "关闭游戏", onPick: () => closeMiniGame() },
      ],
    },
    {
      id: "feedback",
      label: "反馈",
      onPick: () => openFeedbackInput(),
    },

    {
      id: "update",
      label: "检查更新",
      onPick: () => void checkUpdate(true),
    },
    {
      id: "hide",
      label: "隐藏",
      state: topmostCache ? "取消置顶" : "置顶",
      onPick: () => {
        void invoke("hide_pet");
        toast("已隐藏（托盘/Alt+P唤出）");
      },
      onStatePick: () => {
        const next = !topmostCache;
        void invoke("set_topmost", { on: next }).then(() => {
          topmostCache = next;
          toast(next ? "已置顶" : "已取消置顶");
        });
      },
    },
    {
      id: "autostart",
      label: "开机自启",
      state: autostartCache ? "开" : "关",
      onPick: async () => {
        const next = !autostartCache;
        const ok = await invoke<boolean>("set_autostart", { enabled: next });
        if (ok) {
          autostartCache = next;
          toast(next ? "已开启开机自启" : "已关闭开机自启");
        }
      },
    },
    { id: "sep", separator: true },
    {
      id: "restart",
      label: "重启",
      onPick: () => void invoke("restart_app"),
    },
    {
      id: "quit",
      label: "退出",
      danger: true,
      onPick: () => void invoke("quit_app"),
    },
  ];
}

async function toggleIdle() {
  settings.idleMode = !settings.idleMode;
  saveSettings(settings);
  if (settings.idleMode) {
    // 进入待机：收起对话框/气泡/天气信息板，待机期间一律不显示
    closeAssistant();
    clearBubbles();
    infoPanelEl?.classList.add("hidden");
    // 同步窗口实际位置（逻辑），保证就近边缘判断准确（引擎 pos 可能因漫游漂移）
    const p = await getCurrentWindow().outerPosition();
    engine.setPos(p.x / scaleFactor, p.y / scaleFactor);
    savePetPosition(p.x / scaleFactor, p.y / scaleFactor);
  }
  // 获取角色边界用于精确待机定位（left/right 也参与水平夹紧，避免贴边进入待机时瞬移出屏）
  const charBounds = view.getCharacterBounds?.();
  await engine.setIdle(settings.idleMode, charBounds ?? undefined);
  // 仅进入待机时定位到边缘；退出时保持当前位置
  if (settings.idleMode) {
    const t = engine.idleTarget;
    // 引擎与 setPosition 都是逻辑坐标；等待窗口定位完成后再允许 modelOffset 归零
    try {
      await getCurrentWindow().setPosition(new LogicalPosition(t.x, t.y));
    } finally {
      engine.markIdleSettled();
    }
  }
  toast(settings.idleMode ? "困了，先眯一会儿…" : "醒啦～");
}


// ---------- 模型调节面板 ----------
function toggleModelAdjustPanel() {
  const panel = document.getElementById("model-adjust-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }

  // 仅 PSD 模型支持
  if (!(view instanceof Rigged2DView)) {
    toast("当前模型不支持调节", "warn");
    return;
  }
  const rigView = view as Rigged2DView;

  const p = panel || (() => {
    const el = document.createElement("div");
    el.id = "model-adjust-panel";
    el.className = "model-panel";
    document.body.appendChild(el);
    return el;
  })();

  const modelName = currentModel.name ?? "default";
  const savedParams = settings.modelParams[modelName] ?? {};
  const savedAuto = settings.modelAuto[modelName] ?? {};

  const render = () => {
    p.innerHTML = "";

    // 标题
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "🎨 模型调节（测试）";
    p.appendChild(title);

    // 自动行为开关
    const autoTitle = document.createElement("div");
    autoTitle.className = "mp-hint";
    autoTitle.textContent = "自动行为";
    autoTitle.style.fontWeight = "600";
    p.appendChild(autoTitle);

    const autoOptions: Array<{ key: "autoBlink" | "autoRand" | "autoIdle"; label: string; desc: string }> = [
      { key: "autoBlink", label: "自动眨眼", desc: "随机眨眼动画" },
      { key: "autoRand", label: "随机小动作", desc: "视线/头部随机漂移" },
      { key: "autoIdle", label: "待机晃动", desc: "静止时轻微摇晃" },
    ];

    for (const opt of autoOptions) {
      const row = document.createElement("div");
      row.className = "mp-item";
      const label = document.createElement("span");
      label.textContent = opt.label;
      const desc = document.createElement("span");
      desc.style.cssText = "font-size:10px;color:#8a7a95;margin-left:auto;";
      desc.textContent = opt.desc;
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = savedAuto[opt.key] ?? true;
      toggle.addEventListener("change", () => {
        rigView.setAutoOption(opt.key, toggle.checked);
        if (!settings.modelAuto[modelName]) settings.modelAuto[modelName] = {};
        settings.modelAuto[modelName][opt.key] = toggle.checked;
        saveSettings(settings);
      });
      row.append(label, desc, toggle);
      p.appendChild(row);
    }

    // 分隔
    const sep = document.createElement("div");
    sep.className = "sep";
    sep.style.margin = "6px 0";
    p.appendChild(sep);

    // 物理/外观参数
    const paramTitle = document.createElement("div");
    paramTitle.className = "mp-hint";
    paramTitle.textContent = "物理 & 外观";
    paramTitle.style.fontWeight = "600";
    p.appendChild(paramTitle);

    const paramDefs: Array<{ key: string; label: string; min: number; max: number; step: number }> = [
      { key: "physAmp", label: "物理幅度", min: 0, max: 5, step: 0.1 },
      { key: "soft", label: "柔软度", min: 0, max: 5, step: 0.1 },
      { key: "fhAmp", label: "发丝幅度", min: 0, max: 5, step: 0.1 },
      { key: "fhSoft", label: "发丝柔软度", min: 0, max: 2, step: 0.05 },
      { key: "bust", label: "胸腔位置", min: 0, max: 5, step: 0.1 },
      { key: "bustY", label: "胸腔偏移", min: 0, max: 3, step: 0.1 },
      { key: "eyeEase", label: "眼睛平滑", min: 0.05, max: 1, step: 0.05 },
      { key: "mouthEase", label: "嘴型平滑", min: 0.05, max: 1, step: 0.05 },
      { key: "mouthScale", label: "嘴巴缩放", min: 0.3, max: 2, step: 0.05 },

      { key: "irisScale", label: "瞳孔缩放", min: 0.3, max: 2, step: 0.05 },
    ];

    for (const pd of paramDefs) {
      const row = document.createElement("div");
      row.className = "mp-item";
      row.style.flexDirection = "column";
      row.style.alignItems = "stretch";
      row.style.gap = "2px";

      const header = document.createElement("div");
      header.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
      const label = document.createElement("span");
      label.textContent = pd.label;
      const valSpan = document.createElement("span");
      valSpan.style.cssText = "font-size:11px;color:#8a7a95;min-width:30px;text-align:right;";
      const currentVal = savedParams[pd.key] ?? rigView.getDefault(pd.key);
      valSpan.textContent = currentVal.toFixed(2);
      header.append(label, valSpan);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(pd.min);
      slider.max = String(pd.max);
      slider.step = String(pd.step);
      slider.value = String(currentVal);
      slider.className = "as-slider";
      slider.addEventListener("input", () => {
        const v = parseFloat(slider.value);
        valSpan.textContent = v.toFixed(2);
        rigView.setParam(pd.key, v);
        if (!settings.modelParams[modelName]) settings.modelParams[modelName] = {};
        settings.modelParams[modelName][pd.key] = v;
        saveSettings(settings);
      });

      row.append(header, slider);
      p.appendChild(row);
    }

    // 重置按钮
    const btns = document.createElement("div");
    btns.className = "as-set-btns";
    const resetBtn = document.createElement("button");
    resetBtn.className = "as-btn";
    resetBtn.textContent = "重置默认";
    resetBtn.addEventListener("click", () => {
      delete settings.modelParams[modelName];
      delete settings.modelAuto[modelName];
      saveSettings(settings);
      // 恢复默认值
      for (const pd of paramDefs) {
        rigView.setParam(pd.key, rigView.getDefault(pd.key));
      }
      for (const opt of autoOptions) {
        rigView.setAutoOption(opt.key, true);
      }
      render();
      toast("已恢复默认参数");
    });
    const backBtn = document.createElement("button");
    backBtn.className = "as-btn";
    backBtn.textContent = "返回";
    backBtn.addEventListener("click", () => {
      p.classList.add("hidden");
    });
    btns.append(resetBtn, backBtn);
    p.appendChild(btns);
  };

  render();
  p.classList.remove("hidden");
  positionPanelNearModel(p);
}

// ---------- 日记素材采样 ----------
/**
 * 从窗口标题猜"主人在用哪个软件"。
 * Windows 标题惯例是 "文档名 - 应用名"，取最后一段；常见软件统一成短名字，
 * 这样日记里的时间线读起来是"你在 VS Code 里泡了一下午"，而不是一串文件名。
 */
function appNameFromTitle(title: string): string {
  const raw = (title || "").trim();
  if (!raw) return "";
  const seg = raw.split(" - ").pop()?.trim() || raw;
  const tl = seg.toLowerCase();
  const known: Array<[string[], string]> = [
    [["visual studio code", "vscode", "code.exe"], "VS Code"],
    [["chrome", "edge", "firefox", "brave"], "浏览器"],
    [["wechat", "微信"], "微信"],
    [["qq"], "QQ"],
    [["steam"], "Steam"],
    [["bilibili", "哔哩哔哩"], "B站"],
    [["netease", "网易云"], "网易云音乐"],
    [["word"], "Word"],
    [["excel"], "Excel"],
    [["powerpoint"], "PowerPoint"],
    [["powershell", "terminal", "cmd", "windows terminal"], "终端"],
    [["explorer", "文件资源管理器"], "文件管理器"],
    [["typora", "obsidian", "notion"], "笔记"],
  ];
  for (const [keys, name] of known) {
    if (keys.some((k) => tl.includes(k))) return name;
  }
  return seg.slice(0, 20);
}

/** 每 5 分钟采样一次前台应用；人离开（空闲 > 5 分钟）时不记 */
function startActivitySampling(): void {
  const SAMPLE_MINUTES = 5;
  const sample = async () => {
    try {
      const idle = await invoke<number>("get_idle_seconds");
      if (idle > 300) return;
      const title = await invoke<string>("active_window_title");
      const app = appNameFromTitle(title);
      if (app) trackAppUse(app, SAMPLE_MINUTES);
    } catch {
      /* 忽略：采样失败不影响别的功能 */
    }
  };
  void sample();
  window.setInterval(() => void sample(), SAMPLE_MINUTES * 60_000);
}

/** 记录今天听过的歌：SMTC 每 500ms 推一次，只有换歌才记一条 */
function startMusicJournaling(): void {
  let lastKey = "";
  void listen<{ hasSession: boolean; title: string; artist: string }>("media:nowplaying", (e) => {
    const p = e.payload;
    if (!p?.hasSession || !p.title) return;
    const key = `${p.title}|${p.artist ?? ""}`;
    if (key === lastKey) return;
    lastKey = key;
    trackMusic(p.title, p.artist ?? "");
  });
}

// ---------- 整点播报 ----------
/**
 * 免打扰时段：用户在「免打扰时段」面板里用左右两个上下调时控件设定。
 * 关掉开关、或起止相同（例如 8→8）都用 quietStart === quietEnd 表示"永不静音"。
 */
function chimeOptions(): { quietStart: number; quietEnd: number } {
  if (settings.hourlyChimeQuiet === false) return { quietStart: 0, quietEnd: 0 };
  return {
    quietStart: settings.hourlyQuietStart ?? 23,
    quietEnd: settings.hourlyQuietEnd ?? 8,
  };
}

/** 整点到了：打游戏 / 助手正在回答时就不打扰 */
function onHourlyChime(line: string): void {
  if (isMiniGameOpen() || isAssistantBusy()) return;
  sayPetLine(line);
}

/** 按当前设置（重新）装载整点播报 */
function applyHourlyChime(): void {
  stopHourlyChime();
  if (settings.hourlyChime) startHourlyChime(onHourlyChime, chimeOptions());
}

// ---------- 信息板（桌宠伴侣信息） ----------
let infoPanelEl: HTMLElement | null = null;
let infoPanelHideTimer: ReturnType<typeof setTimeout> | null = null;
let cachedWeather: { text: string; time: number } | null = null;

// 天气解析与展示见 src/features/weather/WeatherFormat.ts（纯函数，有单测）

async function showInfoPanel() {
  if (!infoPanelEl) {
    infoPanelEl = document.createElement("div");
    infoPanelEl.id = "info-panel";
    infoPanelEl.className = "info-panel";
    document.body.appendChild(infoPanelEl);
  }
  const el = infoPanelEl;

  // 计算陪伴时间
  const companionText = formatDuration(Date.now() - companionStart);

  // 天气（缓存 10 分钟）
  let weatherHtml = "<span class='info-weather-loading'>获取中...</span>";
  if (cachedWeather && Date.now() - cachedWeather.time < 600000) {
    weatherHtml = cachedWeather.text;
  } else {
    invoke<string>("get_weather", { city: settings.weatherCity || null })
      .then((raw) => {
        weatherHtml = formatWeatherHtml(raw, settings.weatherCity);
        cachedWeather = { text: weatherHtml, time: Date.now() };
        updateInfoPanelContent(el, companionText, weatherHtml);
      })
      .catch(() => {
        weatherHtml = "天气获取失败";
        updateInfoPanelContent(el, companionText, weatherHtml);
      });
  }

  updateInfoPanelContent(el, companionText, weatherHtml);

  // 先显示再测量实际高度（高度由内容决定，不能假设 200）
  el.classList.remove("hidden");
  const mr = getModelRect();
  const vr = getWindowVisibleRect();
  // 贴边自适应：宽度随可见区收缩
  let panelW = Math.min(270, Math.max(160, vr.right - vr.left - 20));
  let panelH = el.offsetHeight || 200;
  el.style.maxHeight = "";

  // 定位：助手开启时避开输入框（输入框默认在模型下方，其次可见区底部、模型上方），
  // 候选依次 上方 → 左右外侧 → 输入框下方；旁边空间略小时收缩面板宽度贴合侧面（不压模型），
  // 全部放不下时收缩高度（滚动）兜底，保证信息板始终出现且不遮输入框、不压模型
  const a = engine.workArea;
  const screenCy = a ? a.top + a.height / 2 : window.innerHeight / 2;
  const modelScreenCenterY = engine.windowScreenPos.y + mr.top + mr.height / 2;
  const assistantOpen = settings.assistant.enabled;
  // 贴顶（模型顶边贴近工作区顶部）+ 助手开启：不显示信息板（贴顶布局局促，避免与输入框冲突）
  const atTop = a ? engine.windowScreenPos.y + mr.top <= a.top + 40 : false;
  if (assistantOpen && atTop) {
    el.classList.add("hidden");
    return;
  }
  let cx = mr.left + (mr.width - panelW) / 2;
  const BAR_H = 80; // 输入框高度估计
  const BAR_W = 185;
  let left = cx;
  let top = mr.bottom + 6;
  if (assistantOpen) {
    // 输入框预期位置（与 openAssistant 一致：模型下方 → 可见区底部 → 模型上方）
    let barTop = mr.bottom + 10;
    if (barTop + BAR_H > vr.bottom) barTop = vr.bottom - BAR_H;
    if (barTop < vr.top) barTop = vr.top;
    const barRect = { left: mr.left, right: mr.left + BAR_W, top: barTop, bottom: barTop + BAR_H };
    const hitsBar = (l: number, t: number) =>
      l < barRect.right && l + panelW > barRect.left && t < barRect.bottom && t + panelH > barRect.top;
    const fits = (l: number, t: number) =>
      !hitsBar(l, t) &&
      l >= vr.left && l + panelW <= vr.right &&
      t >= vr.top && t + panelH <= vr.bottom;
    let placed: { left: number; top: number } | null = null;
    // 上方
    if (fits(cx, mr.top - panelH - 6)) placed = { left: cx, top: mr.top - panelH - 6 };
    // 左右外侧（严格不压模型；空间略小时收缩宽度贴合侧面）
    if (!placed) {
      const rightAvail = vr.right - (mr.right + 10);
      const leftAvail = mr.left - 10 - vr.left;
      const trySide = (avail: number, l: number): boolean => {
        if (avail < 140) return false;
        if (avail < panelW) {
          panelW = Math.max(140, avail);
          cx = mr.left + (mr.width - panelW) / 2;
        }
        if (fits(l, mr.top)) {
          placed = { left: l, top: mr.top };
          return true;
        }
        return false;
      };
      if (!trySide(rightAvail, mr.right + 10)) trySide(leftAvail, mr.left - panelW - 10);
    }
    // 输入框下方（叠放，不遮输入框）
    if (!placed && fits(cx, barRect.bottom + 6)) placed = { left: cx, top: barRect.bottom + 6 };
    // 空间不足：收缩高度（滚动）优先放输入框下方，其次模型上方，最后钳制到输入框下方
    if (!placed) {
      const belowH = vr.bottom - (barRect.bottom + 6);
      const aboveH = mr.top - 6 - vr.top;
      if (belowH >= 80) {
        panelH = belowH;
        el.style.maxHeight = `${panelH}px`;
        placed = { left: cx, top: barRect.bottom + 6 };
      } else if (aboveH >= 80) {
        panelH = aboveH;
        el.style.maxHeight = `${panelH}px`;
        placed = { left: cx, top: vr.top };
      } else {
        panelH = Math.max(60, vr.bottom - vr.top - 10);
        el.style.maxHeight = `${panelH}px`;
        placed = { left: cx, top: Math.max(vr.top, Math.min(barRect.bottom + 6, vr.bottom - panelH)) };
      }
    }
    if (placed) {
      left = placed.left;
      top = placed.top;
    }
  } else if (modelScreenCenterY <= screenCy) {
    // 模型在上半屏 → 信息版默认在下方
    top = mr.bottom + 6;
    if (top + panelH > vr.bottom) top = mr.top - panelH - 6;
  } else {
    // 模型在下半屏 → 信息版在上方
    top = mr.top - panelH - 6;
    if (top < vr.top) top = mr.bottom + 6;
  }
  // 兜底钳制到可见区
  left = Math.max(vr.left, Math.min(left, Math.max(vr.left, vr.right - panelW)));
  top = Math.max(vr.top, Math.min(top, Math.max(vr.top, vr.bottom - panelH)));

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.width = `${panelW}px`;
  el.style.opacity = "1";
  // 进入动画（从下方滑入）
  el.style.transform = "translateY(12px)";
  requestAnimationFrame(() => { el.style.transform = "translateY(0)"; });

  // 5 秒自动消失；region collector 会自动移除信息版区域。
  if (infoPanelHideTimer) clearTimeout(infoPanelHideTimer);
  infoPanelHideTimer = setTimeout(() => {
    if (el) {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      setTimeout(() => { if (el) el.classList.add("hidden"); }, 300);
    }
  }, 5000);
}

// 待办变化时刷新信息版（模态框添加后触发）
document.addEventListener("reminders-changed", () => {
  const el = document.getElementById("info-panel") as HTMLElement | null;
  if (el && !el.classList.contains("hidden")) {
    const c = formatDuration(Date.now() - companionStart);
    const w = el.querySelector(".info-panel-weather")?.textContent?.replace("🌡 ", "") ?? "";
    updateInfoPanelContent(el, c, w);
  }
});

function updateInfoPanelContent(el: HTMLElement, companion: string, weather: string) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  // 待办列表（前 3 条）
  const reminders = getReminders().slice(0, 3);
  const rmHtml = reminders.length > 0
    ? `<div class="info-panel-reminders">
        ${reminders.map((r) => `<div class="info-rm-row${r.done ? " done" : ""}">
          <span class="info-rm-time">${fmtReminderTime(r.time)}</span>
          <span class="info-rm-text">${escapeHtml(r.text)}</span>
          <button class="info-rm-del" data-id="${r.id}">✕</button>
        </div>`).join("")}
      </div>`
    : `<div class="info-panel-reminders empty">暂无待办</div>`;

  el.innerHTML = `
    <div class="info-panel-header">${dateStr}</div>
    <div class="info-panel-weather">${weather}</div>
    <div class="info-panel-companion">💖 陪伴时间：${companion}</div>
    <div class="info-panel-rm-title">待办事项 <button class="info-rm-add">＋ 添加</button></div>
    ${rmHtml}
  `;

  // 添加按钮 → 弹出填写窗口
  el.querySelector(".info-rm-add")?.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    openReminderModal();
  });
  // 删除按钮
  el.querySelectorAll(".info-rm-del").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const id = Number((btn as HTMLElement).dataset.id);
      removeReminder(id);
      // 刷新信息版内容（重新拉一次天气/陪伴）
      const c = formatDuration(Date.now() - companionStart);
      const w = document.querySelector(".info-panel-weather")?.textContent?.replace("🌡 ", "") ?? "";
      updateInfoPanelContent(el, c, w);
    });
  });
  // 功能按钮（日记、抽卡）
  el.querySelectorAll(".info-feat-btn").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const feat = (btn as HTMLElement).dataset.feat;
      if (feat === "diary") toggleDiaryPanel();
      if (feat === "card") toggleDailyCardPanel();
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------- 动作调试面板 ----------
function toggleActionDebug() {
  const panel = document.getElementById("action-debug") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    view.stopAction();
    panel.classList.add("hidden");
    return;
  }

  const render = (host: HTMLElement) => {
    clearElement(host);

    const head = document.createElement("div");
    head.className = "ap-head";
    const title = document.createElement("span");
    title.className = "ap-title";
    title.textContent = "动作试玩";
    const backBtn = document.createElement("button");
    backBtn.className = "as-btn";
    backBtn.textContent = "返回";
    backBtn.addEventListener("click", () => {
      view.stopAction();
      host.classList.add("hidden");
    });
    head.append(title, backBtn);
    host.appendChild(head);

    const list = document.createElement("div");
    list.className = "ap-list";
    for (const a of listActions()) {
      const row = document.createElement("div");
      row.className = "mp-item";
      const span = document.createElement("span");
      span.textContent = a.label;
      row.appendChild(span);
      row.addEventListener("click", () => {
        view.playAction(a.id, true);
        list.querySelectorAll(".mp-item").forEach((el) => el.classList.remove("active"));
        row.classList.add("active");
        // 选完动作隐藏面板，等左键点击恢复
        host.classList.add("hidden");
        actionDebugHidden = true;
      });
      list.appendChild(row);
    }
    host.appendChild(list);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "action-debug";
    p.className = "model-panel action-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
      positionPanelNearModel(p);
  }
}

/** 模型大小滑动条面板（20%~200%，拖动实时应用） */
function toggleSizePanel() {
  const panel = document.getElementById("size-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }

  const render = (host: HTMLElement) => {
    clearElement(host);

    const head = document.createElement("div");
    head.className = "ap-head";
    const title = document.createElement("span");
    title.className = "ap-title";
    title.textContent = "模型大小";
    const val = document.createElement("span");
    val.className = "size-val";
    val.textContent = `${Math.round(settings.modelScale * 100)}%`;
    const backBtn = document.createElement("button");
    backBtn.className = "as-btn";
    backBtn.textContent = "返回";
    backBtn.addEventListener("click", () => {
      host.classList.add("hidden");
    });
    head.append(title, val, backBtn);
    host.appendChild(head);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "20";
    slider.max = "200";
    slider.step = "1";
    slider.value = String(Math.round(settings.modelScale * 100));
    slider.className = "size-slider";
    let lastApply = 0;
    slider.addEventListener("input", () => {
      val.textContent = `${slider.value}%`;
      const now = performance.now();
      if (now - lastApply < 80) return; // 节流，避免高频窗口 resize 抖动
      lastApply = now;
      void applyModelScale(Number(slider.value) / 100);
    });
    slider.addEventListener("change", () => {
      void applyModelScale(Number(slider.value) / 100, true);
    });
    host.appendChild(slider);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "size-panel";
    p.className = "model-panel action-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
    positionPanelNearModel(p);
  }
}

// 诊断钩子（CDP 验证待机位置用）
declare global {
  interface Window {
    __pet?: {
      toggleIdle: () => Promise<void>;
      info: () => { idle: boolean; idleTop: boolean; idleTarget: { x: number; y: number }; pos: { x: number; y: number } };
      winPos: () => Promise<{ x: number; y: number }>;
      setPos: (x: number, y: number) => Promise<void>;
    };
  }
}
window.__pet = {
  toggleIdle: () => toggleIdle(),
  info: () => ({
    idle: engine.isIdle,
    idleTop: engine.isIdleTop,
    idleTarget: engine.idleTarget,
    pos: engine.position,
    cursorDx: engine.cursorDx,
    cursorDy: engine.cursorDy,
  }),
  winPos: async () => {
    const p = await getCurrentWindow().outerPosition();
    return { x: p.x, y: p.y };
  },
  setPos: async (x: number, y: number) => {
    await getCurrentWindow().setPosition(new LogicalPosition(x, y));
    engine.setPos(x, y);
  },
};

// ---------- 调整模型边界面板 ----------
let boundsPanelOpen = false;
let boundsPanelWasShowing = false;
function toggleBoundsPanel() {
  const panel = document.getElementById("bounds-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    // 关闭面板时恢复绿框状态
    boundsPanelOpen = false;
    if (!boundsPanelWasShowing && debugModelBoundsVisible) {
      toggleModelBounds();
    }
    panel.classList.add("hidden");
    return;
  }
  // 打开面板时自动显示绿框
  boundsPanelOpen = true;
  boundsPanelWasShowing = debugModelBoundsVisible;
  if (!debugModelBoundsVisible) {
    toggleModelBounds();
  }
  const render = (host: HTMLElement) => {
    host.innerHTML = "";
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "调整模型边界";
    host.appendChild(title);

    const hint = document.createElement("div");
    hint.className = "mp-hint";
    hint.textContent = "微调绿框（角色边界）四边松紧，正=放大，负=收紧";
    host.appendChild(hint);

    const mkSlider = (label: string, key: keyof BoundsPadding) => {
      // 紧凑布局：label + slider + value 一行（减少面板高度，避免滚动条）
      const row = document.createElement("div");
      row.className = "as-set-row";
      const l = document.createElement("span");
      l.className = "as-set-label";
      l.textContent = label;
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "-120";
      slider.max = "120";
      slider.step = "1";
      slider.value = String(settings.boundsPadding[key]);
      slider.className = "as-input";
      slider.style.flex = "1";
      slider.style.minWidth = "0";
      const val = document.createElement("span");
      val.className = "as-set-label";
      val.style.minWidth = "38px";
      val.style.textAlign = "right";
      val.textContent = settings.boundsPadding[key] + "px";
      slider.addEventListener("input", () => {
        const v = parseInt(slider.value, 10);
        settings.boundsPadding[key] = v;
        val.textContent = v + "px";
        saveSettings(settings);
        (view as any).setBoundsPadding?.(settings.boundsPadding);
      });
      row.append(l, slider, val);
      host.appendChild(row);
    };
    mkSlider("左", "left");
    mkSlider("右", "right");
    mkSlider("上", "top");
    mkSlider("下", "bottom");

    const btns = document.createElement("div");
    btns.className = "as-set-btns";
    const reset = document.createElement("button");
    reset.className = "as-btn";
    reset.textContent = "重置";
    reset.addEventListener("click", () => {
      settings.boundsPadding = { left: 0, right: 0, top: 0, bottom: 0 };
      saveSettings(settings);
      (view as any).setBoundsPadding?.(settings.boundsPadding);
      host.classList.add("hidden");
      toggleBoundsPanel();
    });
    const done = document.createElement("button");
    done.className = "as-btn as-btn-primary";
    done.textContent = "完成";
    done.addEventListener("click", () => {
      host.classList.add("hidden");
    });
    btns.append(reset, done);
    host.appendChild(btns);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "bounds-panel";
    p.className = "model-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
      positionPanelNearModel(p);
  }
}

// 导入 BoundsPadding 类型
import type { BoundsPadding } from "./utils/settings";

// ---------- 对话记录面板 ----------
function toggleChatHistory() {
  const existing = document.getElementById("chat-history-panel");
  if (existing) { existing.remove(); return; }

  const panel = document.createElement("div");
  panel.id = "chat-history-panel";
  panel.className = "model-panel";
  panel.style.zIndex = "170";
  panel.style.cssText = "display:flex;flex-direction:column;overflow:hidden;width:auto;max-width:360px;";

  const title = document.createElement("div");
  title.className = "mp-title";
  title.textContent = "对话记录";
  panel.appendChild(title);

  // 从 localStorage 读取历史，过滤主动问候和工具消息
  let msgs: {role: string; content: string}[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem("live2d-pet-assistant-history") || "[]");
    msgs = raw
      .filter((m: any) => {
        if (m.role !== "user" && m.role !== "assistant") return false;
        if (!m.content) return false;
        const c = String(m.content);
        if (c.startsWith("[主动问候]")) return false;
        if (c.startsWith("[主动学习]")) return false;
        return true;
      })
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 500) }));
  } catch {}

  const copyOne = (text: string) => {
    void copyText(text).then((ok) => toast(ok ? "已复制这条对话" : "复制失败，请手动选中", ok ? "info" : "warn"));
  };

  if (msgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mp-hint";
    empty.textContent = "暂无对话记录";
    panel.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "ch-list";
    for (const m of msgs) {
      const row = document.createElement("div");
      row.className = "ch-row " + (m.role === "user" ? "ch-user" : "ch-ai");

      const role = document.createElement("span");
      role.className = "ch-role";
      role.textContent = m.role === "user" ? "👤 我" : "🐾 桌宠";

      const body = document.createElement("span");
      body.textContent = m.content;

      // 单条复制：复制纯文本，不带角色前缀
      const copy = document.createElement("button");
      copy.className = "ch-copy";
      copy.type = "button";
      copy.textContent = "复制";
      copy.title = "复制这条";
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        copyOne(m.content);
      });

      row.append(role, document.createTextNode("  "), body, copy);
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  // 底部按钮：复制全部 / 关闭
  const btns = document.createElement("div");
  btns.className = "as-set-btns";
  if (msgs.length > 0) {
    const allBtn = document.createElement("button");
    allBtn.className = "as-btn";
    allBtn.textContent = "复制全部";
    allBtn.addEventListener("click", () => {
      const all = msgs.map((m) => `${m.role === "user" ? "我" : "桌宠"}：${m.content}`).join("\n");
      copyOne(all);
    });
    btns.appendChild(allBtn);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "as-btn";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => panel.remove());
  btns.appendChild(closeBtn);
  panel.appendChild(btns);

  document.body.appendChild(panel);
  positionPanelNearModel(panel);
  // 限高：超出就在列表里滚动。之前 CSS 写成 max-height:none + overflow:visible，
  // 列表一长整块溢出到面板外面，最下方（连同关闭按钮）看不到。
  const vr = getWindowVisibleRect();
  panel.style.maxHeight = `${Math.max(200, Math.min(460, vr.bottom - vr.top - 40))}px`;

  // 点击外部关闭（延迟注册避免当前点击触发）
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node)) {
        panel.remove();
        document.removeEventListener("pointerdown", close);
      }
    };
    document.addEventListener("pointerdown", close);
  }, 50);
}


// ---------- 小助手设置面板 ----------
async function toggleAssistantSettings() {
  const panel = document.getElementById("assistant-settings") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  const render = (host: HTMLElement) => {
    clearElement(host);
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "小助手设置";
    host.appendChild(title);

    const mkRow = (label: string, el: HTMLElement) => {
      const row = document.createElement("div");
      row.className = "as-set-row";
      const l = document.createElement("span");
      l.className = "as-set-label";
      l.textContent = label;
      row.append(l, el);
      host.appendChild(row);
      return row;
    };

    const provider = document.createElement("select");
    provider.className = "as-input as-select";
    (Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>).forEach(k => { const opt = document.createElement("option"); opt.value = k; opt.textContent = PROVIDERS[k].label; provider.appendChild(opt); })
    provider.value = settings.assistant.provider;
    mkRow("提供商", provider);

    const baseUrl = document.createElement("input");
    baseUrl.className = "as-input";
    baseUrl.placeholder = "如 https://api.openai.com/v1";
    baseUrl.value = settings.assistant.customBaseUrl;
    const baseUrlRow = mkRow("API 端点", baseUrl);
    // Ollama 使用提示
    const ollamaHint = document.createElement("div");
    ollamaHint.className = "as-privacy";
    ollamaHint.style.cssText = "display:none;";
    ollamaHint.innerHTML =
      "💡 <b>Ollama：</b>① 安装 <code>ollama.com</code> ② 运行 <code>ollama serve</code> ③ <code>ollama pull qwen2.5:7b</code> ④ 点下方「自动获取模型」 ⑤ API Key 留空" +
      "<br>同理，自定义端点填 <code>127.0.0.1</code>/<code>localhost</code>（LM Studio、llama.cpp）时也可以留空。";
    host.appendChild(ollamaHint);

    const toggleBaseUrl = () => {
      const p = provider.value as keyof typeof PROVIDERS;
      const info = PROVIDERS[p];
      baseUrlRow.style.display = p === "custom" ? "flex" : "none";
      key.placeholder = info?.placeholder ?? "API Key";
      ollamaHint.style.display = p === "ollama" ? "block" : "none";
    };
    provider.addEventListener("change", toggleBaseUrl);

    const key = document.createElement("input");
    key.className = "as-input";
    key.type = "password";
    key.placeholder = "API Key";
    key.value = "";
    mkRow("API Key", key);
    toggleBaseUrl(); // set initial placeholder
    // API Key 存 Rust 侧（DPAPI 加密），打开面板时回填
    void invoke<string>("get_api_key")
      .then((k) => {
        key.value = k;
      })
      .catch(() => {
        /* 未设置 */
      });

    const modelSelect = document.createElement("select");
    modelSelect.className = "as-input as-select";
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "（点下方「自动获取模型」）";
    modelSelect.appendChild(emptyOpt);
    mkRow("模型列表", modelSelect);

    const model = document.createElement("input");
    model.className = "as-input";
    model.placeholder = "模型名（留空用默认）";
    model.value = settings.assistant.model;
    mkRow("模型名", model);
    modelSelect.addEventListener("change", () => {
      if (modelSelect.value) model.value = modelSelect.value;
    });

    const persona = document.createElement("textarea");
    persona.className = "as-input as-persona";
    persona.rows = 3;
    persona.placeholder = "人格设定，如：你是一只爱撒娇的猫娘，说话带波浪号～（留空则默认）";
    persona.value = settings.assistant.persona;
    mkRow("人格设定", persona);

    // 对用户的称呼
    const nickname = document.createElement("input");
    nickname.className = "as-input";
    nickname.placeholder = "对用户的称呼（如“主人”，留空由 AI 决定）";
    nickname.value = settings.assistant.nickname ?? "";
    mkRow("对用户的称呼", nickname);

    // 天气城市：填了就按城市查，不会再被代理出口 IP 带偏
    const weatherCity = document.createElement("input");
    weatherCity.className = "as-input";
    weatherCity.placeholder = "天气城市（如 北京；留空自动定位）";
    weatherCity.value = settings.weatherCity ?? "";
    const weatherCityRow = mkRow("天气城市", weatherCity);
    weatherCityRow.title = "开了代理/VPN 时自动定位可能指向梯子地区，填上城市就不会错";

    // 主动问候间隔时间设置
    const greetRow = document.createElement("div");
    greetRow.className = "as-set-row";
    const greetLabel = document.createElement("span");
    greetLabel.className = "as-set-label";
    greetLabel.textContent = "主动问候间隔";
    const greetInput = document.createElement("input");
    greetInput.className = "as-input";
    greetInput.type = "number";
    greetInput.min = "5";
    greetInput.max = "120";
    greetInput.step = "5";
    greetInput.value = String(settings.assistant.greetInterval ?? 20);
    greetInput.style.width = "120px";
    greetInput.style.textAlign = "center";
    const greetUnit = document.createElement("span");
    greetUnit.textContent = "分钟";
    greetUnit.style.fontSize = "12px";
    greetUnit.style.color = "#8a7a95";
    greetRow.append(greetLabel, greetInput, greetUnit);
    host.appendChild(greetRow);

    const gameTalk = document.createElement("input");
    gameTalk.type = "checkbox";
    gameTalk.checked = settings.gameTalk === true;
    gameTalk.setAttribute("aria-describedby", "game-talk-help");
    const gameTalkRow = mkRow("AI 对局互动", gameTalk);
    gameTalkRow.title = "开启后仅在麻将关键事件发送精简公开牌况，并消耗已配置服务的 API 额度";
    const gameTalkHelp = document.createElement("div");
    gameTalkHelp.id = "game-talk-help";
    gameTalkHelp.className = "as-privacy";
    gameTalkHelp.textContent = "关闭时使用本地台词。开启后仅在关键牌局事件发送精简可知牌况，会消耗 API 额度；不会发送玩家暗牌或牌山顺序。";
    host.appendChild(gameTalkHelp);

    const fetchBtn = document.createElement("button");
    fetchBtn.className = "as-btn";
    fetchBtn.textContent = "自动获取模型";
    fetchBtn.addEventListener("click", async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = "获取中…";
      let models: string[] = [];
      try {
        models = await listModels(
          provider.value as AssistantProvider,
          key.value.trim(),
          baseUrl.value.trim(),
        );
      } catch (e: unknown) {
        models = [];
        const errMsg = e instanceof Error ? e.message : String(e);
        toast(`获取失败：${errMsg}`, "warn");
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = "自动获取模型";
      }
      if (models.length) {
        // 填充下拉列表
        modelSelect.innerHTML = "";
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          modelSelect.appendChild(opt);
        }
        // 自动选中：优先保留用户之前填的模型名，否则选第一个
        const current = model.value.trim();
        if (current && models.includes(current)) {
          modelSelect.value = current;
        } else {
          model.value = models[0];
          modelSelect.value = models[0];
        }
        toast(`获取到 ${models.length} 个模型，已自动选择：${model.value}`);
      } else {
        // error already shown in catch
      }
    });
    mkRow("", fetchBtn);

    // AI 用量统计（本地估算，帮助用户感知 token 消耗）
    const usageRow = document.createElement("div");
    usageRow.className = "as-set-row";
    usageRow.style.cssText = "align-items:flex-start;";
    const usageLabel = document.createElement("span");
    usageLabel.className = "as-set-label";
    usageLabel.textContent = "AI 用量";
    const usageBox = document.createElement("div");
    usageBox.style.cssText = "flex:1;font-size:11.5px;color:#8a7a95;line-height:1.8;";
    const fmtTokens = (n: number) => (n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n));
    const renderUsage = () => {
      const u = getUsageStats();
      const cachedPart = u.cachedTokens > 0 ? " · 缓存命中 " + fmtTokens(u.cachedTokens) : "";
      usageBox.textContent = u.calls > 0
        ? "共 " + u.calls + " 次调用 · 输入 " + fmtTokens(u.inputTokens) + " · 输出 " + fmtTokens(u.outputTokens) + cachedPart + " tok（服务端优先，本地估算兜底）"
        : "暂无记录（服务端优先，本地估算兜底）";
    };
    renderUsage();
    const usageReset = document.createElement("button");
    usageReset.className = "as-btn";
    usageReset.style.cssText = "padding:2px 8px;font-size:11px;flex:none;";
    usageReset.textContent = "清零";
    usageReset.addEventListener("click", () => {
      resetUsageStats();
      renderUsage();
    });
    usageRow.append(usageLabel, usageBox, usageReset);
    host.appendChild(usageRow);

    const btns = document.createElement("div");
    btns.className = "as-set-btns";

    const clearHistBtn = document.createElement("button");
    clearHistBtn.className = "as-btn";
    clearHistBtn.textContent = "清空对话历史";
    clearHistBtn.addEventListener("click", () => {
      clearHistory();
      toast("对话历史已清空（长期记忆保留）");
    });

    const privacyHint = document.createElement("div");
    privacyHint.className = "as-privacy";
    privacyHint.textContent = "隐私提示：主动问候会读取当前前台窗口标题+进程名并发送给 AI。API Key 经系统 DPAPI 加密存储。";
    host.appendChild(privacyHint);
    host.appendChild(clearHistBtn);

    const back = document.createElement("button");
    back.className = "as-btn";
    back.textContent = "返回";
    back.addEventListener("click", () => {
      host.classList.add("hidden");
    });

    const save = document.createElement("button");
    save.className = "as-btn as-btn-primary";
    save.textContent = "保存";
    save.addEventListener("click", async () => {
      settings.assistant.provider = provider.value as AssistantProvider;
      settings.assistant.customBaseUrl = baseUrl.value.trim();
      settings.assistant.model = model.value.trim();
      settings.assistant.persona = persona.value.trim();
      settings.assistant.nickname = nickname.value.trim();
      settings.gameTalk = gameTalk.checked;
      // 天气城市变了就清掉缓存，下次打开信息板立刻重新取
      const cityNext = weatherCity.value.trim();
      if (cityNext !== settings.weatherCity) cachedWeather = null;
      settings.weatherCity = cityNext;
      // 保存主动问候间隔（钳制到 5-120 分钟）
      const greetVal = parseInt(greetInput.value, 10);
      settings.assistant.greetInterval = Math.max(5, Math.min(120, isNaN(greetVal) ? 20 : greetVal));
      saveSettings(settings);
      // API Key 存 Rust 侧（DPAPI 加密）
      try {
        await invoke("set_api_key", { apiKey: key.value.trim() });
        clearApiKeyCache();
        clearPetTalkKeyCache();
      } catch (e) {
        toast(`API Key 保存失败：${e}`, "warn");
      }
      host.classList.add("hidden");
      toast("小助手设置已保存");
    });
    btns.append(back, save);
    host.appendChild(btns);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "assistant-settings";
    p.className = "model-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
    positionPanelNearModel(p);
  }
}

// ---------- 反馈面板 ----------
function openFeedbackInput() {
  const panel = document.getElementById("feedback-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) return;

  const render = (host: HTMLElement) => {
    clearElement(host);
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "反馈";
    host.appendChild(title);

    const desc = document.createElement("div");
    desc.className = "mp-hint";
    desc.textContent =
      "告诉我们遇到了什么问题，会自动附上本次启动的运行日志。优先走邮件；邮件通道不可用时导出到桌面，也可以直接「复制」贴给我。";
    host.appendChild(desc);

    const ta = document.createElement("textarea");
    ta.className = "as-input as-persona";
    ta.rows = 5;
    ta.placeholder = "描述你遇到的问题…";
    host.appendChild(ta);

    const btns = document.createElement("div");
    btns.className = "as-set-btns";
    const back = document.createElement("button");
    back.className = "as-btn";
    back.textContent = "返回";
    back.addEventListener("click", () => {
      host.classList.add("hidden");
    });
    const copy = document.createElement("button");
    copy.className = "as-btn";
    copy.textContent = "复制";
    copy.title = "复制描述 + 环境信息 + 本次启动日志，可直接粘给别人";
    copy.addEventListener("click", () => {
      const t = ta.value.trim();
      if (!t) {
        toast("请先描述一下遇到的问题", "warn");
        return;
      }
      void invoke<string>("feedback_text", { message: t })
        .then((text) => copyText(text))
        .then((ok) => toast(ok ? "反馈内容已复制（含本次启动日志）" : "复制失败，请手动选中复制", ok ? "info" : "warn"))
        .catch((e) => toast(`复制失败：${e}`, "warn"));
    });
    const send = document.createElement("button");
    send.className = "as-btn as-btn-primary";
    send.textContent = "发送";
    send.addEventListener("click", () => {
      const t = ta.value.trim();
      if (!t) {
        toast("请先描述一下遇到的问题", "warn");
        return;
      }
      host.classList.add("hidden");
      void doSendFeedback(t);
    });
    btns.append(back, copy, send);
    host.appendChild(btns);
  };

  if (panel) {
    render(panel);
    panel.classList.remove("hidden");
  } else {
    const p = document.createElement("div");
    p.id = "feedback-panel";
    p.className = "model-panel hidden";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    render(p);
    document.body.appendChild(p);
    p.classList.remove("hidden");
      positionPanelNearModel(p);
  }
}

async function doSendFeedback(message: string) {
  toast("正在发送反馈…");
  try {
    const msg = await invoke<string>("send_feedback", { message });
    toast(msg);
    return;
  } catch (e) {
    // 邮件发不出去（最常见：邮箱授权码失效，服务器回 535）：说清原因，再走桌面导出
    toast(`邮件通道不可用：${e}`, "warn");
  }
  try {
    const path = await invoke<string>("export_feedback", { message });
    toast(`已导出到桌面：${path}（把这个文件发给我即可）`);
  } catch (e2) {
    toast(`导出也失败了：${e2}。请用「复制」把内容贴给我`, "warn");
  }
}

// ---------- 检查更新 ----------
const UPDATE_KEY = "live2d-pet-last-update-notify"; // 已提示过的版本（启动自动检查时不重复弹）

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

/** a>b 返回正数，相等 0，a<b 负数 */
function cmpVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function showUpdateBubble(tag: string) {
  // 检测到更新后明确询问，用户确认才开始下载。
  const existing = document.getElementById("update-bubble");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "update-bubble";
  el.className = "big-toast";
  el.style.whiteSpace = "normal";
  el.style.maxWidth = "280px";
  el.addEventListener("pointerdown", (e) => e.stopPropagation());

  const mr = getModelRect();
  el.style.left = `${Math.round(mr.left + mr.width / 2)}px`;
  el.style.bottom = `${Math.round(window.innerHeight - mr.top + 14)}px`;
  el.style.transform = "translateX(-50%)";

  const title = document.createElement("div");
  title.style.fontSize = "15px";
  title.textContent = `✨ 新版本 ${tag} 可用！`;
  const hint = document.createElement("div");
  hint.style.cssText = "font-size:12px;font-weight:400;margin-top:4px;opacity:0.8;";
  hint.textContent = "现在下载并安装吗？";
  const bar = document.createElement("div");
  bar.style.cssText = "height:4px;background:rgba(176,74,126,0.2);border-radius:4px;margin-top:8px;display:none;";
  const fill = document.createElement("div");
  fill.style.cssText = "height:100%;background:#d06a9a;border-radius:4px;width:0%;transition:width 0.3s;";
  bar.appendChild(fill);
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;margin-top:9px;justify-content:center;";
  const updateBtn = document.createElement("button");
  updateBtn.className = "as-btn as-btn-primary";
  updateBtn.textContent = "立即更新";
  const laterBtn = document.createElement("button");
  laterBtn.className = "as-btn";
  laterBtn.textContent = "稍后";
  actions.append(updateBtn, laterBtn);
  el.append(title, hint, bar, actions);
  document.body.appendChild(el);

  const openDownloadPage = () => {
    void invoke("open_url", { url: `https://github.com/Wumiu/Petra/releases/tag/${tag}` });
    el.remove();
  };
  laterBtn.addEventListener("click", () => el.remove());
  updateBtn.addEventListener("click", async () => {
    hint.textContent = "正在下载…";
    bar.style.display = "block";
    updateBtn.disabled = true;
    laterBtn.disabled = true;
    const ok = await performUpdate([], (pct) => {
      fill.style.width = `${pct}%`;
      hint.textContent = `正在下载… ${pct}%`;
    });
    if (ok) {
      hint.textContent = "下载完成，即将安装…";
    } else {
      hint.textContent = "下载失败，请前往下载页手动更新。";
      bar.style.display = "none";
      updateBtn.disabled = false;
      updateBtn.textContent = "重试";
      laterBtn.disabled = false;
      laterBtn.textContent = "前往下载";
      laterBtn.onclick = openDownloadPage;
    }
  });

}

// TODO: 测试用，发布前删除

async function checkUpdate(manual = false) {
  // 手动检查：取消尚未触发的启动自动检查，避免 5 秒后重复检查一次
  if (manual && startupUpdateTimer !== null) {
    clearTimeout(startupUpdateTimer);
    startupUpdateTimer = null;
  }
  // 手动检查时显示头顶大气泡
  let checkingEl: HTMLElement | null = null;
  if (manual) {
    checkingEl = document.createElement("div");
    checkingEl.className = "big-toast";
    checkingEl.textContent = "🔍 检查更新中…";
    document.body.appendChild(checkingEl);
    const mr = getModelRect();
    checkingEl.style.left = `${Math.round(mr.left + mr.width / 2)}px`;
    checkingEl.style.bottom = `${Math.round(window.innerHeight - mr.top + 14)}px`;
    checkingEl.style.transform = "translateX(-50%)";
  }
  try {
    const info = await checkForUpdate();
    if (info) {
      if (!manual && localStorage.getItem(UPDATE_KEY) === info.version) return;
      localStorage.setItem(UPDATE_KEY, info.version);
      showUpdateBubble(info.version);
    } else if (manual) {
      const v = await getVersion().catch(() => "?");
      toast(`已是最新版本（v${v}）`);
    }
  } catch (e) {
    // 按错误类型给用户可理解提示（自动检查静默，仅记录日志）
    if (manual) {
      const kind = e instanceof UpdateCheckErrorExt ? e.kind : "unknown";
      const msg =
        kind === "plugin-unavailable" ? "更新组件不可用"
        : kind === "metadata" ? "更新信息获取失败"
        : kind === "signature" ? "更新包安全验证失败"
        : "检查更新失败，请检查网络或代理设置";
      // 附加底层原因，便于定位（如：release 未发布 / 未传 latest.json / 网络不通）
      const detail = e instanceof Error ? e.message : String(e);
      const hint = detail && detail.length > 90 ? `${detail.slice(0, 90)}…` : detail;
      toast(hint ? `${msg}（${hint}）` : msg, "warn");
    }
  } finally {
    if (checkingEl) checkingEl.remove();
  }
}

function toggleAudio(on: boolean) {
  settings.audioEnabled = on;
  saveSettings(settings);
  view.setSwayEnabled(on);
  void invoke("set_audio_enabled", { enabled: on });
  toast(on ? "耳朵竖起来啦～" : "暂时不想听音乐了");
}

// 注册小游戏（右键菜单「🎮 小游戏」入口）
registerRiichiGame();

void boot();

































