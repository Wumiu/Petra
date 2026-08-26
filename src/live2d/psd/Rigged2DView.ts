import type { Container } from "pixi.js";
import type { PetDriver, PetView } from "../PetDriver";
import { PsdRuntime, type RigParams } from "./PsdRuntime";
import { findAction, sampleAction, pickPoolAction, type ActionDef } from "../actions";
import { clamp } from "../../utils/math";
import { getActivityFactor, getActivityLevel } from "../../utils/settings";

// ---- 音乐情绪类型 ----
type MusicMood = "calm" | "normal" | "energetic";

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
  mood: "happy" | "neutral" | "sad"; // 情绪标签（音乐模式下过滤用）
}

const EXPRESSIONS: Expression[] = [
  { brow: 0.35, mouthOpen: 0.18, mouthForm: 0.9, eyeX: 0, eyeY: 0, closeL: 0.05, closeR: 0.05, irisScale: 0, tilt: 0, mood: "happy" }, // 微笑
  { brow: 1, mouthOpen: 0.65, mouthForm: -0.1, eyeX: 0, eyeY: 0.1, closeL: 0, closeR: 0, irisScale: -0.2, tilt: 0, mood: "happy" }, // 惊讶
  { brow: 0.3, mouthOpen: 0, mouthForm: 0.45, eyeX: 0, eyeY: 0, closeL: 0.62, closeR: 0.62, irisScale: 0, tilt: 0, mood: "happy" }, // 眯眯眼
  { brow: -0.45, mouthOpen: 0.15, mouthForm: -0.3, eyeX: 0, eyeY: -0.25, closeL: 0.15, closeR: 0.15, irisScale: 0, tilt: 0.06, mood: "sad" }, // 委屈
  { brow: -0.8, mouthOpen: 0.05, mouthForm: -0.55, eyeX: 0, eyeY: 0, closeL: 0.08, closeR: 0.08, irisScale: 0, tilt: -0.05, mood: "sad" }, // 生气
  { brow: 0.55, mouthOpen: 0.12, mouthForm: 0.6, eyeX: 0.35, eyeY: -0.15, closeL: 0.45, closeR: 0.45, irisScale: 0, tilt: 0.1, mood: "happy" }, // 害羞
  { brow: 0.25, mouthOpen: 0.35, mouthForm: 0.7, eyeX: 0, eyeY: 0, closeL: 1, closeR: 0, irisScale: 0, tilt: 0.04, mood: "neutral" }, // 左眨眼
  { brow: 0.25, mouthOpen: 0.35, mouthForm: 0.7, eyeX: 0, eyeY: 0, closeL: 0, closeR: 1, irisScale: 0, tilt: -0.04, mood: "neutral" }, // 右眨眼
  { brow: 0.2, mouthOpen: 0.85, mouthForm: -0.35, eyeX: 0, eyeY: 0.15, closeL: 0.12, closeR: 0.12, irisScale: 0.05, tilt: 0.03, mood: "neutral" }, // 吐舌/哈欠
  { brow: 0.6, mouthOpen: 0.5, mouthForm: -0.15, eyeX: -0.3, eyeY: 0, closeL: 0, closeR: 0, irisScale: 0, tilt: 0.08, mood: "happy" }, // 好奇
];

/** 音乐播放时只抽 happy/neutral 表情 */
const MUSIC_EXPRESSIONS = EXPRESSIONS.filter(e => e.mood !== "sad");

