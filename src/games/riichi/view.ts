/**
 * 双人立直麻将界面：全窗口覆盖的麻将桌，与桌宠对局。
 * 桌宠的情绪会实时反馈（和了→开心、被和→惊讶、流局→打盹），完成一局涨心情。
 */
import { RiichiGame, type Seat } from "./engine";
import { doraFromIndicator, isDragon, suitOf, tileName, tileShort } from "./tiles";
import { boostMood, getMood, reactNow } from "../../assistant/EmotionEngine";
import type { MiniGameContext, MiniGameInstance } from "../types";

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

function tileEl(t: number, small: boolean): HTMLElement {
  const e = document.createElement("div");
  e.className = "mg-tile" + (small ? " mg-tile-sm" : "");
  const suit = suitOf(t);
  if (suit === 0) e.classList.add("mg-suit-m");
  else if (suit === 1) e.classList.add("mg-suit-p");
  else if (suit === 2) e.classList.add("mg-suit-s");
  else e.classList.add("mg-honor");
  if (isDragon(t)) e.classList.add("mg-dragon");
  e.textContent = tileShort(t);
  e.title = tileName(t);
  return e;
}

/** 桌宠心情 → emoji（覆盖层盖住角色，用表情传达情绪） */
function moodFace(): string {
  const h = getMood().happiness;
  if (h > 0.75) return "😻";
  if (h > 0.6) return "😊";
  if (h > 0.45) return "🙂";
  if (h > 0.3) return "😕";
  return "😿";
}

function backEl(small: boolean): HTMLElement {
  const e = document.createElement("div");
  e.className = "mg-tile mg-tile-back" + (small ? " mg-tile-sm" : "");
  return e;
}

function rowOfTiles(tiles: number[], small: boolean): HTMLElement {
  const row = el("div", "mg-tile-row");
  for (const t of tiles) row.appendChild(tileEl(t, small));
  return row;
}

