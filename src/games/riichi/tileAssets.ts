/**
 * Traditional Japanese riichi tile artwork mapping.
 *
 * Artwork: FluffyStuff/riichi-mahjong-tiles, Regular set (Public Domain/CC0).
 * Vendored under public/mahjong/tiles with the upstream license alongside it.
 */
import { rankOf, suitOf, tileName } from "./tiles";

const BASE = "/mahjong/tiles/";
const HONORS = ["Ton", "Nan", "Shaa", "Pei", "Haku", "Hatsu", "Chun"] as const;

function svgData(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function tileFile(tile: number, red: boolean): string {
  const suit = suitOf(tile);
  const rank = rankOf(tile);
  if (suit === 0) return `Man${rank}${red && rank === 5 ? "-Dora" : ""}.svg`;
  if (suit === 1) return `Pin${rank}${red && rank === 5 ? "-Dora" : ""}.svg`;
  if (suit === 2) return `Sou${rank}${red && rank === 5 ? "-Dora" : ""}.svg`;
  return `${HONORS[rank - 1]}.svg`;
}

export function tileFaceSrc(tile: number, red = false): string {
  return BASE + tileFile(tile, red);
}

// The upstream Regular back is bright red. Keep Petra's existing green back so
// the live wall remains legible against the table while all face art is upstream.
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
