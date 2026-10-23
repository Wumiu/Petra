import type { MenuItemSpec } from "./ContextMenu";

/**
 * 独立设置窗口：收纳从右键菜单移出的全部功能项。
 *
 * 设计要点：
 * - 数据源是「回调」而不是静态快照：每次操作后重新 build() 渲染，
 *   开/关状态（待机模式、置顶、开机自启…）永远显示最新值；
 * - 支持任意层级 submenu（缩进子分组渲染）—— buildMenu() 里有嵌套子菜单，
 *   直接平铺会让「父行」变成点了没反应的死行；
 * - 点击行执行原菜单的 onPick（行为与旧右键菜单完全一致），面板保持打开；
 * - 带 onStatePick 的行（如 隐藏=取消置顶），右侧 state 文本可单独点击；
 * - control 行（免打扰时段 ▲▼ 调时）由控件自己 stopPropagation，行本身不重渲染。
 */

let panel: HTMLElement | null = null;
/** 当前数据源：render() 每次都用它重新取一遍最新状态 */
let currentBuild: (() => MenuItemSpec[]) | null = null;
/** 常规定位（贴着角色）与「让位到底部」两种摆法，都由 main.ts 提供 */
let placeNear: ((p: HTMLElement) => void) | null = null;
let placeBottom: ((p: HTMLElement) => void) | null = null;

/** 空闲多久自动收起设置窗口（用户要求：长时间不点击也要自己消失） */
const SETTINGS_IDLE_MS = 25000;
let idleTimer: number | null = null;
/** 是否正被二级面板「挤」在底部停靠中 */
let docked = false;
/** 轮询二级面板有没有关掉（关了就自动变回原位） */
let dockWatch: number | null = null;

export function closeSettingsPanel() {
  stopIdle();
  stopDockWatch();
  docked = false;
  panel?.classList.add("hidden");
}

function armIdle() {
  stopIdle();
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    // 停靠中说明用户在调二级面板，这时候把入口收掉反而添乱
    if (docked) return;
    closeSettingsPanel();
  }, SETTINGS_IDLE_MS);
}

function stopIdle() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * 二级面板关掉后把设置窗口变回原位（用户要求「改完了要变回来」）。
 *
 * 只盯**这次点开的那几个**面板：别家用别的面板（比如之前开着的小助手设置）不该
 * 把设置窗口一直扣在底部 —— 这是踩过的坑，早先按「有没有任何面板开着」判断，
 * 只要有一块残留面板没关，设置窗口就永远回不去。
 */
function startDockWatch(watchIds: string[]) {
  stopDockWatch();
  dockWatch = window.setInterval(() => {
    if (!panel || panel.classList.contains("hidden")) {
      stopDockWatch();
      return;
    }
    const stillOpen = visiblePanelIds().some((id) => watchIds.includes(id));
    if (stillOpen) return;
    stopDockWatch();
    docked = false;
    // 清掉停靠时写死的宽高，交回给常规定位（它会按可见区重算 maxWidth/maxHeight）
    panel.style.width = "";
    panel.style.maxHeight = "";
    placeNear?.(panel);
    armIdle(); // 变回原位后重新开始空闲计时
  }, 400);
}

function stopDockWatch() {
  if (dockWatch !== null) {
    clearInterval(dockWatch);
    dockWatch = null;
  }
}

export function isSettingsPanelOpen() {
  return !!panel && !panel.classList.contains("hidden");
}

export function openSettingsPanel(
  build: () => MenuItemSpec[],
  position: (p: HTMLElement) => void,
  dockBottom?: (p: HTMLElement) => void,
) {
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "settings-window";
    // 与其它面板一致：面板内按下不冒泡（避免触发拖动 / 点击穿透逻辑）
    panel.className = "model-panel settings-window";
    panel.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      armIdle(); // 在面板里点任何东西都算"还在用"
    });
    // 只认「真的在操作」：点击/滚轮/按键。鼠标只是从上面划过不算
    //（否则用户把鼠标停在桌宠上，设置窗口就永远不消失）
    panel.addEventListener("wheel", () => armIdle(), { passive: true });
    panel.addEventListener("keydown", () => armIdle());
    document.body.appendChild(panel);
  }
  currentBuild = build;
  placeNear = position;
  placeBottom = dockBottom ?? position;
  render();
  panel.classList.remove("hidden");
  position(panel);
  docked = false;
  stopDockWatch();
  armIdle();
}

/** 当前所有可见的「二级面板」id（排除设置窗口自己） */
function visiblePanelIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".model-panel, #chat-history-panel, #asr-dlg, .rm-modal-box"),
  )
    .filter((el) => el.id !== "settings-window" && !el.classList.contains("hidden") && !el.classList.contains("closing"))
    .map((el) => el.id || el.className);
}

