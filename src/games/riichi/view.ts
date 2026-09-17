/**
 * 双人立直麻将 2.5D 桌面。
 * 所有视觉都从 RiichiGame 的公开状态派生；动画只表现事件，不持有第二份牌状态。
 */
import { RiichiGame, type RiverTile, type Seat } from "./engine";
import { doraFromIndicator, tileName, tileShort } from "./tiles";
import { createTileBackImage, createTileImage } from "./tileAssets";
import { createRiichiIcon, type RiichiIconName } from "./icons";
import { boostMood, reactNow } from "../../assistant/EmotionEngine";
import { isAssistantBusy } from "../../assistant/AssistantPanel";
import { petTalkAvailable, petTalkWanted, requestPetTalk, resetPetTalk } from "./petTalk";
import type { Meld } from "./rules";
import type { MiniGameContext, MiniGameInstance } from "../types";

const MOTION_KEY = "petra.riichi.motion";
const PET_KEY = "petra.riichi.petInteraction";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

function toolButton(icon: RiichiIconName, label: string, onClick: () => void, pressed?: boolean): HTMLButtonElement {
  const actionLabel = pressed === undefined ? label : `${pressed ? "关闭" : "开启"}${label}`;
  const b = button("", "mg-tool", onClick, actionLabel);
  b.setAttribute("aria-label", actionLabel);
  if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
  b.append(createRiichiIcon(icon), el("span", "mg-tool-label", label));
  return b;
}

interface TileOptions {
  small?: boolean;
  tiny?: boolean;
  back?: boolean;
  sideways?: boolean;
  drawn?: boolean;
  animate?: boolean;
  clickable?: boolean;
  riichi?: boolean;
}

function tileEl(tile: number, options: TileOptions = {}): HTMLElement {
  const e = el("div", "mg-tile");
  if (options.small) e.classList.add("mg-tile-sm");
  if (options.tiny) e.classList.add("mg-tile-xs");
  if (options.back) e.classList.add("mg-tile-back");
  if (options.sideways || options.riichi) e.classList.add("mg-tile-sideways");
  if (options.drawn) e.classList.add("mg-tile-drawn");
  if (options.animate) e.classList.add("mg-anim-draw");
  if (options.clickable) e.classList.add("mg-tile-click");
  e.appendChild(options.back ? createTileBackImage() : createTileImage(tile));
  e.title = options.back ? "牌背" : tileName(tile);
  return e;
}

function renderRiver(river: RiverTile[], seat: Seat, animateLast = false): HTMLElement {
  // 牌河越长越紧凑，避免对家与自己的牌河在后半局撞在一起。
  const density = river.length > 24 ? " mg-river-dense" : river.length > 12 ? " mg-river-compact" : "";
  const grid = el("div", `mg-river mg-river-${seat === 0 ? "me" : "pet"}${density}`);
  river.forEach((entry, index) => {
    const slot = el("div", "mg-river-slot");
    if (entry.called) {
      slot.classList.add("mg-river-called");
      slot.title = `${tileName(entry.tile)}已被鸣牌`;
      slot.appendChild(el("span", "mg-called-mark", "↗"));
    } else {
      const t = tileEl(entry.tile, { tiny: true, riichi: entry.riichi });
      if (animateLast && index === river.length - 1) t.classList.add("mg-anim-discard");
      slot.appendChild(t);
    }
    grid.appendChild(slot);
  });
  return grid;
}

function meldLabel(meld: Meld): string {
  if (meld.kind === "kan") return meld.open ? "明杠" : "暗杠";
  if (meld.kind === "triplet") return "碰";
  return "吃";
}

