import type { MenuItemSpec } from "./ContextMenu";

/**
 * 独立设置窗口：收纳从右键菜单移除的全部功能项。
 *
 * 设计要点：
 * - 数据来源是「回调」而不是静态快照：每次点击后重新 build() 渲染，
 *   开/关状态（待机模式、置顶、开机自启……）永远显示最新值；
 * - 顶级项带 submenu 的渲染成「分组标题 + 子项行」，无 submenu 的归入「通用」组；
 * - 点击行执行原菜单的 onPick（行为与旧右键菜单完全一致），面板保持打开；
 * - 带 onStatePick 的行（如 隐藏/置顶），右侧 state 文本可点击。
 */

let panel: HTMLElement | null = null;

export function closeSettingsPanel() {
  panel?.classList.add("hidden");
}

export function isSettingsPanelOpen() {
  return !!panel && !panel.classList.contains("hidden");
}

export function openSettingsPanel(
  build: () => MenuItemSpec[],
  position: (p: HTMLElement) => void,
) {
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "settings-window";
    panel.className = "model-panel hidden";
    // 与其它面板一致：面板内按下不冒泡（避免触发拖动/穿透逻辑）
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.style.width = "300px";
    panel.style.overflowY = "auto";
    document.body.appendChild(panel);
  }
  const host = panel;
  render();
  host.classList.remove("hidden");
  position(host);

  function render() {
    while (host.firstChild) host.removeChild(host.firstChild);

    // ---- 标题栏 ----
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;";
    const title = document.createElement("div");
    title.className = "mp-title";
    title.textContent = "设置";
    const close = document.createElement("span");
    close.textContent = "✕";
    close.style.cssText = "cursor:pointer;font-size:14px;color:#9a8a9a;padding:2px 6px;border-radius:8px;";
    close.title = "关闭设置";
    close.addEventListener("click", () => closeSettingsPanel());
    header.append(title, close);
    host.appendChild(header);

    // ---- 分组渲染 ----
    const items = build();
    const general: MenuItemSpec[] = [];
    for (const item of items) {
      if (item.separator || item.hint) continue;
      if (item.submenu && item.submenu.length) {
        host.appendChild(buildGroup(item.label ?? "", item.submenu));
      } else {
        general.push(item);
      }
    }
    if (general.length) host.appendChild(buildGroup("通用", general));
  }

  function buildGroup(groupTitle: string, rows: MenuItemSpec[]): HTMLElement {
    const group = document.createElement("div");
    group.style.cssText = "margin:6px 0 10px;";
    const t = document.createElement("div");
    t.style.cssText = "font-size:11px;color:#9a8a9a;margin:2px 0 4px 4px;letter-spacing:1px;";
    t.textContent = groupTitle;
    group.appendChild(t);
    for (const item of rows) {
      if (item.separator || item.hint) continue;
      group.appendChild(buildRow(item));
    }
    return group;
  }

  function buildRow(item: MenuItemSpec): HTMLElement {
    const row = document.createElement("div");
    row.className = `st-row${item.danger ? " st-danger" : ""}`;
    row.style.cssText = [
      "display:flex;align-items:center;justify-content:space-between;gap:8px;",
      "padding:8px 12px;margin:2px 0;border-radius:10px;cursor:pointer;font-size:13px;",
      "background:rgba(255,255,255,.35);transition:background .15s;",
    ].join("");
    row.addEventListener("mouseenter", () => (row.style.background = "rgba(255,255,255,.65)"));
    row.addEventListener("mouseleave", () => (row.style.background = "rgba(255,255,255,.35)"));

    const label = document.createElement("span");
    label.textContent = item.label ?? "";
    row.appendChild(label);

    if (item.state !== undefined) {
      const st = document.createElement("span");
      st.style.cssText = "color:#8a7a8a;font-size:12px;white-space:nowrap;";
      st.textContent = item.state;
      if (item.onStatePick) {
        st.style.cursor = "pointer";
        st.style.textDecoration = "underline dotted";
        st.addEventListener("click", (ev) => {
          ev.stopPropagation();
          item.onStatePick?.();
          render(); // 状态变更后刷新显示
        });
      }
      row.appendChild(st);
    }

    if (item.control) {
      item.control(row); // 行内控件（如 ▲▼ 调时）：控件自己 stopPropagation
    }

    row.addEventListener("click", () => {
      item.onPick?.();
      render(); // 点击后重渲染，刷新所有开/关状态
    });
    return row;
  }
}