function render() {
  const host = panel;
  if (!host) return;
  // 记住滚动位置：render() 会把整个内容区删掉重建，新元素 scrollTop 归零 ——
  // 列表 20+ 行在 700 窗口里必然要滚，每点一下就跳回顶部会让人以为"点了没反应"。
  const prevBody = host.querySelector(".sw-body") as HTMLElement | null;
  const keepScroll = prevBody ? prevBody.scrollTop : 0;
  while (host.firstChild) host.removeChild(host.firstChild);

  // ---- 标题栏 ----
  const header = document.createElement("div");
  header.className = "sw-header";
  const title = document.createElement("div");
  title.className = "sw-title";
  title.textContent = "设置";
  const close = document.createElement("button");
  close.className = "sw-close";
  close.type = "button";
  close.textContent = "✕";
  close.title = "关闭设置";
  close.setAttribute("aria-label", "关闭设置");
  close.addEventListener("click", () => closeSettingsPanel());
  header.append(title, close);
  host.appendChild(header);

  // ---- 可滚动内容区 ----
  const body = document.createElement("div");
  body.className = "sw-body";
  host.appendChild(body);

  const items = currentBuild?.() ?? [];
  const general: MenuItemSpec[] = [];
  for (const item of items) {
    if (item.separator || item.hint) continue;
    if (item.submenu && item.submenu.length) body.appendChild(group(item.label ?? "", item.submenu));
    else general.push(item);
  }
  if (general.length) body.appendChild(group("通用", general));
  // 恢复滚动位置（内容比上次短时浏览器会自动夹到合法范围）
  if (keepScroll > 0) body.scrollTop = keepScroll;
}

/**
 * 动作后重绘。
 *
 * 真实状态（开机自启、置顶、快捷键）大多是 `invoke().then` 或 `await` 之后才写回缓存，
 * 立刻 render() 只会读到点击前的旧值，异步完成后又不再重绘 —— 表现为「开关显示滞后
 * 一次点击」，第二次点又把第一次真正生效的操作切回去。所以补两次延迟重绘。
 */
function renderAfterAction() {
  render();
  window.setTimeout(() => render(), 200);
  window.setTimeout(() => render(), 700);
}

/** 一组设置项（组标题 + 行） */
function group(titleText: string, rows: MenuItemSpec[]): HTMLElement {
  const g = document.createElement("section");
  g.className = "sw-group";
  if (titleText) {
    const t = document.createElement("div");
    t.className = "sw-group-title";
    t.textContent = titleText;
    g.appendChild(t);
  }
  appendRows(g, rows, false);
  return g;
}

/** 把一列表项塞进容器；嵌套 submenu 渲染成缩进子分组而不是死行 */
function appendRows(container: HTMLElement, rows: MenuItemSpec[], nested: boolean) {
  for (const item of rows) {
    if (item.hint) continue;
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "sw-sep";
      container.appendChild(sep);
      continue;
    }
    if (item.submenu && item.submenu.length) {
      const sub = document.createElement("div");
      sub.className = "sw-subgroup";
      const t = document.createElement("div");
      t.className = "sw-subgroup-title";
      t.textContent = item.label ?? "";
      sub.appendChild(t);
      appendRows(sub, item.submenu, true);
      container.appendChild(sub);
      continue;
    }
    container.appendChild(row(item, nested));
  }
}

function row(item: MenuItemSpec, child: boolean): HTMLElement {
  const r = document.createElement("div");
  r.className = `sw-row${child ? " is-child" : ""}${item.danger ? " is-danger" : ""}`;

  const label = document.createElement("span");
  label.className = "sw-label";
  label.textContent = item.label ?? "";
  r.appendChild(label);

  // 和右键菜单一致：只有真有切换处理器的叶子项才做开关（带 submenu 的项会渲染成子分组）
  const isToggleRow = (item.state === "开" || item.state === "关")
    && !item.submenu
    && !!(item.onStatePick || item.onPick);
  if (isToggleRow) {
    // 纯开/关项做成半拟态开关：点开关本身即切换（与点整行等价）
    const on = item.state === "开";
    const sw = document.createElement("span");
    sw.className = `sw-switch${on ? " is-on" : ""}`;
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(on));
    sw.title = on ? "点击关闭" : "点击开启";
    sw.addEventListener("click", (ev) => {
      ev.stopPropagation();
      (item.onStatePick ?? item.onPick)?.();
      renderAfterAction(); // 切换后重取最新值（异步状态补两次重绘）
    });
    r.appendChild(sw);
  } else if (item.state !== undefined) {
    // 其余状态（30% / Ctrl+Shift+S / 正常 / 23→08）保持文字，避免把数值项误判成开关
    const st = document.createElement("span");
    st.className = `sw-state${item.onStatePick ? " is-clickable" : ""}`;
    st.textContent = item.state;
    if (item.onStatePick) {
      st.addEventListener("click", (ev) => {
        ev.stopPropagation();
        item.onStatePick?.();
        renderAfterAction(); // 状态变了，重取最新值（异步状态补两次重绘）
      });
    }
    r.appendChild(st);
  }

  if (item.control) {
    // 行内控件（▲▼ 调时等）自己处理点击，行不参与 onPick / 重渲染
    item.control(r);
    return r;
  }

  r.addEventListener("click", () => {
    const before = new Set(visiblePanelIds());
    item.onPick?.();
    renderAfterAction(); // 动作后刷新所有开/关状态（异步状态补两次重绘）
    // 这一下真的点开了二级面板（调整模型边界 / 语音设置 / 对话记录…）才让位：
    // 设置窗口沉到最下面腾出角色和绿框，等那个面板关掉再自动变回原位。
    const justOpened = visiblePanelIds().filter((id) => !before.has(id));
    if (panel && justOpened.length) {
      docked = true;
      stopIdle(); // 调二级面板期间不自动收起
      placeBottom?.(panel);
      startDockWatch(justOpened);
    }
  });
  return r;
}
