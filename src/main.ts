import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow, LogicalPosition, PhysicalPosition, availableMonitors, primaryMonitor } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

// 启动错误捕获：崩溃时直接显示在屏幕上
window.addEventListener("error", (e) => {
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;top:10px;left:10px;right:10px;background:#ff0000;color:#fff;padding:10px;font-size:12px;z-index:99999;white-space:pre-wrap;";
  div.textContent = "启动错误: " + e.message + "\n" + (e.error?.stack || "");
  document.body?.appendChild(div);
});
window.addEventListener("unhandledrejection", (e) => {
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;top:10px;left:10px;right:10px;background:#ff6600;color:#fff;padding:10px;font-size:12px;z-index:99999;white-space:pre-wrap;";
  div.textContent = "Promise错误: " + (e.reason?.message || e.reason);
  document.body?.appendChild(div);
});

import { AudioAnalyzer } from "./audio/AudioAnalyzer";
import { BehaviorEngine } from "./autonomous/BehaviorEngine";
import { idleDriver, type PetDriver, type PetView } from "./live2d/PetDriver";
import { Rigged2DView } from "./live2d/psd/Rigged2DView";
import { listActions } from "./live2d/actions";
import { setupTrashDrop } from "./features/trash/TrashHandler";
import { setupContextMenu, type MenuItemSpec } from "./ui/ContextMenu";
import { openSettingsPanel, closeSettingsPanel } from "./ui/SettingsPanel";
import { trackEvent, incrementInteractionCount, trackAppUse, trackMusic } from "./features/diary/DiaryEventTracker";
import { checkAndGenerateDiary, takeDiaryStorageWarning, loadDiaries } from "./features/diary/DiaryManager";
import { formatWeatherHtml } from "./features/weather/WeatherFormat";
import { toggleDiaryPanel } from "./features/diary/DiaryPanel";
import { hasDrawnToday, getTodayDraw, dailyDraw } from "./features/card/DailyCardManager";
import { toggleDailyCardPanel } from "./features/card/DailyCardPanel";

import { toast } from "./ui/Toast";
import { ttsPlayer } from "./tts/TTSPlayer";
import { copyText } from "./ui/clipboard";
import { setVisibleRect, clampIntoRect, fitSizeInRect } from "./ui/visible";
import { infoPanelPlacement } from "./ui/infoPanelPlacement";
import { clamp } from "./utils/math";
import { loadSettings, saveSettings as saveSettingsRaw, composePersona, type Settings, type AssistantProvider } from "./utils/settings";
import { OUTPUT_LANGUAGE_OPTIONS } from "./utils/outputLanguage";
import { ACTIVITY_LABEL, nextActivity, type ActivityLevel } from "./utils/settings";
import { astrobotOn } from "./bridges/astrobot";
import { openAssistant, repositionAssistantBubbles } from "./assistant/AssistantPanel";
import { setLifecycle, triggerProactive, closeAssistant, clearBubbles, clearApiKeyCache, clearHistory, isAssistantBusy, sayPetLine, setModelRectProvider, fitBubbleHeights } from "./assistant/AssistantPanel";
import { getSpeechRecognizer } from "./asr/SpeechRecognizer";
import { repositionLyricBubble } from "./music/LyricBubble";
import {
  adjustLyricOffset,
  getLyricOffsetMs,
  LYRIC_OFFSET_STEP_MS,
} from "./music/NowPlaying";
import { startHourlyChime, stopHourlyChime, formatQuietRange } from "./features/hourly/HourlyChime";
import { mountHandAxisControls } from "./live2d/psd/HandAxisPicker";
import { buildHourlyQuietMenuItems } from "./features/hourly/HourlyQuietRows";
import { listModels, PROVIDERS, getUsageStats, resetUsageStats, chatStream } from "./assistant/AssistantClient";
import { getApiKey, setApiKey, normalizeOpenAIBase, presetKeyScope, currentKeyScope } from "./assistant/apiKey";
import { registerEmotionReactor, reactToTouch, getMoodDriverValue, emotionExpression, emotionToAction } from "./assistant/EmotionEngine";
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
import { appNameFromTitle, isOwnWindow } from "./utils/foregroundApp";


/**
 * 当前运行平台。用途：裁剪只有部分平台才有的能力（系统回环录音、媒体会话、歌词翻译）。
 * Tauri 没有装 os 插件，直接读 WebView 的 UA：
 *   macOS → WKWebView，UA 含 "Macintosh" / "Mac OS X"
 *   Linux → WebKitGTK，UA 含 "Linux"（X11 与 Wayland 会话的 UA 看不出区别）
 *   其余  → Windows WebView2
 * 判断顺序必须先 mac 再 linux：有些 Linux UA 里也可能出现 "X11"，不能作为区分依据。
 */
const PLATFORM: "win" | "mac" | "linux" = /Macintosh|Mac OS X/i.test(navigator.userAgent)
  ? "mac"
  : /Linux/i.test(navigator.userAgent)
    ? "linux"
    : "win";

/**
 * 只有 Windows 才有系统回环录音（WASAPI）与覆盖面最全的媒体会话（SMTC）。
 * mac 读 Apple Music/Spotify，Linux 走 MPRIS，都能提供歌词气泡所需的曲目信息。
 */
const IS_WINDOWS = PLATFORM === "win";

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
      // 性能优化：小桌宠无需强制高性能 GPU，交由系统按需调度，避免独显持续占用
      powerPreference: "default",
    });
    // 性能优化：桌宠动画 30fps 已足够流畅；回调内用真实 dt 驱动，
    // 降帧不改变动作速度，仅降低合成/重绘频率，CPU/GPU 占用约减半。
    this.app.ticker.maxFPS = 30;
    document.getElementById("stage")!.appendChild(this.app.view as unknown as Node);
  }
}

const app = new PIXIApp();
let view!: PetView;
let settings: Settings = loadSettings();
let ttsApiKey = "";
invoke<string>("get_tts_key").then(k => {
  ttsApiKey = k;
  ttsPlayer.setConfig(settings.tts.enabled, k, settings.tts.speakerId, settings.assistant.outputLanguage ?? "");
}).catch(() => {});
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

/**
 * 设置落盘 + 通知控制面板。
 *
 * 全项目有 30 处 `saveSettings(settings)`，逐个改成「顺便推给面板」既啰嗦又容易漏，
 * 所以在这里包一层：落盘走 saveSettingsRaw（原来的实现），推送按 300ms 防抖
 * （拖滑条会连续触发，只需要最后一次）。
 */
