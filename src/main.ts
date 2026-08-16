import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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

const WIN = 300;
const PSD_KEY = "live2d-pet-psd";
const BUILTIN_KEY = "live2d-pet-builtin-model"; // 当前选中的内置模型（manifest files 内）

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
let view: PetView;
let settings: Settings = loadSettings();
let engine: BehaviorEngine;
let scaleFactor = 1; // 物理↔逻辑坐标转换（系统缩放）
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
    const m = await fetch("/models/manifest.json", { cache: "no-store" }).then((r) => r.json())
      .catch((err) => { void invoke("debug_mark", { msg: `[diag] manifest fetch 抛错: ${err}` }).catch(() => {}); throw err; });
    if (m?.type === "psd" && m.file) {
      // 默认模型：优先用用户上次选择的内置模型（须在 files 列表内）
      const saved = localStorage.getItem(BUILTIN_KEY);
      const file = saved && Array.isArray(m.files) && m.files.includes(saved) ? saved : m.file;
      try {
        const path = await invoke<string>("model_resource_path", { name: file });
        const res = await fetch(convertFileSrc(path));
        if (res.ok) {
          currentModel = { type: "manifest", name: file };
          return await makePsdView(new Uint8Array(await res.arrayBuffer()));
        }
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
  attachView(view);
}

async function reloadView() {
  view.unmount();
  await mountView();
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
  const pos = await currentLogicalPos(win);

  engine = new BehaviorEngine(pos);
  engine.setScale(scaleFactor);
  engine.setActivityLevel(settings.activity);
  engine.setTracking(settings.mouseTrack);
  // 小助手对话期间桌宠静止，关闭后恢复漫游
  setLifecycle(
    () => engine.suspend(3600_000),
    () => engine.suspend(1500),
  );
  // 启动一律正常站立（不自动恢复待机）
  if (settings.idleMode) {
    settings.idleMode = false;
    saveSettings(settings);
  }
  // 延迟首次漫游（low 档完全静止，不触发首次移动）
  if (settings.activity !== "low") {
    setTimeout(() => void engine.teleportRandom(), 5000);
  }

  // 小助手主动问候：每 20 分钟，若开启且空闲则智能打招呼（识别当前窗口）
  setInterval(() => {
    if (settings.assistant.enabled) void triggerProactive();
  }, 20 * 60 * 1000);

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
  // 启动后自动检查一次更新（静默）
  setTimeout(() => void checkUpdate(false), 5000);

  listen<string | object>("audio:error", (e) => {
    toast(`音频走丢了：${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`, "warn");
    toggleAudio(false);
  });
  void startAudio();

  // ---------- 交互 ----------
  setupTrashDrop(() => view, win, (path) => void importPsdFromPath(path));
  setupContextMenu(() => buildMenu(engine), onMenuOpen, () => {
    // 待机时窗口部分在屏外，菜单限制在可见区
    if (!settings.idleMode) return { top: 0, height: 300 };
    if (engine.isIdleTop) return { top: 150, height: 150 }; // 顶部待机：可见窗口下部
    return { top: 0, height: 95 }; // 底部待机：可见窗口上部
  });

  // 左键：按住可拖动桌宠；轻点（<6px 未拖）算"摸头"反应或打开小助手。
  // 非待机：拖动走 Rust 原生跟随线程（GetCursorPos → SetWindowPos，8ms，零每帧 IPC）。
  // 待机中：拖动沿边缘水平滑动（Rust 锁 y 跟随，只移动待机位置，不退出；退出仅靠右键菜单）。
  let drag: { sx: number; sy: number; wx: number; wy: number; moved: boolean; mode: "idleSlide" | "free" } | null = null;
  let dragLastMove = 0;
  document.addEventListener("pointerdown", (e) => {
    void analyzer.ctx.resume();
    if (e.button !== 0) return;
    // 动作试玩面板隐藏中：左键点击恢复面板，不触发拖拽/摸头
    if (actionDebugHidden) {
      actionDebugHidden = false;
      const panel = document.getElementById("action-debug") as HTMLElement | null;
      panel?.classList.remove("hidden");
      return;
    }
    if ((e.target as HTMLElement).closest?.("#menu, #toasts, #assistant-panel")) return;
    const p = engine.position;
    drag = { sx: e.clientX, sy: e.clientY, wx: p.x, wy: p.y, moved: false, mode: "free" };
    engine.suspend(30000); // 先停自主漫游，拖动结束再恢复
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      if (settings.idleMode) {
        // 待机中：沿边缘水平滑动（Rust 锁 y 跟随，8ms 原生流畅）
        drag.mode = "idleSlide";
        void invoke("drag_start", { lockedY: Math.round(engine.idleTarget.y * scaleFactor) });
      } else {
        drag.mode = "free";
        // 一次性启动 Rust 原生拖动（此后窗口由 8ms 线程直接跟随鼠标）
        void invoke("drag_start", {});
      }
    }
    const now = performance.now();
    if (now - dragLastMove < 16) return;
    dragLastMove = now;
    if (drag.mode === "idleSlide") {
      // 本地同步：x 跟随鼠标，y 锁待机边缘（窗口由 Rust 线程跟随）
      const edgeY = engine.idleTarget.y;
      const nx = Math.max(4, Math.min(screen.availWidth - 300 - 4, Math.round(drag.wx + dx)));
      engine.setPos(nx, edgeY);
    } else {
      // 本地位置同步（逻辑坐标：CSS 增量即逻辑增量；窗口实际由 Rust 线程跟随）
      engine.setPos(Math.round(drag.wx + dx), Math.round(drag.wy + dy));
    }
  });
  const endDrag = () => {
    if (!drag) return;
    const clicked = !drag.moved;
    if (drag.moved) void invoke("drag_end");
    drag = null;
    if (clicked) {
      // 小助手开启时轻点打开对话框，否则摸头
      if (settings.assistant.enabled) {
        openAssistant();
      } else {
        view.playClick();
      }
    }
    engine.suspend(1500); // 拖完原地歇一会再乱逛
  };
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

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

    engine.update(now, dt);
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

// ---------- 右键菜单 ----------
let autostartCache = false;

function onMenuOpen() {
  void invoke<boolean>("get_autostart").then((v) => {
    autostartCache = v;
  });
}

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
    const m = await fetch("/models/manifest.json", { cache: "no-store" }).then((r) => r.json());
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
    host.innerHTML = "";
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
    backBtn.addEventListener("click", () => host.classList.add("hidden"));
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
  }
}

