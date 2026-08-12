import type { Container } from "pixi.js";
import type { PetDriver, PetView } from "../PetDriver";
import { PsdRuntime, type RigParams } from "./PsdRuntime";
import { clamp } from "../../utils/math";
import { getActivityFactor } from "../../utils/settings";

/** 表情目标参数（在音乐驱动基础上叠加偏移） */
interface Expression {
  brow: number; // -1..1 眉毛
  mouthOpen: number; // 0..1 嘴开
  mouthForm: number; // -1..1 嘴形（+笑 -撇嘴）
  eyeX: number; // 视线横
  eyeY: number; // 视线纵
  closeL: number; // 0..1 左眼闭合
  closeR: number; // 0..1 右眼闭合
  irisScale: number; // 瞳缩放偏移
  tilt: number; // 歪头
}

const EXPRESSIONS: Expression[] = [
  { brow: 0.35, mouthOpen: 0.18, mouthForm: 0.9, eyeX: 0, eyeY: 0, closeL: 0.05, closeR: 0.05, irisScale: 0, tilt: 0 }, // 微笑
  { brow: 1, mouthOpen: 0.65, mouthForm: -0.1, eyeX: 0, eyeY: 0.1, closeL: 0, closeR: 0, irisScale: -0.2, tilt: 0 }, // 惊讶
  { brow: 0.3, mouthOpen: 0, mouthForm: 0.45, eyeX: 0, eyeY: 0, closeL: 0.62, closeR: 0.62, irisScale: 0, tilt: 0 }, // 眯眯眼
  { brow: -0.45, mouthOpen: 0.15, mouthForm: -0.3, eyeX: 0, eyeY: -0.25, closeL: 0.15, closeR: 0.15, irisScale: 0, tilt: 0.06 }, // 委屈
  { brow: -0.8, mouthOpen: 0.05, mouthForm: -0.55, eyeX: 0, eyeY: 0, closeL: 0.08, closeR: 0.08, irisScale: 0, tilt: -0.05 }, // 生气
  { brow: 0.55, mouthOpen: 0.12, mouthForm: 0.6, eyeX: 0.35, eyeY: -0.15, closeL: 0.45, closeR: 0.45, irisScale: 0, tilt: 0.1 }, // 害羞
  { brow: 0.25, mouthOpen: 0.35, mouthForm: 0.7, eyeX: 0, eyeY: 0, closeL: 1, closeR: 0, irisScale: 0, tilt: 0.04 }, // 左眨眼
  { brow: 0.25, mouthOpen: 0.35, mouthForm: 0.7, eyeX: 0, eyeY: 0, closeL: 0, closeR: 1, irisScale: 0, tilt: -0.04 }, // 右眨眼
  { brow: 0.2, mouthOpen: 0.85, mouthForm: -0.35, eyeX: 0, eyeY: 0.15, closeL: 0.12, closeR: 0.12, irisScale: 0.05, tilt: 0.03 }, // 吐舌/哈欠
  { brow: 0.6, mouthOpen: 0.5, mouthForm: -0.15, eyeX: -0.3, eyeY: 0, closeL: 0, closeR: 0, irisScale: 0, tilt: 0.08 }, // 好奇
];

function pickExpression(rng: () => number): Expression {
  return EXPRESSIONS[Math.floor(rng() * EXPRESSIONS.length)];
}

/**
 * 2.5D PSD 渲染后端（Anime2.5DRig 技术本地化）。
 * 独立 canvas + WebGL1，与 pixi 层共存；PSD → 自动 rig → 即时驱动。
 */
export class Rigged2DView implements PetView {
  readonly canvas: HTMLCanvasElement;
  private runtime: PsdRuntime;
  private gobblePulse = 0;
  private clickPulse = 0;
  private scalePulse = 0;
  private swayEnabled = true;

  // 随机表情状态机
  private exprT = 0;
  private exprDur = 1.6;
  private exprNext = 0;
  private expr: Expression = EXPRESSIONS[0];

  private static rand() {
    return Math.random();
  }

  private constructor(canvas: HTMLCanvasElement, runtime: PsdRuntime) {
    this.canvas = canvas;
    this.runtime = runtime;
    canvas.className = "rig";
  }

  static async create(bytes: Uint8Array): Promise<Rigged2DView> {
    const canvas = document.createElement("canvas");
    canvas.id = "rig-canvas";
    const runtime = new PsdRuntime(canvas);
    await runtime.load(bytes);
    const view = new Rigged2DView(canvas, runtime);
    view.setSwayEnabled(true);
    return view;
  }

  attachTo(stage: HTMLElement, _pixiStage: Container) {
    stage.appendChild(this.canvas);
  }

  unmount() {
    this.canvas.remove();
    this.runtime.destroy();
  }

  /** rigger warnings（缺 face / 闭眼自动合成等） */
  get warnings(): string[] {
    return this.runtime.warnings;
  }

