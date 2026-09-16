/**
 * 立直麻将规则核心：和牌分解、听牌判定、役种与算点。
 * 说明：2 人桌宠对局采用「无符计算」的简化算点（番数表），役种覆盖常见门清/副露役。
 */
import {
  countsOf,
  doraFromIndicator,
  isDragon,
  isHonor,
  isTerminalOrHonor,
  rankOf,
  sortTiles,
  TILE_KINDS,
} from "./tiles";

export type GroupKind = "run" | "triplet" | "kan";

/** 副露（含暗杠）：tiles 为完整 3/4 张；from 为放铳者（暗杠为 null） */
export interface Meld {
  kind: GroupKind;
  tiles: number[];
  open: boolean;
  from: 0 | 1 | null;
}

export interface Decomp {
  pair: number;
  runs: number[];      // 顺子起始牌
  triplets: number[];  // 刻子牌
}

/** 递归搜索：把 counts 恰好拆成 need 组（刻子/顺子） */
function searchGroups(
  counts: number[],
  need: number,
): { runs: number[]; triplets: number[] } | null {
  if (need === 0) {
    for (let i = 0; i < TILE_KINDS; i++) if (counts[i] !== 0) return null;
    return { runs: [], triplets: [] };
  }
  let t = 0;
  while (t < TILE_KINDS && counts[t] === 0) t++;
  if (t === TILE_KINDS) return null;
  if (counts[t] >= 3) {
    counts[t] -= 3;
    const rest = searchGroups(counts, need - 1);
    counts[t] += 3;
    if (rest) return { runs: rest.runs, triplets: [t, ...rest.triplets] };
  }
  if (t < 27 && rankOf(t) <= 7 && counts[t + 1] > 0 && counts[t + 2] > 0) {
    counts[t]--;
    counts[t + 1]--;
    counts[t + 2]--;
    const rest = searchGroups(counts, need - 1);
    counts[t]++;
    counts[t + 1]++;
    counts[t + 2]++;
    if (rest) return { runs: [t, ...rest.runs], triplets: rest.triplets };
  }
  return null;
}

/** 枚举所有「雀头 + 若干面子」拆解（上限 24 种，防爆） */
export function decompose(tiles: number[], need: number): Decomp[] {
  if (need < 0 || tiles.length !== need * 3 + 2) return [];
  const counts = countsOf(tiles);
  const out: Decomp[] = [];
  for (let t = 0; t < TILE_KINDS; t++) {
    if (counts[t] < 2) continue;
    counts[t] -= 2;
    const res = searchGroups(counts, need);
    counts[t] += 2;
    if (res) out.push({ pair: t, runs: res.runs, triplets: res.triplets });
    if (out.length >= 24) break;
  }
  return out;
}

/** 和牌判定 */
export function canWin(closed: number[], meldCount: number): boolean {
  return decompose(closed, 4 - meldCount).length > 0;
}

/**
 * 听牌判定：返回所有可和牌张。
 * unavailable(t) 用于排除已见 4 张的牌。
 */
export function tenpaiWaits(
  closed: number[],
  meldCount: number,
  unavailable: (t: number) => boolean,
): number[] {
  if (closed.length !== 13 - 3 * meldCount) return [];
  const waits: number[] = [];
  for (let t = 0; t < TILE_KINDS; t++) {
    if (unavailable(t)) continue;
    if (canWin(sortTiles([...closed, t]), meldCount)) waits.push(t);
  }
  return waits;
}

export function isTenpai(
  closed: number[],
  meldCount: number,
  unavailable: (t: number) => boolean,
): boolean {
  return tenpaiWaits(closed, meldCount, unavailable).length > 0;
}

export interface WinContext {
  closed: number[];        // 含和牌张的门清手牌
  melds: Meld[];
  tsumo: boolean;
  riichi: boolean;
  seatWind: number;
  roundWind: number;
  doraIndicators: number[];
  winningTile: number;
}

