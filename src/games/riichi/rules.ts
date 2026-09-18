/**
 * 立直麻将规则核心：和牌分解、听牌、役种、符与点数。
 * 番符以 WRC Rules 2022 第 11 章为基准；Petra 双人房规由唯一对手支付
 * 按庄闲荣和倍率算出的整笔手牌价值，自摸不套用四人分摊。
 * 一发、里宝牌、赤牌、抢杠、责任支付与累计役满当前不计。
 */
import {
  countsOf, doraFromIndicator, isDragon, isHonor, isTerminal, isTerminalOrHonor,
  rankOf, sortTiles, TILE_KINDS, WIND_E,
} from "./tiles";

export type GroupKind = "run" | "triplet" | "kan";
export interface Meld { kind: GroupKind; tiles: number[]; open: boolean; from: 0 | 1 | null; }
export interface Decomp { pair: number; runs: number[]; triplets: number[]; }
interface GroupSearch { runs: number[]; triplets: number[]; }

function searchGroupsAll(counts: number[], need: number, out: GroupSearch[], runs: number[], triplets: number[]): void {
  if (out.length >= 96) return;
  if (need === 0) {
    if (counts.every((count) => count === 0)) out.push({ runs: [...runs], triplets: [...triplets] });
    return;
  }
  let tile = 0;
  while (tile < TILE_KINDS && counts[tile] === 0) tile++;
  if (tile === TILE_KINDS) return;
  if (counts[tile] >= 3) {
    counts[tile] -= 3; triplets.push(tile);
    searchGroupsAll(counts, need - 1, out, runs, triplets);
    triplets.pop(); counts[tile] += 3;
  }
  if (tile < 27 && rankOf(tile) <= 7 && counts[tile + 1] > 0 && counts[tile + 2] > 0) {
    counts[tile]--; counts[tile + 1]--; counts[tile + 2]--; runs.push(tile);
    searchGroupsAll(counts, need - 1, out, runs, triplets);
    runs.pop(); counts[tile]++; counts[tile + 1]++; counts[tile + 2]++;
  }
}

/** 枚举全部合法拆分，而不是只取第一条递归路径。 */
export function decompose(tiles: number[], need: number): Decomp[] {
  if (need < 0 || tiles.length !== need * 3 + 2) return [];
  const counts = countsOf(tiles);
  const out: Decomp[] = [];
  for (let pair = 0; pair < TILE_KINDS; pair++) {
    if (counts[pair] < 2) continue;
    counts[pair] -= 2;
    const groups: GroupSearch[] = [];
    searchGroupsAll(counts, need, groups, [], []);
    counts[pair] += 2;
    for (const group of groups) {
      out.push({ pair, runs: group.runs, triplets: group.triplets });
      if (out.length >= 96) return out;
    }
  }
  return out;
}

function isSevenPairs(tiles: number[]): boolean {
  return tiles.length === 14 && countsOf(tiles).filter((count) => count === 2).length === 7;
}

const ORPHANS = new Set([0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]);
function isKokushi(tiles: number[]): boolean {
  if (tiles.length !== 14) return false;
  const counts = countsOf(tiles);
  let pair = false;
  for (let tile = 0; tile < TILE_KINDS; tile++) {
    if (!ORPHANS.has(tile) && counts[tile] > 0) return false;
    if (ORPHANS.has(tile)) {
      if (counts[tile] === 0) return false;
      if (counts[tile] >= 2) pair = true;
    }
  }
  return pair;
}

export function canWin(closed: number[], meldCount: number): boolean {
  if (meldCount === 0 && (isSevenPairs(closed) || isKokushi(closed))) return true;
  return decompose(closed, 4 - meldCount).length > 0;
}

/** unavailable 只影响普通提示；传恒 false 可保留“余0”的牌形听牌。 */
export function tenpaiWaits(closed: number[], meldCount: number, unavailable: (tile: number) => boolean): number[] {
  if (closed.length !== 13 - 3 * meldCount) return [];
  const waits: number[] = [];
  for (let tile = 0; tile < TILE_KINDS; tile++) {
    if (!unavailable(tile) && canWin(sortTiles([...closed, tile]), meldCount)) waits.push(tile);
  }
  return waits;
}
export function isTenpai(closed: number[], meldCount: number, unavailable: (tile: number) => boolean): boolean {
  return tenpaiWaits(closed, meldCount, unavailable).length > 0;
}

