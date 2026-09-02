/**
 * 日记面板 UI
 * 玻璃拟态风格，支持展开/收起日记详情。
 * 只显示 AI 生成的日记。
 */

import { loadDiaries, regenerateDiary, deleteDiary, type DiaryEntry } from "./DiaryManager";
import { getVisibleRect } from "../../ui/visible";
import { toast } from "../../ui/Toast";

let panelEl: HTMLElement | null = null;
let expandedDate: string | null = null;

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${m}月${d}日`;
}

function closePanel() {
  if (panelEl) {
    panelEl.classList.add("hidden");
    expandedDate = null;
  }
}

function renderList(host: HTMLElement) {
  const diaries = loadDiaries().slice(0, 30);
  host.innerHTML = "";

  // 标题栏
  const titleBar = document.createElement("div");
  titleBar.className = "dp-title-bar";

  const title = document.createElement("span");
  title.className = "dp-title";
  title.textContent = "📖 我的日记本";

  const closeBtn = document.createElement("button");
  closeBtn.className = "dp-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePanel();
  });

  titleBar.append(title, closeBtn);
  host.appendChild(titleBar);

  if (diaries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dp-empty";
    empty.textContent = "还没有日记哦~跟我互动就会自动生成啦！";
    host.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "dp-list";

  for (const diary of diaries) {
    const item = document.createElement("div");
    item.className = "dp-item" + (expandedDate === diary.date ? " expanded" : "");

    const header = document.createElement("div");
    header.className = "dp-item-header";

    const dateSpan = document.createElement("span");
    dateSpan.className = "dp-date";
    dateSpan.textContent = formatDate(diary.date);

    header.append(dateSpan);
    item.appendChild(header);

    if (expandedDate === diary.date) {
      const content = document.createElement("div");
      content.className = "dp-content";
      content.textContent = diary.content;
      item.appendChild(content);

      const actions = document.createElement("div");
      actions.className = "dp-actions";

      const regenBtn = document.createElement("button");
      regenBtn.className = "dp-btn";
      regenBtn.textContent = "🔄 重新生成";
      regenBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        regenBtn.disabled = true;
        regenBtn.textContent = "生成中…";
        try {
          const result = await regenerateDiary(diary.date);
          if (result) {
            toast(result.aiGenerated ? "日记已重新生成" : "已生成简单纪要（配置 API 后更生动）");
            if (panelEl) renderList(panelEl);
            return;
          }
          toast("生成失败：该日期没有可用的互动记录", "warn");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast(`重新生成失败：${msg}`, "warn");
        }
        regenBtn.disabled = false;
        regenBtn.textContent = "🔄 重新生成";
      });
      actions.appendChild(regenBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "dp-btn dp-btn-danger";
      delBtn.textContent = "🗑️ 删除";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteDiary(diary.date);
        toast("日记已删除");
        expandedDate = null;
        if (panelEl) renderList(panelEl);
      });
      actions.appendChild(delBtn);

      item.appendChild(actions);
    }

    header.addEventListener("click", () => {
      expandedDate = expandedDate === diary.date ? null : diary.date;
      if (panelEl) renderList(panelEl);
    });

    list.appendChild(item);
  }
  host.appendChild(list);
}

function positionPanel(el: HTMLElement, panelW: number) {
  el.style.visibility = "hidden";
  el.style.width = `${panelW}px`;
  el.style.transform = "none";

  requestAnimationFrame(() => {
    if (!el.parentNode) return;
    const vr = getVisibleRect();
    const ph = el.offsetHeight || 300;
    const left = vr.left + Math.max(0, (vr.right - vr.left - panelW) / 2);
    const top = vr.top + Math.max(0, (vr.bottom - vr.top - ph) / 2);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = "";
  });
}

export function toggleDiaryPanel(): void {
  // 复用同一个面板元素（避免反复开关在 body 里堆积隐藏节点）
  if (!panelEl) {
    panelEl = document.createElement("div");
    panelEl.id = "diary-panel";
    panelEl.className = "diary-panel model-panel";
    panelEl.classList.add("hidden"); // 初始隐藏：首次 toggle 直接走"打开"分支
    document.body.appendChild(panelEl);
    panelEl.addEventListener("pointerdown", (e) => {
      if (e.target === panelEl) closePanel();
    });
  }

  if (!panelEl.classList.contains("hidden")) {
    closePanel();
    return;
  }

  renderList(panelEl);
  panelEl.classList.remove("hidden");

  const vr = getVisibleRect();
  const panelW = Math.min(280, Math.max(200, vr.right - vr.left - 20));
  positionPanel(panelEl, panelW);
}