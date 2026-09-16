/**
 * 双人立直麻将 2.5D 桌面。
 * 所有视觉都从 RiichiGame 的公开状态派生；动画只表现事件，不持有第二份牌状态。
 */
import { RiichiGame, type RiverTile, type Seat } from "./engine";
import { doraFromIndicator, tileName, tileShort } from "./tiles";
import { createTileBackImage, createTileImage } from "./tileAssets";
import { boostMood, reactNow } from "../../assistant/EmotionEngine";
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

interface TileOptions {
  small?: boolean;
  tiny?: boolean;
  back?: boolean;
  sideways?: boolean;
  drawn?: boolean;
  clickable?: boolean;
  riichi?: boolean;
}

function tileEl(tile: number, options: TileOptions = {}): HTMLElement {
  const e = el("div", "mg-tile");
  if (options.small) e.classList.add("mg-tile-sm");
  if (options.tiny) e.classList.add("mg-tile-xs");
  if (options.back) e.classList.add("mg-tile-back");
  if (options.sideways || options.riichi) e.classList.add("mg-tile-sideways");
  if (options.drawn) e.classList.add("mg-tile-drawn", "mg-anim-draw");
  if (options.clickable) e.classList.add("mg-tile-click");
  e.appendChild(options.back ? createTileBackImage() : createTileImage(tile));
  e.title = options.back ? "牌背" : tileName(tile);
  return e;
}

