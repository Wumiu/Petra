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