export interface WinContext {
  closed: number[]; melds: Meld[]; tsumo: boolean; riichi: boolean;
  seatWind: number; roundWind: number; doraIndicators: number[]; winningTile: number;
  rinshan?: boolean; haitei?: boolean; houtei?: boolean;
}
export interface YakuHit { name: string; han: number; yakuman?: number; }
export interface FuItem { name: string; fu: number; }
export type HandShape = "standard" | "seven-pairs" | "thirteen-orphans";
export interface WinResult {
  yaku: YakuHit[]; doraCount: number; han: number; fu: number; fuRaw: number;
  fuItems: FuItem[]; points: number; basePoints: number; limitName: string | null;
  yakuman: number; shape: HandShape; runs: number[]; triplets: number[];
  pair: number; menzen: boolean;
}

const round100 = (value: number) => Math.ceil(value / 100) * 100;
function pointBase(han: number, fu: number, yakuman: number): { base: number; limit: string | null } {
  if (yakuman > 0) return { base: 8000 * yakuman, limit: yakuman > 1 ? `${yakuman}倍役满` : "役满" };
  if (han >= 11) return { base: 6000, limit: "三倍满" };
  if (han >= 8) return { base: 4000, limit: "倍满" };
  if (han >= 6) return { base: 3000, limit: "跳满" };
  if (han >= 5) return { base: 2000, limit: "满贯" };
  const raw = fu * (2 ** (han + 2));
  return raw >= 1920 ? { base: 2000, limit: "满贯" } : { base: raw, limit: null };
}
export function pointsForHand(han: number, fu: number, dealer: boolean, yakuman = 0): { points: number; basePoints: number; limitName: string | null } {
  const value = pointBase(han, fu, yakuman);
  return { points: round100(value.base * (dealer ? 6 : 4)), basePoints: value.base, limitName: value.limit };
}
/** 旧调用兼容：南家荣和、30符。 */
export function pointsForHan(han: number): number { return pointsForHand(han, 30, false).points; }

function allTilesFor(ctx: WinContext): number[] {
  return [...ctx.closed, ...ctx.melds.flatMap((meld) => meld.tiles)];
}
function addContextYaku(ctx: WinContext, menzen: boolean, yaku: YakuHit[]): void {
  if (ctx.riichi) yaku.push({ name: "立直", han: 1 });
  if (ctx.tsumo && menzen) yaku.push({ name: "门前清自摸和", han: 1 });
  if (ctx.rinshan) yaku.push({ name: "岭上开花", han: 1 });
  if (ctx.haitei && ctx.tsumo) yaku.push({ name: "海底摸月", han: 1 });
  if (ctx.houtei && !ctx.tsumo) yaku.push({ name: "河底捞鱼", han: 1 });
}
function flushYaku(allTiles: number[], menzen: boolean): YakuHit | null {
  const suits = new Set<number>();
  let honors = false;
  for (const tile of allTiles) isHonor(tile) ? honors = true : suits.add(Math.floor(tile / 9));
  if (suits.size !== 1) return null;
  return honors ? { name: "混一色", han: menzen ? 3 : 2 } : { name: "清一色", han: menzen ? 6 : 5 };
}
function countDora(ctx: WinContext, allTiles: number[]): number {
  const dora = new Set(ctx.doraIndicators.map(doraFromIndicator));
  return allTiles.reduce((sum, tile) => sum + (dora.has(tile) ? 1 : 0), 0);
}
function finishResult(ctx: WinContext, shape: HandShape, yaku: YakuHit[], fu: number, fuRaw: number,
  fuItems: FuItem[], runs: number[], triplets: number[], pair: number, menzen: boolean): WinResult | null {
  const yakuman = yaku.reduce((sum, item) => sum + (item.yakuman ?? 0), 0);
  const yakuHan = yaku.reduce((sum, item) => sum + item.han, 0);
  if (yakuman === 0 && yakuHan === 0) return null;
  const doraCount = yakuman > 0 ? 0 : countDora(ctx, allTilesFor(ctx));
  const han = yakuman > 0 ? 0 : yakuHan + doraCount;
  const point = pointsForHand(han, fu, ctx.seatWind === WIND_E, yakuman);
  return { yaku, doraCount, han, fu, fuRaw, fuItems, points: point.points, basePoints: point.basePoints,
    limitName: point.limitName, yakuman, shape, runs, triplets, pair, menzen };
}

