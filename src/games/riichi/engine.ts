/**
 * 双人立直麻将引擎（桌宠版房规）
 * - 座位：玩家＝东家，桌宠＝南家；场风固定东
 * - 无吃（二人局），碰/明杠/暗杠可用；立直需门清听牌且点数≥1000
 * - 无符算点：番数表，放铳方/对手全额支付；立直棒归和牌者
 * - 流局：听牌方收未听牌方 3000 点，立直棒留场
 * - 无役不可和（宝牌不算役）；本版未实现一发/里宝牌/加杠/九种九牌等
 */
import {
  buildWall,
  countsOf,
  doraFromIndicator,
  isDragon,
  isHonor,
  sortTiles,
  tileName,
  WIND_E,
  WIND_S,
} from "./tiles";
import {
  canWin,
  evaluateWin,
  handPotential,
  isTenpai,
  isolationOf,
  tenpaiWaits,
  type Meld,
  type WinResult,
} from "./rules";

export type Seat = 0 | 1;

export interface PlayerState {
  hand: number[];
  melds: Meld[];
  discards: number[];
  riichi: boolean;
  score: number;
}

export type ActionType = "discard" | "tsumo" | "ron" | "pon" | "kan" | "ankan" | "pass";

export interface PlayerAction {
  type: ActionType;
  tile?: number;
  riichi?: boolean;
}

export interface PendingState {
  kind: "turn" | "call";
  options: string[];
  tile?: number;
}

export const SEAT_NAME = ["你", "桌宠"];

export class RiichiGame {
  players: [PlayerState, PlayerState];
  wall: number[] = [];
  doraIndicators: number[] = [];
  sticks = 0;
  handNo = 1;
  phase: "playing" | "handend" | "ended" = "handend";
  pending: PendingState | null = null;
  log: string[] = [];
  lastDiscard: { tile: number; from: Seat } | null = null;
  lastDraw: number | null = null;
  riichiPending = false;
  handResult: string | null = null;
  matchWinner: Seat | null = null;
  lastHandWinner: Seat | null = null;
  onUpdate: (() => void) | null = null;

  private waiter: ((a: PlayerAction) => void) | null = null;
  private runId = 0;
  private disposed = false;

  constructor() {
    this.players = [this.blankPlayer(), this.blankPlayer()];
  }

  private blankPlayer(): PlayerState {
    return { hand: [], melds: [], discards: [], riichi: false, score: 25000 };
  }

  // ---------- 对外操作 ----------

  newMatch() {
    this.players = [this.blankPlayer(), this.blankPlayer()];
    this.handNo = 1;
    this.sticks = 0;
    this.log = [];
    this.matchWinner = null;
    this.handResult = null;
    this.startHand();
  }

  nextHand() {
    if (this.phase !== "handend") return;
    this.handNo++;
    this.startHand();
  }

  dispose() {
    this.disposed = true;
    this.phase = "ended";
    this.resolveWaiter({ type: "pass" });
  }

  /** 玩家点击手牌 */
  playTile(index: number) {
    if (!this.pending || this.pending.kind !== "turn" || this.waiter === null) return;
    if (this.disposed || this.phase !== "playing") return;
    const me = this.players[0];
    const tile = me.hand[index];
    if (tile === undefined) return;
    let riichi = this.riichiPending;
    if (riichi) {
      const rest = me.hand.filter((_, i) => i !== index);
      if (!isTenpai(rest, me.melds.length, (t) => this.visibleCount(t) >= 4)) {
        riichi = false;
        this.log.push("这张牌打出去没有听牌，立直未成立");
      }
    }
    this.resolveWaiter({ type: "discard", tile, riichi });
  }

  declareRiichi() {
    if (!this.pending || !this.pending.options.includes("riichi")) return;
    this.riichiPending = true;
    this.log.push("你宣言立直，请选择要打出的牌");
    this.update();
  }

  cancelRiichi() {
    this.riichiPending = false;
    this.update();
  }