function saveSettings(s: Settings) {
  saveSettingsRaw(s);
  schedulePanelSync();
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

/**
 * 红框（窗口边界）元素：**按需惰性创建**。
 *
 * 菜单里的「显示边框」在正式构建里也是可见的，但元素以前只在 `import.meta.env.DEV`
 * 的 boot 分支里创建 —— 打包版点开关只会把状态翻成「开」，屏幕上什么都不会出现
 * （`el?.` 对 null 静默跳过）。和绿框同一个坑，改成谁用谁创建。
 */
function ensureDebugBorderEl(): HTMLElement {
  let el = document.getElementById("debug-border");
  if (!el) {
    el = document.createElement("div");
    el.id = "debug-border";
    el.className = "hidden";
    document.body.appendChild(el);
  }
  return el;
}

/** 调试边框开关（红线勾勒窗口边界，观察窗口出屏与模型偏移） */
function toggleDebugBorder() {
  debugBorderVisible = !debugBorderVisible;
  ensureDebugBorderEl().classList.toggle("hidden", !debugBorderVisible);
}

/**
 * 绿框（角色边界面）元素：**按需惰性创建**。
 *
 * 以前这个 div 只在 `import.meta.env.DEV` 的 boot 分支里创建，可「调整模型边界」是
 * 面向用户的正式功能（右键 → 模型 → 调整模型边界，打开面板会自动显示绿框）——
 * 于是打包版里打开面板只有滑条、屏幕上根本没有绿框；dev 里一切正常，所以一直没被发现。
 * 现在改成谁用谁创建：菜单开关、打开边界面板、每帧定位都走这里。
 */
function ensureModelBoundsEl(): HTMLElement {
  let el = document.getElementById("model-bounds");
  if (!el) {
    el = document.createElement("div");
    el.id = "model-bounds";
    el.className = "hidden";
    document.body.appendChild(el);
  }
  return el;
}

/** 模型边框开关（绿框勾勒角色边界：调边界面板会自动打开，也可从菜单「显示模型边框」手动开） */
function toggleModelBounds() {
  debugModelBoundsVisible = !debugModelBoundsVisible;
  ensureModelBoundsEl().classList.toggle("hidden", !debugModelBoundsVisible);
}

/** 每帧更新模型边框绿框位置（窗口坐标 = modelOffset + 角色边界） */
function updateModelBounds(bounds?: { left: number; top: number; right: number; bottom: number } | null) {
  // 关着就什么都不做（连元素都不建，免得多一个节点参与布局）
  if (!debugModelBoundsVisible) {
    engine.lastBoundsOnScreen = null;
    return;
  }
  const el = ensureModelBoundsEl();
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
  const left = Math.max(0, a.left - wx);
  const top = Math.max(0, a.top - wy);
  const right = Math.min(winSize, a.left + a.width - wx);
  const bottom = Math.min(winSize, a.top + a.height - wy);
  /**
   * 桌宠贴边/待机出屏时，交集可能退化甚至反向（right < left）。
   * 以前直接把这个区间交给调用方：`maxW = max(60, right-left-40)` 于是被抬到 60，
   * 面板被压成一条细线；菜单的 `left = x - w - 12` 也可能算出负坐标直接飞出屏幕。
   * 这里保证区间至少 MIN_SPAN 宽高；真的退化到看不见时退回整个窗口，
   * 让面板出现在窗口内（部分可见），而不是被摆到屏幕外完全看不见。
   */
  const MIN_SPAN = 160;
  return {
    left: right - left >= MIN_SPAN ? left : 0,
    top: bottom - top >= MIN_SPAN ? top : 0,
    right: right - left >= MIN_SPAN ? right : winSize,
    bottom: bottom - top >= MIN_SPAN ? bottom : winSize,
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
  // 对话记录面板打开时：对话气泡与歌词气泡一律贴到面板正下方，不遮挡面板内容。
  // 这里是每帧定位的权威入口（positionBubbles/positionBox 只在新气泡出现时跑一次，会被本函数覆盖）。
  const chatPanel = document.getElementById("chat-history-panel");
  const chatRect = chatPanel && chatPanel.isConnected ? chatPanel.getBoundingClientRect() : null;
  if (toasts && toasts.children.length > 0) {
    // bottom 是相对窗口底部的距离：可见范围 [innerHeight - vr.bottom, innerHeight - vr.top]
    const minBottom = window.innerHeight - vr.bottom + 8;
    const maxBottom = window.innerHeight - vr.top - 8;
    const bottom = Math.max(minBottom, Math.min(window.innerHeight - mr.bottom - 10, maxBottom));
    // 关键：先把 right 清成 auto，让容器宽度收敛成"最宽的那条提示"。
    // 原来 CSS 是 left:0;right:0，JS 只改 left —— 容器宽度会变成 innerWidth-cx，
    // 再叠加 translateX(-50%) 就整体跑偏：角色在右边时宽度只剩几十像素，
    // 提示会溢到窗口外被裁掉（用户看到"弹窗没对着模型"就是这么来的）。
    toasts.style.right = "auto";
    const maxW = Math.max(80, vr.right - vr.left - 16);
    toasts.style.maxWidth = `${Math.round(maxW)}px`;
    const tw = Math.min(toasts.offsetWidth || 0, maxW);
    const idealCx = mr.left + mr.width / 2;
    const minCx = vr.left + tw / 2 + 4;
    const maxCx = vr.right - tw / 2 - 4;
    const cx = minCx <= maxCx
      ? Math.max(minCx, Math.min(idealCx, maxCx))
      : (vr.left + vr.right) / 2;
    toasts.style.left = `${Math.round(cx)}px`;
    toasts.style.bottom = `${Math.round(bottom)}px`;
    toasts.style.transform = "translateX(-50%)";
  }
  if (bubbles && bubbles.children.length > 0) {
    // 限制气泡宽度不超过可见区域，防止贴边时被截断
    const visibleW = vr.right - vr.left - 8;
    bubbles.style.maxWidth = `${Math.max(80, visibleW)}px`;
    const bw = bubbles.offsetWidth || 214;
    // 用户反馈「气泡会挡住人物」：定位前先按「头顶还剩多少」给气泡限高（长回复在气泡里滚动），
    // 这样气泡只会贴在头顶上方，不会压到角色身上。这里是每帧的权威定位入口，
    // 所以限高也必须在这里做 —— 只在 AssistantPanel 里做会被本函数覆盖掉。
    const bubbleRoom = chatRect
      ? Math.max(0, vr.bottom - (chatRect.bottom + 8) - 8)
      : Math.max(0, mr.top - vr.top - 16);
    const bh = fitBubbleHeights(bubbleRoom) || bubbles.offsetHeight || 60;
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
    // 固定贴模型上方，不翻到下方（否则会压到输入框）；上方不够就贴可见区顶部
    let top = mr.top - bh - 12;
    top = Math.max(vr.top, Math.min(top, vr.bottom - bh - 4));
    if (chatRect) {
      // 对话记录面板打开：气泡贴面板正下方，水平居中于面板，绝不遮挡面板
      const pcx = chatRect.left + chatRect.width / 2;
      cx = Math.max(vr.left + bw / 2 + 4, Math.min(pcx, vr.right - bw / 2 - 4));
      top = chatRect.bottom + 8;
      if (top + bh > vr.bottom - 4) top = vr.bottom - bh - 4; // 下方不够贴屏幕底，绝不回到面板上方
      top = Math.max(vr.top + 4, Math.min(top, vr.bottom - bh - 4));
    }
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
    let cx = minCx <= maxCx ? Math.max(minCx, Math.min(idealCx, maxCx)) : (vr.left + vr.right) / 2;
    const left = cx - lw / 2;
    // 动作试玩面板打开时，歌词气泡必须避开它（不能压住面板）
    const actPanel = document.getElementById("action-debug");
    const actRect = actPanel && !actPanel.classList.contains("hidden") ? actPanel.getBoundingClientRect() : null;
    const hitPanel = (l: number, t: number) =>
      !!actRect && l < actRect.right && l + lw > actRect.left && t < actRect.bottom && t + lh > actRect.top;
    const inView = (l: number, t: number) =>
      l >= vr.left - 1 && l + lw <= vr.right + 1 && t >= vr.top - 1 && t + lh <= vr.bottom + 1;
    // 候选：模型上方（叠助手气泡之上）→ 紧贴模型上方 → 模型下方
    const candTops = [
      mr.top - lh - 12 - bubblesHeight,
      mr.top - lh - 12,
      mr.bottom + 12,
    ];
    let top: number = Number.NaN;
    for (const t of candTops) {
      if (inView(left, t) && !hitPanel(left, t)) { top = t; break; }
    }
    if (Number.isNaN(top)) top = Math.max(vr.top + 8, Math.min(vr.bottom - lh - 8, candTops[candTops.length - 1]));
    if (chatRect) {
      // 对话记录面板打开：歌词气泡贴面板正下方，绝不遮挡面板
      const pcx = chatRect.left + chatRect.width / 2;
      cx = Math.max(vr.left + lw / 2 + 4, Math.min(pcx, vr.right - lw / 2 - 4));
      top = chatRect.bottom + 8;
      if (top + lh > vr.bottom - 4) top = vr.bottom - lh - 4;
      top = Math.max(vr.top + 4, Math.min(top, vr.bottom - lh - 4));
    }
    lyric.style.left = `${Math.round(cx)}px`;
    lyric.style.top = `${Math.round(top)}px`;
    lyric.style.bottom = "auto";
    lyric.style.transform = "translateX(-50%)";
  }
}

/** 将面板定位到模型旁边：往屏幕内侧（空间大的方向），不挡住模型、不出屏 */
function positionPanelNearModel(
  panel: HTMLElement,
  /** 要避开的矩形（目前是贴底停靠的设置窗口）：候选位置压在它上面就换下一个 */
  avoid?: { left: number; top: number; right: number; bottom: number } | null,
) {
  panel.style.position = "fixed"; // 确保 fixed 定位
  const mr = getModelRect();
  const vr = getWindowVisibleRect();
  // 可见区尺寸下限保护：60px 时代面板会被压成一条细线（看不清也点不准），
  // 抬到 200 宽 / 140 高的可用下限；getWindowVisibleRect 已保证区间本身不退化成负值。
  const maxW = Math.max(200, vr.right - vr.left - 40);
  const maxH = Math.max(140, vr.bottom - vr.top - 40);
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

  const hitsAvoid = (l: number, t: number) =>
    !!avoid && l < avoid.right && l + pw > avoid.left && t < avoid.bottom && t + ph > avoid.top;

  // 选第一个完整落在可见区、且不压在「要避开的矩形」上的位置
  for (const c of candidates) {
    const l = Math.round(c.left);
    const t = Math.round(c.top);
    if (l >= vr.left && l + pw <= vr.right && t >= vr.top && t + ph <= vr.bottom && !hitsAvoid(l, t)) {
      panel.style.left = `${l}px`;
      panel.style.top = `${t}px`;
      panel.style.bottom = "auto";
      panel.style.transform = "none";
      return;
    }
  }

  // 兜底 1：四个常规方位都被占/放不下时，在可见区里扫一个不压 avoid 的位置
  // （典型场景：设置窗口贴底停靠，边界面板还得找地方站）
  if (avoid) {
    // 候选位置取「有意义的边界」而不是死扫网格：网格步长会正好错过模型与
    // 设置窗口之间那条几十像素宽的空档（实测 250px 宽的面板只剩 l=444..450 可用）。
    const xs = Array.from(new Set([
      vr.left, vr.right - pw,
      mr.right + 8, mr.left - pw - 8,
      (vr.left + vr.right - pw) / 2,
    ])).filter((x) => x >= vr.left - 0.5 && x + pw <= vr.right + 0.5);
    const ys = Array.from(new Set([
      vr.top, vr.bottom - ph,
      mr.bottom + 8, mr.top - ph - 8,
      (vr.top + vr.bottom - ph) / 2,
    ])).filter((y) => y >= vr.top - 0.5 && y + ph <= vr.bottom + 0.5);
    // 两轮：先找「既不压 avoid 也不压角色」的，找不到再放宽到只避开 avoid
    for (const strict of [true, false]) {
      for (const t of ys) {
        for (const l of xs) {
          if (hitsAvoid(l, t)) continue;
          const hitsModel = l < mr.right + 8 && l + pw > mr.left - 8 && t < mr.bottom + 8 && t + ph > mr.top - 8;
          if (strict && hitsModel) continue;
          panel.style.left = `${Math.round(l)}px`;
          panel.style.top = `${Math.round(t)}px`;
          panel.style.bottom = "auto";
          panel.style.transform = "none";
          return;
        }
      }
    }
  }

  // 兜底 2：clamp 到可见区
  const left = Math.max(vr.left, Math.min(preferRight ? mr.right + 10 : mr.left - pw - 10, vr.right - pw));
  const top = Math.max(vr.top, Math.min(preferBottom ? mr.bottom + 10 : mr.top - ph - 10, vr.bottom - ph));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.bottom = "auto";
  panel.style.transform = "none";
}

/** 天气面板优先放模型侧面，缩窄/滚动后仍放不下才翻到上下方。 */
function positionInfoPanelNearModel(
  el: HTMLElement,
  mr: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  vr: { left: number; top: number; right: number; bottom: number },
) {
  el.style.boxSizing = "border-box";
  const inputBar = document.getElementById("as-inputbar");
  const inputRect = inputBar && !inputBar.classList.contains("hidden")
    ? inputBar.getBoundingClientRect() : undefined;

  // 拿「模型旁边那块空闲区域」的真实尺寸：故意传一个远超内容的高度，
  // 布局函数就会把 region 撑满可用空间返回，于是返回的 box 就是这块地方的四边。
  //
  // 为什么不再按内容高度去算（历史坑，用户截图里"面板出现滚动条、陪伴时间被切一半"）：
  // 面板高度是内容决定的，而内容（天气/待办）是异步来的；一旦用「当前量到的高度」去设
  // max-height，就会被上一帧的上限反锁住 —— 内容变高也撑不开，只能出滚动条。
  // 现在改成**只把 max-height 设成 region 高度**，面板自己随内容伸缩，永远不会自锁。
  const box = infoPanelPlacement(mr, vr, { width: 270, height: 100000 }, inputRect);
  el.style.visibility = box ? "" : "hidden";
  if (!box) return;
  const boxH = Math.max(60, box.bottom - box.top);
  el.style.width = `${box.width}px`;
  el.style.maxHeight = `${boxH}px`;
  el.style.left = `${Math.round(box.left)}px`;
  // 高度由内容决定，量出来再把它垂直居中到 region 里（放不下就顶上）
  const h = el.offsetHeight || 200;
  const top = Math.max(box.top, Math.min(box.top + (boxH - h) / 2, Math.max(box.top, box.bottom - h)));
  el.style.top = `${Math.round(top)}px`;
}

/** 将通知定位到模型头顶（不挡住模型） */
function positionAboveModel(el: HTMLElement) {
  const mr = getModelRect();
  el.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
  el.style.bottom = `${Math.round(window.innerHeight - mr.top + 10)}px`;
  el.style.top = "auto";
  el.style.transform = "translateX(-50%)";
}

const ZERO_PADDING = { left: 0, right: 0, top: 0, bottom: 0 };

/** 边界松紧按模型存：key 与 modelScales / modelParams 一致，用模型名 */
function paddingKey(): string {
  return currentModel.name ?? "default";
}

/** 当前模型的边界松紧（没有记录就退到旧版全局值，再退默认 0） */
function currentBoundsPadding() {
  return settings.boundsPaddings[paddingKey()] ?? settings.boundsPadding ?? { ...ZERO_PADDING };
}

/** 写入当前模型的边界松紧并立刻应用到渲染层 */
function setCurrentBoundsPadding(p: { left: number; right: number; top: number; bottom: number }) {
  settings.boundsPaddings[paddingKey()] = p;
  saveSettings(settings);
  (view as any)?.setBoundsPadding?.(p);
}

/**
 * 换模型时**不要**再清边界松紧。
 *
 * 边界松紧已经按模型存（boundsPaddings），新模型本来就没有记录、自然回落到 0；
 * 而这里两个调用点（importPsdBytes / 模型列表点击）都在 currentModel 更新**之前**执行，
 * paddingKey() 拿到的是"即将卸载的旧模型" —— 会把用户在原模型上辛苦调好的值删掉，
 * 切回去就丢了。所以保留按模型的值，什么都不做。
 */
function resetBoundsOnModelSwitch() {
  /* no-op：保留每个模型自己的边界松紧 */
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
  (view as any).setBoundsPadding?.(currentBoundsPadding());
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

/**
 * 重新加载模型（换模型 / 拖入新 PSD / WebGL 上下文丢失后重建）。
 *
 * **必须串行**：以前 unmount 之后立刻 await mountView，两次调用交错时两边都会 attach
 * 一个新 canvas —— 后完成的覆盖 view，先完成的那个 canvas 永久留在 #stage 且不再更新
 * （残影/双模型），旧 WebGL 上下文也一直不释放。这里用一条 Promise 链排队。
 */
let viewReloadChain: Promise<void> = Promise.resolve();

function reloadView(): Promise<void> {
  const run = () => doReloadView();
  const next = viewReloadChain.then(run, run);
  viewReloadChain = next.catch(() => {});
  return next;
}

async function doReloadView() {
  view.unmount();
  await mountView();
  // 切换模型：恢复该模型自己的大小（无记录用默认 100%）
  const key = currentModel.name ?? "";
  const scale = settings.modelScales[key] ?? 1;
  void applyModelScale(scale, false);
}

// WebGL 上下文丢失（驱动重置 / 休眠唤醒 / 远程桌面）时模型会整块消失但 UI 还在，
// 且没有任何自愈路径 —— 只能换模型或重启。这里自动重建一次。
document.addEventListener("petra:webgl-lost", () => {
  toast("显示上下文丢失了，正在重新加载模型…", "warn");
  void reloadView().catch(() => toast("模型重新加载失败，可在菜单里换一个模型", "warn"));
});

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
  const prev = settings.assistant.shortcut;
  // 先注册、成功了再持久化：Rust 侧注册函数会先 unregister 旧键再注册新键，
  // 失败时旧键已经丢了。以前先写设置再注册，于是一个被占用的组合会让"原来的快捷键失效 +
  // 坏组合被持久化"，重启后仍按坏组合静默失败。
  const ok = await registerAssistantHotkey(acc);
  if (ok) {
    settings.assistant.shortcut = acc;
    saveSettings(settings);
    toast(`呼出快捷键已设为 ${acc}`, "info");
    return;
  }
  // 注册失败：把旧键重新注册回去，别让用户两头落空
  if (prev) await registerAssistantHotkey(prev);
  toast(
    prev
      ? `快捷键 ${acc} 注册失败（可能被别的程序占用），已保留原来的 ${prev}`
      : `快捷键 ${acc} 注册失败，可换个组合试试`,
    "warn",
  );
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

/**
 * 上次主动问候的时刻（ms）。0 = 从没问候过。
 *
 * **必须持久化**：只放内存的话，每次刷新页面 / 重启应用锚点都会归零，
 * `sinceGreet` 变成天文数字 → 一分钟后就补一次问候。实测（调试时反复刷新）：
 * 问候间隔从设置的 20 分钟变成 1~6 分钟，而且每次都是一次真请求 + 一次朗读。
 */
const LAST_GREET_KEY = "petra-last-greet-at";
let lastGreetAt = (() => {
  try {
    return Number(localStorage.getItem(LAST_GREET_KEY) || 0) || 0;
  } catch {
    return 0;
  }
})();

/** 记一次问候（内存 + 落盘），所有触发点都走这里，别再直接赋值 */
function markGreeted(at: number): void {
  lastGreetAt = at;
  try {
    localStorage.setItem(LAST_GREET_KEY, String(at));
  } catch {
    /* 忽略 */
  }
}

/**
 * 用户在设置里改了问候间隔后调用：把计时锚点重设到当下，
 * 让新间隔从改动这一刻起算，而不是继续沿用"距上次问候"的旧节奏。
 */
function resyncGreetingSchedule() {
  markGreeted(Date.now());
  scheduleNextGreeting();
}

/** 当前生效的问候间隔（分钟→毫秒），带下限保护 */
function greetIntervalMsNow(): number {
  return Math.max(5, Number(settings.assistant.greetInterval) || 20) * 60 * 1000;
}

/**
 * 主动问候的精确调度：**按「上次问候 + 设置间隔」定到秒**，不再靠 60 秒 tick 去撞。
 *
 * 旧实现是每 60 秒检查一次 `now - lastGreetAt > interval`，于是实际间隔是
 * 「设置的 N 分钟 + 0~60 秒」；再加上「离开≥15 分钟回来就问候」那条不看间隔，
 * 用户看到的就是"时间间隔不准"。现在改成一次性 setTimeout 定到点，
 * 每次问候/改设置/启动都重排一次，误差只剩定时器本身（毫秒级）。
 */
let greetTimer: number | null = null;
function scheduleNextGreeting(): void {
  if (greetTimer !== null) {
    clearTimeout(greetTimer);
    greetTimer = null;
  }
  if (!settings.assistant.enabled) return;
  // 至少 5 秒后才可能触发：避免"刚启动就问候"（锚点很旧时 due 已经过去）
  const due = Math.max(lastGreetAt + greetIntervalMsNow(), Date.now() + 5000);
  const delay = Math.max(1000, due - Date.now());
  greetTimer = window.setTimeout(() => {
    greetTimer = null;
    void fireScheduledGreeting(due);
  }, delay);
}

/** 到点后的主动问候：待机/离开/关掉小助手时先不打扰，延后一分钟再看 */
async function fireScheduledGreeting(dueAt: number): Promise<void> {
  if (!settings.assistant.enabled || settings.idleMode) {
    scheduleNextGreeting();
    return;
  }
  let idleSec = 0;
  try { idleSec = await invoke<number>("get_idle_seconds"); } catch {}
  if (idleSec > 300) {
    // 用户离开了：不打扰，回来之后由 60 秒 tick 的"回归问候"或下一个到期点接手
    greetTimer = window.setTimeout(() => void fireScheduledGreeting(dueAt), 60 * 1000);
    return;
  }
  // 期间可能已经被别的路径问候过（回归问候），到点就别重复
  if (Date.now() - lastGreetAt < greetIntervalMsNow()) {
    scheduleNextGreeting();
    return;
  }
  markGreeted(Date.now());
  void triggerProactive();
  trackEvent({ type: "greeting", summary: "主动问候了用户" });
  scheduleNextGreeting();
}

async function boot() {
  try {
    await mountView();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast(`模型加载失败：${msg}`, "warn");
    return;
  }

  // 旧版单 Key 迁移：启动时先按"当前选中的供应商"领一次。
  // 明确传 provider 而不是 currentKeyScope()：当前若套着预设，旧 Key 不该被写进预设槽位。
  void getApiKey(settings.assistant.provider).catch(() => {});

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
    // 保存的位置可能属于已拔出/改过布局的显示器：不做校验的话窗口会落在屏幕外，
    // 表现是"托盘有图标、任务管理器里有进程，但屏幕上根本看不到桌宠"（只能删配置恢复）。
    const onScreen = await isWindowPosOnScreen(savedPos);
    if (!onScreen) {
      pos = await centerOfPrimaryMonitor();
      toast("上次的位置在已断开的显示器上，已把桌宠放回主屏中间", "info");
    }
    void win.setPosition(new LogicalPosition(pos.x, pos.y));
  }

  engine = new BehaviorEngine(pos);
  engine.setScale(scaleFactor);
  engine.setActivityLevel(settings.activity);
  engine.setTracking(settings.mouseTrack);
  // 应用持久化模型缩放（窗口尺寸 + canvas + 引擎窗口边长）
  void applyModelScale(settings.modelScale);
  // 红框 / 绿框都改成按需创建（见 ensureDebugBorderEl / ensureModelBoundsEl）：
  // 菜单开关在正式构建里也可见，提前在 boot 里按 dev 创建会让打包版"有开关无效果"。
  // 气泡按桌宠当前位置摆放（放它上方），别把桌宠挡住
  setModelRectProvider(getModelRect);
  if (import.meta.env.DEV) {
    // dev 调试钩子：CDP 里直接读角色包围盒/绿框状态，排查"气泡位置/绿框不对"时不用再临时改代码
    (window as any).__petraDebug = {
      getModelRect,
      getWindowVisibleRect,
      // 打开「小助手设置」：CDP 里验证预设/Key 显隐时不用再手动点右键菜单
      openAssistantSettings: () => void toggleAssistantSettings(),
      // 问候调度自检：不用真等 20 分钟就能核对"下一次该什么时候问候"
      tickerFps: () => { try { return app.app.ticker.maxFPS; } catch { return null; } },
      greetingSchedule: () => ({
        lastGreetAt,
        intervalMs: greetIntervalMsNow(),
        dueAt: lastGreetAt + greetIntervalMsNow(),
        timerArmed: greetTimer !== null,
      }),
    };
  }
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

  // 主动问候：精确定时（见 scheduleNextGreeting），60 秒 tick 只管"离开/回来"与回归问候
  let lastActiveAt = Date.now();    // 最近一次检测到用户活跃的时间
  let wasIdle = false;              // 上次检查时是否处于空闲
  scheduleNextGreeting();           // 启动就排下一次

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
        // 从离开状态回来
        wasIdle = false;
        // 回归问候：离开超过 15 分钟才触发
        const awayMs = now - lastActiveAt;
        // 回归问候同样要守用户设的间隔：离开 15 分钟以上回来，但距上次问候还没到
        // 设定间隔时就不补，交给精确定时器（否则用户会觉得"间隔忽长忽短"）
        if (awayMs > 15 * 60 * 1000 && now - lastGreetAt > greetIntervalMsNow()) {
          markGreeted(now);
          void triggerProactive();
          trackEvent({ type: "greeting", summary: "主动问候了用户" });
          scheduleNextGreeting();
          return;
        }
      }
      lastActiveAt = now;
    }

    // 固定间隔问候交给 scheduleNextGreeting() 的精确定时器（60 秒粒度会把
    // "20 分钟"变成"20 分钟 + 0~60 秒"，用户觉得不准）。这个 tick 只负责任务：
    // 记录离开/回来、以及"回来时补一次回归问候"。

    // 原先这里还有一条"早晨首次（6~10 点且 lastGreetAt===0）"：锚点持久化后它永远不会命中
    // （间隔分支先跑，且 lastGreetAt 极少为 0），而且它在用户**离开**时也会触发 —— 删掉。
    // 早上第一次见到用户由上面两条覆盖：隔夜没问候必然超过间隔（间隔分支），
    // 从"离开"回到"活跃"时走回归问候，两处的 prompt 里都带着当前时间。
  }, 60 * 1000);

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

  // 托盘菜单「控制面板」：Rust 侧发 open-control-panel，起本地服务并用浏览器打开
  void listen("open-control-panel", () => void openControlPanel());
  // 控制面板改参数 → Rust 深合并后 emit 回来，这里应用到运行中的桌宠
  void listen<{ patch: Record<string, unknown> }>("panel:apply", (e) => {
    void applyPanelPatch(e.payload?.patch ?? {});
  });
  // 控制面板点功能按钮 → 直接跑右键菜单里同一个 onPick
  void listen<{ id: string; payload?: unknown }>("panel:action", (e) =>
    runPanelAction(e.payload?.id ?? "", e.payload?.payload),
  );
  // 控制面板里导入的 PSD 已经由 Rust 写进 models 目录，这里补上「切换 + 重载」
  void listen<{ name: string }>("panel:model-imported", (e) => {
    const name = e.payload?.name ?? "";
    if (!name) return;
    localStorage.setItem(PSD_KEY, name);
    resetBoundsOnModelSwitch();
    void reloadView().then(() => pushPanelState());
    toast(`已导入并切换到 ${name.replace(/\.psd$/i, "")}`);
  });
  // 面板服务起来了（可能是托盘/调试自启动起来的）→ 补推一次当前设置
  void listen("panel:ready", () => {
    panelEverOpened = true;
    void pushPanelState();
  });
  // boot 兜底：服务若在本页面注册监听之前就起来了，上面的 listen 收不到那条事件
  void invoke<number | null>("panel_running")
    .then((port) => {
      if (port) {
        panelEverOpened = true;
        void pushPanelState();
      }
    })
    .catch(() => {});

  listen<string | object>("audio:error", (e) => {
    toast(`音频走丢了：${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`, "warn");
    // 不要因为一次瞬时失败就关掉功能并写进设置；Rust 侧 3 秒后会自动重连，
    // 但 enabled=false 会让它再也推不出 PCM（前端也收不到恢复事件）——
    // 以前一次蓝牙重连/切播放设备就把「跟随音乐」永久关了，还得手动去设置里开。
    if (settings.audioEnabled) void invoke("set_audio_enabled", { enabled: true });
  });
  void startAudio();

  // 歌词气泡（SMTC 识别正在播放 + 在线歌词）
  if (settings.musicLyrics) startMusicLyrics();

  // ---------- 交互 ----------
  setupTrashDrop(() => view, win, (path) => void importPsdFromPath(path));
  setupReminder();

  setupContextMenu(
    () => buildCompactMenu(engine),
    onMenuOpen,
    () => getWindowVisibleRect(),
    (x: number, y: number) => isInsideModel({ clientX: x, clientY: y }),
    () => getModelRect(),
  );
  startInteractionRegionSync();
  void setupAssistantHotkeyListener();

  // 渲染帧率：平时 30fps 省电，拖拽时抬到 60fps 让画布跟得上窗口
  const IDLE_MAX_FPS = 30;
  const DRAG_MAX_FPS = 120; // 窗口是 8ms(=125Hz) 原生在动，画布跟上才不显得"拖影"

  const setTickerFps = (n: number) => {
    try { app.app.ticker.maxFPS = n; } catch { /* 未初始化时忽略 */ }
  };

  // 左键：按住可拖动桌宠；轻点（<6px 未拖）算"摸头"反应或打开小助手。
  // 非待机：拖动走 Rust 原生跟随线程（GetCursorPos → SetWindowPos，8ms，零每帧 IPC）。
  // 待机中：拖动沿边缘水平滑动（Rust 锁 y 跟随，只移动待机位置，不退出；退出仅靠右键菜单）。
  let drag: { sx: number; sy: number; wx: number; wy: number; moved: boolean; mode: "idleSlide" | "free" } | null = null;
  let nativeDragStart: Promise<unknown> | null = null;
  let uiPointerLocked = false;
  let dragLastMove = 0;

  /**
   * 拖拽时把模型边界推给 Rust 的 8ms 跟随线程 —— **限流到 ~20 次/秒**。
   *
   * 原来 pointermove（16ms）与每帧 tick 各发一次，实测一次 IPC 往返 ~8ms，
   * 于是拖拽时每秒 60~90 次调用把 IPC 桥塞满，表现为"拖动有点卡"。
   * 边界只需要跟上窗口位移的量级，20 次/秒足够让 8ms 线程夹紧。
   */
  let lastBoundsPushAt = 0;
  if (import.meta.env.DEV) {
    // dev 调试：CDP 里看拖拽状态（moved/mode），排查"拖拽没触发/被看门狗掐掉"用
    (window as any).__dragState = () => (drag ? { moved: drag.moved, mode: drag.mode } : null);
  }
  const pushModelBounds = (cb: { left: number; top: number; right: number; bottom: number } | null) => {
    const now = performance.now();
    if (now - lastBoundsPushAt < 30) return; // ≈33 次/秒：再密就是白烧 IPC，再疏夹紧会滞后
    lastBoundsPushAt = now;
    const ox = engine.rawOffset.x;
    const oy = engine.rawOffset.y;
    const b = cb ?? { left: 200, top: 200, right: 500, bottom: 500 };
    const s = scaleFactor || 1;
    void invoke("set_model_bounds", {
      left: Math.round((ox + b.left) * s),
      top: Math.round((oy + b.top) * s),
      right: Math.round((ox + b.right) * s),
      bottom: Math.round((oy + b.bottom) * s),
    });
  };
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
      // 窗口是 Rust 每 8ms 挪一次的，画布却还按 30fps 出图 → 视觉上模型"追不上"
      // 窗口，看着就是卡。拖拽期间临时抬到 60fps，松手再降回去（省电）。
      setTickerFps(DRAG_MAX_FPS);
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
      // 实时发送模型边界（含 offset）给 Rust drag_follow，8ms 原生夹紧（内部限流）
      pushModelBounds(cb);
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
    setTickerFps(IDLE_MAX_FPS);
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
  document.getElementById("announcement-panel")?.remove();
  const panel = document.createElement("div");
  panel.id = "announcement-panel";
  // 固定头 + 可滚正文 + 固定按钮（见 style.css 的 .announcement-panel）
  panel.className = "model-panel announcement-panel";

  const titleEl = document.createElement("div");
  titleEl.className = "mp-title";
  titleEl.textContent = title;
  // 标题栏右侧也放一个 ✕：万一「知道了」被什么挡住/点了没反应，还有第二条路
  const closeBtn = document.createElement("button");
  closeBtn.className = "announce-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.textContent = "×";
  titleEl.appendChild(closeBtn);
  panel.appendChild(titleEl);

  const bodyEl = document.createElement("div");
  bodyEl.className = "announce-body";
  for (const line of lines) {
    if (!line) {
      const spacer = document.createElement("div");
      spacer.style.height = "6px";
      bodyEl.appendChild(spacer);
      continue;
    }
    const p = document.createElement("div");
    p.style.cssText = "font-size:12.5px;color:#5a4a65;line-height:1.7;padding:2px 0;";
    // 分节标题（【新增】/【优化】/【未来计划】/【作者的话】）加粗并上色，方便一眼扫过
    if (/^【.+】/.test(line)) {
      p.style.cssText = "font-size:12.5px;font-weight:700;color:#b0658f;line-height:1.7;padding:4px 0 1px;";
    }
    p.textContent = line;
    bodyEl.appendChild(p);
  }
  panel.appendChild(bodyEl);

  const btns = document.createElement("div");
  btns.className = "as-set-btns announce-actions";
  const okBtn = document.createElement("button");
  okBtn.className = "as-btn as-btn-primary";
  okBtn.textContent = "知道了";
  btns.appendChild(okBtn);
  panel.appendChild(btns);

  document.body.appendChild(panel);
  // 不整块自滚：滚动交给 .announce-body，标题和按钮永远在原位。
  // 尺寸按可见区钳制（窗口贴边/高 DPI 缩小屏时也不会顶出屏幕）。
  keepDialogFullyVisible(panel, 8, { selfScroll: false });
  requestInteractionRegionSync(true);

  // ---- 模态期间强制可点 ----
  // 点击能否落到窗口，取决于 Rust 侧的「交互区域命中」：光标进入面板后要等
  // 看门狗把 WS_EX_TRANSPARENT 清掉，用户"移过去马上点"会被吃掉；区域同步
  // 一抖（快照过期、DPI 换算、多屏）也会整窗穿透。公告是必须能关掉的模态，
  // 所以这期间直接把 renderer_locked 顶住（和右键菜单打开时一个做法），
  // 并每 400ms 重申一次 —— 其它路径（pointerup 释放 interacting）不会把它清掉。
  const lockInput = () => { void invoke("set_interacting", { active: true }).catch(() => {}); };
  lockInput();
  const lockTimer = window.setInterval(lockInput, 400);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.clearInterval(lockTimer);
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("keydown", onKey, true);
    markAnnounced(version, lines);
    panel.remove();
    void invoke("set_interacting", { active: false }).catch(() => {});
    requestInteractionRegionSync(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  okBtn.addEventListener("click", close);
  closeBtn.addEventListener("click", close);
  // 对话记录面板打开后，让歌词/对话气泡贴到面板下方，不遮挡面板内容
  repositionLyricBubble();
  repositionAssistantBubbles();
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
    const __t0 = import.meta.env.DEV ? performance.now() : 0; // dev 性能采样起点
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;

    analyzer.tick();

    // syncModelOffset 先于 update（constrainPosition 在 update 内，需要最新 offset）
    const cb = view.getCharacterBounds?.() ?? null;
    engine.syncModelOffset(cb ?? undefined);
    engine.update(now, dt);
    // 仅拖拽期间同步给 Rust drag follower；穿透判定使用独立 regions。
    // 和 pointermove 那条共用限流（同一次拖拽里两边都调也只是 20 次/秒）
    if (drag?.moved && drag.mode !== "idleSlide") pushModelBounds(cb);
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
      // 输入框：默认在模型下方居中，放不下翻到上方，避开信息板，钳制可见区
      const ib = document.getElementById("as-inputbar");
      if (ib && !ib.classList.contains("hidden")) {
        const ih = ib.offsetHeight || 60;
        const iw = ib.offsetWidth || 185;
        // 水平居中在模型正下方：模型中心 - 输入框半宽
        const modelCenterX = mr.left + mr.width / 2;
        const idealLeft = modelCenterX - iw / 2;
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
          if (!collides(idealLeft, t) && t >= vr.top && t + ih <= vr.bottom) {
            top = t;
            break;
          }
        }
        top = Math.max(vr.top, Math.min(top, vr.bottom - ih));
        // 钳制到可见区内
        const left = Math.max(vr.left, Math.min(idealLeft, vr.right - iw));
        ib.style.left = `${Math.round(left)}px`;
        ib.style.top = `${Math.round(top)}px`;
        ib.style.bottom = "auto";
      }
      positionFloatingUi(toasts, bubbles, lyricBubbles, mr, vr);
      // 其他面板（model-panel、chat-history 等）：统一避开设置窗口，别互相叠住
      const settingsWin = document.getElementById("settings-window");
      const settingsRect = settingsWin && !settingsWin.classList.contains("hidden")
        ? settingsWin.getBoundingClientRect()
        : null;
      document.querySelectorAll(".model-panel:not(.hidden), #chat-history-panel").forEach(el => {
        if ((el as HTMLElement).id === "settings-window") return;
        positionPanelNearModel(el as HTMLElement, settingsRect);
      });
      // 天气信息板单独跟随：始终紧挨着模型，贴边自动翻到内侧
      const followEl = document.getElementById("info-panel");
      if (followEl && !followEl.classList.contains("hidden")) {
        positionInfoPanelNearModel(followEl, mr, vr);
      }
    }

    // 调试日志仅 dev 构建输出
    if (import.meta.env.DEV && Math.round(now) % 2000 < 20 && (driver.bass > 0.001 || driver.mid > 0.001)) {
      console.log(`[driver] → bass=${driver.bass.toFixed(3)} mid=${driver.mid.toFixed(3)} sway=${settings.audioEnabled ? "on" : "OFF"}`);
    }
    view.update(driver, dt);
    if (import.meta.env.DEV) {
      // dev 性能采样：每帧 JS 耗时（含本回调里所有 DOM 读写），供 CDP 里统计
      const w = window as any;
      (w.__tickMs ||= []).push(performance.now() - __t0);
      if (w.__tickMs.length > 400) w.__tickMs.shift();
    }
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

