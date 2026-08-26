/**
 * 每日抽卡 UI
 * 翻牌动画 + 稀有度光效 + 图鉴展示（含未收集卡牌）。
 */

import { dailyDraw, hasDrawnToday, getTodayDraw, getCollectionProgress, getDrawHistory, getCollectionEntries, type DrawResult } from "./DailyCardManager";
import { getCardPool, RARITY_LABELS, type Rarity, type CardDef } from "./CardPool";
import { getVisibleRect } from "../../ui/visible";
import { toast } from "../../ui/Toast";
import { triggerCardCommentary } from "../../assistant/AssistantPanel";

let panelEl: HTMLElement | null = null;
let showCollection = false;
let drewThisSession = false;
let typewriterTimer: ReturnType<typeof setInterval> | null = null;

function clearTypewriter() {
  if (typewriterTimer !== null) {
    clearInterval(typewriterTimer);
    typewriterTimer = null;
  }
}

function typewriter(el: HTMLElement, text: string, speed = 50): void {
  clearTypewriter();
  el.textContent = "";
  let i = 0;
  typewriterTimer = setInterval(() => {
    if (i < text.length) {
      el.textContent += text[i];
      i++;
    } else {
      clearTypewriter();
    }
  }, speed);
}

function closeCardPanel() {
  if (panelEl) {
    panelEl.classList.add("hidden");
    clearTypewriter();
    const shouldComment = drewThisSession;
    drewThisSession = false;
    panelEl = null;
    showCollection = false;
    if (shouldComment) {
      const result = getTodayDraw();
      if (result) {
        triggerCardCommentary({
          rarity: result.rarity,
          theme: result.card.theme,
          baseText: result.card.baseText,
          aiText: result.aiText,
        });
      }
    }
  }
}

function renderCard(host: HTMLElement, result: DrawResult | null, animating: boolean) {
  clearTypewriter();
  host.innerHTML = "";

  // 标题
  const title = document.createElement("div");
  title.className = "cp-title";
  if (result) {
    title.textContent = "🎴 今日运势 · ";
    const raritySpan = document.createElement("span");
    raritySpan.className = `cp-rarity-${result.rarity}`;
    raritySpan.textContent = RARITY_LABELS[result.rarity];
    title.appendChild(raritySpan);
  } else {
    title.textContent = "🎴 今日运势抽卡";
  }
  host.appendChild(title);

  // 关闭按钮
  const closeBtn = document.createElement("button");
  closeBtn.className = "cp-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeCardPanel();
  });
  host.appendChild(closeBtn);

  if (showCollection) {
    renderCollection(host);
    return;
  }

  // 卡牌容器
  const cardContainer = document.createElement("div");
  cardContainer.className = "cp-card-container";

  const card = document.createElement("div");
  card.className = "cp-card" + (result ? ` cp-rarity-bg-${result.rarity}` : " cp-card-back");

  if (result) {
    card.classList.add("cp-card-front");
    if (animating) card.classList.add("cp-flip-anim");

    const glow = document.createElement("div");
    glow.className = `cp-glow cp-glow-${result.rarity}`;
    card.appendChild(glow);

    const face = document.createElement("div");
    face.className = "cp-face";

    const art = document.createElement("div");
    art.className = "cp-art";
    if (result.card.image) {
      const img = document.createElement("img");
      img.src = result.card.image;
      img.className = "cp-card-image";
      art.appendChild(img);
    } else {
      art.textContent = result.card.emoji;
    }
    face.appendChild(art);

    const theme = document.createElement("div");
    theme.className = "cp-theme";
    theme.textContent = result.card.theme;
    face.appendChild(theme);

    card.appendChild(face);
  } else {
    const back = document.createElement("div");
    back.className = "cp-back";
    const q = document.createElement("div");
    q.className = "cp-back-q";
    q.textContent = "❓";
    const t = document.createElement("div");
    t.className = "cp-back-text";
    t.textContent = "?";
    back.append(q, t);
    card.appendChild(back);
  }
  cardContainer.appendChild(card);
  host.appendChild(cardContainer);

  // 文案
  if (result) {
    const textEl = document.createElement("div");
    textEl.className = "cp-text" + (result.aiGenerated ? " cp-text-ai" : "");
    if (animating) {
      typewriter(textEl, result.aiText);
    } else {
      textEl.textContent = result.aiText;
    }
    host.appendChild(textEl);
  }

  // 操作按钮
  const actions = document.createElement("div");
  actions.className = "cp-actions";

  if (!result) {
    const drawBtn = document.createElement("button");
    drawBtn.className = "cp-btn cp-btn-draw";
    drawBtn.textContent = "✨ 点击翻牌 ✨";
    drawBtn.addEventListener("click", async () => {
      drawBtn.disabled = true;
      drawBtn.textContent = "翻牌中…";
      const drawResult = await dailyDraw();
      drewThisSession = true;
      renderCard(host, drawResult, true);
      if (drawResult.rarity === "SSR") {
        toast("✨ SSR！恭喜抽到超稀有卡！");
      }
    });
    actions.appendChild(drawBtn);
  }

  const { collected, total } = getCollectionProgress();
  const collBtn = document.createElement("button");
  collBtn.className = "cp-btn cp-btn-collection";
  collBtn.textContent = showCollection ? "← 返回" : `📚 图鉴 (${collected}/${total})`;
  collBtn.addEventListener("click", () => {
    showCollection = !showCollection;
    if (panelEl) renderCard(panelEl, result, false);
  });
  actions.appendChild(collBtn);

  host.appendChild(actions);
}

