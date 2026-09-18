/**
 * Traditional Japanese riichi tile artwork mapping.
 *
 * Artwork: FluffyStuff/riichi-mahjong-tiles, Regular set (Public Domain/CC0).
 * Vendored under public/mahjong/tiles with the upstream license alongside it.
 */
import { rankOf, suitOf, tileName } from "./tiles";

const BASE = "/mahjong/tiles/";
const HONORS = ["Ton", "Nan", "Shaa", "Pei", "Haku", "Hatsu", "Chun"] as const;

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

// User-supplied moon/lily back shared by the wall, hidden hand and concealed kan.
export const tileBackSrc = "/mahjong/theme/tile-back.png";

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