function buildMenu(engine: BehaviorEngine) {
  return [
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
      id: "idle",
      label: "待机模式",
      state: settings.idleMode ? "开" : "关",
      onPick: () => void toggleIdle(),
    },
    {
      id: "models",
      label: "模型设置",
      onPick: () => void toggleModelPanel(),
    },
    {
      id: "assistant",
      label: "小助手模式",
      state: settings.assistant.enabled ? "开" : "关",
      onPick: () => {
        settings.assistant.enabled = !settings.assistant.enabled;
        saveSettings(settings);
        if (!settings.assistant.enabled) {
          // 关闭时立即关闭对话框 + 清空气泡
          closeAssistant();
          clearBubbles();
        }
        toast(settings.assistant.enabled ? "小助手已开启（点我对话）" : "小助手已关闭");
      },
    },
    {
      id: "assistant-settings",
      label: "小助手设置",
      onPick: () => void toggleAssistantSettings(),
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
      onPick: () => {
        void invoke("hide_pet");
        toast("我去托盘待会儿 (托盘/Alt+P 唤我)");
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
        } else {
          toast("自启设置失败", "warn");
        }
      },
    },
    { id: "sep", separator: true },
    {
      id: "restart",
      label: "重启",
      onPick: () => {
        void invoke("restart_app");
      },
    },
    {
      id: "action-debug",
      label: "动作试玩",
      onPick: () => void toggleActionDebug(),
    },
    {
      id: "quit",
      label: "退出",
      danger: true,
      onPick: () => {
        void invoke("quit_app");
      },
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

// ---------- 动作调试面板 ----------
function toggleActionDebug() {
  const panel = document.getElementById("action-debug") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    view.stopAction();
    panel.classList.add("hidden");
    return;
  }

  const render = (host: HTMLElement) => {
    host.innerHTML = "";

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

// ---------- 小助手设置面板 ----------
async function toggleAssistantSettings() {
  const panel = document.getElementById("assistant-settings") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  const render = (host: HTMLElement) => {
    host.innerHTML = "";
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
        // 填充下拉列表，让用户自己选（不自动用第一个）
        modelSelect.innerHTML = "";
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          modelSelect.appendChild(opt);
        }
        toast(`获取到 ${models.length} 个模型，请从「模型列表」选择`);
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
  }
}

// ---------- 反馈面板 ----------
function openFeedbackInput() {
  const panel = document.getElementById("feedback-panel") as HTMLElement | null;
  if (panel && !panel.classList.contains("hidden")) return;

  const render = (host: HTMLElement) => {
    host.innerHTML = "";
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
    back.addEventListener("click", () => host.classList.add("hidden"));
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
const UPDATE_REPO = "Wumiu/pet";
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

function showUpdateBubble(tag: string, url: string) {
  let el = document.getElementById("update-bubble") as HTMLElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = "update-bubble";
    el.className = "update-bubble";
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(el);
  }
  el.innerHTML = `<b>✨ 新版本 ${tag} 可用！</b><span>点这里前往下载</span>`;
  el.classList.remove("hidden");
  el.onclick = () => {
    void invoke("open_url", { url }).catch(() => {});
    el!.remove();
  };
  // 8 秒未点击自动消失
  clearTimeout((el as unknown as { _t?: number })._t);
  (el as unknown as { _t?: number })._t = window.setTimeout(() => {
    if (el?.isConnected) el.remove();
  }, 8000);
}

async function checkUpdate(manual = false) {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      cache: "no-store",
    });
    if (!res.ok) {
      if (manual) toast("检查更新失败（网络或仓库不可用）", "warn");
      return;
    }
    const rel = await res.json();
    const tag = String(rel.tag_name ?? "");
    const url = String(rel.html_url ?? "");
    const local = parseVersion(await getVersion().catch(() => "0"));
    const remote = parseVersion(tag);
    if (remote.length && cmpVersion(remote, local) > 0) {
      // 自动检查：同一版本只提示一次；手动检查总是提示
      if (!manual && localStorage.getItem(UPDATE_KEY) === tag) return;
      localStorage.setItem(UPDATE_KEY, tag);
      showUpdateBubble(tag, url);
    } else if (manual) {
      toast(`已是最新版本（v${local.join(".")}）`);
    }
  } catch {
    if (manual) toast("检查更新失败（网络不可用）", "warn");
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