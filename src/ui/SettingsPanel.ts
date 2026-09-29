/**
 * Bongocat 风格的设置窗口。
 *
 * 作为主窗口内的一个不透明模态面板呈现：打开时把主窗口临时放大到
 * 960x720，左侧导航 + 右侧分组列表；关闭后缩回 700x700 恢复桌宠。
 * 所有 onPick 回调直接复用 main.ts 里已有的函数，功能零丢失。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";

export interface SettingsRow {
  label: string;
  state?: string;
  danger?: boolean;
  checked?: boolean;
  /** 点击行；返回 false / void 都行 */
  onPick: () => void;
}

export interface SettingsSection {
  title: string;
  rows: SettingsRow[];
}

export interface SettingsPanelHandle {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  render: () => void;
  showStandalone: () => void;
}

const ORIGINAL_SIZE = 700;
const PANEL_SIZE = 720;
const PANEL_HEIGHT = 560;

export function setupSettingsPanel(opts: {
  getSections: () => SettingsSection[];
  onOpen?: () => void;
}): SettingsPanelHandle {
  const win = getCurrentWindow();

  const root = document.createElement("div");
root.id = "settings-panel";
  root.dataset.petraInteractive = "settings-panel";
  root.className = "settings-panel hidden";
  root.innerHTML = `
    <div class="sp-sidebar">
      <div class="sp-brand" data-tauri-drag-region>
        <img class="sp-brand-icon" src="/app-icon.png" alt="logo" draggable="false">
        <span>Petra 设置</span>
      </div>
      <div class="sp-nav"></div>
      <div class="sp-sidebar-foot">
        <div class="sp-theme" title="切换亮/暗背景">🌙 暗色</div>
        <div class="sp-close">✕ 关闭</div>
      </div>
    </div>
    <div class="sp-main">
      <div class="sp-content"></div>
    </div>
  `;
  document.body.appendChild(root);

  const navEl = root.querySelector(".sp-nav") as HTMLElement;
  const contentEl = root.querySelector(".sp-content") as HTMLElement;
  const closeBtn = root.querySelector(".sp-close") as HTMLElement;

  let openState = false;
  let activeSection = 0;

  function render() {
    const sections = opts.getSections();
    navEl.innerHTML = "";
    contentEl.innerHTML = "";
    sections.forEach((sec, i) => {
      const btn = document.createElement("div");
      btn.className = "sp-nav-item" + (i === activeSection ? " active" : "");
      btn.textContent = sec.title;
      btn.addEventListener("click", () => {
        activeSection = i;
        render();
      });
      navEl.appendChild(btn);

      const page = document.createElement("div");
      page.className = "sp-page" + (i === activeSection ? " active" : "");
      sec.rows.forEach((row) => {
        const r = document.createElement("div");
        r.className = "sp-row" + (row.danger ? " danger" : "");
        const label = document.createElement("span");
        label.className = "sp-row-label";
        label.textContent = row.label;
        if (row.checked !== undefined) {
          const sw = document.createElement("span");
          sw.className = "sp-switch" + (row.checked ? " on" : "");
          sw.innerHTML = '<span class="sp-switch-knob"></span>';
          r.append(label, sw);
        } else {
          const state = document.createElement("span");
          state.className = "sp-row-state";
          state.textContent = row.state ?? "";
          r.append(label, state);
        }
        r.addEventListener("click", () => {
          try { row.onPick(); } catch (err) { console.warn(err); }
          if (row.checked !== undefined) {
            // 开关类：留在面板里刷新状态
            setTimeout(render, 50);
          } else {
            // 打开子面板/跳转类：先关设置，避免盖住新弹出的面板
            void close();
          }
        });
        page.appendChild(r);
      });
      contentEl.appendChild(page);
    });
  }

  async function open() {
    if (openState) return;
    openState = true;
    try { await opts.onOpen?.(); } catch { /* ignore */ }
    activeSection = 0;
    render();
    root.classList.remove("hidden");
    // 直接告诉 Rust：整窗锁定输入，不依赖交互矩形上报（避免 resize 时序问题）
    void invoke("set_interacting", { active: true }).catch(() => {});
    void invoke("set_menu_open", { open: true }).catch(() => {});
    document.dispatchEvent(new CustomEvent("petra:settings-opened"));
    try {
      await win.setSize(new LogicalSize(PANEL_SIZE, PANEL_HEIGHT));
      await win.center();
    } catch { /* ignore */ }
  }

  async function close() {
    if (!openState) return;
    openState = false;
    root.classList.add("hidden");
    void invoke("set_interacting", { active: false }).catch(() => {});
    void invoke("set_menu_open", { open: false }).catch(() => {});
    document.dispatchEvent(new CustomEvent("petra:settings-closed"));
    try {
      await win.setSize(new LogicalSize(ORIGINAL_SIZE, ORIGINAL_SIZE));
    } catch { /* ignore */ }
  }

  const themeBtn = root.querySelector(".sp-theme") as HTMLElement;
  let lightTheme = localStorage.getItem("petra-settings-theme") === "light";
  function applyTheme() {
    root.classList.toggle("light", lightTheme);
    themeBtn.textContent = lightTheme ? "☀️ 亮色" : "🌙 暗色";
  }
  applyTheme();
  themeBtn.addEventListener("click", () => {
    lightTheme = !lightTheme;
    localStorage.setItem("petra-settings-theme", lightTheme ? "light" : "dark");
    applyTheme();
  });
  closeBtn.addEventListener("click", () => void close());
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void close();
  });
  // 让面板能接收键盘事件
  root.tabIndex = -1;

  function showStandalone() {
    openState = true;
    render();
    root.classList.remove("hidden");
  }
  return { open, close, isOpen: () => openState, render, showStandalone };
}