export interface YakuHit {
  name: string;
  han: number;
}

export interface WinResult {
  yaku: YakuHit[];
  doraCount: number;
  han: number;
  points: number;
  runs: number[];
  triplets: number[];
  pair: number;
  menzen: boolean;
}

/** 番数 → 点数（无符，2 人局由放铳方/对手全额支付） */
export function pointsForHan(han: number): number {
  if (han >= 11) return 24000;
  if (han >= 8) return 16000;
  if (han >= 6) return 12000;
  if (han >= 5) return 8000;
  if (han === 4) return 7700;
  if (han === 3) return 3900;
  if (han === 2) return 2000;
  if (han === 1) return 1000;
  return 0;
}

function scoreDecomp(ctx: WinContext, d: Decomp): WinResult | null {
  const menzen = ctx.melds.every((m) => !m.open);
  const allTiles: number[] = [...ctx.closed];
  for (const m of ctx.melds) allTiles.push(...m.tiles);

  const runStarts: number[] = [...d.runs];
  const tripletTiles: number[] = [...d.triplets];
  for (const m of ctx.melds) {
    if (m.kind === "run") runStarts.push(m.tiles[0]);
    else tripletTiles.push(m.tiles[0]);
  }

  const yaku: YakuHit[] = [];

  if (ctx.riichi) yaku.push({ name: "立直", han: 1 });
  if (ctx.tsumo && menzen) yaku.push({ name: "门前清自摸和", han: 1 });

  if (allTiles.every((t) => !isTerminalOrHonor(t))) yaku.push({ name: "断幺九", han: 1 });

  // 平和：门清 + 全顺子 + 雀头非役牌 + 两面听
  const pairYakuhai = isDragon(d.pair) || d.pair === ctx.roundWind || d.pair === ctx.seatWind;
  let ryanmen = false;
  if (!d.triplets.includes(ctx.winningTile) && d.pair !== ctx.winningTile) {
    for (const r of d.runs) {
      if (r === ctx.winningTile || r + 2 === ctx.winningTile) {
        ryanmen = true;
        break;
      }
    }
  }
  if (menzen && runStarts.length === 4 && !pairYakuhai && ryanmen) {
    yaku.push({ name: "平和", han: 1 });
  }

  let yakuhaiHan = 0;
  for (const t of tripletTiles) {
    if (isDragon(t)) yakuhaiHan += 1;
    if (t === ctx.roundWind) yakuhaiHan += 1;
    if (t === ctx.seatWind) yakuhaiHan += 1;
  }
  if (yakuhaiHan > 0) yaku.push({ name: "役牌", han: yakuhaiHan });

  if (menzen) {
    const runCount = new Map<number, number>();
    for (const r of runStarts) runCount.set(r, (runCount.get(r) ?? 0) + 1);
    for (const v of runCount.values()) {
      if (v >= 2) {
        yaku.push({ name: "一杯口", han: 1 });
        break;
      }
    }
  }

  {
    const byRank = new Map<number, Set<number>>();
    for (const r of runStarts) {
      const rank = r % 9;
      const set = byRank.get(rank) ?? new Set<number>();
      set.add(Math.floor(r / 9));
      byRank.set(rank, set);
    }
    for (const set of byRank.values()) {
      if (set.size === 3) {
        yaku.push({ name: "三色同顺", han: 2 });
        break;
      }
    }
  }

  {
    const bySuit = new Map<number, Set<number>>();
    for (const r of runStarts) {
      const s = Math.floor(r / 9);
      const set = bySuit.get(s) ?? new Set<number>();
      set.add(r % 9);
      bySuit.set(s, set);
    }
    for (const set of bySuit.values()) {
      if (set.has(0) && set.has(3) && set.has(6)) {
        yaku.push({ name: "一气通贯", han: menzen ? 2 : 1 });
        break;
      }
    }
  }

  if (tripletTiles.length === 4) yaku.push({ name: "对对和", han: 2 });

  {
    // 三暗刻：荣和时和牌张凑成的刻子算明刻
    let ankou = 0;
    for (const t of d.triplets) {
      const madeByRon = !ctx.tsumo && t === ctx.winningTile;
      if (!madeByRon) ankou++;
    }
    ankou += ctx.melds.filter((m) => m.kind === "kan" && !m.open).length;
    if (ankou >= 3) yaku.push({ name: "三暗刻", han: 2 });
  }

  {
    const suits = new Set<number>();
    let hasHonor = false;
    for (const t of allTiles) {
      if (isHonor(t)) hasHonor = true;
      else suits.add(Math.floor(t / 9));
    }
    if (suits.size === 1) {
      if (hasHonor) yaku.push({ name: "混一色", han: menzen ? 3 : 2 });
      else yaku.push({ name: "清一色", han: menzen ? 6 : 5 });
    }
  }

  if (yaku.length === 0) return null;

  let doraCount = 0;
  const doraTiles = new Set(ctx.doraIndicators.map(doraFromIndicator));
  for (const t of allTiles) if (doraTiles.has(t)) doraCount++;

  const han = yaku.reduce((s, y) => s + y.han, 0) + doraCount;
  return {
    yaku,
    doraCount,
    han,
    points: pointsForHan(han),
    runs: runStarts,
    triplets: tripletTiles,
    pair: d.pair,
    menzen,
  };
}

