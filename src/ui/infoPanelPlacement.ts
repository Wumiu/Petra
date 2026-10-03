export interface PanelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 优先左右侧，按可用空间收缩；侧面放不下时尝试上下，避开模型和输入框。 */
export function infoPanelPlacement(
  model: PanelRect,
  visible: PanelRect,
  size: { width: number; height: number },
  input?: PanelRect,
): (PanelRect & { width: number; height: number }) | null {
  const gap = 8;
  const regions: PanelRect[] = [
    { ...visible, left: Math.max(visible.left, model.right + gap) },
    { ...visible, right: Math.min(visible.right, model.left - gap) },
    { ...visible, bottom: Math.min(visible.bottom, model.top - gap) },
    { ...visible, top: Math.max(visible.top, model.bottom + gap) },
  ];
  for (const region of regions) {
    // 输入框与候选区相交时，分别尝试其四周的空闲矩形。
    const overlaps = input && input.left < region.right && input.right > region.left &&
      input.top < region.bottom && input.bottom > region.top;
    const free = overlaps ? [
      { ...region, bottom: Math.min(region.bottom, input!.top - gap) },
      { ...region, top: Math.max(region.top, input!.bottom + gap) },
      { ...region, right: Math.min(region.right, input!.left - gap) },
      { ...region, left: Math.max(region.left, input!.right + gap) },
    ] : [region];
    free.sort((a, b) =>
      Math.min(size.width, b.right - b.left) * Math.min(size.height, b.bottom - b.top) -
      Math.min(size.width, a.right - a.left) * Math.min(size.height, a.bottom - a.top),
    );
    for (const box of free) {
      const width = Math.min(size.width, box.right - box.left);
      const height = Math.min(size.height, box.bottom - box.top);
      if (width < 140 || height < 60) continue;
      const left = Math.max(box.left, Math.min((model.left + model.right - width) / 2, box.right - width));
      const top = Math.max(box.top, Math.min((model.top + model.bottom - height) / 2, box.bottom - height));
      return { left, top, right: left + width, bottom: top + height, width, height };
    }
  }
  return null;
}