interface Placement { kind: "pair" | "triplet" | "run"; runStart?: number; tripletTile?: number; }
function placements(d: Decomp, winningTile: number): Placement[] {
  const out: Placement[] = [];
  if (d.pair === winningTile) out.push({ kind: "pair" });
  for (const tile of d.triplets) if (tile === winningTile) out.push({ kind: "triplet", tripletTile: tile });
  for (const run of d.runs) if (winningTile >= run && winningTile <= run + 2) out.push({ kind: "run", runStart: run });
  return out.length > 0 ? out : [{ kind: "pair" }];
}
function isRyanmen(p: Placement, win: number): boolean {
  if (p.kind !== "run" || p.runStart === undefined) return false;
  const offset = win - p.runStart, start = rankOf(p.runStart);
  return (offset === 0 && start !== 7) || (offset === 2 && start !== 1);
}
function waitFu(p: Placement, win: number): FuItem | null {
  if (p.kind === "pair") return { name: "单骑听牌", fu: 2 };
  if (p.kind !== "run" || p.runStart === undefined) return null;
  const offset = win - p.runStart, start = rankOf(p.runStart);
  if (offset === 1) return { name: "嵌张听牌", fu: 2 };
  if ((offset === 2 && start === 1) || (offset === 0 && start === 7)) return { name: "边张听牌", fu: 2 };
  return null;
}
function groupFu(tile: number, open: boolean, kan: boolean): number {
  const end = isTerminalOrHonor(tile);
  return kan ? (open ? (end ? 16 : 8) : (end ? 32 : 16)) : (open ? (end ? 4 : 2) : (end ? 8 : 4));
}

function standardYakuman(ctx: WinContext, d: Decomp, p: Placement, allTiles: number[], triplets: number[]): YakuHit[] {
  const out: YakuHit[] = [];
  const dragons = triplets.filter(isDragon).length;
  const winds = triplets.filter((tile) => tile >= 27 && tile <= 30).length;
  const kans = ctx.melds.filter((meld) => meld.kind === "kan").length;
  let concealed = d.triplets.length - (!ctx.tsumo && p.kind === "triplet" ? 1 : 0);
  concealed += ctx.melds.filter((meld) => meld.kind === "kan" && !meld.open).length;
  if (dragons === 3) out.push({ name: "大三元", han: 0, yakuman: 1 });
  if (winds === 4) out.push({ name: "大四喜", han: 0, yakuman: 1 });
  else if (winds === 3 && d.pair >= 27 && d.pair <= 30) out.push({ name: "小四喜", han: 0, yakuman: 1 });
  if (concealed === 4) out.push({ name: "四暗刻", han: 0, yakuman: 1 });
  if (kans === 4) out.push({ name: "四杠子", han: 0, yakuman: 1 });
  if (allTiles.every(isHonor)) out.push({ name: "字一色", han: 0, yakuman: 1 });
  if (allTiles.every(isTerminal)) out.push({ name: "清老头", han: 0, yakuman: 1 });
  return out;
}

