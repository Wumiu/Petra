import type { Container } from "pixi.js";
import type { PetDriver, PetView } from "../PetDriver";
import { PsdRuntime, type RigParams } from "./PsdRuntime";
import { findAction, sampleAction, pickPoolAction, type ActionDef } from "../actions";
import { clamp } from "../../utils/math";
import { getActivityFactor, getActivityLevel } from "../../utils/settings";

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
  private displayW = 300; // 当前显示边长（窗口跟随缩放，setScale 更新）

  // 随机表情状态机
  private exprT = 0;
  private exprDur = 1.6;
  private exprNext = 0;
  private expr: Expression = EXPRESSIONS[0];

  // 动作播放器
  private action: ActionDef | null = null;
  private actionT = 0;
  private actionLoop = false;
  private winkRight = false; // wink 动作随机闭右眼

  // 动作池：空闲随机抽取播放（启动 8s 后才开始）
  private actionPoolNext = performance.now() + 8000;

  // 跟随音乐：BPM 节奏摇摆 + 节拍随机 wink
  private bpmPhase = 0;
  private musicWinkT = 0;
  private musicWinkNext = 2 + Math.random() * 4;
  private musicWinkSide: "L" | "R" = "L";

  // 拖拽下半身摆动（弹性惯性，松手自然衰减）
  private swing = 0;
  private swingV = 0;
  private dragSquint = 0; // 拖拽眯眼（0=睁眼，1=眯眼）

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
    const sway = this.swayEnabled && !this.action ? 1 : 0;
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
    } else if (!this.action && nowMs > this.exprNext) {
      this.expr = pickExpression(Rigged2DView.rand);
      this.exprT = 0;
      this.exprDur = 1.6 + Rigged2DView.rand() * 0.8;
      this.exprNext = nowMs + (6000 + Rigged2DView.rand() * 8000) * getActivityFactor();
    }
    const eProg = Math.min(1, this.exprT / this.exprDur);
    const ew = Math.sin(Math.PI * eProg); // 0→1→0
    const e = this.expr;

    // ---- 动作池：空闲随机抽取播放（频率随活动因子拉长，low 最稀疏） ----
    if (!this.action && !d.idle && !d.dragging && nowMs > this.actionPoolNext) {
      const def = pickPoolAction(getActivityLevel());
      if (def) this.playAction(def.id, false);
      this.actionPoolNext = nowMs + (15 + Math.random() * 15) * 1000 * getActivityFactor();
    }

    const exc = d.excited ?? 0; // 逗猫棒兴奋度：眼神更跟手、微前倾、瞳孔聚焦
    // 顶部待机倒挂（旋转 180°）→ 视线横纵都镜像
    const flip = d.idleTop ? -1 : 1;
    const cdx = d.cursorDx * flip;
    const cdy = d.cursorDy * flip;

    // ---- 跟随音乐：BPM 节奏摇摆 + 节拍随机 wink ----
    let bpmSway = 0;
    let winkClose = 0;
    if (sway) {
      if (d.bpm > 40) {
        this.bpmPhase += dt * (d.bpm / 60) * Math.PI * 2;
        bpmSway = Math.sin(this.bpmPhase) * 0.5;
      }
      if (this.musicWinkT > 0) {
        this.musicWinkT -= dt;
        if (this.musicWinkT <= 0) this.musicWinkNext = 2 + Math.random() * 6;
      } else if (this.musicWinkNext > 0) {
        this.musicWinkNext -= dt;
        if (this.musicWinkNext <= 0) {
          this.musicWinkT = 0.35;
          this.musicWinkSide = Math.random() < 0.5 ? "L" : "R";
        }
      } else {
        this.musicWinkNext = 2 + Math.random() * 6;
      }
      winkClose = this.musicWinkT > 0 ? 1 : 0;
    }

    // ---- 下半身摆动：按住期间软乎乎晃动（拖动叠加速度摆动）/ 松开立即归正 ----
    if (d.pressed) {
      const hold = Math.sin((nowMs / 1000) * 0.6) * 0.4 + Math.sin((nowMs / 1000) * 0.25 + 1.0) * 0.18;
      const speedSwing = d.dragging ? clamp(d.dragVelX * 2.0, -1.5, 1.5) : 0;
      const target = hold + speedSwing;
      this.swingV += (target - this.swing) * 45 * dt;
      this.swingV *= Math.exp(-dt * 6.3); // 帧率无关阻尼（等效 60fps 下每帧 *0.9）
      this.swing += this.swingV * dt;
    } else {
      // 松开：立即归正
      this.swingV = 0;
      this.swing += (0 - this.swing) * Math.min(1, dt * 12);
    }
    // 按住眯眼平滑（全闭）
    this.dragSquint += ((d.pressed ? 1 : 0) - this.dragSquint) * Math.min(1, dt * 6);

    const o: Partial<RigParams> = {
      // 头部轻微跟随（眼神为主）：头微动、眼明显；兴奋时微前倾
      angleX: clamp(cdx * 0.25 + d.vx * 0.25 + exc * 0.12, -1, 1),
      angleY: clamp(-cdy * 0.15 + exc * 0.06, -1, 1),
      eyeX: clamp(cdx * (1.8 + exc * 0.6) + e.eyeX * ew, -1, 1),
      eyeY: clamp(cdy * (1.2 + exc * 0.5) + e.eyeY * ew, -1, 1),
      // 音乐 → 身体律动（+ BPM 节奏摇摆）
      body: clamp(d.bass * 0.55 * sway + d.vx * 0.3 + d.beat * 0.2 * sway + bpmSway, -1, 1),
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
      // 拖拽 → 下半身摆动
      bodySwing: clamp(this.swing, -1.5, 1.5),
    };

    // 音乐节拍 wink：闭对应单眼
    if (winkClose) {
      if (this.musicWinkSide === "L") o.eyeOpenL = Math.min(o.eyeOpenL ?? 1, 0.12);
      else o.eyeOpenR = Math.min(o.eyeOpenR ?? 1, 0.12);
    }

    // 按住眯眼：全闭
    if (this.dragSquint > 0.01) {
      const sq = 1 - 0.95 * this.dragSquint;
      o.eyeOpenL = Math.min(o.eyeOpenL ?? 1, sq);
      o.eyeOpenR = Math.min(o.eyeOpenR ?? 1, sq);
    }

    // ---- 动作层：覆盖对应通道（播放完自动回落待机 / 循环） ----
    if (this.action) {
      const speed = this.action.bpmSync && d.bpm > 40 ? d.bpm / 60 : 1;
      this.actionT += dt * speed;
      const progress = Math.min(1, this.actionT / this.action.duration);
      const ap = sampleAction(this.action, progress);
      if (this.action.randomEye && this.winkRight) {
        // 显式交换声明过的眼睛通道（缺失通道不写入 undefined）
        const l = ap.eyeOpenL;
        const r = ap.eyeOpenR;
        if (r !== undefined) ap.eyeOpenL = r;
        if (l !== undefined) ap.eyeOpenR = l;
      }
      // 平滑混合：动作参数与基线 lerp，渐入渐出消除硬覆盖跳变
      const FADE = 0.2; // 秒
      let w = 1;
      if (!this.actionLoop) {
        w = Math.min(1, this.actionT / FADE, Math.max(0, (this.action.duration - this.actionT) / FADE));
      }
      for (const k in ap) {
        const av = (ap as unknown as Record<string, number>)[k];
        if (typeof av === "number") {
          const base = (o as unknown as Record<string, number>)[k] ?? 0;
          (o as unknown as Record<string, number>)[k] = base * (1 - w) + av * w;
        }
      }
      if (this.actionT >= this.action.duration) {
        if (this.actionLoop) {
          this.actionT = 0;
          if (this.action.randomEye) this.winkRight = Math.random() < 0.5;
        } else {
          this.action = null;
          this.setAuto(true);
        }
      }
    }

    this.runtime.update(dt, o);

    // 待机顶部 → 整体旋转 180°（露出头顶+眼睛）
    const rot = d.idleTop ? " rotate(180deg)" : "";
    // 模型边缘露出偏移（窗口探出屏幕时模型自动跟随）
    const ox = Math.round(d.modelOffsetX || 0);
    const oy = Math.round(d.modelOffsetY || 0);
    const shift = ox !== 0 || oy !== 0 ? ` translate(${ox}px, ${oy}px)` : "";

    // 吞咽/点击时 canvas 缩放脉冲
    if (this.scalePulse > 0) {
      const s = 1 + this.scalePulse * 0.15 * (this.gobblePulse > 0 ? 1.2 : 0.6);
      this.canvas.style.transform = `translate(-50%, -50%)${shift}${rot} scale(${s})`;
    } else {
      this.canvas.style.transform = `translate(-50%, -50%)${shift}${rot}`;
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

  playAction(id: string, loop = false) {
    const def = findAction(id);
    if (def) {
      this.action = def;
      this.actionT = 0;
      this.actionLoop = loop;
      if (def.randomEye) this.winkRight = Math.random() < 0.5;
      // 动作独占：关闭自动眨眼/随机晃头/待机微动，避免干扰动作
      this.setAuto(false);
    }
  }

  stopAction() {
    this.action = null;
    this.actionT = 0;
    this.actionLoop = false;
    this.setAuto(true);
  }

  /** 动作独占开关：统一管理自动眨眼/随机微动/待机晃动 */
  private setAuto(on: boolean) {
    this.runtime.autoBlinkOn = on;
    this.runtime.autoRandOn = on;
    this.runtime.autoIdleOn = on;
  }

  setSwayEnabled(on: boolean) {
    this.swayEnabled = on;
  }

  /** 模型显示尺寸：窗口跟随缩放时，canvas 显示尺寸同步为窗口边长 */
  setScale(displayW: number) {
    this.displayW = displayW;
    const px = `${Math.round(displayW)}px`;
    this.canvas.style.maxWidth = px;
    this.canvas.style.maxHeight = px;
  }

  /** 角色在窗口内的边界（相对窗口左上，逻辑 px，含缩放），供模型边缘补偿 */
  getCharacterBounds(): { left: number; top: number; right: number; bottom: number } | null {
    const cb = this.runtime.characterBounds;
    if (!cb) return null;
    const s = this.displayW / this.runtime.canvasWidth;
    const offsetX = (700 - this.displayW) / 2;
    const offsetY = (700 - this.displayW) / 2;
    // 用户自定义边界微调（正 = 放大框，负 = 收紧框）
    const pad = this.boundsPad;
    return {
      left: offsetX + cb.left * s - pad.left,
      top: offsetY + cb.top * s - pad.top,
      right: offsetX + cb.right * s + pad.right,
      bottom: offsetY + cb.bottom * s + pad.bottom,
    };
  }

  private boundsPad = { left: 0, right: 0, top: 0, bottom: 0 };
  setBoundsPadding(p: { left: number; right: number; top: number; bottom: number }) {
    this.boundsPad = p;
  }
}