function renderMelds(melds: Meld[], seat: Seat, animateLast = false): HTMLElement {
  const wrap = el("div", `mg-melds mg-melds-${seat === 0 ? "me" : "pet"}`);
  for (const meld of melds) {
    const group = el("div", "mg-meld");
    if (animateLast && meld === melds[melds.length - 1]) group.classList.add("mg-anim-call");
    group.dataset.kind = meldLabel(meld);
    meld.tiles.forEach((tile, index) => {
      const concealedEdge = !meld.open && meld.kind === "kan" && (index === 0 || index === meld.tiles.length - 1);
      group.appendChild(tileEl(tile, {
        tiny: true,
        back: concealedEdge,
        sideways: meld.open && index === 1,
      }));
    });
    wrap.appendChild(group);
  }
  return wrap;
}

function renderWallEdge(name: string, slotTiles: number[]): HTMLElement {
  const edge = el("div", `mg-wall-edge mg-wall-${name}`);
  for (let i = 0; i < 12; i++) {
    const stack = el("div", "mg-wall-stack");
    const count = slotTiles[i] ?? 0;
    if (count === 0) stack.classList.add("mg-wall-empty");
    if (count === 1) stack.classList.add("mg-wall-half");
    for (let tile = 0; tile < count; tile++) stack.appendChild(tileEl(0, { tiny: true, back: true }));
    edge.appendChild(stack);
  }
  return edge;
}

function renderLiveWall(remaining: number): HTMLElement {
  const wrap = el("div", "mg-live-wall");
  let tiles = remaining;
  for (const name of ["top", "right", "bottom", "left"]) {
    const slots = Array.from({ length: 12 }, () => {
      const count = Math.max(0, Math.min(2, tiles));
      tiles -= count;
      return count;
    });
    wrap.appendChild(renderWallEdge(name, slots));
  }
  return wrap;
}

function renderDeadWall(game: RiichiGame): HTMLElement {
  const wrap = el("div", "mg-dead-wall");
  wrap.appendChild(el("span", "mg-dead-label", "宝牌区"));
  for (let i = 0; i < 7; i++) {
    const stack = el("div", "mg-dead-stack");
    stack.appendChild(tileEl(0, { tiny: true, back: true }));
    const indicator = game.doraIndicators[i];
    const top = indicator === undefined ? tileEl(0, { tiny: true, back: true }) : tileEl(indicator, { tiny: true });
    if (indicator !== undefined) top.title = `宝牌指示牌：${tileName(indicator)}`;
    stack.appendChild(top);
    wrap.appendChild(stack);
  }
  return wrap;
}

function boolSetting(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === "1";
}