  get stats(): string {
    return `已自动装配 ${this.runtime.partsCount} 部件 / 发丝 ${this.runtime.strandCount} 束`;
  }

  update(d: PetDriver, dt: number) {
    const sway = this.swayEnabled ? 1 : 0;
    this.gobblePulse = Math.max(0, this.gobblePulse - dt * 2.2);
    this.clickPulse = Math.max(0, this.clickPulse - dt * 6);
    this.scalePulse = Math.max(0, this.scalePulse - dt * 5);

    // ---- 表情节奏：间隔随活动因子拉长，播放 1.6~2.4 秒（正弦包络淡入淡出）。
    //      待机时安静：不触发新表情，回到中性。
    const nowMs = performance.now();
    this.exprT += dt;
    if (d.idle) {
      if (this.exprT > this.exprDur || this.exprT === 0) {
        this.expr = EXPRESSIONS[0];
        this.exprT = 0;
      }
      this.exprNext = nowMs + 60000;
    } else if (nowMs > this.exprNext) {
      this.expr = pickExpression(Rigged2DView.rand);
      this.exprT = 0;
      this.exprDur = 1.6 + Rigged2DView.rand() * 0.8;
      this.exprNext = nowMs + (6000 + Rigged2DView.rand() * 8000) * getActivityFactor();
    }
    const eProg = Math.min(1, this.exprT / this.exprDur);
    const ew = Math.sin(Math.PI * eProg); // 0→1→0
    const e = this.expr;

    const exc = d.excited ?? 0; // 逗猫棒兴奋度：眼神更跟手、微前倾、瞳孔聚焦

    const o: Partial<RigParams> = {
      // 头部轻微跟随（眼神为主）：头微动、眼明显；兴奋时微前倾
      angleX: clamp(d.cursorDx * 0.7 + d.vx * 0.25 + exc * 0.12, -1, 1),
      angleY: clamp(d.cursorDy * 0.55 + exc * 0.06, -1, 1),
      eyeX: clamp(d.cursorDx * (1.8 + exc * 0.6) + e.eyeX * ew, -1, 1),
      eyeY: clamp(-d.cursorDy * (1.2 + exc * 0.5) + e.eyeY * ew, -1, 1),
      // 音乐 → 身体律动
      body: clamp(d.bass * 0.55 * sway + d.vx * 0.3 + d.beat * 0.2 * sway, -1, 1),
      angleZ: clamp(Math.sin(d.breathing) * 0.02 + d.treble * 0.25 * sway + e.tilt * ew, -0.5, 0.5),
      // 音乐 → 嘴型（中频 + 节拍 + 吞咽/点击脉冲），表情叠加，兴奋时微张嘴
      mouthOpen: clamp(d.mid * 0.9 * sway + d.beat * 0.5 * sway + this.gobblePulse + this.clickPulse * 0.5 + e.mouthOpen * ew + exc * 0.12, 0, 1.3),
      mouthForm: clamp(d.mid * 0.4 * sway + e.mouthForm * ew, -1, 1),
      // 眉毛：音乐驱动 + 表情偏移
      brow: clamp(d.treble * 0.5 * sway - d.bass * 0.3 + e.brow * ew, -1, 1),
      // 眼睛开合：音乐微动 + 表情（wink/眯眼用乘法收敛），兴奋时睁大
      eyeOpenL: clamp((1 - d.mid * 0.06 * sway) * (1 - e.closeL * ew) + exc * 0.05, 0, 1.08),
      eyeOpenR: clamp((1 - d.mid * 0.06 * sway) * (1 - e.closeR * ew) + exc * 0.05, 0, 1.08),
      // 瞳孔聚焦微缩
      irisScale: clamp(1 + e.irisScale * ew - exc * 0.06, 0.5, 1.3),
      // 发丝物理加成
      fhAmp: 2 + d.mid * 2.5 * sway,
      physAmp: 2 + d.bass * 2 * sway,
      // 走动摇晃 → 手臂摆动
      armY: clamp(d.vx * 0.6, -1, 1),
    };

    this.runtime.update(dt, o);

    // 待机顶部 → 整体旋转 180°（露出头顶+眼睛）
    const rot = d.idleTop ? " rotate(180deg)" : "";

    // 吞咽/点击时 canvas 缩放脉冲
    if (this.scalePulse > 0) {
      const s = 1 + this.scalePulse * 0.15 * (this.gobblePulse > 0 ? 1.2 : 0.6);
      this.canvas.style.transform = `translate(-50%, -50%)${rot} scale(${s})`;
    } else {
      this.canvas.style.transform = `translate(-50%, -50%)${rot}`;
    }
  }

  playGobble() {
    this.gobblePulse = 1;
    this.scalePulse = 1;
  }

  playClick() {
    this.clickPulse = 1;
    this.scalePulse = 1;
  }

  setSwayEnabled(on: boolean) {
    this.swayEnabled = on;
  }
}