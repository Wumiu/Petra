/**
 * 手臂旋转轴心调试（挂在「模型调节（测试）」面板里）。
 *
 * 为什么需要它：手臂"绕轴旋转"只盯数字很难判断，轴差几十像素就变成"根部上升"。
 * 这里在模型上叠出每只手的紧包围盒 + 可点击的小方块准星，配角度滑杆实时预览绕轴旋转，
 * 对了就保存 —— 保存后**立刻**用于真实动画（挥手/举手/跟随鼠标），并按模型记在本地。
 *
 * 用法：右键 → 交互 → 🎨 模型调节（测试）→ 底部「手臂轴心（测试）」
 *   · 点方框内任意位置 = 把该手的轴移过去（红/绿小方块就是轴）
 *   · 开「对称」= 调一侧自动镜像到另一侧（按模型中轴镜像）
 *   · 拉角度滑杆或勾「自动摆动」= 实时看手臂绕轴转，盯手根是否定点不动
 *   · 「复制坐标」= 复制 JSON 发给开发者，可烘成默认值
 */
import { toast } from "../../ui/Toast";
import { copyText } from "../../ui/clipboard";
import { exportHandAxes, type HandAxis } from "./handAxis";

export interface AxisPickableView {
  canvas: HTMLCanvasElement;
  axisCanvasSize: { w: number; h: number };
  handAxisInfo(): Array<{
    side: "L" | "R";
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    axis: HandAxis;
    auto: HandAxis;
    perHand: boolean;
  }>;
  setHandAxis(side: "L" | "R", x: number, y: number): void;
  resetHandAxes(): void;
  armPreview: { L: number; R: number } | null;
  /** 模型中轴（对称镜像用） */
  modelCenterX: number;
}

const SIDE_LABEL = { L: "屏幕左手", R: "屏幕右手" } as const;

let overlay: HTMLElement | null = null;
let overlayHost: HTMLElement | null = null;
let axisHost: HTMLElement | null = null;
let raf = 0;
let activeView: AxisPickableView | null = null;

/** 调试状态（会话内共享）：对称开关 / 预览角度 / 自动摆动 */
// 默认都关：打开面板不自动镜像、也不自动摆手（用户要求）
const dbg = { symmetry: false, autoSway: false, angleL: 0, angleR: 0 };

/** 在模型上叠一层：每个手臂图层的包围盒 + 可点的小方块准星 */
function ensureOverlay(): HTMLElement {
  if (overlay) return overlay;
  const root = document.createElement("div");
  root.id = "hand-axis-overlay";
  const host = document.createElement("div");
  host.className = "hao-layers";
  root.appendChild(host);
  document.body.appendChild(root);
  overlay = root;
  overlayHost = host;
  return root;
}

function paintOverlay(view: AxisPickableView) {
  if (!overlay || !overlayHost) return;
  const rect = view.canvas.getBoundingClientRect();
  const { w, h } = view.axisCanvasSize;
  const s = rect.width / w;
  const items = view.handAxisInfo();

  if (overlayHost.children.length !== items.length) {
    overlayHost.innerHTML = "";
    for (const it of items) {
      const box = document.createElement("div");
      box.className = "hao-box";
      // 点框内任意处 = 把轴移过来（窗口是穿透的，登记过才收点击）
      box.dataset.petraInteractive = `hand-axis-box-${it.side}`;
      box.title = `${it.name}（${SIDE_LABEL[it.side]}）：点这里把轴移过来`;
      const label = document.createElement("div");
      label.className = "hao-box-label";
      const mark = document.createElement("div");
      mark.className = "hao-mark";
      box.append(label, mark);
      box.addEventListener("pointerdown", (ev) => onPick(view, it.side, ev));
      overlayHost.appendChild(box);
    }
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const el = overlayHost.children[i] as HTMLElement;
    el.style.left = `${rect.left + it.x * s}px`;
    el.style.top = `${rect.top + it.y * s}px`;
    el.style.width = `${it.w * s}px`;
    el.style.height = `${it.h * s}px`;
    const label = el.firstChild as HTMLElement;
    label.textContent = `${SIDE_LABEL[it.side]}${it.perHand ? "" : "（未拆分）"}`;
    const mark = el.lastChild as HTMLElement;
    mark.style.left = `${(it.axis.x - it.x) * s}px`;
    mark.style.top = `${(it.axis.y - it.y) * s}px`;
    mark.dataset.side = it.side;
  }
}

/** 点/拖：把轴设到指针位置；开了对称就镜像到另一侧 */
function onPick(view: AxisPickableView, side: "L" | "R", ev: PointerEvent) {
  const rect = view.canvas.getBoundingClientRect();
  const { w, h } = view.axisCanvasSize;
  const mx = ((ev.clientX - rect.left) / rect.width) * w;
  const my = ((ev.clientY - rect.top) / rect.height) * h;
  view.setHandAxis(side, mx, my);
  if (dbg.symmetry) {
    const cx = view.modelCenterX;
    const other: "L" | "R" = side === "L" ? "R" : "L";
    view.setHandAxis(other, 2 * cx - mx, my);
  }
  ev.preventDefault();
  ev.stopPropagation();
}

