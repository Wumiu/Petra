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
 * 菜单超出窗口时会自动朝左/上展开，配合窗口固定的 300x300。
 */
export function setupContextMenu(build: () => MenuItemSpec[], onOpen?: () => void) {
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
      row.innerHTML = `<span>${item.label ?? ""}</span>${
        item.state !== undefined ? `<span class="state">${item.state}</span>` : ""
      }`;
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
    // 翻转：避免超出窗口
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let left = x;
    let top = y;
    if (left + w > 298) left = Math.max(0, 298 - w - 4);
    if (top + h > 298) top = Math.max(0, 298 - h - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
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