function scoreStandard(ctx: WinContext, d: Decomp, placement: Placement): WinResult | null {
  const menzen = ctx.melds.every((meld) => !meld.open);
  const allTiles = allTilesFor(ctx);
  const runs = [...d.runs, ...ctx.melds.filter((meld) => meld.kind === "run").map((meld) => meld.tiles[0])];
  const triplets = [...d.triplets, ...ctx.melds.filter((meld) => meld.kind !== "run").map((meld) => meld.tiles[0])];
  const yakuman = standardYakuman(ctx, d, placement, allTiles, triplets);
  if (yakuman.length) return finishResult(ctx, "standard", yakuman, 0, 0, [], runs, triplets, d.pair, menzen);

  const yaku: YakuHit[] = [];
  addContextYaku(ctx, menzen, yaku);
  if (allTiles.every((tile) => !isTerminalOrHonor(tile))) yaku.push({ name: "断幺九", han: 1 });
  const valuePair = isDragon(d.pair) || d.pair === ctx.roundWind || d.pair === ctx.seatWind;
  const pinfu = menzen && runs.length === 4 && !valuePair && isRyanmen(placement, ctx.winningTile);
  if (pinfu) yaku.push({ name: "平和", han: 1 });
  let yakuhai = 0;
  for (const tile of triplets) {
    if (isDragon(tile)) yakuhai++;
    if (tile === ctx.roundWind) yakuhai++;
    if (tile === ctx.seatWind) yakuhai++;
  }
  if (yakuhai) yaku.push({ name: "役牌", han: yakuhai });

  if (menzen) {
    const seen = new Map<number, number>();
    for (const run of runs) seen.set(run, (seen.get(run) ?? 0) + 1);
    const pairs = [...seen.values()].reduce((sum, count) => sum + Math.floor(count / 2), 0);
    if (pairs >= 2) yaku.push({ name: "二杯口", han: 3 });
    else if (pairs === 1) yaku.push({ name: "一杯口", han: 1 });
  }
  const sameRuns = new Map<number, Set<number>>();
  for (const run of runs) {
    const rank = run % 9, suits = sameRuns.get(rank) ?? new Set<number>();
    suits.add(Math.floor(run / 9)); sameRuns.set(rank, suits);
  }
  if ([...sameRuns.values()].some((suits) => suits.size === 3)) yaku.push({ name: "三色同顺", han: menzen ? 2 : 1 });
  const straights = new Map<number, Set<number>>();
  for (const run of runs) {
    const suit = Math.floor(run / 9), starts = straights.get(suit) ?? new Set<number>();
    starts.add(run % 9); straights.set(suit, starts);
  }
  if ([...straights.values()].some((starts) => starts.has(0) && starts.has(3) && starts.has(6))) yaku.push({ name: "一气通贯", han: menzen ? 2 : 1 });
  if (triplets.length === 4) yaku.push({ name: "对对和", han: 2 });
  let concealed = d.triplets.length - (!ctx.tsumo && placement.kind === "triplet" ? 1 : 0);
  concealed += ctx.melds.filter((meld) => meld.kind === "kan" && !meld.open).length;
  if (concealed >= 3) yaku.push({ name: "三暗刻", han: 2 });
  if (ctx.melds.filter((meld) => meld.kind === "kan").length >= 3) yaku.push({ name: "三杠子", han: 2 });
  for (let rank = 1; rank <= 9; rank++) {
    if ([0, 1, 2].every((suit) => triplets.includes(suit * 9 + rank - 1))) { yaku.push({ name: "三色同刻", han: 2 }); break; }
  }
  if (triplets.filter(isDragon).length === 2 && isDragon(d.pair)) yaku.push({ name: "小三元", han: 2 });
  if (allTiles.every(isTerminalOrHonor)) yaku.push({ name: "混老头", han: 2 });
  else {
    const ends = isTerminalOrHonor(d.pair) && runs.every((run) => rankOf(run) === 1 || rankOf(run) === 7) && triplets.every(isTerminalOrHonor);
    if (ends && runs.length) {
      const honors = allTiles.some(isHonor);
      yaku.push({ name: honors ? "混全带幺九" : "纯全带幺九", han: honors ? (menzen ? 2 : 1) : (menzen ? 3 : 2) });
    }
  }
  const flush = flushYaku(allTiles, menzen); if (flush) yaku.push(flush);

  const fuItems: FuItem[] = [{ name: "底符", fu: 20 }];
  if (!ctx.tsumo && menzen) fuItems.push({ name: "门清荣和", fu: 10 });
  if (ctx.tsumo && !pinfu) fuItems.push({ name: "自摸", fu: 2 });
  if (isDragon(d.pair)) fuItems.push({ name: "三元牌雀头", fu: 2 });
  if (d.pair === ctx.seatWind) fuItems.push({ name: "自风雀头", fu: 2 });
  if (d.pair === ctx.roundWind) fuItems.push({ name: "场风雀头", fu: 2 });
  const wait = waitFu(placement, ctx.winningTile); if (wait) fuItems.push(wait);
  for (const tile of d.triplets) {
    const open = !ctx.tsumo && placement.kind === "triplet" && placement.tripletTile === tile;
    fuItems.push({ name: `${open ? "明" : "暗"}${isTerminalOrHonor(tile) ? "幺九" : "中张"}刻`, fu: groupFu(tile, open, false) });
  }
  for (const meld of ctx.melds) {
    if (meld.kind === "run") continue;
    const tile = meld.tiles[0];
    fuItems.push({ name: `${meld.open ? "明" : "暗"}${isTerminalOrHonor(tile) ? "幺九" : "中张"}${meld.kind === "kan" ? "杠" : "刻"}`, fu: groupFu(tile, meld.open, meld.kind === "kan") });
  }
  let fuRaw = fuItems.reduce((sum, item) => sum + item.fu, 0);
  let fu = pinfu && ctx.tsumo ? 20 : Math.ceil(fuRaw / 10) * 10;
  if (!menzen && !ctx.tsumo && fu === 20) { fuItems.push({ name: "副露荣和最低符", fu: 10 }); fuRaw += 10; fu = 30; }
  return finishResult(ctx, "standard", yaku, fu, fuRaw, fuItems, runs, triplets, d.pair, menzen);
}

