export interface PetDriver {
  bass: number; // 0..1 低频能量
  mid: number; // 0..1 中频能量
  treble: number; // 0..1 高频能量
  beat: number; // 0..1 节拍脉冲（衰减）
  bpm: number; // 检测到的 BPM（0=无音乐）
  bob: number; // 0..1 运动幅度（移动时抖动）
  vx: number; // -1..1 横向速度（朝左为负）
  cursorDx: number; // -1..1 鼠标相对窗口中心的横向偏移
  cursorDy: number; // -1..1 鼠标相对窗口中心的纵向偏移
  breathing: number; // 呼吸相位 0..2π
  excited: number; // 0..1 逗猫棒兴奋度（越高越投入）
  idleTop: boolean; // 待机且倒挂（顶部待机 → 渲染旋转 180°）
  idle: boolean; // 待机模式（暂停随机表情、安静）
  dragging: boolean; // 拖拽中（下半身摆动）
  dragVelX: number; // -1..1 拖拽横向速度（供身体惯性摆动）
  pressed: boolean; // 按住（点中，含未拖动）→ 轻轻晃动 + 眯眼
  modelOffsetX: number; // 模型水平偏移 px（窗口探出屏幕时保持模型可见）
  modelOffsetY: number; // 模型垂直偏移 px
}

import type { Container } from "pixi.js";

export interface PetView {
  update(d: PetDriver, dt: number): void;
  playGobble(): void; // 吃文件（垃圾桶）反馈
  playClick(): void; // 被点击反馈
  playAction(id: string, loop?: boolean): void; // 播放动作（动作库 id，loop 循环）
  stopAction(): void; // 停止当前动作，回落待机
  setSwayEnabled(on: boolean): void;
  /** 设置模型显示尺寸（窗口跟随缩放时，canvas 显示尺寸同步为窗口边长） */
  setScale(displayW: number): void;
  /** 角色在窗口内的边界（相对窗口左上，逻辑 px），模型边缘补偿用；可选 */
  getCharacterBounds?(): { left: number; top: number; right: number; bottom: number } | null;
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
    bpm: 0,
    bob: 0,
    vx: 0,
    cursorDx: 0,
    cursorDy: 0,
    breathing: 0,
    excited: 0,
    idleTop: false,
    idle: false,
    dragging: false,
    dragVelX: 0,
    pressed: false,
    modelOffsetX: 0,
    modelOffsetY: 0,
  };
}