/** 至少要有这么多逻辑像素同时落在某块屏上，才算"看得见" */
const MIN_VISIBLE_SPAN = 120;

function monitorLogicalRect(m: { position: { x: number; y: number }; size: { width: number; height: number }; scaleFactor: number }) {
  const s = m.scaleFactor || 1;
  return {
    left: m.position.x / s,
    top: m.position.y / s,
    width: m.size.width / s,
    height: m.size.height / s,
  };
}

/**
 * 这个窗口位置还看得见吗？
 *
 * 恢复上次保存的位置时用。显示器被拔掉、分辨率/缩放改了、或者笔记本从扩展屏拔下来，
 * 保存的坐标就可能完全在金外 —— 窗口照常创建、托盘图标也在，但用户什么都看不到。
 * 混合 DPI 下 monitor.position/size 是物理像素，按各自 scaleFactor 换成逻辑再比。
 */
async function isWindowPosOnScreen(p: { x: number; y: number }): Promise<boolean> {
  try {
    const monitors = await availableMonitors();
    if (!monitors.length) return true; // 拿不到信息时不要误判
    return monitors.some((m) => {
      const r = monitorLogicalRect(m);
      const overlapX = Math.min(p.x + WIN, r.left + r.width) - Math.max(p.x, r.left);
      const overlapY = Math.min(p.y + WIN, r.top + r.height) - Math.max(p.y, r.top);
      return overlapX >= MIN_VISIBLE_SPAN && overlapY >= MIN_VISIBLE_SPAN;
    });
  } catch {
    return true;
  }
}