function renderCollection(host: HTMLElement) {
  const { collected, total } = getCollectionProgress();
  const title = document.createElement("div");
  title.className = "cp-title";
  title.textContent = `📚 卡牌图鉴 (${collected}/${total})`;
  host.appendChild(title);

  // 筛选标签
  const filterBar = document.createElement("div");
  filterBar.className = "cp-filter-bar";
  const rarities: (Rarity | "all")[] = ["all", "SSR", "SR", "R"];
  let currentFilter: Rarity | "all" = "all";

  for (const r of rarities) {
    const btn = document.createElement("button");
    btn.className = "cp-filter-btn" + (r === currentFilter ? " active" : "");
    btn.textContent = r === "all" ? "全部" : r;
    btn.addEventListener("click", () => {
      currentFilter = r;
      filterBar.querySelectorAll(".cp-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderCollectionCards(list, currentFilter);
    });
    filterBar.appendChild(btn);
  }
  host.appendChild(filterBar);

  const list = document.createElement("div");
  list.className = "cp-collection";
  host.appendChild(list);

  renderCollectionCards(list, currentFilter);
}

function renderCollectionCards(list: HTMLElement, filter: Rarity | "all") {
  list.innerHTML = "";
  const pool = getCardPool();
  const entries = getCollectionEntries();
  const entryMap = new Map(entries.map(e => [e.id, e]));

  const filtered = filter === "all" ? pool : pool.filter(c => c.rarity === filter);

  // 按稀有度排序：SSR > SR > R
  const rarityOrder: Record<Rarity, number> = { SSR: 0, SR: 1, R: 2 };
  const sorted = [...filtered].sort((a, b) => rarityOrder[a.rarity] - rarityOrder[b.rarity]);

  for (const cardDef of sorted) {
    const entry = entryMap.get(cardDef.id);
    const isCollected = !!entry;

    const item = document.createElement("div");
    item.className = `cp-coll-item ${isCollected ? `cp-rarity-border-${cardDef.rarity}` : "cp-coll-locked"}`;

    const art = document.createElement("div");
    art.className = "cp-coll-art";
    if (isCollected) {
      if (cardDef.image) {
        const img = document.createElement("img");
        img.src = cardDef.image;
        img.className = "cp-coll-img";
        art.appendChild(img);
      } else {
        art.textContent = cardDef.emoji;
      }
    } else {
      art.textContent = "🔒";
    }
    item.appendChild(art);

    const info = document.createElement("div");
    info.className = "cp-coll-info";

    const themeDiv = document.createElement("div");
    themeDiv.className = "cp-coll-theme";
    if (isCollected) {
      themeDiv.textContent = cardDef.theme;
    } else {
      themeDiv.textContent = "???";
      themeDiv.classList.add("cp-coll-unknown");
    }

    const rarityDiv = document.createElement("div");
    rarityDiv.className = `cp-coll-rarity cp-rarity-${cardDef.rarity}`;
    rarityDiv.textContent = RARITY_LABELS[cardDef.rarity];

    info.append(themeDiv, rarityDiv);

    if (isCollected && entry) {
      const metaDiv = document.createElement("div");
      metaDiv.className = "cp-coll-date";
      metaDiv.textContent = `${entry.firstDate} · ×${entry.count}`;
      info.appendChild(metaDiv);
    }

    item.appendChild(info);

    // 点击已收集的卡牌显示详情
    if (isCollected) {
      item.style.cursor = "pointer";
      item.addEventListener("click", () => {
        showCardDetail(cardDef, entry!);
      });
    }

    list.appendChild(item);
  }

  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dp-empty";
    empty.textContent = "该稀有度暂无卡牌~";
    list.appendChild(empty);
  }
}