  tsumo() {
    if (!this.pending || !this.pending.options.includes("tsumo")) return;
    this.resolveWaiter({ type: "tsumo" });
  }

  ankan() {
    if (!this.pending || !this.pending.options.includes("ankan")) return;
    this.resolveWaiter({ type: "ankan" });
  }

  call(type: ActionType) {
    if (!this.pending || this.pending.kind !== "call") return;
    if (!this.pending.options.includes(type)) return;
    this.resolveWaiter({ type });
  }

  // ---------- 基础查询 ----------

  private update() {
    if (!this.disposed && this.onUpdate) this.onUpdate();
  }

  private resolveWaiter(a: PlayerAction) {
    const w = this.waiter;
    this.waiter = null;
    this.pending = null;
    this.riichiPending = false;
    if (w) w(a);
  }

  private request(actor: number, kind: "turn" | "call", options: string[], tile?: number): Promise<PlayerAction> {
    this.pending = { kind, options, tile };
    // 关键顺序：先挂上等待者再刷新 UI —— onUpdate 的回调可能同步应答（如自动打牌/过），
    // 否则应答会被丢弃并造成死锁。
    return new Promise<PlayerAction>((resolve) => {
      this.waiter = resolve;
      this.update();
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** 某张牌已可见的数量（自己手牌/副露/牌河/宝牌指示牌） */
  private visibleCount(t: number): number {
    let n = 0;
    for (const p of this.players) {
      for (const x of p.hand) if (x === t) n++;
      for (const m of p.melds) for (const x of m.tiles) if (x === t) n++;
      for (const x of p.discards) if (x === t) n++;
    }
    for (const d of this.doraIndicators) if (d === t) n++;
    return n;
  }

  private seatWind(seat: Seat): number {
    return seat === 0 ? WIND_E : WIND_S;
  }

  private doraSet(): Set<number> {
    return new Set(this.doraIndicators.map(doraFromIndicator));
  }

  private evalWin(seat: Seat, closed: number[], winningTile: number, tsumo: boolean): WinResult | null {
    const p = this.players[seat];
    return evaluateWin({
      closed,
      melds: p.melds,
      tsumo,
      riichi: p.riichi,
      seatWind: this.seatWind(seat),
      roundWind: WIND_E,
      doraIndicators: this.doraIndicators,
      winningTile,
    });
  }

  private canAnkan(seat: Seat): boolean {
    const p = this.players[seat];
    if (p.riichi) return false;
    if (p.hand.length !== 14 - 3 * p.melds.length) return false;
    const counts = countsOf(p.hand);
    for (let t = 0; t < counts.length; t++) if (counts[t] === 4) return true;
    return false;
  }

  private ankanTile(seat: Seat): number | null {
    const p = this.players[seat];
    const counts = countsOf(p.hand);
    for (let t = 0; t < counts.length; t++) if (counts[t] === 4) return t;
    return null;
  }

  private bestRiichiDiscard(seat: Seat): number | null {
    const p = this.players[seat];
    if (p.melds.length > 0) return null;
    if (p.hand.length !== 14) return null;
    let best: number | null = null;
    let bestWaits = 0;
    const seen = new Set<number>();
    for (let i = 0; i < p.hand.length; i++) {
      const t = p.hand[i];
      if (seen.has(t)) continue;
      seen.add(t);
      const rest = p.hand.filter((_, j) => j !== i);
      const waits = tenpaiWaits(rest, 0, (x) => this.visibleCount(x) >= 4);
      if (waits.length > bestWaits) {
        bestWaits = waits.length;
        best = t;
      }
    }
    return best;
  }

  private canRiichi(seat: Seat): boolean {
    const p = this.players[seat];
    if (p.riichi || p.melds.length > 0 || p.score < 1000) return false;
    if (this.wall.length < 4) return false;
    return this.bestRiichiDiscard(seat) !== null;
  }

  private isTenpaiSeat(seat: Seat): boolean {
    const p = this.players[seat];
    return isTenpai(p.hand, p.melds.length, (t) => this.visibleCount(t) >= 4);
  }

  /** 听牌提示（UI 显示"听：xx"） */
  waitsHint(seat: Seat): number[] {
    const p = this.players[seat];
    return tenpaiWaits(p.hand, p.melds.length, (t) => this.visibleCount(t) >= 4);
  }

  /** 玩家本局是否已立直（UI 高亮用） */
  isRiichi(seat: Seat): boolean {
    return this.players[seat].riichi;
  }

  // ---------- 对局流程 ----------

  private startHand() {
    this.phase = "playing";
    this.handResult = null;
    this.pending = null;
    this.waiter = null;
    this.riichiPending = false;
    this.deal();
    this.log.push("第 " + this.handNo + " 局开始（你＝东家，桌宠＝南家）");
    this.update();
    const id = ++this.runId;
    void this.runLoop(id);
  }

  private deal() {
    this.wall = buildWall();
    this.doraIndicators = [this.wall.shift() as number];
    for (const p of this.players) {
      p.hand = [];
      p.melds = [];
      p.discards = [];
      p.riichi = false;
    }
    for (let i = 0; i < 13; i++) {
      for (const seat of [0, 1] as Seat[]) {
        p_pushHand(this.players[seat], this.wall.shift() as number);
      }
    }
    for (const p of this.players) p.hand = sortTiles(p.hand);
    this.lastDiscard = null;
    this.lastDraw = null;
  }

  private async runLoop(id: number) {
    let current: Seat = 0;
    let needDraw = true;
    for (;;) {
      if (this.disposed || this.phase !== "playing" || id !== this.runId) return;

      if (needDraw) {
        if (this.wall.length === 0) {
          this.finishDraw();
          return;
        }
        const tile = this.wall.shift() as number;
        p_pushHand(this.players[current], tile);
        this.players[current].hand = sortTiles(this.players[current].hand);
        this.lastDraw = tile;
        this.update();
      }

      let action: PlayerAction;
      if (current === 0) {
        const options = this.turnOptions(0, needDraw);
        action = await this.request(0, "turn", options);
        if (this.disposed || id !== this.runId) return;
      } else {
        await this.delay(needDraw ? 650 : 450);
        if (this.disposed || id !== this.runId) return;
        action = this.petDecide(1, needDraw);
      }

      if (action.type === "tsumo") {
        const win = this.evalWin(current, [...this.players[current].hand], this.lastDraw as number, true);
        if (win) {
          this.finishWin(current, win, true);
          return;
        }
        continue;
      }

      if (action.type === "ankan") {
        this.applyAnkan(current);
        needDraw = true;
        continue;
      }

      // 打牌
      const tile = action.tile !== undefined ? action.tile : this.players[current].hand[0];
      this.applyDiscard(current, tile, action.riichi === true);
      this.update();
      await this.delay(280);
      if (this.disposed || id !== this.runId) return;

      const other: Seat = current === 0 ? 1 : 0;
      const resp = await this.requestCall(other, tile);
      if (resp.type === "ron") {
        const win = this.evalWin(other, sortTiles([...this.players[other].hand, tile]), tile, false);
        if (win) {
          this.finishWin(other, win, false);
          return;
        }
      } else if (resp.type === "pon" || resp.type === "kan") {
        this.applyCall(other, resp.type, tile);
        current = other;
        needDraw = resp.type === "kan";
        this.update();
        continue;
      }

      current = other;
      needDraw = true;
    }
  }

  private turnOptions(seat: Seat, needDraw: boolean): string[] {
    const p = this.players[seat];
    const options: string[] = ["discard"];
    if (!needDraw) return options;
    const win = this.evalWin(seat, [...p.hand], this.lastDraw as number, true);
    if (win) options.push("tsumo");
    if (this.canRiichi(seat)) options.push("riichi");
    if (this.canAnkan(seat)) options.push("ankan");
    return options;
  }

  private requestCall(seat: Seat, tile: number): Promise<PlayerAction> {
    const p = this.players[seat];
    const options: string[] = ["pass"];
    const counts = countsOf(p.hand);
    if (this.evalWin(seat, sortTiles([...p.hand, tile]), tile, false)) options.push("ron");
    if (!p.riichi && this.wall.length > 0) {
      if (counts[tile] >= 2) options.push("pon");
      if (counts[tile] >= 3) options.push("kan");
    }
    if (seat === 0) {
      if (options.length === 1) return Promise.resolve({ type: "pass" });
      return this.request(0, "call", options, tile);
    }
    if (this.disposed) return Promise.resolve({ type: "pass" });
    return Promise.resolve(this.petCall(1, tile, options));
  }

  private applyDiscard(seat: Seat, tile: number, riichi: boolean) {
    const p = this.players[seat];
    const idx = p.hand.indexOf(tile);
    if (idx < 0) return;
    p.hand.splice(idx, 1);
    p.discards.push(tile);
    this.lastDiscard = { tile, from: seat };
    if (riichi && !p.riichi && p.melds.length === 0 && p.score >= 1000) {
      p.riichi = true;
      p.score -= 1000;
      this.sticks += 1;
      this.log.push(SEAT_NAME[seat] + " 宣言立直（" + tileName(tile) + "）");
    } else {
      this.log.push(SEAT_NAME[seat] + " 打出 " + tileName(tile));
    }
  }

  private applyCall(seat: Seat, type: "pon" | "kan", tile: number) {
    const p = this.players[seat];
    const need = type === "pon" ? 2 : 3;
    for (let i = 0; i < need; i++) {
      const idx = p.hand.indexOf(tile);
      if (idx >= 0) p.hand.splice(idx, 1);
    }
    p.melds.push({
      kind: type === "pon" ? "triplet" : "kan",
      tiles: type === "pon" ? [tile, tile, tile] : [tile, tile, tile, tile],
      open: true,
      from: seat === 0 ? 1 : 0,
    });
    const from = seat === 0 ? 1 : 0;
    this.players[from].discards.pop();
    this.lastDiscard = null;
    this.log.push(SEAT_NAME[seat] + (type === "pon" ? " 碰 " : " 明杠 ") + tileName(tile));
    if (type === "kan") this.flipKanDora();
  }

  private applyAnkan(seat: Seat) {
    const tile = this.ankanTile(seat);
    if (tile === null) return;
    const p = this.players[seat];
    for (let i = 0; i < 4; i++) {
      const idx = p.hand.indexOf(tile);
      if (idx >= 0) p.hand.splice(idx, 1);
    }
    p.melds.push({ kind: "kan", tiles: [tile, tile, tile, tile], open: false, from: null });
    this.log.push(SEAT_NAME[seat] + " 暗杠 " + tileName(tile));
    this.flipKanDora();
    this.update();
  }

  private flipKanDora() {
    if (this.doraIndicators.length >= 5 || this.wall.length === 0) return;
    const ind = this.wall.shift() as number;
    this.doraIndicators.push(ind);
    this.log.push("新宝牌指示牌：" + tileName(ind));
  }

  // ---------- 桌宠 AI ----------

  private petDecide(seat: Seat, needDraw: boolean): PlayerAction {
    const p = this.players[seat];
    if (needDraw) {
      const win = this.evalWin(seat, [...p.hand], this.lastDraw as number, true);
      if (win) return { type: "tsumo" };
      if (this.canAnkan(seat) && Math.random() < 0.85) return { type: "ankan" };
      if (this.canRiichi(seat)) {
        const choice = this.bestRiichiDiscard(seat);
        if (choice !== null && Math.random() < 0.9) return { type: "discard", tile: choice, riichi: true };
      }
    }
    return { type: "discard", tile: this.petPickDiscard(seat) };
  }

  private petPickDiscard(seat: Seat): number {
    const p = this.players[seat];
    const counts = countsOf(p.hand);
    const dora = this.doraSet();
    const seen = new Set<number>();
    let best = p.hand[0];
    let bestScore = -Infinity;
    for (let i = 0; i < p.hand.length; i++) {
      const t = p.hand[i];
      if (seen.has(t)) continue;
      seen.add(t);
      const rest = p.hand.filter((_, j) => j !== i);
      const tenpaiNow = isTenpai(rest, p.melds.length, (x) => this.visibleCount(x) >= 4);
      if (p.riichi && !tenpaiNow) continue;
      let score = handPotential(rest) * 10 + isolationOf(t, counts) * 0.8;
      if (dora.has(t)) score -= 5;
      if (isHonor(t) && counts[t] >= 2) score += 3;
      if (tenpaiNow) score += 6;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  private petCall(seat: Seat, tile: number, options: string[]): PlayerAction {
    if (options.includes("ron")) return { type: "ron" };
    const p = this.players[seat];
    const counts = countsOf(p.hand);
    const dora = this.doraSet();
    const isYakuhai = isDragon(tile) || tile === this.seatWind(seat) || tile === WIND_E;
    if (options.includes("kan") && counts[tile] >= 3 && (isYakuhai || dora.has(tile)) && Math.random() < 0.7) {
      return { type: "kan" };
    }
    if (options.includes("pon") && counts[tile] >= 2) {
      if (isYakuhai && Math.random() < 0.85) return { type: "pon" };
      if (dora.has(tile) && Math.random() < 0.5) return { type: "pon" };
      if (!p.riichi && p.melds.length > 0 && Math.random() < 0.25) return { type: "pon" };
    }
    return { type: "pass" };
  }

  // ---------- 结算 ----------

  private finishWin(winner: Seat, win: WinResult, tsumo: boolean) {
    this.lastHandWinner = winner;
    const loser: Seat = winner === 0 ? 1 : 0;
    const pts = win.points;
    this.players[loser].score -= pts;
    this.players[winner].score += pts + this.sticks * 1000;
    const stickGet = this.sticks * 1000;
    this.sticks = 0;
    const detail = win.yaku.map((y) => y.name + y.han + "番").join("、") +
      (win.doraCount > 0 ? "、宝牌" + win.doraCount : "");
    this.log.push(
      SEAT_NAME[winner] + (tsumo ? " 自摸" : " 荣和") + "：" + detail +
      "，共 " + win.han + " 番 " + pts + " 点" + (stickGet > 0 ? "（含立直棒 " + stickGet + "）" : ""),
    );
    this.handResult =
      (winner === 0 ? "🎉 你和了！" : "😿 桌宠和了") +
      "\n" + detail + " ｜ " + win.han + " 番 " + pts + " 点" +
      "\n" + (tsumo ? "自摸" : "荣和") + "，由" + SEAT_NAME[loser] + "支付";
    this.endHand();
  }

  private finishDraw() {
    this.lastHandWinner = null;
    const t0 = this.isTenpaiSeat(0);
    const t1 = this.isTenpaiSeat(1);
    let msg = "牌墙摸完，流局";
    if (t0 && !t1) {
      this.players[0].score += 3000;
      this.players[1].score -= 3000;
      msg += "：你听牌，桌宠支付 3000 点";
    } else if (t1 && !t0) {
      this.players[1].score += 3000;
      this.players[0].score -= 3000;
      msg += "：桌宠听牌，你支付 3000 点";
    } else if (t0 && t1) {
      msg += "：双方听牌，无点数变动";
    } else {
      msg += "：双方均未听牌";
    }
    this.log.push(msg);
    this.handResult = "🀫 " + msg + "\n立直棒留在桌上";
    this.endHand();
  }

  private endHand() {
    this.phase = "handend";
    this.pending = null;
    const [a, b] = this.players;
    if (a.score <= 0 || b.score <= 0) {
      this.phase = "ended";
      this.matchWinner = a.score >= b.score ? 0 : 1;
      this.handResult += "\n\n🏁 对局结束：" + (this.matchWinner === 0 ? "你赢了！" : "桌宠赢了") +
        "（" + a.score + " : " + b.score + "）";
    }
    this.update();
  }
}

/** 手牌插入并保持有序 */
function p_pushHand(p: PlayerState, tile: number) {
  p.hand.push(tile);
}