/** 主屏工作区正中（拿不到信息时退回屏幕坐标 100,100） */
async function centerOfPrimaryMonitor(): Promise<{ x: number; y: number }> {
  try {
    const m = (await primaryMonitor()) ?? (await availableMonitors())[0];
    if (!m) return { x: 100, y: 100 };
    const r = monitorLogicalRect(m);
    return {
      x: Math.round(r.left + (r.width - WIN) / 2),
      y: Math.round(r.top + (r.height - WIN) / 2),
    };
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
      const isCurrent = currentModel.type === "manifest" && currentModel.name === f;
      mk(`内置 · ${label}`, () => {
        localStorage.setItem(BUILTIN_KEY, f);
        localStorage.removeItem(PSD_KEY);
        // 只有真的换了模型才重置边界：不同模型轮廓不同，上一个模型调好的边框不适用。
        // 不能把这个重置放进 createView —— 启动时也走那条加载路径，会导致每次启动都清掉用户设置。
        if (!isCurrent) resetBoundsOnModelSwitch();
      }, isCurrent);
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

/**
 * 把弹窗整体挪进"屏幕上真正看得见的那块区域"。
 *
 * 桌宠窗口固定 700×700、但可以贴到屏幕边缘（部分出屏）。弹窗按窗口居中时，
 * 出屏那一半连带着弹窗一起看不见 —— 用户看到的就是"窗口显示不全"。
 * 这里做两件事：先按可见区给尺寸上限（可见区比弹窗还窄时让它缩，别硬撑出屏），
 * 再把左上角钳进可见区。调用前必须已经 append 到 body，否则量不到尺寸。
 */
function keepDialogFullyVisible(
  dlg: HTMLElement,
  margin = 8,
  opts: { selfScroll?: boolean } = {},
): void {
  const vr = getWindowVisibleRect();
  const { maxWidth, maxHeight } = fitSizeInRect(vr, margin);
  dlg.style.maxWidth = `${Math.round(maxWidth)}px`;
  dlg.style.maxHeight = `${Math.round(maxHeight)}px`;
  // selfScroll=false 用于「固定头 + 可滚正文」的弹窗：滚动交给内部容器，
  // 整块面板自己 overflow:hidden 才不会把标题/按钮一起滚走
  if (opts.selfScroll !== false) dlg.style.overflow = "auto";
  const r = dlg.getBoundingClientRect(); // 量"缩小之后"的真实尺寸
  const pos = clampIntoRect(
    { left: r.left, top: r.top, width: r.width, height: r.height },
    vr,
    margin,
  );
  dlg.style.transform = "none"; // 清掉 translate(-50%,-50%)，改用 left/top 直接定位
  dlg.style.left = `${Math.round(pos.left)}px`;
  dlg.style.top = `${Math.round(pos.top)}px`;
}

/** 语音设置弹窗 */
function showTtsDialog(savedKey: string) {
  document.getElementById("tts-dlg")?.remove();
  const dlg = document.createElement("div");
  dlg.id = "tts-dlg";
  dlg.setAttribute("data-petra-interactive", "true");
  // 用 width 而不是 min-width：min-width 的优先级高于 max-width，
  // keepDialogFullyVisible 给的上限会被它顶掉，弹窗就还是缩不下来
  dlg.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#2a2a2a;color:#fff;padding:24px;border-radius:12px;z-index:999999;width:320px;box-sizing:border-box;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.6);pointer-events:auto;";
  dlg.innerHTML = `
    <div style="font-weight:bold;font-size:16px;margin-bottom:16px;">语音设置</div>
    <div style="color:#999;margin-bottom:4px;">API Key</div>
    <input id="tts-k" type="password" value="${savedKey.replace(/"/g,'&quot;')}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #555;background:#333;color:#fff;box-sizing:border-box;margin-bottom:14px;outline:none;">
    <div style="color:#999;margin-bottom:4px;">音色 ID</div>
    <input id="tts-s" type="text" value="${settings.tts.speakerId.replace(/"/g,'&quot;')}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #555;background:#333;color:#fff;box-sizing:border-box;margin-bottom:18px;outline:none;">
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button id="tts-c" style="padding:8px 20px;border-radius:6px;border:none;background:#555;color:#fff;cursor:pointer;">取消</button>
      <button id="tts-ok" style="padding:8px 20px;border-radius:6px;border:none;background:#5a9;color:#fff;cursor:pointer;">保存</button>
    </div>
  `;
  document.body.appendChild(dlg);
  keepDialogFullyVisible(dlg);
  const close = () => { dlg.remove(); };
  (dlg.querySelector("#tts-c") as HTMLElement).onclick = close;
  (dlg.querySelector("#tts-ok") as HTMLElement).onclick = async () => {
    const k = (dlg.querySelector("#tts-k") as HTMLInputElement).value.trim();
    const s = (dlg.querySelector("#tts-s") as HTMLInputElement).value.trim();
    await invoke("set_tts_key", { apiKey: k }).catch(() => {});
    settings.tts.speakerId = s;
    saveSettings(settings);
    ttsApiKey = k;
    ttsPlayer.setConfig(settings.tts.enabled, k, s, settings.assistant.outputLanguage ?? "");
    close();
    toast("语音设置已保存");
  };
}

/**
 * 语音识别（ASR）设置弹窗。
 *
 * 只有"在线识别"这一条路需要用户提供 Key：Windows 的浏览器原生识别不需要，
 * Mac/Linux（以及原生识别被判定不可用后的 Windows）走 Rust 侧转发硅基流动。
 * Key 交给 Rust 存（DPAPI / 钥匙串 / 600 文件），跟 TTS / 聊天 Key 一个待遇，
 * 前端只在弹窗里读回来做回填。
 */
async function showAsrDialog() {
  document.getElementById("asr-dlg")?.remove();
  const savedKey = await invoke<string>("get_asr_key").catch(() => "");
  const online = getSpeechRecognizer().getBackendName() === "siliconflow";
  const backendLine = online
    ? "在线识别（硅基流动）—— 已内置默认 Key，开箱即用；填自己的会覆盖默认（加密存在本机）。"
    : "浏览器原生识别（Windows）—— 不需要 Key。若原生识别不可用会自动切到在线识别。";
  const inputStyle = "width:100%;padding:8px;border-radius:6px;border:1px solid #555;background:#333;color:#fff;box-sizing:border-box;margin-bottom:18px;outline:none;";
  const dlg = document.createElement("div");
  dlg.id = "asr-dlg";
  dlg.setAttribute("data-petra-interactive", "true");
  dlg.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#2a2a2a;color:#fff;padding:24px;border-radius:12px;z-index:999999;width:340px;box-sizing:border-box;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.6);pointer-events:auto;";
  dlg.innerHTML = `
    <div style="font-weight:bold;font-size:16px;margin-bottom:12px;">语音识别设置</div>
    <div style="color:#999;margin-bottom:14px;line-height:1.6;">${backendLine}</div>
    <div style="color:#999;margin-bottom:4px;">麦克风权限</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <div id="asr-perm-state" style="flex:1;line-height:1.5;"></div>
      <button id="asr-perm-btn" style="padding:6px 14px;border-radius:6px;border:none;background:#5a9;color:#fff;cursor:pointer;white-space:nowrap;"></button>
    </div>
    <div id="asr-perm-note" style="color:#888;font-size:11.5px;line-height:1.5;margin-bottom:16px;"></div>
    <div style="color:#999;margin-bottom:4px;">硅基流动 API Key（留空 = 用内置默认）</div>
    <input id="asr-k" type="password" placeholder="sk-..." value="${savedKey.replace(/"/g, "&quot;")}" style="${inputStyle}">
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button id="asr-c" style="padding:8px 20px;border-radius:6px;border:none;background:#555;color:#fff;cursor:pointer;">取消</button>
      <button id="asr-ok" style="padding:8px 20px;border-radius:6px;border:none;background:#5a9;color:#fff;cursor:pointer;">保存</button>
    </div>
  `;
  document.body.appendChild(dlg);
  keepDialogFullyVisible(dlg);
  const close = () => { dlg.remove(); };

  // ---- 麦克风权限：应用内开关（立即生效）+ 同步 Windows 隐私设置 ----
  const stateEl = dlg.querySelector("#asr-perm-state") as HTMLElement;
  const btnEl = dlg.querySelector("#asr-perm-btn") as HTMLButtonElement;
  const noteEl = dlg.querySelector("#asr-perm-note") as HTMLElement;
  const renderPermission = async () => {
    // 读模块级 settings（而不是 loadSettings() 的副本）：这里和别处的保存
    // 都写同一个对象，避免"改完又被别的 saveSettings(settings) 覆盖回去"
    const allowed = settings.asr.micAllowed;
    const os = await invoke<{ global: string; app: string }>("get_mic_permission").catch(() => null);
    stateEl.innerHTML = allowed
      ? '<span style="color:#6c6;">已开启</span>'
      : '<span style="color:#e08;">已关闭</span><span style="color:#999;">（点 🎤 会直接提示权限已关）</span>';
    btnEl.textContent = allowed ? "关闭麦克风" : "开启麦克风";
    btnEl.style.background = allowed ? "#555" : "#5a9";
    const bits: string[] = [];
    if (os && os.global === "deny") bits.push("⚠ 系统总开关是「拒绝」，语音输入用不了 —— 点「开启麦克风」会一并改回允许");
    if (os && os.app === "deny") bits.push("⚠ Windows 里本应用被设为「拒绝」（开启时会清掉）");
    if (os && os.global === "unsupported") bits.push("当前系统不支持在应用内改权限（macOS 只能在“系统设置 → 隐私与安全性 → 麦克风”里改）");
    bits.push("应用内开关立即生效，同时会同步到 Windows 的麦克风隐私设置（对已经在跑的窗口，系统那一层要重启应用后才算数）");
    noteEl.textContent = bits.join("\n");
    noteEl.style.whiteSpace = "pre-line";
  };
  btnEl.onclick = async () => {
    const next = !settings.asr.micAllowed;
    settings.asr.micAllowed = next; // 先改模块级对象再落盘（否则会被别处的 settings 写回）
    saveSettings(settings);
    if (!next) getSpeechRecognizer().cancel(); // 关掉时顺手停掉正在听的
    let osMsg = "";
    try {
      osMsg = await invoke<string>("set_mic_permission", { allow: next });
    } catch (e) {
      osMsg = `应用内已${next ? "开启" : "关闭"}，但系统权限没改成：${e instanceof Error ? e.message : String(e)}`;
    }
    await renderPermission();
    toast(next ? `麦克风已开启（${osMsg}）` : `麦克风已关闭（${osMsg}）`);
  };
  await renderPermission();

  (dlg.querySelector("#asr-c") as HTMLElement).onclick = close;
  (dlg.querySelector("#asr-ok") as HTMLElement).onclick = async () => {
    const k = (dlg.querySelector("#asr-k") as HTMLInputElement).value.trim();
    try {
      await invoke("set_asr_key", { apiKey: k });
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "warn");
      return;
    }
    close();
    toast(k ? "语音识别 Key 已保存" : "已清除语音识别 Key");
  };
}

/** 歌词同步微调的显示文案：0 就是"正常"，正数=提前 */
function fmtLyricOffset(ms: number): string {
  if (!ms) return "正常";
  return `${ms > 0 ? "提前" : "延后"} ${(Math.abs(ms) / 1000).toFixed(1)}s`;
}

/** 调一次歌词同步（0 = 复位），并把结果告诉用户 —— 静默改数值等于让用户以为没生效 */
function nudgeLyricOffset(deltaMs: number): void {
  const v = adjustLyricOffset(deltaMs);
  toast(deltaMs === 0 ? "歌词同步已复位（本首）" : `歌词同步：${fmtLyricOffset(v)}（本首记住）`);
}

function buildMenu(engine: BehaviorEngine, opts?: { ignoreIdle?: boolean }): MenuItemSpec[] {
  // 待机模式下：菜单只保留"待机模式 开/关"这一条，其余内容一律不显示。
  // 控制面板例外（ignoreIdle）：它是「功能清单」，睡着时也得能把人叫醒之外的项都点得到。
  if (settings.idleMode && !opts?.ignoreIdle) {
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
          // 非 Windows 平台入口改名：这里只剩歌词相关设置（回环跟唱那项在 mac/Linux 不存在）
          id: "audio",
          // 这一行只负责展开（带 submenu 的行点了就是展开，不放开关）；
          // 真正的开关放在子项里，Windows / mac / Linux 行为一致
          label: IS_WINDOWS ? "跟随音乐" : "音乐与歌词",
          submenu: [
            // "跟随音乐"靠 Windows 的系统回环录音（WASAPI）跟节拍/跟唱：
            // mac 没有等价能力（要装 BlackHole 或写 CoreAudio Tap）；
            // Linux 虽然可以用 PipeWire/PulseAudio 的 monitor 源做回环，但本产品在 Linux 上
            // 决定不做（见 src-tauri/src/audio_linux.rs），所以这一项同样只在 Windows 显示。
            // 歌词气泡在 mac/Linux 都可用（mac 走 AppleScript，Linux 走 MPRIS），保留。
            {
              id: "audio-follow",
              label: IS_WINDOWS ? "跟随音乐" : "跟随音乐（未完善）",
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
              id: "lyrics-sync",
              label: "歌词同步微调（本首）",
              state: fmtLyricOffset(getLyricOffsetMs()),
              submenu: [
                {
                  id: "lyrics-sync-earlier",
                  label: "提前 0.3 秒",
                  onPick: () => nudgeLyricOffset(LYRIC_OFFSET_STEP_MS),
                },
                {
                  id: "lyrics-sync-later",
                  label: "延后 0.3 秒",
                  onPick: () => nudgeLyricOffset(-LYRIC_OFFSET_STEP_MS),
                },
                {
                  id: "lyrics-sync-reset",
                  label: "复位（本首）",
                  onPick: () => nudgeLyricOffset(0),
                },
              ],
            },
            // 歌词翻译依赖"另一份译文数据"：Windows 是从网易云拿 tlyric 合并进 LRCLIB 结果的，
            // mac/Linux 上只查 LRCLIB（它没有译文），留着这个开关就是个按了没反应的假开关，所以隐藏。
            ...(IS_WINDOWS
              ? []
              : [
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
                ]),
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
          id: "weather-bubble",
          label: "天气气泡",
          state: settings.weatherBubble ? "开" : "关",
          onPick: () => {
            settings.weatherBubble = !settings.weatherBubble;
            saveSettings(settings);
            // 关掉时把已经弹出来的面板一并收走，否则要等它 5 秒超时
            if (!settings.weatherBubble) hideInfoPanel();
            toast(settings.weatherBubble ? "天气气泡已开启" : "天气气泡已关闭");
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
      id: "tts-toggle",
      label: "🔊 语音输出",
      state: settings.tts.enabled ? "开" : "关",
      onPick: () => {
        settings.tts.enabled = !settings.tts.enabled;
        saveSettings(settings);
        ttsPlayer.setConfig(settings.tts.enabled, ttsApiKey, settings.tts.speakerId, settings.assistant.outputLanguage ?? "");
        toast(settings.tts.enabled ? "语音输出已开启" : "语音输出已关闭");
      },
    },
    {
      id: "tts-config",
      label: "语音设置",
      onPick: async () => {
        const savedKey = await invoke<string>("get_tts_key").catch(() => "");
        showTtsDialog(savedKey);
      },
    },
    {
      id: "tts-test",
      label: "测试语音",
      onPick: () => {
        // 语音输出没开的时候点测试：直接提示，不自动打开、不花钱调API
        if (!settings.tts.enabled) {
          toast("请先开启语音输出再测试", "warn");
          return;
        }
        const lang = settings.assistant.outputLanguage ?? "";
        ttsPlayer.setConfig(true, ttsApiKey, settings.tts.speakerId, lang);
        const testText: Record<string, string> = {
          en: "Hello, voice test successful.",
          ja: "こんにちは、音声テスト成功しました。",
          ko: "안녕하세요, 음성 테스트 성공했습니다.",
          fr: "Bonjour, test vocal réussi.",
          es: "Hola, prueba de voz exitosa.",
          de: "Hallo, Sprachtest erfolgreich.",
          ru: "Привет, тест голоса успешен.",
        };
        ttsPlayer.pushDelta(testText[lang] ?? "你好，语音测试成功。");
        ttsPlayer.flush();
      },
    },
    {
      id: "asr-config",
      label: "🎤 语音识别设置",
      onPick: () => void showAsrDialog(),
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
      id: "website",
      label: "官网",
      onPick: () => void invoke("open_url", { url: "http://petra.xin/" }),
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
      onPick: () => {
        // dev 模式下 app.restart() 会退出但不重新启动，改成刷新页面
        if (import.meta.env.DEV) {
          window.location.reload();
        } else {
          void invoke("restart_app");
        }
      },
    },
    {
      id: "quit",
      label: "退出",
      danger: true,
      onPick: () => void invoke("quit_app"),
    },
  ];
}

/**
 * 右键菜单精简版：只保留 交互 / 语音输出 / 今日抽卡 / 小游戏 / 小助手模式，
 * 其余全部收纳进「设置」独立窗口（openSettingsPanel）。
 * buildMenu(engine) 仍是唯一的全量菜单数据源——设置窗口与右键菜单共用同一份
 * 项定义与 onPick 闭包，保证被转移的功能行为与原来完全一致。
 */
// 抽卡已经有面板原生界面（娱乐 → 抽卡），不再占右键菜单；游戏本体仍在桌宠窗口里跑
const COMPACT_MENU_KEEP = new Set(["interact", "tts-toggle", "minigames", "assistant"]);

function buildCompactMenu(engine: BehaviorEngine): MenuItemSpec[] {
  const all = buildMenu(engine);
  // 待机模式保持原样的迷你菜单（待机开关 + 提示），不受精简影响
  if (settings.idleMode) return all;
  const kept = all.filter((i) => COMPACT_MENU_KEEP.has(i.id));
  return [
    ...kept,
    { id: "sep", separator: true },
    {
      id: "open-control-panel",
      label: "⚙️ 控制面板",
      onPick: () => void openControlPanel(),
    },
  ];
}

/**
 * 设置窗口的「让位」摆法：贴到可见区最下面，并把高度收到可见区 45% 以内。
 * 从设置窗口点开「调整模型边界」这类二级面板时用它 —— 否则设置窗口会盖住角色和绿框，
 * 用户根本看不到自己在调什么。
 */
function dockSettingsBottom(el: HTMLElement): void {
  const vr = getWindowVisibleRect();
  const visH = Math.max(120, vr.bottom - vr.top);
  // 只占可见区约 1/3：下面这条是"让位"，主角是刚打开的二级面板和角色/绿框
  const maxH = Math.max(150, Math.min(300, Math.round(visH * 0.33)));
  // 宽度/横向位置：优先躲到角色旁边较空的一侧（贴底停靠 + 不压角色），
  // 两侧都太窄再退回居中 —— 不然设置窗口总是盖住角色下半身和绿框。
  const mr = getModelRect();
  const gap = 8;
  const spaceRight = vr.right - mr.right - gap * 2;
  const spaceLeft = mr.left - vr.left - gap * 2;
  let w: number;
  let left: number;
  if (spaceRight >= 200 || spaceLeft >= 200) {
    if (spaceRight >= spaceLeft) {
      w = Math.min(320, spaceRight);
      left = vr.right - w - gap;
    } else {
      w = Math.min(320, spaceLeft);
      left = vr.left + gap;
    }
  } else {
    w = Math.min(320, Math.max(200, vr.right - vr.left - gap * 2));
    left = (vr.left + vr.right - w) / 2;
  }
  el.style.maxHeight = `${maxH}px`;
  el.style.width = `${w}px`;
  el.style.left = `${Math.round(left)}px`;
  const h = el.offsetHeight || maxH;
  el.style.top = `${Math.round(Math.max(vr.top + 8, vr.bottom - h - 8))}px`;
  // 停靠后立刻把已经打开的其它面板按"避开设置窗口"重摆一次，
  // 否则它们还停在老位置，会和设置窗口叠在一起（调整模型边界时最明显）
  const r = el.getBoundingClientRect();
  document
    .querySelectorAll<HTMLElement>(".model-panel:not(#settings-window):not(.hidden), #chat-history-panel:not(.hidden)")
    .forEach((other) => positionPanelNearModel(other, r));
}

/** 打开设置窗口的统一入口：右键菜单「⚙️ 设置」与托盘菜单「设置」都走这里 */
function openSettingsWindow(): void {
  openSettingsPanel(() => buildSettingsItems(engine), positionPanelNearModel, dockSettingsBottom);
}

/** 设置窗口内容：全量菜单里除去右键菜单保留项后的全部功能 */
function buildSettingsItems(engine: BehaviorEngine): MenuItemSpec[] {
  return buildMenu(engine).filter((i) => !COMPACT_MENU_KEEP.has(i.id) && !i.separator);
}

// ==================== 控制面板（浏览器） ====================
//
// 设计：**设置的单一事实源仍然是本页面的 `settings` + localStorage**。
// 浏览器面板不自己存一份，它读写的是 Rust 里的一份副本，改动通过事件回到这里应用：
//   打开：panel_prepare（起服务）→ pushPanelState（推当前设置）→ open_url
//   改值：面板 POST /api/settings → Rust 深合并 → emit panel:apply → applyPanelPatch
//   点功能：面板 POST /api/action → emit panel:action → runPanelAction（复用右键菜单 onPick）
// 好处是「面板改的」和「右键菜单改的」永远是同一份内存设置，不会出现两套抽屉。

/** 面板要显示的数据（按需加载：对话记录、日记只在用户点开时读一次） */
let panelChat: { role: string; content: string }[] = [];
let panelDiaries: { date: string; text: string }[] = [];
let panelAssistantModels: string[] = [];
let panelKeys = { assistant: false, tts: false, asr: false };
/** 面板上直接显示出来的 Key 明文（用户明确要求「不怕泄露，贴在控制台上」） */
/**
 * 面板上「可以直接看到明文」的 Key —— **只有 ASR**（用户自己贴过、且要求贴出来）。
 * 小助手 / 语音朗读这类付费 Key 一律不回显：面板只知道"配没配"，连遮罩串都不发。
 */
let panelKeyValues = { asr: "", asrBuiltin: false };
/** 云端识别模型名（面板上显示用） */
let panelAsrModel = "";
/** 面板「试演一句」的结果 */
let panelPersonaTest: { text: string; at: string } | null = null;
/** 面板「识别自检」的结果 */
let panelAsrTest: { text: string; at: string; model: string } | null = null;

/** 把三类 Key 的「有没有」状态同步给面板（只回布尔，绝不把 Key 本身推过去） */
async function refreshPanelKeys(): Promise<void> {
  const [a, t, r] = await Promise.all([
    getApiKey(),
    invoke<string>("get_tts_key").catch(() => ""),
    invoke<boolean>("asr_key_ready").catch(() => false),
  ]);
  panelKeys = { assistant: !!a, tts: !!t, asr: !!r };
  const asrInfo = await invoke<{ key: string; builtin: boolean }>("asr_key_info").catch(() => null);
  panelKeyValues = { asr: asrInfo?.key ?? "", asrBuiltin: !!asrInfo?.builtin };
  panelAsrModel = await invoke<string>("asr_model_name").catch(() => "");
}

/** 面板要显示的模型清单（内置 + 已导入），切换/导入/删除后刷新 */
let panelModels: { builtin: string[]; imported: string[] } = { builtin: [], imported: [] };

/** 从 Rust 重新拉一遍模型清单（内置来自 manifest，已导入来自 models 目录） */
async function refreshPanelModels(): Promise<void> {
  try {
    panelModels.imported = await invoke<string[]>("list_models");
  } catch {
    panelModels.imported = [];
  }
  try {
    const raw = await invoke<string>("read_model_manifest");
    const m = JSON.parse(raw) as { type?: string; files?: string[]; file?: string; active?: string };
    if (m?.type === "psd" && Array.isArray(m.files) && m.files.length) panelModels.builtin = m.files;
    else if (m?.type === "psd" && m.file) panelModels.builtin = [m.file];
    else if (m?.active) panelModels.builtin = [m.active];
    else panelModels.builtin = [];
  } catch {
    panelModels.builtin = [];
  }
}

/** 面板「功能自检」的结果（动作页显示）：只检查每一项能不能在菜单里找到对应的 onPick */
let panelSelfCheck: { at: string; total: number; missing: string[] } | null = null;

/** 面板是否已经开过（没开过就别白推 IPC） */
let panelEverOpened = false;
let panelSyncTimer: number | null = null;
/** 版本号（面板顶栏显示），boot 时填 */
let appVersion = "";

/** 把设置与元数据推给控制面板：面板每次 GET /api/state 读的就是这份 */
async function pushPanelState(): Promise<void> {
  await refreshPanelModels();
  await refreshPanelKeys();
  try {
    await invoke("panel_push_settings", {
      settings: JSON.stringify({ ...loadSettings(), boundsPadding: currentBoundsPadding() }),
      meta: JSON.stringify(buildPanelMeta()),
    });
  } catch (e) {
    console.warn("控制面板：推送设置失败", e);
  }
}

/** 设置变更后延后推送（拖滑条会连发，攒 300ms 只推最后一次） */
function schedulePanelSync(): void {
  if (!panelEverOpened) return;
  if (panelSyncTimer !== null) window.clearTimeout(panelSyncTimer);
  panelSyncTimer = window.setTimeout(() => {
    panelSyncTimer = null;
    void pushPanelState();
  }, 300);
}

/** 面板要渲染的元数据：版本、平台、当前模型、供应商表、语言表、功能清单 */
function buildPanelMeta() {
  return {
    version: appVersion,
    platform: PLATFORM === "win" ? "Windows" : PLATFORM === "mac" ? "macOS" : "Linux",
    model: currentModel.name || currentModel.type,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, model: p.defaultModel })),
    languages: OUTPUT_LANGUAGE_OPTIONS,
    actions: flattenMenuActions(),
    ui: {
      modelBounds: debugModelBoundsVisible,
      debugBorder: debugBorderVisible,
    },
    presets: {
      list: settings.assistant.presets ?? [],
      activeId: settings.assistant.activePresetId ?? "",
      scope: currentKeyScope(),
    },
    models: {
      builtin: panelModels.builtin,
      imported: panelModels.imported,
      current: { type: currentModel.type, name: currentModel.name ?? "" },
    },
    selfcheck: panelSelfCheck,
    data: {
      keys: panelKeys,
      keyValues: panelKeyValues,
      usage: getUsageStats(),
      chat: panelChat,
      diaries: panelDiaries,
      card: getTodayDraw(),
      actionList: listActions(),
      assistantModels: panelAssistantModels,
      personaTest: panelPersonaTest,
      asrModel: panelAsrModel,
      asrTest: panelAsrTest,
    },
    quick: [
      { id: "show-pet", label: "把桌宠叫到前面" },
      { id: "model-bounds-toggle", label: "调整模型边界" },
      { id: "assistant", label: "打开小助手" },
      { id: "daily-card", label: "今日抽卡" },
      { id: "minigames", label: "小游戏" },
      { id: "hide", label: "隐藏桌宠" },
      { id: "restart", label: "重启" },
    ],
  };
}

