/**
 * 窗口可见区共享状态。
 *
 * 主窗口固定 700×700，但可以被拖到屏幕边缘/待机贴边（部分出屏）。
 * main.ts 每帧用 engine.workArea + windowScreenPos 计算"窗口在屏幕工作区内的
 * 可见区域（窗口本地逻辑坐标）"，写入本模块；AssistantPanel / ReminderPanel 等
 * UI 模块读取它做贴边自适应（避免直接依赖 main.ts 造成循环导入）。
 */
export interface VisibleRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

let visibleRect: VisibleRect = { left: 0, top: 0, right: 700, bottom: 700 };

export function setVisibleRect(r: VisibleRect) {
  visibleRect = r;
}

export function getVisibleRect(): VisibleRect {
  return visibleRect;
}

/**
 * 把一块浮层钳进"窗口在屏幕上的可见区"。
 *
 * 主窗口可以被拖到屏幕边缘（部分出屏），这时按窗口居中的弹窗会有一半留在屏幕外，
 * 用户看到的就是"窗口显示不全"。这里按可见区夹一遍，保证整块都露出来。
 *
 * 纯函数（不碰 DOM），方便单测：见 tests/visible-clamp.test.js。
 */
export function clampIntoRect(
  rect: { left: number; top: number; width: number; height: number },
  area: VisibleRect,
  margin = 8,
): { left: number; top: number } {
  // 可见区比浮层还小时，max* 会小于 area.left/top，此时退化成"贴可见区左上角"，
  // 至少标题和第一行露得出来（配合 fitSizeInRect 一般不会走到这一步）
  const maxLeft = Math.max(area.left + margin, area.right - rect.width - margin);
  const maxTop = Math.max(area.top + margin, area.bottom - rect.height - margin);
  return {
    left: Math.min(Math.max(rect.left, area.left + margin), maxLeft),
    top: Math.min(Math.max(rect.top, area.top + margin), maxTop),
  };
}

/** 浮层在可见区里能用的最大尺寸（两侧各留 margin） */
export function fitSizeInRect(
  area: VisibleRect,
  margin = 8,
): { maxWidth: number; maxHeight: number } {
  return {
    maxWidth: Math.max(120, area.right - area.left - margin * 2),
    maxHeight: Math.max(80, area.bottom - area.top - margin * 2),
  };
}
