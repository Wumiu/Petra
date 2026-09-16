/**
 * 麻将牌模型（34 种）
 * 0-8: 一万~九万 ｜ 9-17: 一筒~九筒 ｜ 18-26: 一索~九索 ｜ 27-30: 东南西北 ｜ 31-33: 白发中
 */
export const TILE_KINDS = 34;
export const SUIT_M = 0;
export const SUIT_P = 1;
export const SUIT_S = 2;
export const HONOR = 3;

export const WIND_E = 27;
export const WIND_S = 28;
export const WIND_W = 29;
export const WIND_N = 30;
export const DRAGON_HAKU = 31;
export const DRAGON_HATSU = 32;
export const DRAGON_CHUN = 33;

export function suitOf(t: number): number {
  return t < 27 ? Math.floor(t / 9) : HONOR;
}

export function rankOf(t: number): number {
  return t < 27 ? (t % 9) + 1 : t - 26; // 字牌 1..7
}

export function isHonor(t: number): boolean {
  return t >= 27;
}

export function isDragon(t: number): boolean {
  return t >= DRAGON_HAKU;
}

export function isTerminal(t: number): boolean {
  if (isHonor(t)) return false;
  const r = rankOf(t);
  return r === 1 || r === 9;
}

export function isTerminalOrHonor(t: number): boolean {
  return isHonor(t) || isTerminal(t);
}

const NUM_CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const SUIT_CN = ["万", "筒", "索"];
const HONOR_CN = ["东", "南", "西", "北", "白", "发", "中"];

/** 完整牌名，如 "三万"、"中" */
export function tileName(t: number): string {
  if (t < 27) return NUM_CN[t % 9] + SUIT_CN[Math.floor(t / 9)];
  return HONOR_CN[t - 27];
}

/** 紧凑牌名，如 "3万" */
export function tileShort(t: number): string {
  if (t < 27) return String((t % 9) + 1) + SUIT_CN[Math.floor(t / 9)];
  return HONOR_CN[t - 27];
}

export function tileNames(list: number[]): string {
  return list.map(tileShort).join(" ");
}

/** 洗好的一副牌（136 张） */
export function buildWall(): number[] {
  const wall: number[] = [];
  for (let t = 0; t < TILE_KINDS; t++) {
    for (let i = 0; i < 4; i++) wall.push(t);
  }
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = wall[i];
    wall[i] = wall[j];
    wall[j] = tmp;
  }
  return wall;
}

export function sortTiles(list: number[]): number[] {
  return [...list].sort((a, b) => a - b);
}

export function countsOf(list: number[]): number[] {
  const c = new Array<number>(TILE_KINDS).fill(0);
  for (const t of list) c[t]++;
  return c;
}

/** 宝牌指示牌 → 实际宝牌（数牌 9→1，北→东，中→白） */
export function doraFromIndicator(ind: number): number {
  if (ind < 27) {
    const s = Math.floor(ind / 9);
    const r = ind % 9;
    return s * 9 + ((r + 1) % 9);
  }
  if (ind < 31) return WIND_E + ((ind - WIND_E + 1) % 4);
  return DRAGON_HAKU + ((ind - DRAGON_HAKU + 1) % 3);
}

/** 牌墙剩余可摸张数（用于界面显示） */
export function nextTileInWall(wall: number[]): number {
  return wall.length > 0 ? wall[0] : -1;
}