/**
 * 把右键菜单的树摊平成「分组 → 可点项」。
 * 只收有 onPick 且有文字的叶子：子菜单父行点了没反应，收进去只会让用户以为坏了。
 */
function flattenMenuActions(): { group: string; items: { id: string; label: string }[] }[] {
  if (!engine) return [];
  let all: MenuItemSpec[] = [];
  try {
    // ignoreIdle：睡着时也要给面板「全量清单」，否则清单会少一大半
    all = buildMenu(engine, { ignoreIdle: true });
  } catch (e) {
    console.warn("控制面板：读取菜单失败", e);
    return [];
  }
  const byGroup = new Map<string, { id: string; label: string }[]>();
  const clean = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const walk = (items: MenuItemSpec[], trail: string[]) => {
    for (const it of items) {
      if (it.separator || it.hint) continue;
      if (it.submenu?.length) {
        walk(it.submenu, trail.length ? trail : [clean(it.label ?? it.id)]);
        continue;
      }
      // 「控制面板」自己那一项不列进去：在面板里点它只会再开一个面板标签页。
      // PANEL_NATIVE_IDS 里的功能已经搬到面板原生界面，也不列（否则点了还是弹旧窗口）。
      if (!it.onPick || !it.label || it.id === "open-control-panel" || PANEL_NATIVE_IDS.has(it.id)) continue;
      const group = trail[0] ?? "常用";
      const arr = byGroup.get(group) ?? [];
      if (!arr.some((x) => x.id === it.id)) arr.push({ id: it.id, label: clean(it.label) });
      byGroup.set(group, arr);
    }
  };
  walk(all, []);
  return [...byGroup.entries()].map(([group, items]) => ({ group, items }));
}