export function mountRiichi(ctx: MiniGameContext): MiniGameInstance {
  const game = new RiichiGame();
  let disposed = false;
  let motion = boolSetting(MOTION_KEY, !matchMedia("(prefers-reduced-motion: reduce)").matches);
  let petInteraction = boolSetting(PET_KEY, true);
  /** AI 实时牌况点评是否可用（需助手开启 + API Key；异步探测一次） */
  let aiTalkOn = false;
  /** 探测是否已完成（未完成前先用 petTalkWanted() 同步判断，避免开局第一句落到固定台词池） */
  let aiProbeDone = false;
  let petLine = "";
  let petLineTimer = 0;
  let idleTimer = 0;
  let seenEvent = 0;
  let playerTurns = 0;
  let speechPriority = 0;
  let speechUntil = 0;
  let lastCasualSpeech = 0;
  let renderedEventSeq = 0;

  const root = el("div", "mg-riichi");
  ctx.root.appendChild(root);

  resetPetTalk();
  void petTalkAvailable().then((ok) => {
    aiTalkOn = ok;
    aiProbeDone = true;
    if (!disposed) render();
  });

  const clearTimers = () => {
    window.clearTimeout(petLineTimer);
    window.clearTimeout(idleTimer);
  };

  const say = (line: string, emotion?: "happy" | "surprised" | "tired", priority = 1) => {
    if (!petInteraction || disposed) return;
    const now = Date.now();
    if (now < speechUntil && priority < speechPriority) return;
    if (priority <= 1 && now - lastCasualSpeech < 3200) return;
    if (priority <= 1) lastCasualSpeech = now;
    speechPriority = priority;
    speechUntil = now + (priority >= 3 ? 5200 : 4200);
    petLine = line;
    if (emotion) reactNow(emotion, priority >= 3);
    window.clearTimeout(petLineTimer);
    petLineTimer = window.setTimeout(() => {
      petLine = "";
      speechPriority = 0;
      speechUntil = 0;
      render();
    }, priority >= 3 ? 5200 : 4200);
  };

  /**
   * 事件反应：
   * - AI 互动可用时**不使用固定台词池**，只让 AI 看牌况自己说（表情/动作仍即时本地触发，零 token）；
   * - 没配 API（或关掉 AI 互动）时才回落到本地台词。
   * 节奏：只在关键事件（开局/立直/鸣牌/和了/流局）或"有值得说的事"（听牌、牌墙将尽）时才开口；
   * 频率由 petTalk 控制（最小间隔 18s / 每局 3 次 / 每场 20 次），被节流时这一句就不说；
   * AI 也可以回「沉默」表示没什么可说，此时不显示任何气泡。
   */
  const react = (
    reason: string,
    fallback: string,
    emotion: "happy" | "surprised" | "tired" | undefined,
    priority: number,
  ) => {
    const useAI = aiTalkOn || (petTalkWanted() && !aiProbeDone);
    if (!useAI) {
      say(fallback, emotion, priority);
      return;
    }
    // 只有关键事件才驱动表情/动作（本地、零 token），台词等 AI 回来再显示；普通事件不打扰
    if (emotion && priority >= 3) reactNow(emotion, true);
    void requestPetTalk(game, reason, isAssistantBusy()).then((line) => {
      if (!line || disposed) return;
      say(line, emotion, priority);
    });
  };

  /** 本局是否已就"听牌"提醒过一次，避免反复说同一件事 */
  let noticedTenpai = false;

  /** 本地判断有没有值得点评的事（零 token）；没有就干脆不说 */
  const notableReason = (): string | null => {
    if (game.wall.length <= 22) return "牌墙快摸完了";
    if (!noticedTenpai) {
      const waits = game.waitsHint(0);
      if (waits.length > 0) {
        noticedTenpai = true;
        return `主人已经听牌了（等 ${waits.map((t) => tileName(t)).join("、")}）`;
      }
    }
    return null;
  };

  const reactToEvent = () => {
    const event = game.lastEvent;
    if (!event || event.seq === seenEvent) return;
    seenEvent = event.seq;
    const who = event.seat === 0 ? "主人" : "你自己";
    const tileLabel = event.tile !== undefined ? tileName(event.tile) : "一张牌";
    if (event.type === "hand-start") {
      noticedTenpai = false;
      react("这一局刚开始", "开局啦，请多指教！", "happy", 2);
    } else if (event.type === "turn") {
      // 只在"有值得说的事"时才说话：听牌 / 牌墙将尽（避免每次摸牌都点评）
      if (event.seat === 0) {
        playerTurns++;
        if (playerTurns % 4 === 0) {
          const notable = notableReason();
          if (notable) react(notable, "嗯…这手牌有点意思。", undefined, 2);
        }
      }
    } else if (event.type === "riichi") {
      react(
        `${who}刚刚宣言立直`,
        event.seat === 0 ? "立直！气势很足嘛！" : "我立直啦，要小心哦。",
        "surprised",
        3,
      );
    } else if (event.type === "call") {
      const word = event.call === "kan" ? "杠" : "碰";
      react(
        `${who}刚刚${word}了 ${tileLabel}`,
        event.seat === 0 ? `${word}得漂亮！` : `这张我要${word}！`,
        "surprised",
        3,
      );
    } else if (event.type === "kan") {
      react(
        `${who}刚刚暗杠 ${tileLabel}`,
        event.seat === 0 ? "暗杠！新宝牌要翻开了。" : "嘿嘿，暗杠！",
        "surprised",
        3,
      );
    } else if (event.type === "win") {
      if (event.seat === 0) {
        react("主人和牌赢了这一局", "恭喜和牌！这局是你赢啦！", "happy", 4);
        boostMood("happy");
      } else {
        react("你自己和牌赢了这一局", "我和啦！下一局也要加油哦。", "happy", 4);
        boostMood("chat");
      }
    } else if (event.type === "draw-end") {
      react("这一局流局了", "流局了，休息一下再继续吧。", "tired", 4);
    }
  };

  const scheduleIdleReminder = () => {
    window.clearTimeout(idleTimer);
    const pending = game.pending;
    if (!petInteraction || !pending || (pending.kind !== "turn" && pending.kind !== "call")) return;
    idleTimer = window.setTimeout(() => {
      if (disposed || game.pending !== pending) return;
      react(
        pending.kind === "call" ? "主人正在犹豫要不要鸣牌" : "主人出牌想了挺久",
        pending.kind === "call" ? "要鸣牌吗？不急，想好再决定。" : "还在思考吗？可以看看听牌提示哦。",
        "tired",
        1,
      );
      render();
    }, 14_000);
  };

  const syncPetAnchor = () => {
    const stage = document.getElementById("stage");
    const hit = root.querySelector<HTMLElement>(".mg-pet-hit");
    if (!stage || !hit) return;
    const rect = hit.getBoundingClientRect();
    const fit = Math.min(root.clientWidth / 700, root.clientHeight / 700);
    const scale = Math.max(.24, Math.min(.34, .34 * fit));
    // #stage 的模型基准点是 700×700 画布中心；把该点绑定到对家点击区锚点。
    const anchorX = rect.left + rect.width * .5;
    const anchorY = rect.top + rect.height * .65;
    stage.style.setProperty("--mg-pet-x", `${anchorX - 350}px`);
    stage.style.setProperty("--mg-pet-y", `${anchorY - 350}px`);
    stage.style.setProperty("--mg-pet-scale", String(scale));
  };
  window.addEventListener("resize", syncPetAnchor);

  function render(): void {
    if (disposed) return;
    reactToEvent();
    const event = game.lastEvent;
    const animateEvent = Boolean(motion && event && event.seq !== renderedEventSeq);
    if (event) renderedEventSeq = event.seq;
    root.textContent = "";
    root.classList.toggle("mg-motion", motion);
    root.dataset.event = animateEvent ? event?.type ?? "" : "";

    const head = el("header", "mg-head");
    head.title = "按住空白处拖动窗口";
    head.setAttribute("data-tauri-drag-region", "");
    const brand = el("div", "mg-title");
    brand.append(el("span", "mg-title-mark", "立"), el("span", "mg-title-text", "双人立直麻将"));
    head.appendChild(brand);
    const overview = el("div", "mg-overview");
    const score = el("div", "mg-score");
    score.append(el("span", "mg-score-me", `你 ${game.players[0].score}`), el("span", "mg-score-sep", "·"), el("span", "mg-score-pet", `桌宠 ${game.players[1].score}`));
    const status = el("div", "mg-status");
    status.append(el("span", "mg-handno", `东 ${game.handNo} 局`), el("span", "mg-status-sep", "·"), el("span", "mg-wall-count", `余 ${game.wall.length}`));
    if (game.sticks) status.append(el("span", "mg-status-sep", "·"), el("span", "mg-sticks", `供托 ${game.sticks}`));
    overview.append(score, status);
    head.appendChild(overview);
    const tools = el("div", "mg-head-btns");
    tools.appendChild(toolButton("sparkles", "动效", () => {
      motion = !motion;
      localStorage.setItem(MOTION_KEY, motion ? "1" : "0");
      render();
    }, motion));
    tools.appendChild(toolButton("message-circle", aiTalkOn ? "互动·AI" : "互动", () => {
      petInteraction = !petInteraction;
      localStorage.setItem(PET_KEY, petInteraction ? "1" : "0");
      if (!petInteraction) {
        petLine = "";
        speechPriority = 0;
        speechUntil = 0;
        window.clearTimeout(petLineTimer);
        window.clearTimeout(idleTimer);
      }
      render();
    }, petInteraction));
    tools.appendChild(toolButton("rotate-ccw", "重开", () => { clearTimers(); playerTurns = 0; resetPetTalk(); game.newMatch(); }));
    tools.appendChild(toolButton("x", "退出", () => ctx.close()));
    head.appendChild(tools);
    root.appendChild(head);

    const table = el("main", "mg-table");
    table.appendChild(renderLiveWall(game.wall.length));

    const petSeat = el("section", "mg-seat mg-seat-pet");
    petSeat.appendChild(el("div", "mg-seat-name", `桌宠 · 南家${game.isRiichi(1) ? " · 立直" : ""}`));
    const petHit = button("", "mg-pet-hit", () => {
      const lines = ["我一直在看着牌桌哦。", "摸摸也不能偷看我的手牌！", "要一起打到最后一局呀。"];
      say(lines[Math.floor(Math.random() * lines.length)], "happy", 1);
      render();
    }, "点击桌宠互动");
    petHit.setAttribute("aria-label", "与对面的桌宠互动");
    petSeat.appendChild(petHit);
    if (petLine) petSeat.appendChild(el("div", "mg-pet-speech", petLine));
    petSeat.appendChild(renderMelds(game.players[1].melds, 1, animateEvent && (event?.type === "call" || event?.type === "kan") && event.seat === 1));
    const petHand = el("div", "mg-tile-row mg-pet-hand");
    game.players[1].hand.forEach((_, index) => petHand.appendChild(tileEl(0, {
      tiny: true,
      back: true,
      animate: animateEvent && event?.type === "draw" && event.seat === 1 && index === game.players[1].hand.length - 1,
    })));
    petSeat.appendChild(petHand);
    table.appendChild(petSeat);

    const petRiverZone = el("section", "mg-river-zone mg-river-zone-pet");
    petRiverZone.appendChild(renderRiver(game.players[1].river, 1, animateEvent && (event?.type === "discard" || event?.type === "riichi") && event.seat === 1));
    table.appendChild(petRiverZone);

    const center = el("section", "mg-center");
    center.appendChild(el("div", "mg-round", "東一局"));
    const doraNames = Array.from(new Set(game.doraIndicators.map(doraFromIndicator))).map(tileShort).join(" · ");
    center.appendChild(el("div", "mg-dora-text", `宝牌 ${doraNames}`));
    table.appendChild(center);
    table.appendChild(renderDeadWall(game));

    const myRiverZone = el("section", "mg-river-zone mg-river-zone-me");
    myRiverZone.appendChild(renderRiver(game.players[0].river, 0, animateEvent && (event?.type === "discard" || event?.type === "riichi") && event.seat === 0));
    table.appendChild(myRiverZone);

    const log = el("aside", "mg-log");
    for (const line of game.log.slice(-3)) log.appendChild(el("div", "mg-log-line", line));
    table.appendChild(log);

    const meSeat = el("section", "mg-seat mg-seat-me");
    const meMeta = el("div", "mg-me-meta");
    meMeta.appendChild(el("span", "mg-seat-name", `你 · 东家${game.isRiichi(0) ? " · 立直" : ""}`));
    const waits = game.waitsHint(0);
    if (waits.length > 0) meMeta.appendChild(el("span", "mg-waits", `听牌 ${waits.map(tileShort).join(" ")}`));
    meSeat.appendChild(meMeta);
    meSeat.appendChild(renderMelds(game.players[0].melds, 0, animateEvent && (event?.type === "call" || event?.type === "kan") && event.seat === 0));
    const hand = el("div", "mg-tile-row mg-hand");
    const canDiscard = game.pending?.kind === "turn";
    const handEntries = game.players[0].hand.map((tile, index) => ({ tile, index, drawn: false }));
    if (game.lastDrawSeat === 0 && game.lastDraw !== null) {
      const drawnIndex = handEntries.map((entry) => entry.tile).lastIndexOf(game.lastDraw);
      if (drawnIndex >= 0) {
        const [drawn] = handEntries.splice(drawnIndex, 1);
        drawn.drawn = true;
        handEntries.push(drawn);
      }
    }
    handEntries.forEach(({ tile, index, drawn }) => {
      const te = tileEl(tile, {
        clickable: canDiscard,
        drawn,
        animate: animateEvent && event?.type === "draw" && event.seat === 0 && drawn,
      });
      if (game.riichiPending) te.classList.add("mg-tile-riichi-candidate");
      if (canDiscard) te.addEventListener("click", (event) => {
        event.stopPropagation();
        game.playTile(index);
      });
      hand.appendChild(te);
    });
    meSeat.appendChild(hand);
    table.appendChild(meSeat);
    root.appendChild(table);

    const actions = el("footer", "mg-actions");
    const pending = game.pending;
    if (pending?.kind === "turn") {
      if (pending.options.includes("tsumo")) actions.appendChild(button("自摸和了", "mg-btn mg-btn-win", () => game.tsumo()));
      if (pending.options.includes("riichi") && !game.riichiPending) actions.appendChild(button("立直", "mg-btn", () => game.declareRiichi()));
      if (game.riichiPending) actions.appendChild(button("取消立直", "mg-btn", () => game.cancelRiichi()));
      if (pending.options.includes("ankan")) actions.appendChild(button("暗杠", "mg-btn", () => game.ankan()));
      actions.appendChild(el("span", "mg-hint", game.riichiPending ? "选择一张牌横置宣言立直" : "点击手牌出牌"));
    } else if (pending?.kind === "call") {
      if (pending.options.includes("ron")) actions.appendChild(button("荣和", "mg-btn mg-btn-win", () => game.call("ron")));
      if (pending.options.includes("pon")) actions.appendChild(button("碰", "mg-btn", () => game.call("pon")));
      if (pending.options.includes("kan")) actions.appendChild(button("明杠", "mg-btn", () => game.call("kan")));
      actions.appendChild(button("过", "mg-btn", () => game.call("pass")));
      actions.appendChild(el("span", "mg-hint", `桌宠打出${pending.tile === undefined ? "牌" : tileName(pending.tile)}`));
    } else if (game.phase === "handend") {
      actions.appendChild(button("下一局", "mg-btn mg-btn-primary", () => { clearTimers(); game.nextHand(); }));
      actions.appendChild(el("span", "mg-hint", "本局结束"));
    } else if (game.phase === "ended") {
      actions.appendChild(button("再来一场", "mg-btn mg-btn-primary", () => { clearTimers(); playerTurns = 0; game.newMatch(); }));
      actions.appendChild(el("span", "mg-hint", "对局结束"));
    } else {
      actions.appendChild(el("span", "mg-hint", "桌宠正在思考…"));
    }
    root.appendChild(actions);

    if (game.handResult && game.phase !== "playing") {
      const banner = el("div", "mg-banner");
      banner.appendChild(el("div", "mg-banner-text", game.handResult));
      root.appendChild(banner);
    }
    syncPetAnchor();
    scheduleIdleReminder();
  }

  game.onUpdate = render;
  if (import.meta.env.DEV) {
    Object.defineProperty(root, "__riichiGame", { value: game, configurable: true });
  }
  game.newMatch();

  return {
    unmount() {
      disposed = true;
      clearTimers();
      window.removeEventListener("resize", syncPetAnchor);
      const stage = document.getElementById("stage");
      stage?.style.removeProperty("--mg-pet-x");
      stage?.style.removeProperty("--mg-pet-y");
      stage?.style.removeProperty("--mg-pet-scale");
      game.dispose();
      root.remove();
    },
  };
}
