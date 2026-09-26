/**
 * 手臂旋转轴（枢轴）的存储。
 *
 * 轴这种事情让模型作者自己点最准：所以在应用里做了个"轴心拾取器"
 * （见 HandAxisPicker.ts，DEV 下右键 → 交互 → 手臂轴心（调试）），
 * 拖十字准星定轴、实时预览绕轴旋转，保存后**立刻**用于真实动画。
 * 数据按模型分别存 localStorage，导出的 JSON 可以直接发给开发者烘进默认值。
 */

export interface HandAxis {
  /** PSD 画布坐标（与 rig 图层的 x/y 同一坐标系） */
  x: number;
  y: number;
}

export interface HandAxisStore {
  L?: HandAxis;
  R?: HandAxis;
}

const STORAGE_KEY = "petra-hand-axis";

type AllAxes = Record<string, HandAxisStore>;

function readAll(): AllAxes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as AllAxes) : {};
  } catch {
    return {};
  }
}

function writeAll(all: AllAxes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 存储不可用就算了，本次会话内仍然生效（内存里已有值） */
  }
}

export function loadHandAxes(modelKey: string): HandAxisStore {
  const all = readAll();
  const one = all[modelKey];
  return one && typeof one === "object" ? { ...one } : {};
}

export function saveHandAxis(modelKey: string, side: "L" | "R", axis: HandAxis): void {
  const all = readAll();
  all[modelKey] = { ...(all[modelKey] ?? {}), [side]: { x: Math.round(axis.x), y: Math.round(axis.y) } };
  writeAll(all);
}

export function clearHandAxes(modelKey: string): void {
  const all = readAll();
  delete all[modelKey];
  writeAll(all);
}

/** 导出全部（调试用：复制给开发者） */
export function exportHandAxes(): string {
  return JSON.stringify(readAll(), null, 2);
}