/** 深合并补丁到设置对象（对象递归、数组整体替换，与 Rust 侧 deep_merge 同语义） */
function deepAssign(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch ?? {})) {
    const cur = target[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      cur && typeof cur === "object" && !Array.isArray(cur)
    ) {
      deepAssign(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

/**
 * 应用控制面板送来的补丁。
 * 绝大多数设置是「用的时候现读」，改完自动生效；少数需要立刻作用到引擎/播放器上的，
 * 在这里逐条走原来的入口（复用已有函数，避免面板长出一条平行的第二套逻辑）。
 */
async function applyPanelPatch(patch: Record<string, unknown>): Promise<void> {
  const changed = new Set(Object.keys(patch ?? {}));
  if (!changed.size) return;
  settings = loadSettings();
  const previousAssistant = { ...settings.assistant };
  const { boundsPadding, ...otherPatch } = patch;
  deepAssign(settings as unknown as Record<string, unknown>, otherPatch);
  if (boundsPadding && typeof boundsPadding === "object") {
    setCurrentBoundsPadding({ ...currentBoundsPadding(), ...boundsPadding });
  }
  const assistantPatch = patch.assistant as Record<string, unknown> | undefined;
  if (assistantPatch) {
    if (settings.assistant.provider !== previousAssistant.provider ||
        settings.assistant.customBaseUrl !== previousAssistant.customBaseUrl) {
      settings.assistant.activePresetId = "";
      panelAssistantModels = [];
      if (!("model" in assistantPatch)) settings.assistant.model = "";
    }
    if (settings.assistant.provider === "custom") {
      settings.assistant.customBaseUrl = normalizeOpenAIBase(settings.assistant.customBaseUrl);
    }
    const active = settings.assistant.presets.find(p => p.id === settings.assistant.activePresetId);
    if (active) active.model = settings.assistant.model;
    clearPetTalkKeyCache();
  }
  if (changed.has("weatherCity")) cachedWeather = null;
  if (changed.has("weatherBubble") && !settings.weatherBubble) hideInfoPanel();
  // 留一条日志：面板改了什么一眼能在 pet.log 里查到（用户报「面板改了没反应」时靠它定位）
  void invoke("debug_mark", { msg: `[panel] 应用补丁：${[...changed].join(", ")}` }).catch(() => {});
  saveSettingsRaw(settings); // 只落盘；末尾统一回推一次，别在这里触发防抖循环
  if (changed.has("modelScale")) await applyModelScale(settings.modelScale);
  if (changed.has("activity")) engine?.setActivityLevel(settings.activity);
  if (changed.has("mouseTrack")) {
    engine?.setTracking(settings.mouseTrack);
    void invoke("set_pet_tracking", { enabled: settings.mouseTrack }).catch(() => {});
  }
  if (changed.has("idleMode")) await applyIdleState();
  if (changed.has("audioEnabled")) {
    void invoke("set_audio_enabled", { enabled: settings.audioEnabled }).catch(() => {});
  }
  if (
    changed.has("hourlyChime") || changed.has("hourlyChimeQuiet") ||
    changed.has("hourlyQuietStart") || changed.has("hourlyQuietEnd")
  ) {
    applyHourlyChime();
  }
  if (changed.has("musicLyrics")) {
    if (settings.musicLyrics) startMusicLyrics();
    else stopMusicLyrics();
  }
  if (changed.has("lyricsTranslate")) setLyricsTranslate(settings.lyricsTranslate);
  if (
    changed.has("gameSound") || changed.has("gameMusic") ||
    changed.has("gameSoundVolume") || changed.has("gameMusicVolume")
  ) {
    // 麻将音效模块自己监听这个事件重新读设置（它不 import settings，避免循环依赖）
    window.dispatchEvent(new Event(RIICHI_SOUND_SETTINGS_EVENT));
  }
  if (changed.has("asr")) {
    // 只写设置不够：Windows 的麦克风隐私开关得由 Rust 侧一起改，否则录音还是会被系统拦
    const allow = !!settings.asr.micAllowed;
    void invoke("set_mic_permission", { allow })
      .then((msg) => toast(`麦克风${allow ? "已开启" : "已关闭"}（${msg}）`))
      .catch(() => {});
  }
  if (changed.has("tts")) {
    ttsPlayer.setConfig(settings.tts.enabled, ttsApiKey, settings.tts.speakerId, settings.assistant.outputLanguage ?? "");
  }
  if (changed.has("assistant")) clearApiKeyCache();
  // 人设页改的是结构化字段，这里统一拼成最终文本写回 persona —— 对话/日记/抽卡/麻将都读它
  const aPatch0 = (patch as { assistant?: Record<string, unknown> }).assistant;
  if (aPatch0 && ("personaFields" in aPatch0 || "personaFree" in aPatch0)) {
    settings.assistant.persona = composePersona(settings.assistant);
    saveSettingsRaw(settings);
  }
  // 快捷键在面板里手改的，也要真的跟系统重新注册一次（否则只有写进设置、按了没反应）
  const aPatch = (patch as { assistant?: Record<string, unknown> }).assistant;
  if (aPatch && "shortcut" in aPatch) {
    const acc = (settings.assistant.shortcut ?? "").trim();
    if (acc) {
      void registerAssistantHotkey(acc).then((ok) => {
        if (!ok) toast(`快捷键 ${acc} 注册失败，换个组合试试`, "warn");
      });
    } else {
      void invoke("unregister_assistant_shortcut").catch(() => {});
    }
  }
  // 桌宠这边也要有反馈：面板在浏览器里，用户看的是这块屏幕上的变化，
  // 所以把它改了什么直接说出来，别让人对着浏览器猜「到底生效没有」。
  const names = [...changed].map((k) => PANEL_FIELD_LABELS[k] ?? k);
  const brief = names.slice(0, 3).join("、") + (names.length > 3 ? " 等" : "");
  // 拖滑条会连续来很多条补丁，1.2 秒内只弹第一条，否则桌子上一串 toast 打架
  const nowMs = Date.now();
  if (nowMs - lastPanelToastAt > 1200) {
    lastPanelToastAt = nowMs;
    toast(`控制面板已生效：${brief}`);
  }
  schedulePanelSync();
}

/** 上一次因为控制面板弹提示的时间（拖滑条时用来节流） */
let lastPanelToastAt = 0;

/**
 * 这些功能在控制面板里有原生界面了 —— 不要再作为「动作」列出来，
 * 点了只会又弹一个旧的桌宠侧窗口，正是要被取代掉的那套。
 */
const PANEL_NATIVE_IDS = new Set([
  "models", "size", "bounds", "border", "model-bounds-toggle",
  "tts-config", "asr-config", "chat-history",
  "feedback", "diary-open", "diary-track", "daily-card", "action-debug",
  "assistant-hotkey", "assistant-hotkey-clear", "assistant-settings",
]);

/** 设置键 → 面板上的中文名，只用于「桌宠这边弹一句它改了什么」 */
const PANEL_FIELD_LABELS: Record<string, string> = {
  modelScale: "模型大小", boundsPadding: "边界补偿", activity: "活动频率", mouseTrack: "跟随鼠标",
  idleMode: "待机模式", weatherBubble: "信息面板", weatherCity: "天气城市",
  hourlyChime: "整点播报", hourlyChimeQuiet: "夜间免打扰", hourlyQuietStart: "免打扰开始",
  hourlyQuietEnd: "免打扰结束", audioEnabled: "声音总开关", gameSound: "游戏音效",
  gameSoundVolume: "音效音量", gameMusic: "麻将对局音乐", gameMusicVolume: "音乐音量",
  assistant: "小助手", diary: "日记", dailyCard: "抽卡", musicLyrics: "歌词气泡",
  lyricsTranslate: "歌词翻译", gameTalk: "麻将实时互动", tts: "语音朗读", asr: "语音识别",
  allowAllShell: "免确认命令", allowAllFileWrite: "免确认写文件", fileDenyPaths: "禁止目录",
};

/**
 * 把桌宠叫到眼前：显示窗口 → 置顶 → 如果它几乎整块跑出了工作区就挪回来。
 *
 * 为什么要挪：待机/漫游会让窗口一半挂在屏外（这套设计本来允许「部分出屏」），
 * 而控制面板是「看着它调」的 —— 用户一打开面板却只看到半个身子，等于没法用。
 * 待机模式下不动位置：那是它自己要睡在边上，硬拽回来会和引擎打架。
 */
async function ensurePetVisible(): Promise<void> {
  try {
    await invoke("show_pet");
    await invoke("set_topmost", { on: true });
    if (settings.idleMode) return;
    const win = getCurrentWindow();
    const pos = await win.outerPosition(); // 物理像素
    const size = await win.outerSize();
    const area = await invoke<{ left: number; top: number; width: number; height: number }>(
      "work_area_at",
      { x: pos.x + Math.round(size.width / 2), y: pos.y + Math.round(size.height / 2) },
    );
    const overlapW = Math.min(pos.x + size.width, area.left + area.width) - Math.max(pos.x, area.left);
    const overlapH = Math.min(pos.y + size.height, area.top + area.height) - Math.max(pos.y, area.top);
    const visible =
      overlapW > 0 && overlapH > 0 ? (overlapW * overlapH) / (size.width * size.height) : 0;
    if (visible < 0.35) {
      const nx = Math.round(Math.min(Math.max(pos.x, area.left), area.left + area.width - size.width));
      const ny = Math.round(Math.min(Math.max(pos.y, area.top), area.top + area.height - size.height));
      await win.setPosition(new PhysicalPosition(nx, ny));
      engine?.setPos(nx / scaleFactor, ny / scaleFactor);
      savePetPosition(nx / scaleFactor, ny / scaleFactor);
      toast("你把我跳出屏幕了，我挪回来啦");
    }
  } catch (e) {
    console.warn("把桌宠叫到前面失败", e);
  }
}

/** 面板填的 Key：只在本地 IPC 里传，Rust 侧加密存（DPAPI / Keychain），面板永远不会读回明文 */
async function handlePanelKeyAction(kind: string, payload: unknown): Promise<void> {
  const value = String((payload as { value?: unknown })?.value ?? "").trim();
  try {
    if (kind === "assistant") {
      await setApiKey(value);
      clearPetTalkKeyCache();
      clearApiKeyCache();
      toast(value ? "小助手 API Key 已保存" : "已清空小助手 API Key");
    } else if (kind === "tts") {
      await invoke("set_tts_key", { apiKey: value });
      ttsApiKey = value;
      ttsPlayer.setConfig(settings.tts.enabled, value, settings.tts.speakerId, settings.assistant.outputLanguage ?? "");
      toast(value ? "语音朗读 Key 已保存" : "已清空朗读 Key");
    } else if (kind === "asr") {
      await invoke("set_asr_key", { apiKey: value });
      toast(value ? "语音识别 Key 已保存" : "已清空识别 Key");
    }
  } catch (e) {
    toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "warn");
  }
  await pushPanelState();
}

/**
 * 面板上的「预设」操作。
 *
 * 数据模型与旧设置窗口完全一致：`settings.assistant.presets[]` 只存
 * id/name/provider/baseUrl/model，**Key 不进 settings**，每个预设单独存
 * `preset:<id>` 槽位（DPAPI/Keychain）。这里只是换一个入口，规则不能变：
 * 手动改供应商会清 activePresetId、删预设要顺手删掉它的 Key 槽位。
 */
async function handlePanelPresetAction(kind: string, payload: unknown): Promise<void> {
  const a = settings.assistant;
  const list = (a.presets ??= []);
  const sep = kind.indexOf(":");
  const action = sep < 0 ? kind : kind.slice(0, sep);
  const arg = sep < 0 ? "" : kind.slice(sep + 1);
  try {
    if (action === "apply") {
      const p = list.find((x) => x.id === arg);
      if (!p) return void toast("预设不见了，刷新一下", "warn");
      a.activePresetId = p.id;
      a.provider = p.provider;
      a.customBaseUrl = p.customBaseUrl;
      a.model = p.model;
      saveSettings(settings);
      clearApiKeyCache();
      clearPetTalkKeyCache();
      toast(`已应用预设「${p.name}」`);
    } else if (action === "save") {
      const name = String((payload as { name?: string })?.name ?? "").trim() || `预设 ${list.length + 1}`;
      const id = `p${Date.now().toString(36)}`;
      // 先把当前生效的 Key 复制进新槽位，再切作用域，否则「存成预设」后 Key 就丢了
      const currentKey = await getApiKey(currentKeyScope()).catch(() => "");
      list.push({ id, name, provider: a.provider, customBaseUrl: a.customBaseUrl, model: a.model });
      a.activePresetId = id;
      saveSettings(settings);
      if (currentKey) await setApiKey(currentKey, presetKeyScope(id)).catch(() => {});
      toast(`已保存为预设「${name}」`);
    } else if (action === "rename") {
      const p = list.find((x) => x.id === arg);
      const name = String((payload as { name?: string })?.name ?? "").trim();
      if (!p || !name) return void toast("名字不能为空", "warn");
      p.name = name;
      saveSettings(settings);
      toast("已重命名");
    } else if (action === "delete") {
      const p = list.find((x) => x.id === arg);
      if (!p) return;
      a.presets = list.filter((x) => x.id !== arg);
      if (a.activePresetId === arg) a.activePresetId = "";
      saveSettings(settings);
      await setApiKey("", presetKeyScope(arg)).catch(() => {});
      toast(`已删除预设「${p.name}」`);
    }
  } catch (e) {
    toast(`预设操作失败：${e instanceof Error ? e.message : String(e)}`, "warn");
  }
  await pushPanelState();
}

/** 面板要的数据（对话记录 / 日记 / 抽卡 / 播放动作 / 反馈 / 快捷键 / 拉模型列表） */
async function handlePanelDataAction(kind: string, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>;
  try {
    switch (kind) {
      case "usage-reset":
        resetUsageStats();
        toast("用量统计已清零");
        break;
      case "chat-load": {
        const raw = await invoke<string>("load_chat_history").catch(() => "");
        const arr = JSON.parse(raw || "[]") as { role?: string; content?: string }[];
        panelChat = arr
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
          .map((m) => ({
            role: m.role as string,
            content: String(m.content).split("\n---\n")[0].slice(0, 800),
          }))
          .filter((m) => !m.content.startsWith("[主动问候]") && !m.content.startsWith("[主动学习]"))
          .slice(-30);
        toast(`已读取 ${panelChat.length} 条对话`);
        break;
      }
      case "chat-clear":
        clearHistory();
        panelChat = [];
        toast("对话记录已清空");
        break;
      case "card-draw": {
        const r = await dailyDraw();
        toast(`今日抽到：${r?.card?.theme ?? r?.card?.id ?? "?"}`);
        break;
      }
      case "diary-load":
        panelDiaries = loadDiaries().map((d) => ({ date: d.date, text: String(d.content ?? "").slice(0, 1500) }));
        toast(`已读取 ${panelDiaries.length} 篇日记`);
        break;
      case "feedback-send": {
        const msg = String(p.text ?? "").trim();
        if (!msg) {
          toast("先写点什么再发", "warn");
          return;
        }
        const res = await invoke<string>("send_feedback", { message: msg });
        toast(res);
        break;
      }
      case "action-play": {
        const aid = String(p.id ?? "");
        if (aid) {
          view.playAction(aid, true);
          toast("播放动作：" + aid);
        }
        break;
      }
      case "hotkey-set": {
        const acc = String(p.value ?? "").trim();
        settings.assistant.shortcut = acc;
        saveSettings(settings);
        if (acc) {
          const ok = await registerAssistantHotkey(acc);
          toast(ok ? `呼出快捷键已设为 ${acc}` : `快捷键 ${acc} 注册失败，换一个试试`, ok ? "info" : "warn");
        } else {
          await invoke("unregister_assistant_shortcut").catch(() => {});
          toast("已清除呼出快捷键");
        }
        break;
      }
      case "persona-test": {
        const apiKey = await getApiKey();
        const persona = composePersona(settings.assistant);
        if (!persona.trim()) {
          toast("人设还是空的，先填两句再试", "warn");
          return;
        }
        if (!apiKey && settings.assistant.provider !== "ollama") {
          toast("还没配 API Key，没法试演", "warn");
          return;
        }
        toast("正在用它的人设试演一句…");
        const res = await chatStream(
          settings.assistant.provider,
          apiKey,
          settings.assistant.model,
          [{ role: "user", content: "（试演）用你现在的设定跟我打一句招呼，不超过 20 字，别解释。" }],
          persona,
          [],
          settings.assistant.customBaseUrl,
          () => {},
          false,
        );
        panelPersonaTest = { text: res.text.trim(), at: new Date().toLocaleTimeString("zh-CN", { hour12: false }) };
        toast("试演完成");
        break;
      }
      case "asr-probe": {
        const audio = String(p.audio ?? "");
        if (!audio) { toast("没有收到音频", "warn"); return; }
        toast("正在识别…");
        const text = await invoke<string>("asr_transcribe", { audio });
        panelAsrTest = {
          text: text || "（识别结果为空）",
          at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          model: panelAsrModel,
        };
        toast("识别完成");
        break;
      }
      case "models-fetch": {
        const key = await getApiKey();
        panelAssistantModels = await listModels(
          settings.assistant.provider,
          key,
          settings.assistant.customBaseUrl,
        );
        toast(`拿到 ${panelAssistantModels.length} 个模型`);
        break;
      }
      default:
        toast(`未实现的面板动作：${kind}`, "warn");
        return;
    }
  } catch (e) {
    console.error("控制面板：数据动作失败", e);
    toast(`操作失败：${e instanceof Error ? e.message : String(e)}`, "warn");
  }
  await pushPanelState();
}

/** 面板上的模型操作：切内置 / 切已导入 / 删已导入 */
async function handlePanelModelAction(id: string): Promise<void> {
  if (id === "__model:adjust") {
    toggleModelAdjustPanel();
    return;
  }
  const rest = id.slice("__model:".length);
  const sep = rest.indexOf(":");
  const kind = sep < 0 ? rest : rest.slice(0, sep);
  const file = sep < 0 ? "" : rest.slice(sep + 1);
  void invoke("debug_mark", { msg: `[panel] 模型操作：${kind} ${file}` }).catch(() => {});
  if (!file) return;
  try {
    if (kind === "builtin") {
      const changed = !(currentModel.type === "manifest" && currentModel.name === file);
      localStorage.setItem(BUILTIN_KEY, file);
      localStorage.removeItem(PSD_KEY);
      if (changed) resetBoundsOnModelSwitch();
      await reloadView();
      toast(`已切换到内置模型 ${file.replace(/\.psd$/i, "")}`);
    } else if (kind === "imported") {
      const changed = !(currentModel.type === "import" && currentModel.name === file);
      localStorage.setItem(PSD_KEY, file);
      if (changed) resetBoundsOnModelSwitch();
      await reloadView();
      toast(`已切换到 ${file.replace(/\.psd$/i, "")}`);
    } else if (kind === "delete") {
      if (currentModel.type === "import" && currentModel.name === file) {
        // 正在用的模型不能直接删：先退回内置，再删文件（与内置面板同一套顺序）
        const fallback = panelModels.builtin[0];
        if (fallback) {
          localStorage.setItem(BUILTIN_KEY, fallback);
          localStorage.removeItem(PSD_KEY);
          resetBoundsOnModelSwitch();
          await reloadView();
        }
      }
      await invoke("delete_imported_model", { name: file });
      toast(`已删除模型 ${file.replace(/\.psd$/i, "")}`);
    }
  } catch (e) {
    console.error("控制面板：模型操作失败", e);
    toast(`操作失败：${e instanceof Error ? e.message : String(e)}`, "warn");
  }
  await pushPanelState();
}

/** 控制面板里点了一个功能按钮：找到右键菜单里同一个 id 并执行 */
function runPanelAction(id: string, payload?: unknown): void {
  if (!engine || !id) return;
  // 面板里「填表提交」类动作：把值带回桌宠这边执行（Key 只在本地进程间传，不经网络）
  if (id.startsWith("__key:")) {
    void handlePanelKeyAction(id.slice(6), payload);
    return;
  }
  if (id.startsWith("__data:")) {
    void handlePanelDataAction(id.slice(7), payload);
    return;
  }
  // 预设（API 配置集合）：与旧设置窗口同一套数据模型，Key 各存 preset:<id> 槽位
  if (id.startsWith("__preset:")) {
    void handlePanelPresetAction(id.slice("__preset:".length), payload);
    return;
  }
  // 「把桌宠叫到前面」不是菜单项，是面板自己的入口：被隐藏/被窗口压住时用
  if (id === "show-pet") {
    void invoke("debug_mark", { msg: "[panel] 把桌宠叫到前面" }).catch(() => {});
    void ensurePetVisible().then(() => toast("我在这儿～"));
    return;
  }
  // 「检查全部功能」：只做「能不能在菜单里找到并执行」的静态核对，不真的点下去，
  // 免得自检本身把设置改了。这就是用户要的那句「和原来的设置一样能用」的可验证版本。
  if (id === "__selfcheck") {
    let all: MenuItemSpec[] = [];
    try {
      all = buildMenu(engine, { ignoreIdle: true });
    } catch (e) {
      console.warn("控制面板：自检读取菜单失败", e);
    }
    const ids = new Set<string>();
    const walkIds = (items: MenuItemSpec[]) => {
      for (const it of items) {
        if (it.submenu?.length) walkIds(it.submenu);
        else if (it.onPick && it.label) ids.add(it.id);
      }
    };
    walkIds(all);
    const missing = flattenMenuActions()
      .flatMap((g) => g.items)
      .map((it) => it.id)
      .filter((x) => !ids.has(x) && x !== "show-pet");
    panelSelfCheck = {
      at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      total: ids.size,
      missing: [...new Set(missing)],
    };
    void invoke("debug_mark", {
      msg: `[panel] 功能自检：菜单项 ${ids.size} 条，缺失 ${panelSelfCheck.missing.length} 条 ${missing.join(",")}`,
    }).catch(() => {});
    toast(
      panelSelfCheck.missing.length
        ? `自检完成：${panelSelfCheck.missing.length} 项对不上（${panelSelfCheck.missing.join("、")}）`
        : `自检完成：${panelSelfCheck.total} 项功能全部可用`,
      panelSelfCheck.missing.length ? "warn" : "info",
    );
    void pushPanelState();
    return;
  }
  // 模型相关不是菜单项（菜单里是「模型设置」那个面板），面板要能直接切/删，
  // 所以这里约定一组伪 id：__model:builtin:<文件> / __model:imported:<文件> / __model:delete:<文件>
  if (id.startsWith("__model:")) {
    void handlePanelModelAction(id);
    return;
  }
  void invoke("debug_mark", { msg: `[panel] 点功能：${id}` }).catch(() => {});
  let found: MenuItemSpec | null = null;
  const walk = (items: MenuItemSpec[]) => {
    for (const it of items) {
      if (found) return;
      if (it.id === id && it.onPick) {
        found = it;
        return;
      }
      if (it.submenu?.length) walk(it.submenu);
    }
  };
  try {
    // 同样用 ignoreIdle 的全量菜单：待机时也能从面板里点「待机模式」把自己叫醒
    walk(buildMenu(engine, { ignoreIdle: true }));
  } catch (e) {
    console.warn("控制面板：执行功能失败", e);
  }
  if (!found) {
    void invoke("debug_mark", { msg: `[panel] 未找到功能：${id}` }).catch(() => {});
    toast(`没找到这个功能：${id}`, "warn");
    return;
  }
  try {
    (found as MenuItemSpec).onPick?.();
    schedulePanelSync();
  } catch (e) {
    console.error(e);
    toast("功能执行失败", "warn");
  }
}

/** 右键菜单与托盘的统一入口：起服务 → 推设置 → 用默认浏览器打开 */
async function openControlPanel(): Promise<void> {
  try {
    const url = await invoke<string>("panel_prepare");
    await pushPanelState();
    panelEverOpened = true;
    await invoke("open_url", { url });
    // 面板是用来「看着桌宠调它」的：先确保它没被隐藏、也没被浏览器压住。
    // 这一步失败不该影响打开面板本身，所以单独 try。
    await ensurePetVisible();
    toast("控制面板已在浏览器打开，我在屏幕上，改完立刻能看到");
  } catch (e) {
    console.warn("控制面板：启动失败", e);
    toast("控制面板打不开，先用内置设置窗口", "warn");
    openSettingsWindow();
  }
}

void getVersion()
  .then((v) => {
    appVersion = v;
    schedulePanelSync();
  })
  .catch(() => {});


async function toggleIdle() {
  settings.idleMode = !settings.idleMode;
  await applyIdleState();
}

/**
 * 把 settings.idleMode 的当前值真正执行到引擎上（进入/退出待机）。
 * 从 toggleIdle 里拆出来是因为控制面板也会改 idleMode —— 两条入口必须走同一套逻辑。
 */
async function applyIdleState() {
  saveSettings(settings);
  if (settings.idleMode) {
    // 进入待机：收起所有打开的窗口/面板/对话框，待机期间一律不显示
    closeAssistant();
    clearBubbles();
    infoPanelEl?.classList.add("hidden");
    // 关闭所有面板类元素：模型面板/卡牌/日记/大小/边界/调节等
    document.querySelectorAll(".model-panel:not(.hidden)").forEach(el => el.classList.add("hidden"));
    // 关闭独立面板：小助手设置/对话记录/反馈/动作调试/TTS设置/设置窗口
    document.getElementById("assistant-settings")?.classList.add("hidden");
    closeSettingsPanel();
    document.getElementById("chat-history-panel")?.classList.add("hidden");
    document.getElementById("feedback-panel")?.classList.add("hidden");
    document.getElementById("action-debug")?.classList.add("hidden");
    document.getElementById("tts-dlg")?.remove();
    // 关闭右键菜单
    document.getElementById("menu")?.classList.add("hidden");
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
/** 模型调节面板里「手臂轴心」控件的卸载函数（面板重建/关闭时必须调用） */
let axisControlsCleanup: (() => void) | null = null;

function toggleModelAdjustPanel() {
  const panel = document.getElementById("model-adjust-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    axisControlsCleanup?.();
    axisControlsCleanup = null;
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
    axisControlsCleanup?.();
    axisControlsCleanup = null;
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
      axisControlsCleanup?.();
      axisControlsCleanup = null;
    });
    btns.append(resetBtn, backBtn);
    p.appendChild(btns);

    // 手臂轴心（测试）：点模型上的方框设轴、滑杆实时预览（见 HandAxisPicker.ts）
    if (view instanceof Rigged2DView) {
      axisControlsCleanup = mountHandAxisControls(p, view);
    }
  };

  render();
  p.classList.remove("hidden");
  positionPanelNearModel(p);
}

// ---------- 日记素材采样 ----------
/** 每 5 分钟采样一次前台应用；人离开（空闲 > 5 分钟）时不记，桌宠自己的窗口也不记 */
function startActivitySampling(): void {
  const SAMPLE_MINUTES = 5;
  const sample = async () => {
    try {
      const idle = await invoke<number>("get_idle_seconds");
      if (idle > 300) return;
      const title = await invoke<string>("active_window_title");
      // 桌宠窗口置顶，用户点它时它就是前台 —— 那不是"主人用了什么软件"，别记进日记
      if (isOwnWindow(title)) return;
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
/** 淡出后补 hidden 的定时器（必须可取消，否则会把刚重新弹出的面板又藏起来） */
let infoPanelFadeTimer: ReturnType<typeof setTimeout> | null = null;
let cachedWeather: { text: string; time: number } | null = null;

// 天气解析与展示见 src/features/weather/WeatherFormat.ts（纯函数，有单测）

async function showInfoPanel() {
  // 「交互 → 天气气泡」关掉后，这个面板一律不弹（含天气、待办、陪伴时间）
  if (!settings.weatherBubble) return;
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
  // 先限制尺寸，再按真实可用空间定位。
  positionInfoPanelNearModel(el, mr, vr);

  // 取消上一次淡出尚未执行的「补 hidden」，否则它会在 300ms 后把刚显示的面板又藏起来
  if (infoPanelFadeTimer) {
    clearTimeout(infoPanelFadeTimer);
    infoPanelFadeTimer = null;
  }
  el.classList.remove("hidden");
  el.style.opacity = "1";
  // 进入动画（从下方滑入）
  el.style.transform = "translateY(12px)";
  requestAnimationFrame(() => { el.style.transform = "translateY(0)"; });

  // 5 秒自动消失；region collector 会自动移除信息版区域。
  if (infoPanelHideTimer) clearTimeout(infoPanelHideTimer);
  infoPanelHideTimer = setTimeout(hideInfoPanel, 5000);
}

/** 收起信息板（天气气泡）。自动超时和右上角的 ✕ 都走这里。 */
function hideInfoPanel() {
  const el = infoPanelEl;
  if (!el) return;
  if (infoPanelHideTimer) {
    clearTimeout(infoPanelHideTimer);
    infoPanelHideTimer = null;
  }
  el.style.opacity = "0";
  el.style.transform = "translateY(8px)";
  // 这个延时必须存起来：以前是匿名 setTimeout，showInfoPanel 只清了 5 秒那个定时器，
  // 于是在「✕ 关闭 / 自动淡出」后 300ms 内再点桌宠 —— 面板刚 remove("hidden") 又被
  // 这个旧定时器加回 hidden，表现为"点了一下没弹出信息板，得再点一次"。
  if (infoPanelFadeTimer) clearTimeout(infoPanelFadeTimer);
  infoPanelFadeTimer = setTimeout(() => {
    infoPanelFadeTimer = null;
    el.classList.add("hidden");
  }, 300);
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
    <button class="info-panel-close" data-petra-interactive="true" title="关闭">✕</button>
    <div class="info-panel-weather">${weather}</div>
    <div class="info-panel-companion">💖 陪伴时间：${companion}</div>
    <div class="info-panel-rm-title">待办事项 <button class="info-rm-add">＋ 添加</button></div>
    ${rmHtml}
  `;

  // 关闭按钮：面板每次更新都会整块重渲染，所以监听必须在这里重新绑
  el.querySelector(".info-panel-close")?.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    hideInfoPanel();
  });

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
  // 天气异步返回或待办变化后，内容高度会改变，需重新测量布局。
  if (!el.classList.contains("hidden")) {
    positionInfoPanelNearModel(el, getModelRect(), getWindowVisibleRect());
  }
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
      /** 打开手臂轴心拾取器（DEV） */
      axisPicker?: () => void;
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
  // 轴心拾取器（仅 DEV：菜单「手臂轴心（调试）」或 window.__pet.axisPicker()）
  ...(import.meta.env.DEV
    ? {
        axisPicker: () => {
          const p = document.getElementById("model-adjust-panel");
          if (!p || p.classList.contains("hidden")) toggleModelAdjustPanel();
        },
      }
    : {}),
  setPos: async (x: number, y: number) => {
    await getCurrentWindow().setPosition(new LogicalPosition(x, y));
    engine.setPos(x, y);
  },
};

// ---------- 调整模型边界面板 ----------
let boundsPanelOpen = false;
let boundsPanelWasShowing = false;
/**
 * 关闭边界面板，并**恢复打开前的绿框状态**。
 * 绿框是"打开面板时自动显示"的，所以关闭时必须收回去 ——
 * 之前只有菜单开关那条路会恢复，「完成」按钮直接 hidden 就把绿框留在屏幕上了。
 */
function closeBoundsPanel() {
  const panel = document.getElementById("bounds-panel") as HTMLElement | null;
  if (!panel) return;
  panel.classList.add("hidden");
  boundsPanelOpen = false;
  if (!boundsPanelWasShowing && debugModelBoundsVisible) {
    toggleModelBounds();
  }
}

function toggleBoundsPanel() {
  const panel = document.getElementById("bounds-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    closeBoundsPanel();
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
      slider.value = String(currentBoundsPadding()[key]);
      slider.className = "as-input";
      slider.style.flex = "1";
      slider.style.minWidth = "0";
      const val = document.createElement("span");
      val.className = "as-set-label";
      val.style.minWidth = "38px";
      val.style.textAlign = "right";
      val.textContent = currentBoundsPadding()[key] + "px";
      slider.addEventListener("input", () => {
        const v = parseInt(slider.value, 10);
        // 按模型存：以前写全局 settings.boundsPadding，模型 A 调好的偏移会带到模型 B 上
        const pad = { ...currentBoundsPadding(), [key]: v };
        val.textContent = v + "px";
        setCurrentBoundsPadding(pad);
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
      setCurrentBoundsPadding({ ...ZERO_PADDING });
      closeBoundsPanel();
    });
    const done = document.createElement("button");
    done.className = "as-btn as-btn-primary";
    done.textContent = "完成";
    done.addEventListener("click", () => {
      closeBoundsPanel();
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
async function toggleChatHistory() {
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

  // 从后端读历史，只显示最近10条
  let msgs: {role: string; content: string}[] = [];
  try {
    const raw = await invoke<string>("load_chat_history").catch(() => "");
    const arr = JSON.parse(raw || "[]");
    msgs = arr
      .filter((m: any) => {
        if (m.role !== "user" && m.role !== "assistant") return false;
        if (!m.content) return false;
        const c = String(m.content);
        if (c.startsWith("[主动问候]")) return false;
        if (c.startsWith("[主动学习]")) return false;
        return true;
      })
      .map((m: any) => ({ role: m.role, content: String(m.content).split("\n---\n")[0].slice(0, 500) }))
      .slice(-10);
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
  closeBtn.addEventListener("click", () => { panel.remove(); repositionLyricBubble(); repositionAssistantBubbles(); });
  btns.appendChild(closeBtn);
  panel.appendChild(btns);

  document.body.appendChild(panel);
  positionPanelNearModel(panel);
  // 对话记录面板打开后，让歌词/对话气泡贴到面板下方，不遮挡面板内容
  repositionLyricBubble();
  repositionAssistantBubbles();
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
        repositionLyricBubble();
        repositionAssistantBubbles();
      }
    };
    document.addEventListener("pointerdown", close);
  }, 50);
}


// ---------- 小助手设置面板 ----------
/**
 * 当前设置面板里的 Key 输入框。
 *
 * Key 默认是 password 类型，用户点「👁」才临时显示；关闭面板/保存后必须恢复隐藏，
 * 否则明文会留在 DOM 里（下次打开、切供应商、截屏都可能被看到）。
 */
let assistantKeyInput: HTMLInputElement | null = null;

function maskAssistantKey() {
  if (assistantKeyInput) {
    assistantKeyInput.type = "password";
    const eye = assistantKeyInput.parentElement?.querySelector("button");
    if (eye) {
      eye.textContent = "👁";
      eye.title = "临时显示 API Key";
    }
  }
}

async function toggleAssistantSettings() {
  const panel = document.getElementById("assistant-settings") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    maskAssistantKey();
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
      // 测试分支：长控件（API Key 输入框 / 端点 URL / 模型名）的行改成上下排布，
      // 标签在上、控件铺满整行 —— 原来左右排布时标签固定 64px，会把输入框挤得很窄。
      //
      // 但**开关类**（复选框）不参与纵向：它只有 38px 宽，纵向会把一个孤零零的小开关
      // 甩到标签下一行，看起来像"设置项丢了"。开关行保持「标签在左、开关靠右」。
      const isToggle = el instanceof HTMLInputElement && el.type === "checkbox";
      row.className = isToggle ? "as-set-row as-set-row--toggle" : "as-set-row is-stacked";
      const l = document.createElement("span");
      l.className = "as-set-label";
      l.textContent = label;
      row.append(l, el);
      host.appendChild(row);
      return row;
    };

    /** 功能分组的长横线（纯装饰，不参与交互） */
    const sep = () => {
      const hr = document.createElement("div");
      hr.className = "as-sep";
      host.appendChild(hr);
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
    key.autocomplete = "off";
    key.spellcheck = false;
    // Key 默认隐藏；「👁」临时显示，再次点击 / 关闭面板 / 切换供应商或预设时自动恢复隐藏。
    // 参考酒馆的做法：不给键盘/录屏留一个长期明文。
    const keyWrap = document.createElement("div");
    keyWrap.style.cssText = "display:flex;gap:6px;flex:1;align-items:center;min-width:0;";
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "as-btn";
    eye.textContent = "👁";
    eye.title = "临时显示 API Key";
    eye.setAttribute("aria-label", "临时显示 API Key");
    keyWrap.append(key, eye);
    assistantKeyInput = key;
    const maskKey = () => {
      key.type = "password";
      eye.textContent = "👁";
      eye.title = "临时显示 API Key";
    };
    eye.addEventListener("click", () => {
      const showing = key.type === "text";
      key.type = showing ? "password" : "text";
      eye.textContent = showing ? "👁" : "🙈";
      eye.title = showing ? "临时显示 API Key" : "点击隐藏 API Key";
    });
    mkRow("API Key", keyWrap);
    toggleBaseUrl(); // set initial placeholder
    // API Key 按供应商 / 预设分槽存（Rust 侧加密），打开面板时回填当前那一份。
    // **必须显式传 provider.value**：无参 getApiKey() 读的是已保存的 settings.assistant.provider，
    // 而这里下拉可能已经切到别的供应商但还没保存 —— 会回填上一个供应商的 Key，
    // 再点保存就把 A 家的 Key 写进 B 家的槽位（并把它发给 B 家）。
    const loadKeyForProvider = async () => {
      key.value = await getApiKey(provider.value);
      maskKey();
    };
    void loadKeyForProvider();
    // 切供应商只刷新 Key 显示，不写 settings、也不清 activePresetId：
    // 用户可能只是切一下又切回去，真正的"脱离预设"在保存时判定（见保存处理器）。
    provider.addEventListener("change", () => {
      void loadKeyForProvider();
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

    // 「测试连接」：只验证 端点 + Key + 网络 是否通，不填充模型列表。
    // 之所以单独做一个：用户切供应商后最常见的困惑就是"到底通没通"——
    // 自动获取模型失败时看不出是 Key 错、端点错还是网络错。
    const testBtn = document.createElement("button");
    testBtn.className = "as-btn";
    testBtn.textContent = "测试连接";
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
      try {
        const isCustom = (provider.value as string) === "custom";
        const base = isCustom ? normalizeOpenAIBase(baseUrl.value) : baseUrl.value.trim();
        const models = await listModels(
          provider.value as AssistantProvider,
          key.value.trim(),
          base,
        );
        toast(
          models.length
            ? `连接成功：${PROVIDERS[provider.value as keyof typeof PROVIDERS].label} 可用模型 ${models.length} 个`
            : "连接成功（该端点没有返回模型列表）",
          "info",
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast(`连接失败：${msg}`, "warn");
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "测试连接";
      }
    });
    // 两个按钮同属"验证接入配置"：自动获取模型会填充上面的模型列表，
    // 测试连接只验证端点 + Key + 网络。并成一行靠右，省一行高度。
    const apiBtnRow = document.createElement("div");
    apiBtnRow.className = "as-set-btns";
    apiBtnRow.append(fetchBtn, testBtn);
    host.appendChild(apiBtnRow);

    // ---------- 预设：保存 / 切换 / 重命名 / 删除（参考酒馆的操作方式） ----------
    // 只存非敏感字段；每个预设的 Key 单独存 Rust 侧 `preset:<id>` 槽位。
    sep(); // 分组：预设
    const presetSelect = document.createElement("select");
    presetSelect.className = "as-input as-select";
    mkRow("预设", presetSelect);

    const presetNameRow = document.createElement("div");
    presetNameRow.className = "as-set-row is-stacked";
    const presetNameLabel = document.createElement("span");
    presetNameLabel.className = "as-set-label";
    presetNameLabel.textContent = "预设名称";
    const presetName = document.createElement("input");
    presetName.className = "as-input";
    presetName.placeholder = "重命名用，或作为新预设的名字";
    presetNameRow.append(presetNameLabel, presetName);
    host.appendChild(presetNameRow);

    const presetInfo = document.createElement("div");
    presetInfo.className = "as-privacy";
    host.appendChild(presetInfo);

    const presetBtns = document.createElement("div");
    presetBtns.className = "as-set-btns";
    presetBtns.style.flexWrap = "wrap";
    const presetApply = document.createElement("button");
    presetApply.className = "as-btn as-btn-primary";
    presetApply.textContent = "应用";
    const presetRename = document.createElement("button");
    presetRename.className = "as-btn";
    presetRename.textContent = "重命名";
    const presetDelete = document.createElement("button");
    presetDelete.className = "as-btn";
    presetDelete.textContent = "删除";
    const presetSave = document.createElement("button");
    presetSave.className = "as-btn";
    presetSave.textContent = "＋ 保存当前为预设";
    presetBtns.append(presetApply, presetRename, presetDelete, presetSave);
    host.appendChild(presetBtns);

    const presetsOf = () => (settings.assistant.presets ??= []);
    const selectedPreset = () => presetsOf().find((p) => p.id === presetSelect.value) ?? null;

    const showPresetInfo = () => {
      const p = selectedPreset();
      if (!p) {
        presetName.value = "";
        presetInfo.textContent =
          presetsOf().length ? "选一个预设查看端点与模型" : "把当前配置存成预设，之后一键切换";
        return;
      }
      presetName.value = p.name;
      const base = p.provider === "custom" ? p.customBaseUrl : PROVIDERS[p.provider]?.base ?? "";
      presetInfo.textContent = `端点：${base || "（默认）"}　·　模型：${p.model || "（默认）"}`;
    };

    const refreshPresets = (pickId?: string) => {
      const list = presetsOf();
      presetSelect.innerHTML = "";
      if (!list.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "（还没有预设）";
        presetSelect.appendChild(o);
      }
      for (const p of list) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = `${p.name}（${PROVIDERS[p.provider]?.label ?? p.provider}）`;
        presetSelect.appendChild(o);
      }
      const want = pickId ?? settings.assistant.activePresetId ?? list[0]?.id ?? "";
      if (want) presetSelect.value = want;
      showPresetInfo();
    };
    presetSelect.addEventListener("change", showPresetInfo);

    const applyPreset = async (p: NonNullable<ReturnType<typeof selectedPreset>>) => {
      settings.assistant.provider = p.provider;
      settings.assistant.customBaseUrl = p.customBaseUrl;
      settings.assistant.model = p.model;
      settings.assistant.activePresetId = p.id;
      saveSettings(settings);
      provider.value = p.provider;
      baseUrl.value = p.customBaseUrl;
      model.value = p.model;
      toggleBaseUrl();
      key.value = await getApiKey(presetKeyScope(p.id));
      maskAssistantKey();
      clearApiKeyCache();
      clearPetTalkKeyCache();
      toast(`已切换到预设「${p.name}」`);
    };

    presetApply.addEventListener("click", () => {
      const p = selectedPreset();
      if (!p) return toast("先选一个预设", "warn");
      void applyPreset(p);
    });

    presetRename.addEventListener("click", () => {
      const p = selectedPreset();
      if (!p) return toast("先选一个预设", "warn");
      const name = presetName.value.trim();
      if (!name) return toast("名称不能为空", "warn");
      p.name = name;
      saveSettings(settings);
      refreshPresets(p.id);
      toast("已重命名");
    });

    presetDelete.addEventListener("click", () => {
      const p = selectedPreset();
      if (!p) return toast("先选一个预设", "warn");
      settings.assistant.presets = presetsOf().filter((x) => x.id !== p.id);
      if (settings.assistant.activePresetId === p.id) settings.assistant.activePresetId = "";
      saveSettings(settings);
      // 一并清掉该预设的 Key 槽位（不然会留下读不到的孤儿密码）
      void setApiKey("", presetKeyScope(p.id)).catch(() => {});
      refreshPresets();
      toast(`已删除预设「${p.name}」`);
    });

    presetSave.addEventListener("click", async () => {
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const name = presetName.value.trim() || `预设 ${presetsOf().length + 1}`;
      const prov = provider.value as AssistantProvider;
      const base =
        prov === "custom" ? normalizeOpenAIBase(baseUrl.value) : baseUrl.value.trim();
      settings.assistant.presets = [
        ...presetsOf(),
        { id, name, provider: prov, customBaseUrl: base, model: model.value.trim() },
      ];
      settings.assistant.activePresetId = id;
      // 关键：把当前 UI 的 provider/端点/模型同步进 settings.assistant。
      // 只写 presets+activePresetId 的话，Key 作用域已经切到 preset:<id>，但请求仍按
      // settings.assistant.provider 发 —— 用户改完供应商直接存预设就会出现
      // "旧供应商 + 新预设的 Key" 的错配（跨厂商发 Key / 401），而且重启后仍然错。
      settings.assistant.provider = prov;
      settings.assistant.customBaseUrl = base;
      settings.assistant.model = model.value.trim();
      saveSettings(settings);
      // 把当前 Key 复制到该预设的槽位：预设之间互不覆盖，切回来就是它自己那份
      await setApiKey(key.value.trim(), presetKeyScope(id)).catch(() => {});
      maskAssistantKey();
      refreshPresets(id);
      toast(`已保存预设「${name}」`);
    });

    refreshPresets();

    sep(); // 分组：人设
    const persona = document.createElement("textarea");
    persona.className = "as-input as-persona";
    persona.rows = 3;
    persona.placeholder = "人格设定，如：你是一只爱撒娇的猫娘，说话带波浪号～（留空则默认）";
    persona.value = settings.assistant.persona;
    mkRow("人格设定", persona);

    // 输出语言
    const langSelect = document.createElement("select");
    langSelect.className = "as-input as-select";
    const langs: [string, string][] = [
      ["", "自动（跟随用户）"],
      ["zh-cn", "中文"],
      ["en", "英语"],
      ["ja", "日语"],
      ["ko", "韩语"],
      ["fr", "法语"],
      ["de", "德语"],
      ["es-es", "西班牙语"],
      ["ru", "俄语"],
      ["th", "泰语"],
      ["vi", "越南语"],
      ["it", "意大利语"],
      ["pt", "葡萄牙语"],
      ["ar", "阿拉伯语"],
    ];
    langs.forEach(([code, label]) => {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = label;
      langSelect.appendChild(opt);
    });
    langSelect.value = settings.assistant.outputLanguage ?? "";
    mkRow("人物语言", langSelect);
    const langHint = document.createElement("div");
    langHint.className = "as-privacy";
    langHint.textContent = "AI 用该语言回复，气泡下方显示中文翻译（翻译不朗读）";
    host.appendChild(langHint);

    // 对用户的称呼
    const nickname = document.createElement("input");
    nickname.className = "as-input";
    nickname.placeholder = "对用户的称呼（如“主人”，留空由 AI 决定）";
    nickname.value = settings.assistant.nickname ?? "";
    mkRow("对用户的称呼", nickname);

    // 文件禁止目录：小助手只能读写 桌面/文档/下载，这里额外拉黑
    sep(); // 分组：功能
    const denyPaths = document.createElement("textarea");
    denyPaths.className = "as-input as-persona";
    denyPaths.rows = 3;
    denyPaths.placeholder = "例如：\nD:\\桌面\\桌宠\n# 一行一个，# 开头是注释";
    denyPaths.value = (settings.fileDenyPaths ?? []).join("\n");
    mkRow("文件禁止目录", denyPaths);
    const denyHint = document.createElement("div");
    denyHint.className = "as-privacy";
    denyHint.textContent =
      "小助手读写文件只允许在 桌面 / 文档 / 下载 之内；这里填的目录（含其子目录）一律拒绝 —— 建议把项目源码目录加进来";
    host.appendChild(denyHint);

    // 天气城市：填了就按城市查，不会再被代理出口 IP 带偏
    const weatherCity = document.createElement("input");
    weatherCity.className = "as-input";
    weatherCity.placeholder = "天气城市（如 北京；留空自动定位）";
    weatherCity.value = settings.weatherCity ?? "";
    const weatherCityRow = mkRow("天气城市", weatherCity);
    weatherCityRow.title = "开了代理/VPN 时自动定位可能指向梯子地区，填上城市就不会错";

    // 主动问候间隔时间设置
    const greetRow = document.createElement("div");
    greetRow.className = "as-set-row is-stacked";
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
    // 纵向排布下，输入框和「分钟」要留在同一行；直接作为 row 的子元素会被拆成两行
    const greetInputRow = document.createElement("div");
    greetInputRow.style.cssText = "display:flex;align-items:center;gap:6px;";
    greetInputRow.append(greetInput, greetUnit);
    greetRow.append(greetLabel, greetInputRow);
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


    sep(); // 分组：AI 用量
    // AI 用量统计（本地估算，帮助用户感知 token 消耗）
    const usageRow = document.createElement("div");
    usageRow.className = "as-set-row is-stacked";
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
    usageReset.style.cssText = "padding:2px 8px;font-size:11px;flex:none;margin-left:auto;";
    usageReset.textContent = "清零";
    usageReset.addEventListener("click", () => {
      resetUsageStats();
      renderUsage();
    });
    // 「清零」跟标题同一行、靠右；纵向行里直接当第三个子元素会被甩到统计文字下面，
    // 看起来像一个悬空的小按钮。
    const usageHead = document.createElement("div");
    usageHead.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;";
    usageHead.append(usageLabel, usageReset);
    usageRow.append(usageHead, usageBox);
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

    sep(); // 分组：隐私
    const privacyHint = document.createElement("div");
    privacyHint.className = "as-privacy";
    privacyHint.textContent = "隐私提示：主动问候会读取当前前台窗口标题+进程名并发送给 AI。API Key 经系统 DPAPI 加密存储。";
    host.appendChild(privacyHint);
    // 直接 append 到 host 会是左对齐，和上面那些靠右的按钮不一致；放进按钮组统一靠右
    const clearHistRow = document.createElement("div");
    clearHistRow.className = "as-set-btns";
    clearHistRow.appendChild(clearHistBtn);
    host.appendChild(clearHistRow);

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
      // 先吸收磁盘上的最新设置：别的模块（歌词同步微调、免确认 shell/写文件等）可能刚写过
      // settings，而这里的 settings 是启动时加载的旧快照 —— 直接整对象覆盖会把它们的改动
      // 静默回滚，重启后也消失。
      settings = loadSettings();
      const nextProvider = provider.value as AssistantProvider;
      // 手动改了供应商 => 脱离预设。只在真正保存时判定：只在按下来看一下又切回去，
      // 不应该把已应用的预设作废（旧实现是 change 时立刻持久化清空）。
      if (settings.assistant.activePresetId) {
        const activePreset = (settings.assistant.presets ?? []).find(
          (p) => p.id === settings.assistant.activePresetId,
        );
        if (!activePreset || activePreset.provider !== nextProvider) {
          settings.assistant.activePresetId = "";
        }
      }
      settings.assistant.provider = nextProvider;
      // 自定义端点自动规范化：补 /v1、去掉多余的 /chat/completions
      // （用户很容易把完整请求地址贴进来，导致再拼一次路径而 404）
      settings.assistant.customBaseUrl =
        (provider.value as string) === "custom"
          ? normalizeOpenAIBase(baseUrl.value)
          : baseUrl.value.trim();
      if (settings.assistant.customBaseUrl !== baseUrl.value.trim()) {
        baseUrl.value = settings.assistant.customBaseUrl;
      }
      settings.assistant.model = model.value.trim();
      // 正在使用某个预设时，把这次的供应商/端点/模型改动同步回该预设，
      // 否则"改了但不生效、下次切换还是旧值"。
      if (settings.assistant.activePresetId) {
        const active = (settings.assistant.presets ?? []).find(
          (p) => p.id === settings.assistant.activePresetId,
        );
        if (active) {
          active.provider = settings.assistant.provider;
          active.customBaseUrl = settings.assistant.customBaseUrl;
          active.model = settings.assistant.model;
        }
      }
      settings.assistant.persona = persona.value.trim();
      settings.assistant.nickname = nickname.value.trim();
      settings.assistant.outputLanguage = langSelect.value;
      settings.fileDenyPaths = denyPaths.value
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
      settings.gameTalk = gameTalk.checked;
      // 天气城市变了就清掉缓存，下次打开信息板立刻重新取
      const cityNext = weatherCity.value.trim();
      if (cityNext !== settings.weatherCity) cachedWeather = null;
      settings.weatherCity = cityNext;
      // 保存主动问候间隔（钳制到 5-120 分钟）
      const greetVal = parseInt(greetInput.value, 10);
      const nextGreetInterval = Math.max(5, Math.min(120, isNaN(greetVal) ? 20 : greetVal));
      settings.assistant.greetInterval = nextGreetInterval;
      saveSettings(settings);
      // 重排必须在**新间隔写进 settings 之后**：反过来的话 resync 会按旧间隔算下一次，
      // 用户改成 60 分钟却还是 20 分钟来一次（"间隔不准"的另一个来源）。
      // 顺带把锚点重设到当下，避免"保存前累积的时长已到，刚保存就被问候一下"。
      resyncGreetingSchedule();
      // API Key 按供应商 / 预设分槽存（Rust 侧 DPAPI / Keychain / Secret Service）。
      // 当前套着预设就写进该预设的槽位：预设之间、预设与供应商之间都互不覆盖。
      try {
        const scope = settings.assistant.activePresetId
          ? presetKeyScope(settings.assistant.activePresetId)
          : provider.value;
        await setApiKey(key.value.trim(), scope);
        clearApiKeyCache();
        clearPetTalkKeyCache();
      } catch (e) {
        toast(`API Key 保存失败：${e}`, "warn");
      }
      ttsPlayer.setConfig(settings.tts.enabled, ttsApiKey, settings.tts.speakerId, settings.assistant.outputLanguage ?? "");
      // 关面板前把 Key 恢复隐藏：不留明文在 DOM 里
      maskAssistantKey();
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
      "告诉我们遇到了什么问题，会自动附上本次启动的运行日志。提交后直达飞书反馈群；网络发不出去时会导出到桌面，也可以直接「复制」贴给我。";
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
    // 飞书推送失败（网络/代理问题）：说清原因，再走桌面导出
    toast(`飞书推送不可用：${e}，已改为导出桌面`, "warn");
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
































