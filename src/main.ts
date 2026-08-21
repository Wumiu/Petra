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
import { toast } from "./ui/Toast";
import { clamp } from "./utils/math";
import { loadSettings, saveSettings, type Settings, type AssistantProvider } from "./utils/settings";
import { ACTIVITY_LABEL, nextActivity, type ActivityLevel } from "./utils/settings";
import { astrobotOn } from "./bridges/astrobot";
import { openAssistant } from "./assistant/AssistantPanel";
import { setLifecycle, triggerProactive, closeAssistant, clearBubbles, clearApiKeyCache, clearHistory } from "./assistant/AssistantPanel";
import { listModels } from "./assistant/AssistantClient";
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

/** 将面板定位到模型旁边：往屏幕内侧（空间大的方向），不挡住模型、不出屏 */
function positionPanelNearModel(panel: HTMLElement) {
  panel.style.position = "fixed"; // 确保 fixed 定位
  const mr = getModelRect();
  const vr = getWindowVisibleRect();
  // 先让面板按自身内容撑开
  panel.style.maxWidth = `${vr.right - vr.left - 40}px`;
  panel.style.maxHeight = `${vr.bottom - vr.top - 40}px`;
  let pw = panel.offsetWidth || 230;
  let ph = panel.offsetHeight || 200;
  // 面板比可见区大则缩小
  const maxW = vr.right - vr.left - 40;
  const maxH = vr.bottom - vr.top - 40;
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
}

