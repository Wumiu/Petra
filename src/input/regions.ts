export interface LogicalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PhysicalInteractiveRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
}

/**
 * CSS logical client rect → physical client rect.
 * DOMRect 只在这里乘一次 Tauri/WebView scale factor；Rust 使用 ScreenToClient
 * 得到相同的 physical client coordinates。
 */
export function logicalRectToPhysicalRegion(
  id: string,
  rect: LogicalRect,
  scaleFactor: number,
  clientPhysicalWidth: number,
  clientPhysicalHeight: number,
  padding = 0,
): PhysicalInteractiveRegion | null {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;
  if (![rect.left, rect.top, rect.right, rect.bottom, padding].every(Number.isFinite)) return null;

  const left = Math.max(0, Math.floor((rect.left - padding) * scaleFactor));
  const top = Math.max(0, Math.floor((rect.top - padding) * scaleFactor));
  const right = Math.min(clientPhysicalWidth, Math.ceil((rect.right + padding) * scaleFactor));
  const bottom = Math.min(clientPhysicalHeight, Math.ceil((rect.bottom + padding) * scaleFactor));
  if (right <= left || bottom <= top) return null;

  return {
    id,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    enabled: true,
  };
}

export function regionFingerprint(regions: PhysicalInteractiveRegion[]): string {
  return regions
    .map((r) => `${r.id}:${r.x},${r.y},${r.width},${r.height},${r.enabled ? 1 : 0}`)
    .join("|");
}