function renderRiver(river: RiverTile[], seat: Seat): HTMLElement {
  const grid = el("div", `mg-river mg-river-${seat === 0 ? "me" : "pet"}`);
  river.forEach((entry, index) => {
    const slot = el("div", "mg-river-slot");
    if (entry.called) {
      slot.classList.add("mg-river-called");
      slot.title = `${tileName(entry.tile)}已被鸣牌`;
      slot.appendChild(el("span", "mg-called-mark", "↗"));
    } else {
      const t = tileEl(entry.tile, { tiny: true, riichi: entry.riichi });
      if (index === river.length - 1) t.classList.add("mg-anim-discard");
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

function renderMelds(melds: Meld[], seat: Seat): HTMLElement {
  const wrap = el("div", `mg-melds mg-melds-${seat === 0 ? "me" : "pet"}`);
  for (const meld of melds) {
    const group = el("div", "mg-meld");
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
  wrap.appendChild(el("span", "mg-dead-label", "王牌区"));
  for (let i = 0; i < 7; i++) {
    const stack = el("div", "mg-dead-stack");
    stack.appendChild(tileEl(0, { tiny: true, back: true }));
    const indicator = game.doraIndicators[i];
    stack.appendChild(indicator === undefined ? tileEl(0, { tiny: true, back: true }) : tileEl(indicator, { tiny: true }));
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
  let petLine = "";
  let petLineTimer = 0;
  let idleTimer = 0;
  let seenEvent = 0;
  let playerTurns = 0;
  let speechPriority = 0;
  let speechUntil = 0;
  let lastCasualSpeech = 0;

  const root = el("div", "mg-riichi");
  root.addEventListener("pointerdown", (e) => e.stopPropagation());
  ctx.root.appendChild(root);

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

  const reactToEvent = () => {
    const event = game.lastEvent;
    if (!event || event.seq === seenEvent) return;
    seenEvent = event.seq;
    if (event.type === "hand-start") say("开局啦，请多指教！", "happy", 2);
    else if (event.type === "turn" && event.seat === 0) {
      playerTurns++;
      if (playerTurns === 1 || playerTurns % 5 === 0) say("轮到你了，慢慢想～", undefined, 1);
    } else if (event.type === "riichi") {
      say(event.seat === 0 ? "立直！气势很足嘛！" : "我立直啦，要小心哦。", "surprised", 3);
    } else if (event.type === "call") {
      const word = event.call === "kan" ? "杠" : "碰";
      say(event.seat === 0 ? `${word}得漂亮！` : `这张我要${word}！`, "surprised", 3);
    } else if (event.type === "kan") {
      say(event.seat === 0 ? "暗杠！新宝牌要翻开了。" : "嘿嘿，暗杠！", "surprised", 3);
    } else if (event.type === "win") {
      if (event.seat === 0) {
        say("恭喜和牌！这局是你赢啦！", "happy", 4);
        boostMood("happy");
      } else {
        say("我和啦！下一局也要加油哦。", "happy", 4);
        boostMood("chat");
      }
    } else if (event.type === "draw-end") {
      say("流局了，休息一下再继续吧。", "tired", 4);
    }
  };

  const scheduleIdleReminder = () => {
    window.clearTimeout(idleTimer);
    const pending = game.pending;
    if (!petInteraction || !pending || (pending.kind !== "turn" && pending.kind !== "call")) return;
    idleTimer = window.setTimeout(() => {
      if (disposed || game.pending !== pending) return;
      say(pending.kind === "call" ? "要鸣牌吗？不急，想好再决定。" : "还在思考吗？可以看看听牌提示哦。", "tired", 1);
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
    root.textContent = "";
    root.classList.toggle("mg-motion", motion);
    root.dataset.event = game.lastEvent?.type ?? "";

    const head = el("header", "mg-head");
    const brand = el("div", "mg-title");
    brand.append(el("span", "mg-title-mark", "立"), el("span", "", "双人立直麻将"));
    head.appendChild(brand);
    const score = el("div", "mg-score");
    score.append(el("span", "mg-score-me", `你 ${game.players[0].score}`), el("span", "mg-score-sep", " — "), el("span", "mg-score-pet", `${game.players[1].score} 桌宠`));
    head.appendChild(score);
    head.appendChild(el("div", "mg-handno", `东场 · 第 ${game.handNo} 局`));
    const tools = el("div", "mg-head-btns");
    tools.appendChild(button(motion ? "动效 开" : "动效 关", "mg-btn-sm", () => {
      motion = !motion;
      localStorage.setItem(MOTION_KEY, motion ? "1" : "0");
      render();
    }, "减少或关闭麻将动画"));
    tools.appendChild(button(petInteraction ? "互动 开" : "互动 关", "mg-btn-sm", () => {
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
    }, "关闭桌宠台词与提醒"));
    tools.appendChild(button("重开", "mg-btn-sm", () => { clearTimers(); playerTurns = 0; game.newMatch(); }));
    tools.appendChild(button("退出", "mg-btn-sm", () => ctx.close()));
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
    petSeat.appendChild(renderMelds(game.players[1].melds, 1));
    const petHand = el("div", "mg-tile-row mg-pet-hand");
    game.players[1].hand.forEach(() => petHand.appendChild(tileEl(0, { tiny: true, back: true })));
    petSeat.appendChild(petHand);
    table.appendChild(petSeat);

    const petRiverZone = el("section", "mg-river-zone mg-river-zone-pet");
    petRiverZone.appendChild(renderRiver(game.players[1].river, 1));
    table.appendChild(petRiverZone);

    const center = el("section", "mg-center");
    center.appendChild(el("div", "mg-round", "東一局"));
    center.appendChild(el("div", "mg-wall-count", `余 ${game.wall.length}`));
    center.appendChild(el("div", "mg-sticks", game.sticks ? `立直棒 × ${game.sticks}` : "供托 0"));
    const doraNames = Array.from(new Set(game.doraIndicators.map(doraFromIndicator))).map(tileShort).join(" · ");
    center.appendChild(el("div", "mg-dora-text", `宝牌 ${doraNames}`));
    table.appendChild(center);
    table.appendChild(renderDeadWall(game));

    const myRiverZone = el("section", "mg-river-zone mg-river-zone-me");
    myRiverZone.appendChild(renderRiver(game.players[0].river, 0));
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
    meSeat.appendChild(renderMelds(game.players[0].melds, 0));
    const hand = el("div", "mg-tile-row mg-hand");
    const canDiscard = game.pending?.kind === "turn";
    game.players[0].hand.forEach((tile, index) => {
      const isDrawn = game.lastDrawSeat === 0 && game.lastDraw === tile && index === game.players[0].hand.lastIndexOf(tile);
      const te = tileEl(tile, { clickable: canDiscard, drawn: isDrawn });
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