function showCardDetail(cardDef: CardDef, entry: { id: string; firstDate: string; count: number }) {
  if (!panelEl) return;

  const overlay = document.createElement("div");
  overlay.className = "cp-detail-overlay";

  const detail = document.createElement("div");
  detail.className = `cp-detail cp-rarity-bg-${cardDef.rarity}`;

  const closeBtn = document.createElement("button");
  closeBtn.className = "cp-close-btn";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => overlay.remove());

  const art = document.createElement("div");
  art.className = "cp-detail-art";
  if (cardDef.image) {
    const img = document.createElement("img");
    img.src = cardDef.image;
    img.className = "cp-card-image";
    art.appendChild(img);
  } else {
    art.textContent = cardDef.emoji;
  }

  const theme = document.createElement("div");
  theme.className = "cp-detail-theme";
  theme.textContent = cardDef.theme;

  const rarity = document.createElement("div");
  rarity.className = `cp-detail-rarity cp-rarity-${cardDef.rarity}`;
  rarity.textContent = RARITY_LABELS[cardDef.rarity];

  const text = document.createElement("div");
  text.className = "cp-detail-text";
  text.textContent = cardDef.baseText;

  const meta = document.createElement("div");
  meta.className = "cp-detail-meta";
  meta.textContent = `首次获得：${entry.firstDate}  ·  已获得 ${entry.count} 次`;

  detail.append(closeBtn, art, theme, rarity, text, meta);
  overlay.appendChild(detail);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  panelEl.appendChild(overlay);
}

export function toggleDailyCardPanel(): void {
  if (panelEl && !panelEl.classList.contains("hidden")) {
    closeCardPanel();
    return;
  }

  if (!panelEl) {
    panelEl = document.createElement("div");
    panelEl.id = "daily-card-panel";
    panelEl.className = "daily-card-panel model-panel";
    document.body.appendChild(panelEl);
    panelEl.addEventListener("pointerdown", (e) => {
      if (e.target === panelEl) closeCardPanel();
    });
  }

  showCollection = false;
  const result = getTodayDraw();
  renderCard(panelEl, result, false);
  panelEl.classList.remove("hidden");

  const vr = getVisibleRect();
  const panelW = Math.min(300, Math.max(220, vr.right - vr.left - 20));
  panelEl.style.visibility = "hidden";
  panelEl.style.width = `${panelW}px`;
  panelEl.style.transform = "none";

  requestAnimationFrame(() => {
    if (!panelEl || !panelEl.parentNode) return;
    const ph = panelEl.offsetHeight || 400;
    const left = vr.left + Math.max(0, (vr.right - vr.left - panelW) / 2);
    const top = vr.top + Math.max(0, (vr.bottom - vr.top - ph) / 2);
    panelEl.style.left = `${Math.round(left)}px`;
    panelEl.style.top = `${Math.round(top)}px`;
    panelEl.style.visibility = "";
  });
}
