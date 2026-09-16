/**
 * Petra riichi tile artwork.
 *
 * The faces are original, reusable SVG drawings generated locally by this module.
 * They deliberately use ordinary numerals/kanji and geometric suit marks rather
 * than Unicode mahjong-tile characters.  Keeping the art procedural gives every
 * place in the UI (hand, river, meld, dora and wall) one authoritative mapping.
 */
import { isHonor, rankOf, suitOf, tileName } from "./tiles";

const cache = new Map<string, string>();

const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
}[ch] ?? ch));

function svgData(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function pinMarks(rank: number): string {
  const layouts: Record<number, Array<[number, number, string]>> = {
    1: [[36, 49, "#2f8d62"]],
    2: [[36, 31, "#2d67a7"], [36, 67, "#c94b45"]],
    3: [[22, 29, "#2d67a7"], [36, 49, "#c94b45"], [50, 69, "#2f8d62"]],
    4: [[22, 30, "#2d67a7"], [50, 30, "#2f8d62"], [22, 68, "#2f8d62"], [50, 68, "#2d67a7"]],
    5: [[20, 27, "#2d67a7"], [52, 27, "#2f8d62"], [36, 49, "#c94b45"], [20, 71, "#2f8d62"], [52, 71, "#2d67a7"]],
    6: [[20, 24, "#2f8d62"], [52, 24, "#2f8d62"], [20, 49, "#c94b45"], [52, 49, "#c94b45"], [20, 74, "#2d67a7"], [52, 74, "#2d67a7"]],
    7: [[18, 23, "#c94b45"], [36, 23, "#c94b45"], [54, 23, "#c94b45"], [20, 50, "#2f8d62"], [52, 50, "#2f8d62"], [20, 76, "#2d67a7"], [52, 76, "#2d67a7"]],
    8: [[18, 22, "#2d67a7"], [36, 22, "#2d67a7"], [54, 22, "#2d67a7"], [18, 49, "#2f8d62"], [54, 49, "#2f8d62"], [18, 76, "#c94b45"], [36, 76, "#c94b45"], [54, 76, "#c94b45"]],
    9: [[18, 22, "#2d67a7"], [36, 22, "#2d67a7"], [54, 22, "#2d67a7"], [18, 49, "#c94b45"], [36, 49, "#c94b45"], [54, 49, "#c94b45"], [18, 76, "#2f8d62"], [36, 76, "#2f8d62"], [54, 76, "#2f8d62"]],
  };
  const marks = layouts[rank] ?? [];
  return marks.map(([x, y, color]) => {
    const r = rank === 1 ? 16 : 7;
    return `<g transform="translate(${x} ${y})"><circle r="${r}" fill="none" stroke="${color}" stroke-width="3"/><circle r="${Math.max(2, r * .38)}" fill="${color}"/><path d="M-${r * .7} 0H${r * .7}M0-${r * .7}V${r * .7}" stroke="${color}" stroke-width="1.4" opacity=".55"/></g>`;
  }).join("");
}

function souMarks(rank: number): string {
  if (rank === 1) {
    return `<g transform="translate(36 50)"><path d="M-17 13C-5 4-12-10 1-17C14-12 18 0 11 10C5 20-8 22-17 13Z" fill="#2f8d62" stroke="#195c3e" stroke-width="2"/><circle cx="4" cy="-7" r="3" fill="#c94b45"/><path d="M-10 9L-19 20M9 10L18 21" stroke="#2d67a7" stroke-width="4" stroke-linecap="round"/></g>`;
  }
  const positions: Array<[number, number]> = [];
  const cols = rank <= 4 ? 2 : 3;
  const rows = Math.ceil(rank / cols);
  for (let i = 0; i < rank; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 36 + (col - (cols - 1) / 2) * 19;
    const y = 50 + (row - (rows - 1) / 2) * 26;
    positions.push([x, y]);
  }
  return positions.map(([x, y], i) => {
    const color = i % 3 === 1 ? "#2d67a7" : "#2f8d62";
    return `<g transform="translate(${x} ${y}) rotate(${i % 2 ? 8 : -8})"><rect x="-4" y="-12" width="8" height="24" rx="4" fill="${color}"/><path d="M-7 0H7" stroke="#f7f0da" stroke-width="2"/></g>`;
  }).join("");
}

function faceArt(tile: number, red: boolean): string {
  const suit = suitOf(tile);
  const rank = rankOf(tile);
  if (suit === 0) {
    const color = red ? "#d7352f" : "#b94335";
    return `<text x="36" y="45" text-anchor="middle" font-size="34" font-weight="800" font-family="Georgia,serif" fill="${color}">${rank}</text><text x="36" y="78" text-anchor="middle" font-size="28" font-weight="800" font-family="KaiTi,STKaiti,serif" fill="${color}">萬</text>`;
  }
  if (suit === 1) return pinMarks(rank) + (red && rank === 5 ? `<circle cx="36" cy="49" r="11" fill="none" stroke="#d7352f" stroke-width="3"/>` : "");
  if (suit === 2) return souMarks(rank) + (red && rank === 5 ? `<path d="M27 49H45" stroke="#d7352f" stroke-width="5" stroke-linecap="round"/>` : "");
  const honor = ["東", "南", "西", "北", "白", "發", "中"][rank - 1];
  if (honor === "白") return `<rect x="16" y="22" width="40" height="56" rx="3" fill="none" stroke="#9fb9c5" stroke-width="4"/>`;
  const color = honor === "中" ? "#c83d37" : honor === "發" ? "#238154" : "#243742";
  return `<text x="36" y="68" text-anchor="middle" font-size="43" font-weight="800" font-family="KaiTi,STKaiti,serif" fill="${color}">${honor}</text>`;
}

export function tileFaceSrc(tile: number, red = false): string {
  const key = `${tile}:${red ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const label = esc(tileName(tile) + (red ? "（赤）" : ""));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 100" role="img" aria-label="${label}"><rect x="2" y="2" width="68" height="96" rx="8" fill="#fffdf3"/><rect x="4" y="4" width="64" height="92" rx="7" fill="none" stroke="#d9d0b8" stroke-width="1.5"/>${faceArt(tile, red)}</svg>`;
  const src = svgData(svg);
  cache.set(key, src);
  return src;
}

export const tileBackSrc = svgData(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 100"><defs><pattern id="p" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 6H12" stroke="#8bd0bb" stroke-width="2" opacity=".34"/></pattern><linearGradient id="g" x2="0" y2="1"><stop stop-color="#2b8a71"/><stop offset="1" stop-color="#155b4e"/></linearGradient></defs><rect x="2" y="2" width="68" height="96" rx="8" fill="url(#g)"/><rect x="7" y="7" width="58" height="86" rx="6" fill="url(#p)" stroke="#b7e4d3" stroke-width="2"/><circle cx="36" cy="50" r="16" fill="none" stroke="#d9f2e8" stroke-width="2" opacity=".8"/><path d="M26 50h20M36 40v20" stroke="#d9f2e8" stroke-width="2" opacity=".8"/></svg>`);

export function createTileImage(tile: number, red = false): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "mg-tile-art";
  img.src = tileFaceSrc(tile, red);
  img.alt = tileName(tile) + (red ? "（赤）" : "");
  img.draggable = false;
  return img;
}

export function createTileBackImage(): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "mg-tile-art";
  img.src = tileBackSrc;
  img.alt = "麻将牌背";
  img.draggable = false;
  return img;
}
