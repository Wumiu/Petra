import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { AudioAnalyzer } from "./audio/AudioAnalyzer";
import { BehaviorEngine } from "./autonomous/BehaviorEngine";
import { PlaceholderRenderer } from "./live2d/PlaceholderRenderer";
import { idleDriver, type PetDriver, type PetView } from "./live2d/PetDriver";
import { Rigged2DView } from "./live2d/psd/Rigged2DView";
import { setupTrashDrop } from "./features/trash/TrashHandler";
import { setupContextMenu } from "./ui/ContextMenu";
import { toast } from "./ui/Toast";
import { loadSettings, saveSettings, type Settings } from "./utils/settings";
import { ACTIVITY_LABEL, nextActivity, type ActivityLevel } from "./utils/settings";
import { astrobotOn } from "./bridges/astrobot";

const WIN = 300;
const PSD_KEY = "live2d-pet-psd";

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
      return await makePsdView(new Uint8Array(bytes));
    } catch {
      localStorage.removeItem(PSD_KEY);
    }
  }
  // 2) 打包的 PSD 模型（public/models/<file>）
  try {
    const m = await fetch("/models/manifest.json", { cache: "no-store" }).then((r) => r.json());
    if (m?.type === "psd" && m.file) {
      const res = await fetch(`/models/${m.file}`);
      if (res.ok) {
        return await makePsdView(new Uint8Array(await res.arrayBuffer()));
      }
    }
    if (m?.active) {
      // 动态 import：pixi-live2d-display 有模块级 runtime 检查，隔离避免拖垮主链
      const { Live2DController } = await import("./live2d/Live2DController");
      const v = await Live2DController.create();
      if (v) return v;
    }
  } catch {
    /* 无 manifest 或不是 PSD 模式 */
  }
  // 3) 标准 Live2D（model3.json）
  try {
    const { Live2DController } = await import("./live2d/Live2DController");
    const l2d = await Live2DController.create();
    if (l2d) return l2d;
  } catch (err) {
    console.error(`live2d 加载失败: ${err}`);
  }
  // 4) 占位角色兜底
  return new PlaceholderRenderer();
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
  await mountView();

  // 同步 Rust 侧音频开关到持久化设置
  void invoke("set_audio_enabled", { enabled: settings.audioEnabled });

  const win = getCurrentWindow();
  const pos = await currentLogicalPos(win);

  const engine = new BehaviorEngine(pos);
  engine.setActivityFactor({ low: 3.5, mid: 1.8, high: 1 }[settings.activity]);
  engine.setTracking(settings.mouseTrack);
  // 延迟首次漫游，让主人先在屏幕中央看到桌宠
  setTimeout(() => void engine.teleportRandom(), 5000);

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
  listen<string | object>("audio:error", (e) => {
    toast(`音频走丢了：${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`, "warn");
    toggleAudio(false);
  });
  void startAudio();

  // ---------- 交互 ----------
  setupTrashDrop(() => view, win, (path) => void importPsdFromPath(path));
  setupContextMenu(() => buildMenu(engine), onMenuOpen);

  // 左键：按住可拖动桌宠；轻点（<6px 未拖）算"摸头"反应
  let drag: { sx: number; sy: number; wx: number; wy: number; moved: boolean } | null = null;
  let dragLastMove = 0;
  document.addEventListener("pointerdown", (e) => {
    void analyzer.ctx.resume();
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest?.("#menu, #toasts")) return;
    const p = engine.position;
    drag = { sx: e.clientX, sy: e.clientY, wx: p.x, wy: p.y, moved: false };
    engine.suspend(30000); // 先停自主漫游，拖动结束再恢复
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    const now = performance.now();
    if (now - dragLastMove < 16) return;
    dragLastMove = now;
    const nx = Math.round(drag.wx + dx);
    const ny = Math.round(drag.wy + dy);
    engine.setPos(nx, ny);
    // 拖动时即时跟随：speed 足够大让 mover 直接跳到目标（step=min(speed*dt, dist)=dist）
    void invoke("set_pet_target_speed", { x: nx, y: ny, speed: 99999 });
  });
  const endDrag = () => {
    if (!drag) return;
    const clicked = !drag.moved;
    drag = null;
    if (clicked) view.playClick();
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

    void engine.update(now, dt).then(() => {
      driver.bass = analyzer.bass;
      driver.mid = analyzer.mid;
      driver.treble = analyzer.treble;
      driver.beat = analyzer.beat;
      driver.bob = engine.bob;
      driver.vx = engine.vx;
      driver.cursorDx = engine.cursorDx;
      driver.cursorDy = engine.cursorDy;
      driver.breathing = (now / 1000) * Math.PI * 2 * 0.42;
      // 临时调试：音频数据是否到达角色（每2秒输出一次）
      if (Math.round(now) % 2000 < 20 && (driver.bass > 0.001 || driver.mid > 0.001)) {
        console.log(`[driver] → bass=${driver.bass.toFixed(3)} mid=${driver.mid.toFixed(3)} sway=${settings.audioEnabled ? "on" : "OFF"}`);
      }
      view.update(driver, dt);
    });
  });
}

async function currentLogicalPos(win: Awaited<ReturnType<typeof getCurrentWindow>>) {
  try {
    const scale = await win.scaleFactor();
    const p = await win.outerPosition();
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
  const current = localStorage.getItem(PSD_KEY);
  const curType = current ? "psd" : "builtin";

  const render = (host: HTMLElement) => {
    host.innerHTML = "";
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "模型设置";
    host.appendChild(title);

    const mk = (label: string, type: string, name: string | null, active: boolean) => {
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
        if (type === "builtin") localStorage.removeItem(PSD_KEY);
        else if (name) localStorage.setItem(PSD_KEY, name);
        host.classList.add("hidden");
        await reloadView();
      });
      host.appendChild(row);
    };

    mk("内置模型（打包/默认）", "builtin", null, curType === "builtin");
    for (const m of models) {
      mk(m.replace(/\.psd$/i, ""), "psd", m, curType === "psd" && current === m);
    }
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = "（无已导入模型，拖 PSD 给桌宠或右键导入）";
      host.appendChild(empty);
    }
    const hint = document.createElement("div");
    hint.className = "mp-hint";
    hint.textContent = "拖 PSD 文件到桌宠身上即可导入新模型";
    host.appendChild(hint);
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
  }
}

function buildMenu(engine: BehaviorEngine) {
  return [
    {
      id: "import",
      label: "导入 PSD 模型",
      onPick: () => hiddenPsdInput().click(),
    },
    {
      id: "audio",
      label: "跟随音乐",
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
        engine.setActivityFactor({
          low: 3.5,
          mid: 1.8,
          high: 1,
        }[next]);
        toast(`活动频率：${ACTIVITY_LABEL[next]}（表情/漫游节奏）`);
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
        toast(settings.mouseTrack ? "逗猫棒来啦～" : "收起逗猫棒");
      },
    },
    {
      id: "models",
      label: "模型设置",
      onPick: () => void toggleModelPanel(),
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
      id: "quit",
      label: "退出",
      danger: true,
      onPick: () => {
        void invoke("quit_app");
      },
    },
  ];
}

function toggleAudio(on: boolean) {
  settings.audioEnabled = on;
  saveSettings(settings);
  view.setSwayEnabled(on);
  void invoke("set_audio_enabled", { enabled: on });
  toast(on ? "耳朵竖起来啦～" : "暂时不想听音乐了");
}

void boot();