function pickExpression(rng: () => number, pool?: Expression[]): Expression {
  const list = pool ?? EXPRESSIONS;
  return list[Math.floor(rng() * list.length)];
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
  private displayW = 300;
  // 音乐驱动相位：让 treble/bass 的单向能量乘以 sin 载波变成围绕 0 的双向摆动
  private musicPhase = 0;

  // 随机表情状态机
  private exprT = 0;
  private exprDur = 1.6;
  private exprNext = 0;
  private expr: Expression = EXPRESSIONS[0];

  // 动作播放器
  private action: ActionDef | null = null;
  private actionT = 0;
  private actionLoop = false;
  private winkRight = false;

  // 动作池
  private actionPoolNext = performance.now() + 8000;

  // 跟随音乐：BPM 节奏摇摆 + 节拍随机 wink
  private bpmPhase = 0;
  private musicWinkT = 0;
  private musicWinkNext = 2 + Math.random() * 4;
  private musicWinkSide: "L" | "R" = "L";

  // 拖拽下半身摆动
  private swing = 0;
  private swingV = 0;
  private dragSquint = 0;

  // ---- 相位随机化 ----
  private phaseOffsets = {
    body: 0, angleZ: 0, bust: 0, bangL: 0, bangC: 0, bangR: 0,
    armPos: 0, mouthCY: 0, mouthCAng: 0,
  };
  private phaseRefreshTimer = 0; // 下次刷新相位的时间戳(ms)
  private lastBpm = 0; // 上一帧的 bpm，用于检测音乐开始

  // ---- 用户调节参数（覆盖计算值） ----
  private userParams: Partial<Record<string, number>> = {};

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

  get warnings(): string[] {
    return this.runtime.warnings;
  }

  get stats(): string {
    return `已自动装配 ${this.runtime.partsCount} 部件 / 发丝 ${this.runtime.strandCount} 束`;
  }

  // ---- 音乐情绪检测 ----
  private detectMood(bass: number, mid: number, treble: number): MusicMood {
    const energy = bass + mid + treble;
    const bassRatio = bass / (energy || 1);
    if (energy < 0.05) return "calm";
    if (bassRatio > 0.55 && energy > 0.3) return "energetic";
    return "normal";
  }

  // ---- 相位随机化：刷新所有 per-parameter 相位偏移 ----
  private refreshPhases() {
    for (const k in this.phaseOffsets) {
      (this.phaseOffsets as Record<string, number>)[k] = Math.random() * Math.PI * 2;
    }
  }

  update(d: PetDriver, dt: number) {
    this.musicPhase += dt;
    const sway = this.swayEnabled && !this.action ? 1 : 0;
    this.gobblePulse = Math.max(0, this.gobblePulse - dt * 2.2);
    this.clickPulse = Math.max(0, this.clickPulse - dt * 6);
    this.scalePulse = Math.max(0, this.scalePulse - dt * 5);

    // ---- 相位随机化触发：bpm 从 0→有音乐 时立即刷新，之后每 30 秒刷新 ----
    const nowMs = performance.now();
    if (d.bpm > 40 && this.lastBpm <= 40) {
      // 音乐刚开始，立即刷新相位
      this.refreshPhases();
      this.phaseRefreshTimer = nowMs + 30000;
    } else if (d.bpm > 40 && nowMs > this.phaseRefreshTimer) {
      this.refreshPhases();
      this.phaseRefreshTimer = nowMs + 30000;
    }
    this.lastBpm = d.bpm;

    // ---- 音乐情绪检测 ----
    const mood = this.detectMood(d.bass, d.mid, d.treble);
    // 情绪幅度乘数
    const moodMul = mood === "calm" ? 0.3 : mood === "energetic" ? 1.4 : 1.0;

    // ---- 表情节奏：音乐播放时缩短间隔 + 节拍触发 + mood 过滤 ----
    this.exprT += dt;
    if (d.idle) {
      if (this.exprT > this.exprDur || this.exprT === 0) {
        this.expr = EXPRESSIONS[0];
        this.exprT = 0;
      }
      this.exprNext = nowMs + 60000;
    } else if (!this.action) {
      // 音乐播放时缩短表情间隔
      const isMusic = d.bpm > 40;
      const exprInterval = isMusic
        ? (3000 + Rigged2DView.rand() * 3000) * getActivityFactor()
        : (6000 + Rigged2DView.rand() * 8000) * getActivityFactor();

      // 节拍到来时 20% 概率立即触发新表情
      const beatTrigger = isMusic && d.beat > 0.5 && Rigged2DView.rand() < 0.2 && nowMs > this.exprNext - exprInterval * 0.5;

      if (nowMs > this.exprNext || beatTrigger) {
        // 音乐模式下只抽 happy/neutral 表情
        this.expr = pickExpression(Rigged2DView.rand, isMusic ? MUSIC_EXPRESSIONS : undefined);
        this.exprT = 0;
        this.exprDur = isMusic ? 1.2 + Rigged2DView.rand() * 0.6 : 1.6 + Rigged2DView.rand() * 0.8;
        this.exprNext = nowMs + exprInterval;
      }
    }
    const eProg = Math.min(1, this.exprT / this.exprDur);
    const ew = Math.sin(Math.PI * eProg);
    const e = this.expr;

    // ---- 动作池 ----
    if (!this.action && !d.idle && !d.dragging && nowMs > this.actionPoolNext) {
      const def = pickPoolAction(getActivityLevel());
      if (def) this.playAction(def.id, false);
      this.actionPoolNext = nowMs + (15 + Math.random() * 15) * 1000 * getActivityFactor();
    }

    const exc = d.excited ?? 0;
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

    // ---- 下半身摆动 ----
    if (d.pressed) {
      const hold = Math.sin((nowMs / 1000) * 0.6) * 0.4 + Math.sin((nowMs / 1000) * 0.25 + 1.0) * 0.18;
      const speedSwing = d.dragging ? clamp(d.dragVelX * 2.0, -1.5, 1.5) : 0;
      const target = hold + speedSwing;
      this.swingV += (target - this.swing) * 45 * dt;
      this.swingV *= Math.exp(-dt * 6.3);
      this.swing += this.swingV * dt;
    } else {
      this.swingV = 0;
      this.swing += (0 - this.swing) * Math.min(1, dt * 12);
    }
    this.dragSquint += ((d.pressed ? 1 : 0) - this.dragSquint) * Math.min(1, dt * 6);

    // ---- beat 分层：kick vs snare ----
    const beat = d.beat * sway * moodMul;
    const isKick = d.bass > d.mid * 1.5;

    // ---- 构造驱动参数（含相位随机化 + 情绪幅度乘数 + 扩展通道） ----
    const po = this.phaseOffsets;
    const o: Partial<RigParams> = {
      // 头部轻微跟随
      angleX: clamp(cdx * 0.25 + d.vx * 0.25 + exc * 0.12, -1, 1),
      angleY: clamp(-cdy * 0.15 + exc * 0.06, -1, 1),
      eyeX: clamp(cdx * (1.8 + exc * 0.6) + e.eyeX * ew, -1, 1),
      eyeY: clamp(cdy * (1.2 + exc * 0.5) + e.eyeY * ew, -1, 1),

      // 音乐 → 身体律动（+ BPM 节奏摇摆）+ 相位随机化 + 情绪乘数
      body: clamp(
        d.bass * 0.55 * sway * moodMul * Math.sin(this.musicPhase * 2.1 + po.body)
        + d.vx * 0.3
        + (isKick ? -beat * 0.15 : beat * 0.2) * sway
        + bpmSway,
        -1, 1
      ),
      angleZ: clamp(
        Math.sin(d.breathing) * 0.02
        + d.treble * 0.25 * sway * moodMul * Math.sin(this.musicPhase * 3.3 + po.angleZ)
        + e.tilt * ew,
        -0.5, 0.5
      ),

      // 音乐 → 嘴型
      mouthOpen: clamp(d.mid * 0.9 * sway * moodMul + beat * 0.5 * sway + this.gobblePulse + this.clickPulse * 0.5 + e.mouthOpen * ew + exc * 0.12, 0, 1.3),
      mouthForm: clamp(d.mid * 0.4 * sway * moodMul + e.mouthForm * ew, -1, 1),

      // 嘴角（新增）：mid → 上扬，treble → 角度
      mouthCY: clamp(d.mid * 0.2 * sway * moodMul * Math.sin(this.musicPhase * 1.9 + po.mouthCY), -0.5, 0.5),
      mouthCAng: clamp(d.treble * 0.15 * sway * moodMul * Math.sin(this.musicPhase * 2.7 + po.mouthCAng), -0.3, 0.3),

      // 眉毛
      brow: clamp(d.treble * 0.5 * sway * moodMul - d.bass * 0.3 * moodMul + e.brow * ew, -1, 1),

      // 眼睛开合
      eyeOpenL: clamp((1 - d.mid * 0.06 * sway) * (1 - e.closeL * ew) + exc * 0.05, 0, 1.08),
      eyeOpenR: clamp((1 - d.mid * 0.06 * sway) * (1 - e.closeR * ew) + exc * 0.05, 0, 1.08),

      // 瞳孔缩放（新增）：节拍时微缩 + 表情
      irisScale: clamp(1 + e.irisScale * ew - exc * 0.06 - beat * 0.08, 0.5, 1.3),

      // 胸腔起伏（新增）：bass 错开半拍
      bust: clamp(d.bass * 0.3 * sway * moodMul * Math.sin(this.musicPhase * 2.1 + Math.PI / 3 + po.bust), -0.5, 0.5),
      bustY: clamp(beat * 0.15 * sway, -0.3, 0.3),

      // 刘海三束独立飘动（新增）：treble 乘以不同相位
      bangL: clamp(d.treble * 0.4 * sway * moodMul * Math.sin(this.musicPhase * 3.1 + po.bangL), -0.5, 0.5),
      bangC: clamp(d.treble * 0.35 * sway * moodMul * Math.sin(this.musicPhase * 2.8 + po.bangC), -0.5, 0.5),
      bangR: clamp(d.treble * 0.4 * sway * moodMul * Math.sin(this.musicPhase * 3.5 + po.bangR), -0.5, 0.5),

      // 发丝物理加成（增强）：kick 时额外弹跳
      fhAmp: 2 + d.mid * 2.5 * sway * moodMul,
      physAmp: 2 + d.bass * 2 * sway * moodMul + (isKick ? beat * 1.5 : 0),
      fhSoft: 0.4 + d.treble * 0.3 * sway * moodMul,
      soft: 2 + d.mid * 1.5 * sway * moodMul,

      // 手臂
      armY: clamp(d.vx * 0.6, -1, 1),
      armPos: clamp(d.bass * 0.2 * sway * moodMul * Math.sin(this.musicPhase * 1.7 + po.armPos), -0.5, 0.5),

      // 拖拽 → 下半身摆动
      bodySwing: clamp(this.swing, -1.5, 1.5),
    };

    // snare/hihat：眨眼 + 嘴角上扬 + 眉毛微挑
    if (!isKick && beat > 0.05) {
      o.eyeOpenL = Math.min(o.eyeOpenL ?? 1, 1 - beat * 0.15);
      o.eyeOpenR = Math.min(o.eyeOpenR ?? 1, 1 - beat * 0.15);
      o.mouthCY = (o.mouthCY ?? 0) + beat * 0.1;
      o.brow = clamp((o.brow ?? 0) + beat * 0.15, -1, 1);
    }

    // 音乐节拍 wink
    if (winkClose) {
      if (this.musicWinkSide === "L") o.eyeOpenL = Math.min(o.eyeOpenL ?? 1, 0.12);
      else o.eyeOpenR = Math.min(o.eyeOpenR ?? 1, 0.12);
    }

    // 按住眯眼
    if (this.dragSquint > 0.01) {
      const sq = 1 - 0.95 * this.dragSquint;
      o.eyeOpenL = Math.min(o.eyeOpenL ?? 1, sq);
      o.eyeOpenR = Math.min(o.eyeOpenR ?? 1, sq);
    }

    // ---- 动作层 ----
    if (this.action) {
      const speed = this.action.bpmSync && d.bpm > 40 ? d.bpm / 60 : 1;
      this.actionT += dt * speed;
      const progress = Math.min(1, this.actionT / this.action.duration);
      const ap = sampleAction(this.action, progress);
      if (this.action.randomEye && this.winkRight) {
        const l = ap.eyeOpenL;
        const r = ap.eyeOpenR;
        if (r !== undefined) ap.eyeOpenL = r;
        if (l !== undefined) ap.eyeOpenR = l;
      }
      const FADE = 0.2;
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


    // ---- 应用用户调节参数 ----
    for (const k in this.userParams) {
      const v = this.userParams[k];
      if (v !== undefined) (o as any)[k] = v;
    }

    this.runtime.update(dt, o);

    // 待机顶部 → 整体旋转 180°
    const rot = d.idleTop ? " rotate(180deg)" : "";
    const ox = Math.round(d.modelOffsetX || 0);
    const oy = Math.round(d.modelOffsetY || 0);
    const shift = ox !== 0 || oy !== 0 ? ` translate(${ox}px, ${oy}px)` : "";

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
      this.setAuto(false);
    }
  }

  stopAction() {
    this.action = null;
    this.actionT = 0;
    this.actionLoop = false;
    this.setAuto(true);
  }

  private setAuto(on: boolean) {
    this.runtime.autoBlinkOn = on;
    this.runtime.autoRandOn = on;
    this.runtime.autoIdleOn = on;
  }

  setSwayEnabled(on: boolean) {
    this.swayEnabled = on;
  }

  setScale(displayW: number) {
    this.displayW = displayW;
    const cw = this.runtime.canvasWidth;
    const ch = this.runtime.canvasHeight;
    const s = displayW / Math.max(cw, ch);
    this.canvas.style.width = `${Math.round(cw * s)}px`;
    this.canvas.style.height = `${Math.round(ch * s)}px`;
    this.canvas.style.maxWidth = "none";
    this.canvas.style.maxHeight = "none";
  }

  getCharacterBounds(): { left: number; top: number; right: number; bottom: number } | null {
    const cb = this.runtime.characterBounds;
    if (!cb) return null;
    const cw = this.runtime.canvasWidth;
    const ch = this.runtime.canvasHeight;
    const s = this.displayW / Math.max(cw, ch);
    const dw = cw * s;
    const dh = ch * s;
    const offsetX = (700 - dw) / 2;
    const offsetY = (700 - dh) / 2;
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

  /** 设置用户调节参数（覆盖计算值） */
  setParam(key: string, value: number) {
    this.userParams[key] = value;
  }

  /** 获取参数默认值 */
  getDefault(key: string): number {
    const defaults: Record<string, number> = {
      physAmp: 2, soft: 2, fhAmp: 2, fhSoft: 0.4,
      bust: 2.5, bustY: 1, eyeEase: 0.3, mouthEase: 0.45,
      mouthScale: 1, irisScale: 1,
    };
    return defaults[key] ?? 0;
  }

  /** 设置自动行为开关 */
  setAutoOption(key: "autoBlink" | "autoRand" | "autoIdle", on: boolean) {
    if (key === "autoBlink") this.runtime.autoBlinkOn = on;
    else if (key === "autoRand") this.runtime.autoRandOn = on;
    else if (key === "autoIdle") this.runtime.autoIdleOn = on;
  }

  /** 获取自动行为开关状态 */
  getAutoOption(key: "autoBlink" | "autoRand" | "autoIdle"): boolean {
    if (key === "autoBlink") return (this.runtime as any).autoBlink;
    if (key === "autoRand") return (this.runtime as any).autoRand;
    if (key === "autoIdle") return (this.runtime as any).autoIdle;
    return true;
  }

  /** 获取所有可调参数的当前值 */
  getAdjustableParams(): Record<string, number> {
    const keys = ["physAmp", "soft", "fhAmp", "fhSoft", "bust", "bustY", "eyeEase", "mouthEase", "mouthScale", "eyeScaleL", "eyeScaleR", "irisScale"];
    const result: Record<string, number> = {};
    for (const k of keys) {
      result[k] = this.userParams[k] ?? this.getDefault(k);
    }
    return result;
  }

}