function startOverlayLoop() {
  if (raf) return;
  const loop = () => {
    // 面板被重建/隐藏时（host 断开）自动收尾，避免叠加层和预览残留
    if (!overlay || !activeView || !overlayHost?.isConnected || !axisHost?.isConnected) {
      if (activeView) activeView.armPreview = null;
      activeView = null;
      overlay?.remove();
      overlay = null;
      overlayHost = null;
      raf = 0;
      return;
    }
    if (dbg.autoSway) {
      const t = performance.now() / 1000;
      dbg.angleL = Math.sin(t * 1.6) * 0.8;
      dbg.angleR = Math.sin(t * 1.6 + Math.PI / 3) * 0.8;
    }
    // 只有"自动摆动开着"或"滑杆不在 0"时才接管手臂；
    // 否则完全不干预（打开面板不会冻结挥手/举手等正常动画）
    activeView.armPreview =
      dbg.autoSway || dbg.angleL !== 0 || dbg.angleR !== 0
        ? { L: dbg.angleL, R: dbg.angleR }
        : null;
    paintOverlay(activeView);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}

/**
 * 把「手臂轴心（测试）」控件挂进给定容器（模型调节面板用）。
 * 返回卸载函数：移除控件、隐藏叠加层、清掉预览接管。
 */
export function mountHandAxisControls(host: HTMLElement, view: AxisPickableView): () => void {
  activeView = view;
  axisHost = host;
  ensureOverlay();

  const box = document.createElement("div");
  box.className = "hao-controls";

  const title = document.createElement("div");
  title.className = "mp-hint";
  title.style.fontWeight = "600";
  title.textContent = "手臂轴心（测试）";
  box.appendChild(title);

  const hint = document.createElement("div");
  hint.className = "hao-tip";
  hint.textContent = "点模型上的方框 = 把该手的旋转轴移过去；看手根是否定点不动。";
  box.appendChild(hint);

  // 对称开关
  const symRow = document.createElement("label");
  symRow.className = "hao-row hao-check";
  const sym = document.createElement("input");
  sym.type = "checkbox";
  sym.checked = dbg.symmetry;
  sym.addEventListener("change", () => (dbg.symmetry = sym.checked));
  symRow.append(sym, document.createTextNode(" 对称（改一侧自动镜像到另一侧）"));
  box.appendChild(symRow);

  // 角度滑杆
  const mkSlider = (label: string, get: () => number, set: (v: number) => void) => {
    const row = document.createElement("div");
    row.className = "hao-row";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = "-2"; // 预览范围放宽到 ±2（真实动作大概在 ±1 内，留出余量方便夸张对比）
    input.max = "2";
    input.step = "0.02";
    input.value = String(get());
    const val = document.createElement("code");
    val.textContent = Number(input.value).toFixed(2);
    input.addEventListener("input", () => {
      dbg.autoSway = false;
      if (sway) sway.checked = false;
      set(Number(input.value));
      val.textContent = Number(input.value).toFixed(2);
    });
    row.append(span, input, val);
    box.appendChild(row);
    return input;
  };
  const lIn = mkSlider("左臂角度", () => dbg.angleL, (v) => (dbg.angleL = v));
  const rIn = mkSlider("右臂角度", () => dbg.angleR, (v) => (dbg.angleR = v));

  // 自动摆动
  const swayRow = document.createElement("label");
  swayRow.className = "hao-row hao-check";
  const sway = document.createElement("input");
  sway.type = "checkbox";
  sway.checked = dbg.autoSway;
  sway.addEventListener("change", () => (dbg.autoSway = sway.checked));
  swayRow.append(sway, document.createTextNode(" 自动摆动（来回挥手）"));
  box.appendChild(swayRow);

  const info = document.createElement("div");
  info.className = "hao-info";
  box.appendChild(info);

  const btns = document.createElement("div");
  btns.className = "as-set-btns";
  const copyBtn = document.createElement("button");
  copyBtn.className = "as-btn";
  copyBtn.textContent = "复制坐标";
  copyBtn.addEventListener("click", () => {
    void copyText(exportHandAxes()).then((ok) =>
      toast(ok ? "轴坐标 JSON 已复制，发我即可烘成默认值" : "复制失败，请手动截取", ok ? "info" : "warn"),
    );
  });
  const resetBtn = document.createElement("button");
  resetBtn.className = "as-btn";
  resetBtn.textContent = "重置为自动";
  resetBtn.addEventListener("click", () => {
    view.resetHandAxes();
    toast("已回到自动轴（该手内侧上角）");
  });
  btns.append(copyBtn, resetBtn);
  box.appendChild(btns);
  host.appendChild(box);

  // 数值/状态刷新（面板打开期间一直更新）
  const refresh = () => {
    if (!host.isConnected) return;
    const lines = view
      .handAxisInfo()
      .map((it) => `${SIDE_LABEL[it.side]} 轴 = (${it.axis.x}, ${it.axis.y})  自动 = (${it.auto.x}, ${it.auto.y})`);
    info.innerHTML = lines.join("<br>");
    if (document.activeElement !== lIn) lIn.value = String(dbg.angleL);
    if (document.activeElement !== rIn) rIn.value = String(dbg.angleR);
    setTimeout(refresh, 400);
  };
  refresh();
  startOverlayLoop();

  return () => {
    box.remove();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    overlay?.remove();
    overlay = null;
    overlayHost = null;
    axisHost = null;
    if (activeView) activeView.armPreview = null;
    activeView = null;
  };
}
