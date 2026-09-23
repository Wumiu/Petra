import { invoke } from "@tauri-apps/api/core";
export interface MenuItemSpec {
  id: string;
  label?: string;
  state?: string;
  danger?: boolean;
  separator?: boolean;
  submenu?: MenuItemSpec[];  // 子菜单
  onPick?: () => void;
  onStatePick?: () => void;
  /**
   * 行内自定义控件（例如免打扰时段的 ▲▼ 调时）。
   * 填进这一行右侧；这一行不参与"点击即关闭菜单"，控件内部自己处理点击。
   */
  control?: (row: HTMLElement) => void;
}

/**
 * 玻璃拟态右键菜单。右键点桌宠唤出。
 * getVisibleRect 返回窗口内可见逻辑区（待机时窗口部分在屏外），菜单 clamp 到该区，
 * 超高时 max-height + 滚动，保证待机也能看到/操作菜单。
 */
export function setupContextMenu(
  build: () => MenuItemSpec[],
  onOpen?: () => Promise<void> | void,
  getVisibleRect?: () => { left: number; top: number; right: number; bottom: number },
  isInsideModel?: (x: number, y: number) => boolean,
  getModelRect?: () => { left: number; top: number; right: number; bottom: number } | null,
) {
  const menu = document.getElementById("menu") as HTMLElement;
  let visible = false;

  /**
   * 按"菜单顶边 → 可见区底部"的实际空间设置最大高度。
   * 展开子菜单后内容变高，必须重算，否则底边（重启/退出）会跑出可视区、连滚动条都够不到。
   */
  const fitMenu = () => {
    const vr = getVisibleRect?.() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const top = Number.parseFloat(menu.style.top || "0") || 0;
    menu.style.maxHeight = `${Math.max(60, Math.floor(vr.bottom - top - 8))}px`;
    menu.style.overflowY = "auto";
  };

  /** 收起全部子菜单（含嵌套层级） */
  const closeAllSubmenus = () => {
    menu.querySelectorAll(".pet-menu").forEach((el) => el.classList.add("hidden"));
  };

  /**
   * 递归渲染菜单项：支持多级子菜单（手风琴式向下展开，样式见 .pet-menu .pet-menu）。
   * 子菜单容器插在父行后面（.mi 是 flex 容器，放进去会被横向排到右侧）。
   */
  const renderItems = (items: MenuItemSpec[], container: HTMLElement, depth: number) => {
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "sep";
        container.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = `mi${item.danger ? " danger" : ""}${depth > 0 ? " mi-nested" : ""}`;
      if (depth > 0) row.style.paddingLeft = `${10 + depth * 12}px`;

      const labelSpan = document.createElement("span");
      labelSpan.textContent = item.label ?? "";
      row.appendChild(labelSpan);

      if (item.state !== undefined) {
        const stateSpan = document.createElement("span");
        stateSpan.className = "state";
        stateSpan.textContent = item.state;
        if (item.onStatePick) {
          stateSpan.style.cursor = "pointer";
          stateSpan.addEventListener("click", (ev) => { ev.stopPropagation(); hide("state-pick"); item.onStatePick?.(); });
        }
        row.appendChild(stateSpan);
      }

      if (item.control) {
        row.classList.add("mi-control");
        // 显式登记为可点击区域：菜单整体虽在交互白名单里，
        // 但控件行会被 region 采集按 [data-petra-interactive] 再单独登记一次，避免点不透
        row.dataset.petraInteractive = `menu-control-${item.id}`;
        item.control(row);
        // 控件行：点击落在行内不关菜单（▲▼ 要能连点），也不走 onPick
        row.addEventListener("click", (ev) => ev.stopPropagation());
        container.appendChild(row);
        continue;
      }

      if (item.submenu && item.submenu.length) {
        const arrow = document.createElement("span");
        arrow.className = "state";
        arrow.textContent = "▶";
        row.appendChild(arrow);

        const sub = document.createElement("div");
        sub.className = "pet-menu submenu-level hidden";
        renderItems(item.submenu, sub, depth + 1);

        // 收起同级其它分支（连同它们已展开的深层分支）
        const closeSiblings = () => {
          for (const el of Array.from(container.children)) {
            if (!(el instanceof HTMLElement) || !el.classList.contains("pet-menu")) continue;
            el.classList.add("hidden");
            el.querySelectorAll(".pet-menu").forEach((deep) => deep.classList.add("hidden"));
          }
        };

        row.addEventListener("click", (ev) => {
          ev.stopPropagation();
          // 直接看 DOM 判断展开状态，避免与"点击别处收起"产生状态不同步
          if (!sub.classList.contains("hidden")) {
            sub.classList.add("hidden");
            fitMenu();
            return;
          }
          closeSiblings();
          sub.classList.remove("hidden");
          // 展开后内容变高：重算高度（超出即滚动），并把新展开的子菜单滚进可视区
          fitMenu();
          sub.scrollIntoView({ block: "nearest" });
        });

        container.appendChild(row);
        container.appendChild(sub);
      } else {
        row.addEventListener("click", (ev) => {
          ev.stopPropagation();
          hide("row-click");
          item.onPick?.();
        });
        container.appendChild(row);
      }
    }
  };

  const render = () => {
    menu.innerHTML = "";
    renderItems(build(), menu, 0);
  };

  const showAt = async (x: number, y: number) => {
    visible = true;
    // 先执行 onOpen（里面可以 await 拉取最新状态，例如开机自启/置顶），
    // 再 render()，避免菜单先按旧缓存渲染出错误状态。
    try {
      await onOpen?.();
    } catch {
      /* 状态拉取失败不阻塞菜单 */
    }
    // 等待期间用户可能已经左键关闭菜单，这里不要再弹出来
    if (!visible) return;
    render();
    menu.classList.remove("hidden");
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;

    // 菜单跟随右键位置弹出，clamp 到窗口可见区域（往屏幕内侧翻，不出屏）
    const vr = getVisibleRect?.() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    let left = x + 12;
    if (left + w > vr.right) left = x - w - 12;
    if (left < vr.left) left = vr.left;
    let top = y;
    if (top + h > vr.bottom) top = vr.bottom - h;
    if (top < vr.top) top = vr.top;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    fitMenu();
  };

  const hide = (src = "?") => {
    if (!visible) return;
    menu.classList.add("hidden");
    visible = false;
    // 通知 main.ts 立即移除 menuRect。
    document.dispatchEvent(new CustomEvent("menu-closed"));
    void invoke("set_menu_open", { open: false }).catch(() => {});
  };

  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (isInsideModel && !isInsideModel(e.clientX, e.clientY)) return;
    void invoke("set_menu_open", { open: true }).catch(() => {});
    showAt(e.clientX, e.clientY);
  });

  // pointerdown 关闭菜单：按下瞬间生效（在绿框内按下拖动时不会触发 click，所以用 pointerdown）
  document.addEventListener("pointerdown", (e) => {
    // 只对左键生效：右键（btn=2）本身也是 pointerdown，不能用来关菜单
    if (e.button !== 0) return;
    if (visible && !menu.contains(e.target as Node)) hide("pd-outside");
  });
  // pointerup 和 click 事件流监控
  document.addEventListener("pointerup", (e) => {
  });
  document.addEventListener("click", (e) => {
  });

  // Native watcher 检测光标移出整个窗口后关闭菜单。
  document.addEventListener("menu-hide-request", () => {
    if (visible) hide("cursor-outside");
  });

  // 菜单内非菜单行的空白处点击 → 收起所有子菜单
  document.addEventListener("click", (e) => {
    if (!visible) return;
    const target = e.target as HTMLElement | null;
    if (!target || !menu.contains(target)) return;
    if (target.closest(".mi")) return; // 行自身的点击逻辑已 stopPropagation
    closeAllSubmenus();
    fitMenu();
  });
}
