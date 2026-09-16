/**
 * 小游戏宿主：注册表 + 全窗口覆盖层的打开/关闭。
 * 覆盖层带 data-petra-interactive，因此会被交互区域同步识别为可点击区域，
 * 关闭后自动从区域列表移除（窗口恢复穿透）。
 */
import type { MiniGameContext, MiniGameDef, MiniGameInstance } from "./types";

const registry: MiniGameDef[] = [];
let overlay: HTMLElement | null = null;
let active: { id: string; instance: MiniGameInstance } | null = null;
let onOpenCb: (() => void) | null = null;
let onCloseCb: (() => void) | null = null;

export function registerMiniGame(def: MiniGameDef): void {
  if (registry.some((g) => g.id === def.id)) return;
  registry.push(def);
}

export function listMiniGames(): MiniGameDef[] {
  return [...registry];
}

export function isMiniGameOpen(): boolean {
  return active !== null;
}

export function activeMiniGameId(): string | null {
  return active ? active.id : null;
}

/** 注册开/关回调（main.ts 用于暂停桌宠漫游、收起气泡等） */
export function setMiniGameLifecycle(onOpen: () => void, onClose: () => void): void {
  onOpenCb = onOpen;
  onCloseCb = onClose;
}

export function openMiniGame(id: string): boolean {
  const def = registry.find((g) => g.id === id);
  if (!def) return false;
  if (active && active.id === id) return true;
  closeMiniGame(true);
  const root = document.createElement("div");
  root.className = "mg-view";
  root.dataset.petraInteractive = "minigame";
  root.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.body.appendChild(root);
  document.body.classList.add("mg-active");
  overlay = root;
  const ctx: MiniGameContext = { root, close: () => closeMiniGame() };
  let instance: MiniGameInstance = {};
  try {
    instance = def.mount(ctx) ?? {};
  } catch (err) {
    console.warn("[小游戏] 启动失败：", err);
    root.remove();
    overlay = null;
    document.body.classList.remove("mg-active");
    return false;
  }
  active = { id, instance };
  onOpenCb?.();
  return true;
}

export function closeMiniGame(silent = false): void {
  const current = active;
  active = null;
  if (current) {
    try {
      current.instance.unmount?.();
    } catch (err) {
      console.warn("[小游戏] 清理失败：", err);
    }
  }
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  document.body.classList.remove("mg-active");
  if (!silent) onCloseCb?.();
}

export function toggleMiniGame(id: string): void {
  if (active && active.id === id) closeMiniGame();
  else openMiniGame(id);
}