export function mountRiichi(ctx: MiniGameContext): MiniGameInstance {
  const game = new RiichiGame();
  let disposed = false;
  let lastStamp = "";
  const root = el("div", "mg-riichi");
  root.addEventListener("pointerdown", (e) => e.stopPropagation());
  ctx.root.appendChild(root);

  const reactToHandEnd = () => {
    const stamp = game.phase + ":" + game.handNo;
    if (stamp === lastStamp) return;
    const wasPlaying = lastStamp.startsWith("playing");
    lastStamp = stamp;
    if (!wasPlaying) return;
    if (game.phase === "playing") return;
    if (game.lastHandWinner === 1) {
      reactNow("happy");
      boostMood("happy");
    } else if (game.lastHandWinner === 0) {
      reactNow("surprised");
      boostMood("chat");
    } else {
      reactNow("tired");
    }
  };

  const render = () => {
    if (disposed) return;
    reactToHandEnd();
    root.textContent = "";

    // ---------- 顶栏 ----------
    const head = el("div", "mg-head");
    head.appendChild(el("div", "mg-title", "🀄 双人立直麻将"));
    const scoreBox = el("div", "mg-score");
    scoreBox.appendChild(el("span", "mg-score-me", "你 " + game.players[0].score));
    scoreBox.appendChild(el("span", "mg-score-sep", " vs "));
    scoreBox.appendChild(el("span", "mg-score-pet", "桌宠 " + game.players[1].score));
    head.appendChild(scoreBox);
    head.appendChild(el("div", "mg-handno", "第 " + game.handNo + " 局"));
    const headBtns = el("div", "mg-head-btns");
    headBtns.appendChild(button("重开", "mg-btn-sm", () => game.newMatch()));
    headBtns.appendChild(button("退出", "mg-btn-sm", () => ctx.close()));
    head.appendChild(headBtns);
    root.appendChild(head);

    // ---------- 桌宠区 ----------
    const pet = game.players[1];
    const petZone = el("div", "mg-zone mg-zone-pet");
    const petHead = el("div", "mg-zone-head");
    petHead.appendChild(el("span", "mg-zone-name", "🐾 桌宠（南家）" + (game.isRiichi(1) ? " · 已立直" : "")));
    petHead.appendChild(el("span", "mg-zone-info", moodFace() + " 手牌 " + pet.hand.length + " 张"));
    petZone.appendChild(petHead);
    if (pet.melds.length > 0) {
      const melds = el("div", "mg-melds");
      for (const m of pet.melds) {
        const g = el("div", "mg-meld");
        for (const t of m.tiles) g.appendChild(tileEl(t, true));
        melds.appendChild(g);
      }
      petZone.appendChild(melds);
    }
    const petHandRow = el("div", "mg-tile-row mg-back-row");
    for (let i = 0; i < pet.hand.length; i++) petHandRow.appendChild(backEl(true));
    petZone.appendChild(petHandRow);
    if (pet.discards.length > 0) petZone.appendChild(rowOfTiles(pet.discards, true));
    root.appendChild(petZone);

    // ---------- 中央信息 ----------
    const mid = el("div", "mg-mid");
    const doraBox = el("div", "mg-dora");
    doraBox.appendChild(el("span", "mg-label", "宝牌指示"));
    for (const d of game.doraIndicators) doraBox.appendChild(tileEl(d, true));
    const doraTiles = Array.from(new Set(game.doraIndicators.map(doraFromIndicator))).map(tileShort).join(" ");
    doraBox.appendChild(el("span", "mg-label", "→ 宝牌 " + doraTiles));
    mid.appendChild(doraBox);
    mid.appendChild(el("div", "mg-meta", "牌墙 " + game.wall.length + " 张" + (game.sticks > 0 ? "　立直棒 " + game.sticks + " 根" : "")));
    const logBox = el("div", "mg-log");
    for (const line of game.log.slice(-3)) logBox.appendChild(el("div", "mg-log-line", line));
    mid.appendChild(logBox);
    root.appendChild(mid);

    // ---------- 玩家区 ----------
    const me = game.players[0];
    const meZone = el("div", "mg-zone mg-zone-me");
    const meHead = el("div", "mg-zone-head");
    meHead.appendChild(el("span", "mg-zone-name", "🙋 你（东家）" + (game.isRiichi(0) ? " · 已立直" : "")));
    const waits = game.waitsHint(0);
    if (waits.length > 0) meHead.appendChild(el("span", "mg-waits", "听：" + waits.map(tileShort).join(" ")));
    meZone.appendChild(meHead);
    if (me.melds.length > 0) {
      const melds = el("div", "mg-melds");
      for (const m of me.melds) {
        const g = el("div", "mg-meld");
        for (const t of m.tiles) g.appendChild(tileEl(t, true));
        melds.appendChild(g);
      }
      meZone.appendChild(melds);
    }
    if (me.discards.length > 0) meZone.appendChild(rowOfTiles(me.discards, true));

    const handRow = el("div", "mg-tile-row mg-hand");
    const canDiscard = !!game.pending && game.pending.kind === "turn";
    me.hand.forEach((t, i) => {
      const te = tileEl(t, false);
      if (canDiscard) {
        te.classList.add("mg-tile-click");
        te.addEventListener("click", (ev) => {
          ev.stopPropagation();
          game.playTile(i);
        });
      }
      if (game.riichiPending) te.classList.add("mg-tile-riichi");
      handRow.appendChild(te);
    });
    meZone.appendChild(handRow);
    root.appendChild(meZone);

    // ---------- 操作区 ----------
    const actions = el("div", "mg-actions");
    const p = game.pending;
    if (p && p.kind === "turn") {
      if (p.options.includes("tsumo")) actions.appendChild(button("自摸和了", "mg-btn mg-btn-win", () => game.tsumo()));
      if (p.options.includes("riichi") && !game.riichiPending) actions.appendChild(button("立直", "mg-btn", () => game.declareRiichi()));
      if (game.riichiPending) actions.appendChild(button("取消立直", "mg-btn", () => game.cancelRiichi()));
      if (p.options.includes("ankan")) actions.appendChild(button("暗杠", "mg-btn", () => game.ankan()));
      actions.appendChild(el("span", "mg-hint", game.riichiPending ? "请点击要打出的牌（立直宣言）" : "点击手牌打出"));
    } else if (p && p.kind === "call") {
      if (p.options.includes("ron")) actions.appendChild(button("荣和！", "mg-btn mg-btn-win", () => game.call("ron")));
      if (p.options.includes("pon")) actions.appendChild(button("碰", "mg-btn", () => game.call("pon")));
      if (p.options.includes("kan")) actions.appendChild(button("杠", "mg-btn", () => game.call("kan")));
      actions.appendChild(button("过", "mg-btn", () => game.call("pass")));
      actions.appendChild(el("span", "mg-hint", "桌宠打出 " + (p.tile !== undefined ? tileName(p.tile) : "") + "，可要吗？"));
    } else if (game.phase === "handend") {
      actions.appendChild(button("下一局", "mg-btn mg-btn-primary", () => game.nextHand()));
      actions.appendChild(el("span", "mg-hint", "本局结束"));
    } else if (game.phase === "ended") {
      actions.appendChild(button("再来一局", "mg-btn mg-btn-primary", () => game.newMatch()));
      actions.appendChild(el("span", "mg-hint", "对局已结束"));
    } else {
      actions.appendChild(el("span", "mg-hint", "桌宠思考中…"));
    }
    root.appendChild(actions);

    // ---------- 结算横幅 ----------
    if (game.handResult && game.phase !== "playing") {
      const banner = el("div", "mg-banner");
      banner.appendChild(el("div", "mg-banner-text", game.handResult));
      root.appendChild(banner);
    }
  };

  game.onUpdate = render;
  game.newMatch();

  return {
    unmount() {
      disposed = true;
      game.dispose();
      root.remove();
    },
  };
}
