export interface MenuItemSpec {
  id: string;
  label?: string;
  state?: string;
  danger?: boolean;
  separator?: boolean;
  onPick?: () => void;
}

/**
 * 玻璃拟态右键菜单。右键点桌宠唤出。
 * getVisibleRect 返回窗口内可见逻辑区（待机时窗口部分在屏外），菜单 clamp 到该区，
 * 超高时 max-height + 滚动，保证待机也能看到/操作菜单。
 */
export function setupContextMenu(
  build: () => MenuItemSpec[],
  onOpen?: () => void,
  getVisibleRect?: () => { top: number; height: number },
) {
  const menu = document.getElementById("menu") as HTMLElement;
  let visible = false;

  const render = () => {
    menu.innerHTML = "";
    for (const item of build()) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "sep";
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = `mi${item.danger ? " danger" : ""}`;
      const labelSpan = document.createElement("span");
      labelSpan.textContent = item.label ?? "";
      row.appendChild(labelSpan);
      if (item.state !== undefined) {
        const stateSpan = document.createElement("span");
        stateSpan.className = "state";
        stateSpan.textContent = item.state;
        row.appendChild(stateSpan);
      }
      row.addEventListener("click", () => {
        hide();
        item.onPick?.();
      });
      menu.appendChild(row);
    }
  };

  const showAt = (x: number, y: number) => {
    render();
    menu.classList.remove("hidden");
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const vr = getVisibleRect?.() ?? { top: 0, height: 300 };
    let left = x;
    let top = y;
    // 水平翻转：避免超出窗口右缘
    if (left + w > 298) left = Math.max(0, 298 - w - 4);
    // 垂直：限制在可见区内（顶部待机可见窗口下部，底部待机可见窗口上部）
    if (top < vr.top) top = vr.top;
    if (top + h > vr.top + vr.height) {
      top = Math.max(vr.top, vr.top + vr.height - h - 4);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.maxHeight = `${Math.max(40, vr.height)}px`;
    menu.style.overflowY = "auto";
    visible = true;
    onOpen?.();
  };

  const hide = () => {
    if (!visible) return;
    menu.classList.add("hidden");
    visible = false;
  };

  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showAt(e.clientX, e.clientY);
  });

  document.addEventListener("click", (e) => {
    if (visible && !menu.contains(e.target as Node)) hide();
  });

  window.addEventListener("blur", hide);
}