/** 计算和牌（返回番数最高的解释；无役返回 null） */
export function evaluateWin(ctx: WinContext): WinResult | null {
  const decomps = decompose(ctx.closed, 4 - ctx.melds.length);
  if (decomps.length === 0) return null;
  let best: WinResult | null = null;
  for (const d of decomps) {
    const r = scoreDecomp(ctx, d);
    if (!r) continue;
    if (!best || r.han > best.han) best = r;
  }
  return best;
}

/** 手牌估值（AI 打牌启发式用）：面子数 * 3 + 对子数 + 搭子数 * 0.5 */
export function handPotential(tiles: number[]): number {
  const counts = countsOf(tiles);
  let score = 0;
  const c = [...counts];
  for (let t = 0; t < TILE_KINDS; t++) {
    while (c[t] >= 3) {
      c[t] -= 3;
      score += 3;
    }
  }
  for (let t = 0; t < 27; t++) {
    if (rankOf(t) > 7) continue;
    while (c[t] > 0 && c[t + 1] > 0 && c[t + 2] > 0) {
      c[t]--;
      c[t + 1]--;
      c[t + 2]--;
      score += 3;
    }
  }
  for (let t = 0; t < TILE_KINDS; t++) if (c[t] === 2) score += 1.5;
  for (let t = 0; t < TILE_KINDS; t++) {
    if (c[t] === 0) continue;
    if (t < 27 && rankOf(t) <= 7 && c[t + 1] > 0) score += 0.6;
    if (t < 27 && rankOf(t) <= 6 && c[t + 2] > 0) score += 0.4;
    if (isHonor(t)) score -= 0.4;
  }
  return score;
}

/** 单张牌的孤立度（越大越该打）：字牌 > 幺九 > 与其他牌无关联 */
export function isolationOf(tile: number, counts: number[]): number {
  if (isHonor(tile)) {
    if (counts[tile] >= 3) return -6;
    if (counts[tile] === 2) return -1;
    return 6;
  }
  const r = rankOf(tile);
  let conn = 0;
  if (counts[tile] >= 3) conn += 6;
  if (counts[tile] === 2) conn += 2;
  if (r > 1 && counts[tile - 1] > 0) conn += 1.5;
  if (r < 9 && counts[tile + 1] > 0) conn += 1.5;
  if (r > 2 && counts[tile - 2] > 0) conn += 0.7;
  if (r < 8 && counts[tile + 2] > 0) conn += 0.7;
  let base = 3 - conn;
  if (r === 1 || r === 9) base += 0.8;
  return base;
}
