/**
 * 日记面板 UI
 * 玻璃拟态风格，支持展开/收起日记详情。
 * 列表显示全部已保存日记（最多 180 篇），展开后可复制/删除。
 */

import { loadDiaries, deleteDiary, listMissingDiaryDates, checkAndGenerateDiary, diariesToMarkdown, takeDiaryStorageWarning, hasApiKey } from "./DiaryManager";
import { getEvents } from "./DiaryEventTracker";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../../ui/clipboard";
import { getVisibleRect } from "../../ui/visible";
import { toast } from "../../ui/Toast";

let panelEl: HTMLElement | null = null;
let expandedDate: string | null = null;
/** 有没有配置 API Key：日记只由大模型撰写，没配就只让看不让写 */
let apiReady = false;
/** 删除二次确认：第一次点变成"确认删除" */
let confirmDeleteDate: string | null = null;

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const week = ["日", "一", "二", "三", "四", "五", "六"];
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return `${m}月${d}日 周${week[dt.getDay()]}`;
}

function closePanel() {
  if (panelEl) {
    panelEl.classList.add("hidden");
    expandedDate = null;
    confirmDeleteDate = null;
  }
}

function renderList(host: HTMLElement) {
  const diaries = loadDiaries();
  const missing = listMissingDiaryDates();
  host.innerHTML = "";

  // 标题栏
  const titleBar = document.createElement("div");
  titleBar.className = "dp-title-bar";

  const title = document.createElement("span");
  title.className = "dp-title";
  title.textContent = diaries.length > 0 ? `📖 我的日记本 · ${diaries.length} 篇` : "📖 我的日记本";

  const closeBtn = document.createElement("button");
  closeBtn.className = "dp-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePanel();
  });

  titleBar.append(title, closeBtn);
  host.appendChild(titleBar);

  // 没配 API：明确说清"日记要靠大模型写"，并只保留查看/导出
  if (!apiReady) {
    const hint = document.createElement("div");
    hint.className = "dp-hint";
    hint.textContent = "📖 日记由大模型撰写：请先在「右键 → 小助手设置」里填好 API Key，之后每天会自动回顾你今天做了什么。";
    host.appendChild(hint);
  }

  // 工具栏：补写缺失的日记 / 导出到桌面
  const toolbar = document.createElement("div");
  toolbar.className = "dp-toolbar";

  if (apiReady && missing.length > 0) {
    const fillBtn = document.createElement("button");
    fillBtn.className = "dp-btn";
    fillBtn.textContent = `✍️ 补写 ${missing.length} 天`;
    fillBtn.title = `最近有互动但没有日记的日期：${missing.join("、")}`;
    fillBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      fillBtn.disabled = true;
      fillBtn.textContent = "补写中…";
      try {
        const list = await checkAndGenerateDiary({ manual: true });
        const left = listMissingDiaryDates().length;
        const warn = takeDiaryStorageWarning();
        toast(
          list.length > 0
            ? `补写了 ${list.length} 篇日记${left > 0 ? `，还有 ${left} 天可再点一次` : ""}`
            : "这几天没有可用的互动记录",
        );
        if (warn) toast(warn, "warn");
      } catch (err) {
        toast(`补写失败：${err instanceof Error ? err.message : String(err)}`, "warn");
      }
      if (panelEl) renderList(panelEl);
    });
    toolbar.appendChild(fillBtn);
  }

  if (diaries.length > 0) {
    const exportBtn = document.createElement("button");
    exportBtn.className = "dp-btn";
    exportBtn.textContent = "📤 导出";
    exportBtn.title = "把所有日记导出成 Markdown 文件到桌面";
    exportBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      exportBtn.disabled = true;
      try {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const name = `Petra日记_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.md`;
        const path = await invoke<string>("export_text_to_desktop", {
          fileName: name,
          text: diariesToMarkdown(),
        });
        toast(`已导出到桌面：${path}`);
      } catch (err) {
        toast(`导出失败：${err instanceof Error ? err.message : String(err)}`, "warn");
      }
      exportBtn.disabled = false;
    });
    toolbar.appendChild(exportBtn);
  }

  if (toolbar.childElementCount > 0) host.appendChild(toolbar);

  if (diaries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dp-empty";
    const today = getEvents().length;
    empty.textContent = apiReady
      ? "还没有日记哦~跟我互动就会自动生成啦！" +
        (today > 0 ? `（今天已经记下 ${today} 条记录，明天就会写成日记）` : "（日记在第二天自动补写）")
      : "还没有日记。配置 API Key 后，我会每天回顾你做了什么，写成一篇日记。";
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

    // 生成方式标签（样式早就有，只是以前没接上）
    const tag = document.createElement("span");
    tag.className = "dp-tag " + (diary.aiGenerated ? "ai" : "tpl");
    tag.textContent = diary.aiGenerated ? "AI 生成" : "简单纪要";

    header.append(dateSpan, tag);
    item.appendChild(header);

    if (expandedDate === diary.date) {
      const content = document.createElement("div");
      content.className = "dp-content";
      content.textContent = diary.content;
      item.appendChild(content);

      const actions = document.createElement("div");
      actions.className = "dp-actions";

      const copyBtn = document.createElement("button");
      copyBtn.className = "dp-btn";
      copyBtn.textContent = "📋 复制";
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await copyText(`${formatDate(diary.date)}\n${diary.content}`);
        toast(ok ? "日记已复制到剪贴板" : "复制失败，请手动选中复制", ok ? "info" : "warn");
      });
      actions.appendChild(copyBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "dp-btn dp-btn-danger";
      const confirming = confirmDeleteDate === diary.date;
      delBtn.textContent = confirming ? "确认删除？" : "🗑️ 删除";
      delBtn.title = confirming ? "再点一次就真的删掉了" : "删除这篇日记";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirmDeleteDate !== diary.date) {
          // 第一次点击只做二次确认，避免误删日记
          confirmDeleteDate = diary.date;
          if (panelEl) renderList(panelEl);
          return;
        }
        deleteDiary(diary.date);
        confirmDeleteDate = null;
        expandedDate = null;
        toast("日记已删除");
        if (panelEl) renderList(panelEl);
      });
      actions.appendChild(delBtn);

      item.appendChild(actions);
    }

    header.addEventListener("click", () => {
      expandedDate = expandedDate === diary.date ? null : diary.date;
      confirmDeleteDate = null;
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

export async function toggleDiaryPanel(): Promise<void> {
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

  // 先确认有没有 API：面板要据此决定"能不能写"
  apiReady = await hasApiKey();
  renderList(panelEl);
  panelEl.classList.remove("hidden");

  const vr = getVisibleRect();
  const panelW = Math.min(280, Math.max(200, vr.right - vr.left - 20));
  positionPanel(panelEl, panelW);
}