function scoreSevenPairs(ctx: WinContext): WinResult | null {
  if (ctx.melds.length || !isSevenPairs(ctx.closed)) return null;
  const allTiles = allTilesFor(ctx);
  if (allTiles.every(isHonor)) return finishResult(ctx, "seven-pairs", [{ name: "字一色", han: 0, yakuman: 1 }], 0, 0, [], [], [], -1, true);
  const yaku: YakuHit[] = [{ name: "七对子", han: 2 }];
  addContextYaku(ctx, true, yaku);
  if (allTiles.every((tile) => !isTerminalOrHonor(tile))) yaku.push({ name: "断幺九", han: 1 });
  if (allTiles.every(isTerminalOrHonor)) yaku.push({ name: "混老头", han: 2 });
  const flush = flushYaku(allTiles, true); if (flush) yaku.push(flush);
  return finishResult(ctx, "seven-pairs", yaku, 25, 25, [{ name: "七对子固定", fu: 25 }], [], [], -1, true);
}
function scoreKokushi(ctx: WinContext): WinResult | null {
  if (ctx.melds.length || !isKokushi(ctx.closed)) return null;
  return finishResult(ctx, "thirteen-orphans", [{ name: "国士无双", han: 0, yakuman: 1 }], 0, 0, [], [], [], -1, true);
}
function better(a: WinResult | null, b: WinResult | null): WinResult | null {
  if (!a) return b; if (!b) return a;
  if (a.points !== b.points) return a.points > b.points ? a : b;
  if (a.yakuman !== b.yakuman) return a.yakuman > b.yakuman ? a : b;
  if (a.han !== b.han) return a.han > b.han ? a : b;
  return a.fu >= b.fu ? a : b;
}
export function evaluateWin(ctx: WinContext): WinResult | null {
  let best = better(scoreKokushi(ctx), scoreSevenPairs(ctx));
  for (const decomp of decompose(ctx.closed, 4 - ctx.melds.length)) {
    for (const placement of placements(decomp, ctx.winningTile)) best = better(best, scoreStandard(ctx, decomp, placement));
  }
  return best;
}

export function handPotential(tiles: number[]): number {
  const counts = countsOf(tiles), copy = [...counts]; let score = 0;
  for (let tile = 0; tile < TILE_KINDS; tile++) while (copy[tile] >= 3) { copy[tile] -= 3; score += 3; }
  for (let tile = 0; tile < 27; tile++) {
    if (rankOf(tile) > 7) continue;
    while (copy[tile] && copy[tile + 1] && copy[tile + 2]) { copy[tile]--; copy[tile + 1]--; copy[tile + 2]--; score += 3; }
  }
  for (let tile = 0; tile < TILE_KINDS; tile++) if (copy[tile] === 2) score += 1.5;
  for (let tile = 0; tile < TILE_KINDS; tile++) {
    if (!copy[tile]) continue;
    if (tile < 27 && rankOf(tile) <= 7 && copy[tile + 1]) score += .6;
    if (tile < 27 && rankOf(tile) <= 6 && copy[tile + 2]) score += .4;
    if (isHonor(tile)) score -= .4;
  }
  return score;
}
export function isolationOf(tile: number, counts: number[]): number {
  if (isHonor(tile)) return counts[tile] >= 3 ? -6 : counts[tile] === 2 ? -1 : 6;
  const rank = rankOf(tile); let connected = counts[tile] >= 3 ? 6 : counts[tile] === 2 ? 2 : 0;
  if (rank > 1 && counts[tile - 1]) connected += 1.5;
  if (rank < 9 && counts[tile + 1]) connected += 1.5;
  if (rank > 2 && counts[tile - 2]) connected += .7;
  if (rank < 8 && counts[tile + 2]) connected += .7;
  return 3 - connected + (rank === 1 || rank === 9 ? .8 : 0);
}
