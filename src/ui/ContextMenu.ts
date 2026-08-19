import { invoke } from "@tauri-apps/api/core";
import { toast } from "./Toast";
export interface MenuItemSpec {
  id: string;
  label?: string;
  state?: string;
  danger?: boolean;
  separator?: boolean;
  noPassthrough?: boolean;  // 点击后不恢复穿透（适合打开面板的菜单项）
  submenu?: MenuItemSpec[];  // 子菜单
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
  getVisibleRect?: () => { left: number; top: number; right: number; bottom: number },
  isInsideModel?: (x: number, y: number) => boolean,
  getModelRect?: () => { left: number; top: number; right: number; bottom: number } | null,
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
      let sub: HTMLElement | null = null; // 子菜单容器（有子菜单的项）
      const labelSpan = document.createElement("span");
      labelSpan.textContent = item.label ?? "";
      row.appendChild(labelSpan);
      if (item.state !== undefined) {
        const stateSpan = document.createElement("span");
        stateSpan.className = "state";
        stateSpan.textContent = item.state;
        row.appendChild(stateSpan);
      }
      if (item.submenu && item.submenu.length) {
        const arrow = document.createElement("span");
        arrow.className = "state";
        arrow.textContent = "▶";
        row.appendChild(arrow);
        sub = document.createElement("div");
        sub.className = "pet-menu hidden"; // 手风琴式：父项下方静态展开
        // 子菜单插到 menu（row 之后，随主菜单纵向排列）
        for (const child of item.submenu) {
          if (child.separator) {
            const s = document.createElement("div");
            s.className = "sep";
            sub.appendChild(s);
            continue;
          }
          const sr = document.createElement("div");
          sr.className = `mi${child.danger ? " danger" : ""}`;
          const sl = document.createElement("span");
          sl.textContent = child.label ?? "";
          sr.appendChild(sl);
          if (child.state !== undefined) {
            const st = document.createElement("span");
            st.className = "state";
            st.textContent = child.state;
            sr.appendChild(st);
          }
          sr.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (!child.noPassthrough) hide();
            else {
              // 打开面板的项：只隐藏菜单，不恢复穿透（面板打开后保持 menu_open）
              menu.classList.add("hidden");
              visible = false;
            }
            child.onPick?.();
          });
          sub.appendChild(sr);
        }
        // 子菜单不放入 row（.mi 是 flex 容器会把它横向排到右侧），
        // 改为插到 row 后面，随主菜单纵向排列
        let subOpen = false;
        // 点击父项切换子菜单，点击其他地方关闭
        const closeAllSubs = () => {
          menu.querySelectorAll(".pet-menu").forEach((el) => el.classList.add("hidden"));
          subOpen = false;
        };
        row.addEventListener("click", (ev) => {
          ev.stopPropagation();
          
          if (!sub) return;
          if (subOpen) {
            sub.classList.add("hidden");
            subOpen = false;
          } else {
            closeAllSubs();
            sub.classList.remove("hidden");
            subOpen = true;
          }
        });
        // 点击子菜单外任何地方关闭所有子菜单
        document.addEventListener("click", closeAllSubs, { once: true });
      } else {
        row.addEventListener("click", () => {
          if (!item.noPassthrough) hide("row-click");
          else {
            // 保持交互模式，只隐藏菜单不恢复穿透
            menu.classList.add("hidden");
            visible = false;
          }
          item.onPick?.();
        });
      }
      // row 和子菜单一起插入（sub 在 row 后，纵向展开）
      menu.appendChild(row);
      if (sub) menu.appendChild(sub);
    }
  };

  const showAt = (x: number, y: number) => {
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
    menu.style.maxHeight = `${Math.max(40, vr.bottom - vr.top - 16)}px`;
    menu.style.overflowY = "auto";
    visible = true;
    onOpen?.();
  };

  const hide = (src = "?") => {
    if (!visible) return;
    menu.classList.add("hidden");
    visible = false;
    // 通知 main.ts 覆盖窗口缩回模型区域（多次通知确保覆盖窗口及时缩回）
    document.dispatchEvent(new CustomEvent("menu-closed"));
    void invoke("set_interaction_state", { menuOpen: false, interacting: false }).catch(() => {});
    setTimeout(() => document.dispatchEvent(new CustomEvent("menu-closed")), 50);
  };

  document.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    toast("handler!"); // 诊断
    if (isInsideModel && !isInsideModel(e.clientX, e.clientY)) { toast("rejected outside"); return; }
    try {
      await invoke("set_interaction_state", { menuOpen: true, interacting: true });
      toast("menu_open OK");
    } catch (err) {
      toast("menu_open FAIL: " + err);
    }
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

  // 覆盖窗口失焦 / watcher 检测鼠标移出 → 关闭菜单
  document.addEventListener("menu-hide-request", () => {
    if (visible) hide("overlay-blur");
  });
}