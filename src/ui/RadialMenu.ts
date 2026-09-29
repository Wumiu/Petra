/**
 * Bongocat 风格的环形（radial）菜单。
 *
 * 纯 Canvas 实现，覆盖在桌宠窗口内。右键点模型唤出，扇区从中心依次绽放；
 * 有子项的扇区 hover 时在外圈展开子扇区；点外部 / Esc / 再次右键 关闭。
 *
 * - 圆角扇区（二次贝塞尔）
 * - 全屏暗化背景，菜单浮在顶层
 * - rAF + dirty 重绘：静止时不刷帧，hover 变化才重绘，保证流畅不卡
 */

/** Lucide 风格黑色线条图标 */
export interface RadialChild {
  label: string;
  state?: string;
  checked?: boolean;
  onPick: () => void;
}

export interface RadialEntry {
  id: string;
  label: string;
  icon: string;
  color: string;
  state?: string;
  checked?: boolean;
  danger?: boolean;
  children?: RadialChild[];
  onPick?: () => void;
}

interface RadialOptions {
  getEntries: () => RadialEntry[];
  onOpen?: () => Promise<void> | void;
  isInsideModel?: (x: number, y: number) => boolean;
}

import { invoke } from "@tauri-apps/api/core";

const TAU = Math.PI * 2;
const REVEAL_DURATION = 280;
const REVEAL_STAGGER = 40;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${Math.min(255, Math.round(r * f))},${Math.min(255, Math.round(g * f))},${Math.min(255, Math.round(b * f))})`;
}

function rgbaHex(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function angleDistance(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** 圆角环形扇区路径。a0/a1 弧度，cr 圆角半径（px）。 */
function annularSector(
  c: CanvasRenderingContext2D,
  cx: number, cy: number,
  inner: number, outer: number,
  a0: number, a1: number, cr: number,
) {
  const gap = 0.025;
  a0 += gap; a1 -= gap;
  c.beginPath();
  c.arc(cx, cy, outer, a0, a1);
  c.lineTo(cx + inner * Math.cos(a1), cy + inner * Math.sin(a1));
  c.arc(cx, cy, inner, a1, a0, true);
  c.closePath();
}

export function setupRadialMenu(opts: RadialOptions): void {
  const canvas = document.createElement("canvas");
canvas.id = "radial-menu";
  canvas.dataset.petraInteractive = "radial-menu";
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "500",
  } as CSSStyleDeclaration);
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  let visible = false;
  let raf = 0;
  let entries: RadialEntry[] = [];
  let cx = 0, cy = 0, R = 0;
  let openedAt = 0;
  let activeRoot = -1;
  let activeChild = -1;
  let pressedRoot = -1;
  let pressedChild = -1;
  let childFocus = false;
  let lift: number[] = [];
  let childLift: number[] = [];
  let mouseX = -9999, mouseY = -9999;
  let dpr = 1;
  let dirty = true;

  function resizeCanvas() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    dirty = true;
  }

  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    R = Math.min(w, h) * 0.44;
    cx = Math.max(R, Math.min(w - R, cx));
    cy = Math.max(R, Math.min(h - R, cy));
  }

  function rootAngle(i: number): number {
    return -Math.PI / 2 + (i * TAU) / (entries.length || 1);
  }
  function childCount(root: number): number {
    return entries[root]?.children?.length ?? 0;
  }
  function childAngle(root: number, i: number): number {
    const n = childCount(root);
    if (!n) return 0;
    return rootAngle(root) + (i - (n - 1) / 2) * (TAU / n);
  }
  function childStep(root: number): number {
    return TAU / Math.max(1, childCount(root));
  }

  function hit(mx: number, my: number): { root: number; child: number } {
    const dx = mx - cx, dy = my - cy;
    const radius = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const innerR = R * 0.26, outerR = R * 0.60;
    const innerC = R * 0.60, outerC = R * 0.92;
    if (activeRoot >= 0 && childCount(activeRoot) && radius >= innerC && radius <= outerC) {
      const step = childStep(activeRoot);
      for (let i = 0; i < childCount(activeRoot); i++) {
        if (Math.abs(angleDistance(angle, childAngle(activeRoot, i))) < step / 2) {
          return { root: activeRoot, child: i };
        }
      }
    }
    if (radius >= innerR && radius <= outerR) {
      for (let i = 0; i < entries.length; i++) {
        if (Math.abs(angleDistance(angle, rootAngle(i))) < (TAU / entries.length) / 2) {
          return { root: i, child: -1 };
        }
      }
    }
    // 间隙/中心：子菜单展开时保持当前根项，不要让子扇区收起
    if (childFocus && activeRoot >= 0) {
      return { root: activeRoot, child: -1 };
    }
    return { root: -1, child: -1 };
  }

  function drawRoot(i: number, now: number) {
    const e = entries[i];
    const center = rootAngle(i);
    const half = (TAU / entries.length) / 2;
    const t = easeOutCubic(Math.max(0, Math.min(1, (now - openedAt - i * REVEAL_STAGGER) / REVEAL_DURATION)));
    const l = lift[i] ?? 0;
    const scale = 0.75 + 0.25 * t + 0.05 * l;
    const push = -R * 0.04 * (1 - t) + R * 0.03 * l;
    const ox = Math.cos(center) * push, oy = Math.sin(center) * push;

    const inner = R * 0.26 * scale;
    const outer = R * 0.62 * scale;
    const base = e.danger ? "#ff5b52" : e.color;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.globalAlpha = t;
    annularSector(ctx, cx, cy, inner, outer, center - half, center + half, 22);
    ctx.fillStyle = i === activeRoot ? "rgba(255,255,255,1)" : "rgba(255,255,255,1)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = i === activeRoot ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.08)";
    ctx.stroke();

    const midR = (inner + outer) / 2;
    const ix = cx + midR * Math.cos(center);
    const iy = cy + midR * Math.sin(center);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(R * 0.13)}px system-ui, sans-serif`;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText(e.icon, ix, iy);
    ctx.restore();
  }

  function drawChild(root: number, i: number, now: number) {
    const ch = entries[root].children![i];
    const center = childAngle(root, i);
    const half = childStep(root) / 2;
    const t = easeOutCubic(Math.max(0, Math.min(1,
      (now - openedAt - (root * REVEAL_STAGGER + 100) - i * 20) / REVEAL_DURATION)));
    const l = childLift[i] ?? 0;
    const scale = 0.75 + 0.25 * t + 0.05 * l;
    const push = -R * 0.03 * (1 - t) + R * 0.025 * l;
    const ox = Math.cos(center) * push, oy = Math.sin(center) * push;
    const inner = R * 0.62 * scale;
    const outer = R * 0.92 * scale;
    const base = entries[root].color;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.globalAlpha = t;
    annularSector(ctx, cx, cy, inner, outer, center - half, center + half, 16);
    ctx.fillStyle = i === activeChild ? "rgba(255,255,255,1)" : "rgba(255,255,255,1)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = i === activeChild ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.08)";
    ctx.stroke();

    const midR = (inner + outer) / 2;
    const ix = cx + midR * Math.cos(center);
    const iy = cy + midR * Math.sin(center);
    let fs = R * 0.045;
    ctx.font = `${Math.round(fs)}px system-ui, sans-serif`;
    ctx.fillStyle = "#1a1a1a";
    while (ctx.measureText(ch.label).width > (outer - inner) * 1.1 && fs > 8) {
      fs -= 1;
      ctx.font = `${Math.round(fs)}px system-ui, sans-serif`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ch.label, ix, iy);
    ctx.restore();
  }

  function drawHub() {
    const r = R * 0.20;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.stroke();

    let title = "", sub = "", icon = "";
    if (activeRoot >= 0) {
      const e = entries[activeRoot];
      if (activeChild >= 0 && e.children?.[activeChild]) {
        title = e.children[activeChild].label;
        sub = e.children[activeChild].state ?? "";
      } else {
        title = e.label;
        sub = e.state ?? "";
        icon = e.icon;
      }
    } else {
      title = "菜单";
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (icon) {
      ctx.font = `${Math.round(R * 0.085)}px system-ui, sans-serif`;
      ctx.fillStyle = "#1a1a1a";
      ctx.fillText(icon, cx, cy - R * 0.04);
      ctx.font = `${Math.round(R * 0.042)}px system-ui, sans-serif`;
      ctx.fillStyle = "#333";
      ctx.fillText(title, cx, cy + R * 0.07);
    } else {
      ctx.font = `${Math.round(R * 0.048)}px system-ui, sans-serif`;
      ctx.fillStyle = "#1a1a1a";
      ctx.fillText(title, cx, cy - (sub ? R * 0.02 : 0));
    }
    if (sub) {
      ctx.font = `${Math.round(R * 0.034)}px system-ui, sans-serif`;
      ctx.fillStyle = "#888";
      ctx.fillText(sub, cx, cy + R * 0.09);
    }
  }

  function frame() {
    if (!visible) return;
    const now = performance.now();

    const h = hit(mouseX, mouseY);
    if (h.root !== activeRoot || h.child !== activeChild) {
      activeRoot = h.root;
      activeChild = h.child;
      childFocus = h.child >= 0;
      dirty = true;
    }
    for (let i = 0; i < entries.length; i++) {
      const target = i === activeRoot ? 1 : 0;
      const prev = lift[i] ?? 0;
      const next = prev + (target - prev) * 0.2;
      if (Math.abs(next - prev) > 0.001) { lift[i] = next; dirty = true; }
      else lift[i] = target;
    }
    const cc = childCount(activeRoot);
    childLift.length = cc;
    for (let i = 0; i < cc; i++) {
      const target = i === activeChild ? 1 : 0;
      const prev = childLift[i] ?? 0;
      const next = prev + (target - prev) * 0.2;
      if (Math.abs(next - prev) > 0.001) { childLift[i] = next; dirty = true; }
      else childLift[i] = target;
    }
    if (now - openedAt < REVEAL_DURATION + entries.length * REVEAL_STAGGER + 50) {
      dirty = true;
    }

    if (dirty) {
      dirty = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      for (let i = 0; i < entries.length; i++) {
        drawRoot(i, now);
      }
      if (activeRoot >= 0 && childCount(activeRoot)) {
        for (let i = 0; i < childCount(activeRoot); i++) drawChild(activeRoot, i, now);
      }
      drawHub();
    }

    raf = requestAnimationFrame(frame);
  }

  async function open(x: number, y: number) {
    if (visible) return;
    visible = true;
    resizeCanvas();
    cx = x; cy = y;
    layout();
    try { await opts.onOpen?.(); } catch { /* */ }
    if (!visible) return;
    entries = opts.getEntries();
    lift = new Array(entries.length).fill(0);
    childLift = [];
    activeRoot = -1; activeChild = -1;
    pressedRoot = -1; pressedChild = -1;
    childFocus = false;
    openedAt = performance.now();
    dirty = true;
    canvas.style.pointerEvents = "auto";
    void invoke("set_interacting", { active: true }).catch(() => {});
    void invoke("set_menu_open", { open: true }).catch(() => {});
    document.dispatchEvent(new CustomEvent("petra:radial-opened"));
    raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!visible) return;
    visible = false;
    cancelAnimationFrame(raf);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    canvas.style.pointerEvents = "none";
    void invoke("set_interacting", { active: false }).catch(() => {});
    void invoke("set_menu_open", { open: false }).catch(() => {});
    document.dispatchEvent(new CustomEvent("menu-closed"));
    activeRoot = -1; activeChild = -1;
  }

  function activate() {
    if (activeRoot < 0) return;
    const e = entries[activeRoot];
    if (activeChild >= 0 && e.children?.[activeChild]) {
      const c = e.children[activeChild];
      close();
      c.onPick?.();
      return;
    }
    if (e.children && e.children.length) return;
    close();
    e.onPick?.();
  }

  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (visible) { close(); return; }
    if (opts.isInsideModel && !opts.isInsideModel(e.clientX, e.clientY)) return;
    void open(e.clientX, e.clientY);
  });

  window.addEventListener("petra:show-menu", (e) => {
    const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
    void open(x, y);
  });

  canvas.addEventListener("pointermove", (e) => {
    mouseX = e.clientX; mouseY = e.clientY;
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    mouseX = e.clientX; mouseY = e.clientY;
    const h = hit(mouseX, mouseY);
    if (h.root < 0) { close(); return; }
    pressedRoot = h.root; pressedChild = h.child;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    mouseX = e.clientX; mouseY = e.clientY;
    const h = hit(mouseX, mouseY);
    if (h.root === pressedRoot && h.child === pressedChild) {
      activeRoot = h.root; activeChild = h.child;
      activate();
    }
    pressedRoot = -1; pressedChild = -1;
  });
  document.addEventListener("keydown", (e) => {
    if (!visible) return;
    if (e.key === "Escape") {
      if (childFocus) { childFocus = false; activeChild = -1; dirty = true; }
      else close();
    }
  });
  window.addEventListener("blur", () => close());
  window.addEventListener("resize", () => { resizeCanvas(); if (visible) layout(); });
}