async function reloadView() {
  view.unmount();
  await mountView();
  // 切换模型：恢复该模型自己的大小（无记录用默认 100%）
  const key = currentModel.name ?? "";
  const scale = settings.modelScales[key] ?? 1;
  void applyModelScale(scale, false);
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
  // 小助手对话期间桌宠静止，关闭后恢复漫游
  setLifecycle(
    () => engine.suspend(3600_000),
    () => engine.suspend(IDLE_AFTER_DRAG_MS),
  );
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
    let idleSec = 0;
    try { idleSec = await invoke<number>("get_idle_seconds"); } catch {}

    const now = Date.now();
    const isIdle = idleSec > 3600; // 空闲超过 5 分钟才算"离开"

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
          return;
        }
      }
      lastActiveAt = now;
    }

    const sinceGreet = now - lastGreetAt;
    const activeMs = now - activeStartAt; // 连续活跃时长
    const hour = new Date().getHours();

    // 久坐提醒：连续活跃超过 90 分钟且没离开过
    if (activeMs > 90 * 60 * 1000 && sinceGreet > 60 * 60 * 1000 && !wasIdle) {
      lastGreetAt = now;
      void triggerProactive();
      return;
    }

    // 深夜关怀
    if ((hour >= 23 || hour < 2) && sinceGreet > 30 * 60 * 1000) {
      lastGreetAt = now;
      void triggerProactive();
      return;
    }

    // 早晨首次
    if (hour >= 6 && hour < 10 && lastGreetAt === 0) {
      lastGreetAt = now;
      void triggerProactive();
      return;
    }

    // 兜底
    if (sinceGreet > 60 * 60 * 1000) {
      lastGreetAt = now;
      void triggerProactive();
    }
  }, 5 * 60 * 1000);

  // 光标/工作区轮询：独立定时器，避免渲染热路径 await IPC
  setInterval(() => void engine.pollCursor(), 60);
  setInterval(() => void engine.pollArea(), 2500);

  // ---------- 音频 ----------
  const analyzer = new AudioAnalyzer();
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

  // 左键：按住可拖动桌宠；轻点（<6px 未拖）算"摸头"反应或打开小助手。
  // 非待机：拖动走 Rust 原生跟随线程（GetCursorPos → SetWindowPos，8ms，零每帧 IPC）。
  // 待机中：拖动沿边缘水平滑动（Rust 锁 y 跟随，只移动待机位置，不退出；退出仅靠右键菜单）。
  let drag: { sx: number; sy: number; wx: number; wy: number; moved: boolean; mode: "idleSlide" | "free" } | null = null;
  let nativeDragStart: Promise<unknown> | null = null;
  let uiPointerLocked = false;
  let dragLastMove = 0;
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
    const dragMode = drag?.mode;
    if (drag.moved) {
      const start = nativeDragStart ?? Promise.resolve();
      void start.finally(() => {
        invoke("drag_end").catch(() => {});
        // 待机拖拽结束：同步引擎位置到实际窗口位置
        if (dragMode === "idleSlide") {
          void getCurrentWindow().outerPosition().then(p => {
            engine.setPos(p.x / scaleFactor, p.y / scaleFactor);
          });
        }
      });
    }
    nativeDragStart = null;
    drag = null;
    // 保存桌宠位置（供重启恢复）
    void getCurrentWindow().outerPosition().then(p => { savePetPosition(p.x / scaleFactor, p.y / scaleFactor); });
    if (clicked) {
      view.playClick();
      showInfoPanel();
      if (settings.assistant.enabled) {
        openAssistant(getModelRect());
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

  // ---------- Astrobot 预留钩子 ----------
  astrobotOn((msg) => {
    if (msg.type === "emote" || msg.type === "gesture") view.playClick();
    if (msg.type === "speak") view.playGobble();
    if (msg.type === "move") {
      void engine.teleportRandom();
    }
  });

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
    updateModelBounds(cb);
    driver.bass = analyzer.bass;
    driver.mid = analyzer.mid;
    driver.treble = analyzer.treble;
    driver.beat = analyzer.beat;
    driver.bpm = analyzer.bpm;
    driver.bob = engine.bob;
    driver.vx = engine.vx;
    driver.cursorDx = engine.cursorDx;
    driver.cursorDy = engine.cursorDy;
    // 待机时呼吸放缓
    driver.breathing = (now / 1000) * Math.PI * 2 * (engine.isIdle ? 0.18 : 0.42);
    driver.excited = engine.excitementValue;
    driver.idleTop = engine.isIdleTop;
    driver.idle = engine.isIdle;
    driver.dragging = !!drag && drag.moved;
    driver.dragVelX = clamp(engine.cursorVx / 800, -1, 1);
    driver.pressed = !!drag;
    driver.modelOffsetX = engine.modelOffset.x;
    driver.modelOffsetY = engine.modelOffset.y;
    // 通知区域跟随模型位置（绿框下方）
    const mr = getModelRect();
    const toasts = document.getElementById("toasts");
    if (toasts && toasts.children.length > 0) {
      if (!drag || !drag.moved) {
        toasts.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
        toasts.style.bottom = `${Math.max(8, window.innerHeight - mr.bottom - 10)}px`;
        toasts.style.transform = "translateX(-50%)";
      }
    }
    const bubbles = document.getElementById("as-bubbles");
    if (bubbles && bubbles.children.length > 0 && (!drag || !drag.moved)) {
      bubbles.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
      bubbles.style.top = `${Math.round(mr.top - bubbles.offsetHeight - 12)}px`;
      bubbles.style.bottom = "auto";
      bubbles.style.transform = "translateX(-50%)";
    }
    // 拖拽中所有打开的面板跟随模型位置
    if (drag && drag.moved) {
      // 输入框
      const ib = document.getElementById("as-inputbar");
      if (ib && !ib.classList.contains("hidden")) {
        ib.style.left = `${Math.round(mr.left)}px`;
        ib.style.top = `${Math.min(mr.bottom + 10, window.innerHeight - 60)}px`;
        ib.style.bottom = "auto";
      }
      // 气泡
      if (bubbles && bubbles.children.length > 0) {
        bubbles.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
        bubbles.style.top = `${Math.round(mr.top - bubbles.offsetHeight - 12)}px`;
        bubbles.style.bottom = "auto";
        bubbles.style.transform = "translateX(-50%)";
      }
      // 通知
      if (toasts && toasts.children.length > 0) {
        toasts.style.left = `${Math.round(mr.left + (mr.right - mr.left) / 2)}px`;
        toasts.style.bottom = `${Math.max(8, window.innerHeight - mr.bottom - 10)}px`;
        toasts.style.transform = "translateX(-50%)";
      }
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

function onMenuOpen() {
  // 右键打开菜单时暂停移动
  engine.suspend(60000);
  void invoke("clear_pet_target").catch(() => {});
  void invoke<boolean>("get_autostart").then((v) => {
    autostartCache = v;
  });
  void invoke<boolean>("is_topmost").then(v => { topmostCache = v; }).catch(() => {});
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
  window.setInterval(() => requestInteractionRegionSync(), 33);
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
          label: "跟随音乐（未完善）",
          state: settings.audioEnabled ? "开" : "关",
          onPick: () => toggleAudio(!settings.audioEnabled),
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
    // 同步窗口实际位置（逻辑），保证就近边缘判断准确（引擎 pos 可能因漫游漂移）
    const p = await getCurrentWindow().outerPosition();
    engine.setPos(p.x / scaleFactor, p.y / scaleFactor);
    savePetPosition(p.x / scaleFactor, p.y / scaleFactor);
  }
  await engine.setIdle(settings.idleMode);
  // 仅进入待机时定位到边缘；退出时保持当前位置
  if (settings.idleMode) {
    const t = engine.idleTarget;
    // 引擎与 setPosition 都是逻辑坐标
    void getCurrentWindow().setPosition(new LogicalPosition(t.x, t.y));
  }
  toast(settings.idleMode ? "困了，先眯一会儿…" : "醒啦～");
}


// ---------- 信息板（桌宠伴侣信息） ----------
let infoPanelEl: HTMLElement | null = null;
let infoPanelHideTimer: ReturnType<typeof setTimeout> | null = null;
let cachedWeather: { text: string; time: number } | null = null;

/** 天气描述 → emoji */
function weatherEmoji(desc: string): string {
  const d = desc.toLowerCase();
  if (d.includes("晴") || d.includes("sunny") || d.includes("clear")) return "☀️";
  if (d.includes("多云") || d.includes("cloud")) return "⛅";
  if (d.includes("阴") || d.includes("overcast")) return "☁️";
  if (d.includes("雨") || d.includes("rain")) return "🌧";
  if (d.includes("雪") || d.includes("snow")) return "❄️";
  if (d.includes("雷") || d.includes("thunder")) return "⛈";
  if (d.includes("雾") || d.includes("fog") || d.includes("mist")) return "🌫";
  return "🌤";
}

/** 解析 wttr.in 返回的 "城市|描述|温度|最高|最低|降雨%" 格式 */
function formatWeatherHtml(raw: string): string {
  const parts = (raw || "").split("|");
  if (parts.length < 6) return raw || "天气获取失败";
  const [city, desc, temp, maxT, minT, rain] = parts.map((s) => s.trim());
  const emoji = weatherEmoji(desc);
  const displayCity = settings.weatherCity || city;
  return `${displayCity}　${emoji} ${desc} ${temp}°C\n最高 ${maxT}° / 最低 ${minT}° · 降雨 ${rain}%`;
}

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
    invoke<string>("get_weather")
      .then((raw) => {
        weatherHtml = formatWeatherHtml(raw);
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
  const panelW = 270;
  const panelH = el.offsetHeight || 200;

  // 定位：模型在屏幕上半 → 信息版在下方（屏幕内侧），下半 → 上方
  const mr = getModelRect();
  const vr = getWindowVisibleRect();

  // 水平居中对齐模型
  let left = Math.round(mr.left + (mr.width - panelW) / 2);
  // 模型中心（屏幕坐标）相对屏幕中心判断上下
  const a = engine.workArea;
  const screenCy = a ? a.top + a.height / 2 : window.innerHeight / 2;
  const modelScreenCenterY = engine.windowScreenPos.y + mr.top + mr.height / 2;
  let top: number;
  // 小助手开启时，信息板避开助手位置（助手在模型下方）
  const assistantOpen = settings.assistant.enabled;
  if (modelScreenCenterY <= screenCy) {
    // 模型在上半屏 → 信息版默认在下方
    if (assistantOpen) {
      // 助手在下方，信息板移到上方
      top = mr.top - panelH - 6;
      if (top < vr.top) top = mr.bottom + 6; // 上方放不下就还是下方
    } else {
      top = mr.bottom + 6;
      if (top + panelH > vr.bottom) top = mr.top - panelH - 6;
    }
  } else {
    // 模型在下半屏 → 信息版在上方（助手也在下方，不冲突）
    top = mr.top - panelH - 6;
    if (top < vr.top) top = mr.bottom + 6;
  }

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
function toggleBoundsPanel() {
  const panel = document.getElementById("bounds-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
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

  if (msgs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mp-hint";
    empty.textContent = "暂无对话记录";
    panel.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.style.cssText = "flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:4px 0;scrollbar-width:thin;";
    for (const m of msgs) {
      const row = document.createElement("div");
      row.style.cssText = "font-size:12px;line-height:1.5;padding:6px 10px;border-radius:8px;white-space:pre-wrap;word-break:break-word;";
      if (m.role === "user") {
        row.style.background = "rgba(100,140,255,0.12)";
        row.textContent = "👤 " + m.content;
      } else {
        row.style.background = "rgba(255,255,255,0.6)";
        row.textContent = "🐾 " + m.content;
      }
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  // 关闭按钮
  const btns = document.createElement("div");
  btns.className = "as-set-btns";
  const closeBtn = document.createElement("button");
  closeBtn.className = "as-btn";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => panel.remove());
  btns.appendChild(closeBtn);
  panel.appendChild(btns);

  document.body.appendChild(panel);
  positionPanelNearModel(panel);

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
    provider.innerHTML = `<option value="deepseek">DeepSeek（内置）</option><option value="custom">自定义 OpenAI 兼容</option>`;
    provider.value = settings.assistant.provider;
    mkRow("提供商", provider);

    const baseUrl = document.createElement("input");
    baseUrl.className = "as-input";
    baseUrl.placeholder = "如 https://api.openai.com/v1";
    baseUrl.value = settings.assistant.customBaseUrl;
    const baseUrlRow = mkRow("API 端点", baseUrl);
    const toggleBaseUrl = () => {
      baseUrlRow.style.display = provider.value === "custom" ? "flex" : "none";
    };
    provider.addEventListener("change", toggleBaseUrl);
    toggleBaseUrl();

    const key = document.createElement("input");
    key.className = "as-input";
    key.type = "password";
    key.placeholder = "API Key";
    key.value = "";
    mkRow("API Key", key);
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
      } catch {
        models = [];
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
        toast("未获取到模型列表（可能接口不支持），请在「模型名」手填", "warn");
      }
    });
    mkRow("", fetchBtn);

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
      saveSettings(settings);
      // API Key 存 Rust 侧（DPAPI 加密）
      try {
        await invoke("set_api_key", { apiKey: key.value.trim() });
        clearApiKeyCache();
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
    desc.textContent = "告诉我们遇到了什么问题，将自动附上本次启动的运行日志发送给开发者；发送失败时自动导出到桌面。";
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
    btns.append(back, send);
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
  } catch (e) {
    // 邮件发送失败：兜底导出桌面文件
    toast(`邮件发送失败：${e}`, "warn");
    try {
      const path = await invoke<string>("export_feedback", { message });
      toast(`已导出反馈文件到桌面：${path}`);
    } catch {
      /* 忽略 */
    }
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

function showUpdateBubble(tag: string, downloadUrls: string[]) {
  // 用模型头顶大气泡样式
  const existing = document.getElementById("update-bubble");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "update-bubble";
  el.className = "big-toast";
  el.style.whiteSpace = "normal";
  el.style.maxWidth = "280px";
  el.style.cursor = "pointer";
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
  hint.textContent = "点这里自动更新";
  const bar = document.createElement("div");
  bar.style.cssText = "height:4px;background:rgba(176,74,126,0.2);border-radius:4px;margin-top:8px;display:none;";
  const fill = document.createElement("div");
  fill.style.cssText = "height:100%;background:#d06a9a;border-radius:4px;width:0%;transition:width 0.3s;";
  bar.appendChild(fill);
  el.append(title, hint, bar);
  document.body.appendChild(el);

  el.onclick = async () => {
    hint.textContent = "正在下载…";
    bar.style.display = "block";
    el.style.cursor = "default";
    el.onclick = null;
    const ok = await performUpdate(downloadUrls, (pct) => {
      fill.style.width = `${pct}%`;
      hint.textContent = `正在下载… ${pct}%`;
    });
    if (ok) {
      hint.textContent = "下载完成，即将安装…";
    } else {
      hint.textContent = "下载失败，点这里手动下载";
      bar.style.display = "none";
      el.style.cursor = "pointer";
      el.onclick = () => {
        void invoke("open_url", { url: `https://github.com/Wumiu/Petra/releases/tag/${tag}` });
        el.remove();
      };
    }
  };

  setTimeout(() => {
    if (el.isConnected) {
      el.classList.add("bye");
      setTimeout(() => el.remove(), 300);
    }
  }, 15000);
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
      showUpdateBubble(info.version, info.downloadUrls);
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
      toast(msg, "warn");
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

void boot();
































