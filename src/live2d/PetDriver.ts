export interface PetDriver {
  bass: number; // 0..1 低频能量
  mid: number; // 0..1 中频能量
  treble: number; // 0..1 高频能量
  beat: number; // 0..1 节拍脉冲（衰减）
  bob: number; // 0..1 运动幅度（移动时抖动）
  vx: number; // -1..1 横向速度（朝左为负）
  cursorDx: number; // -1..1 鼠标相对窗口中心的横向偏移
  cursorDy: number; // -1..1 鼠标相对窗口中心的纵向偏移
  breathing: number; // 呼吸相位 0..2π
}

import type { Container } from "pixi.js";

export interface PetView {
  update(d: PetDriver, dt: number): void;
  playGobble(): void; // 吃文件（垃圾桶）反馈
  playClick(): void; // 被点击反馈
  setSwayEnabled(on: boolean): void;
  /** 挂载：rig 系视图挂到 DOM，pixi 系视图挂到 PIXI stage */
  attachTo(stage: HTMLElement, pixiStage: Container): void;
  /** 卸载前清理（删画布 / 销毁容器与 GL 资源） */
  unmount(): void;
}

export function idleDriver(): PetDriver {
  return {
    bass: 0,
    mid: 0,
    treble: 0,
    beat: 0,
    bob: 0,
    vx: 0,
    cursorDx: 0,
    cursorDy: 0,
    breathing: 0,
  };
}