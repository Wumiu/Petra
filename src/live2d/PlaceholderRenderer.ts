import * as PIXI from "pixi.js";
import type { PetDriver, PetView } from "./PetDriver";
import { getActivityFactor } from "../utils/settings";

const BODY = 0xffd6ea;
const BODY_LIGHT = 0xfff0f7;
const OUTLINE = 0xe58fb4;
const DARK = 0x4a2838;
const BLUSH = 0xff9fb8;

/**
 * 占位角色：粉团子（在用户做好 Live2D 模型前保持桌宠可用）。
 * 耳朵 + 眼睛追光标 + 嘴随音乐开合 + 按压式缩放呼吸。
 */
export class PlaceholderRenderer implements PetView {
  readonly container = new PIXI.Container();

  private body!: PIXI.Graphics;
  private earL!: PIXI.Graphics;
  private earR!: PIXI.Graphics;
  private innerL!: PIXI.Graphics;
  private innerR!: PIXI.Graphics;
  private eyeLW!: PIXI.Graphics;
  private eyeRW!: PIXI.Graphics;
  private eyeLP!: PIXI.Graphics;
  private eyeRP!: PIXI.Graphics;
  private mouth!: PIXI.Graphics;
  private blushL!: PIXI.Graphics;
  private blushR!: PIXI.Graphics;
  private shadow!: PIXI.Graphics;
  private burst: PIXI.Container | null = null;
  private burstTimer = 0;

  private t = 0;
  private blinkAt = 2.5 + Math.random() * 2;
  private blinkPhase = 0;
  private gobblePulse = 0;
  private clickPulse = 0;
  private swayEnabled = true;
  private exprT = 0;
  private exprDur = 1.8;
  private exprNext = 0;
  private exprKind = 0; // 0 无 1 winkL 2 winkR 3 眯眼 4 嘟嘴 5 惊讶
  private rotSmooth = 0; // 待机倒挂旋转插值

  constructor() {
    this.body = new PIXI.Graphics();
    this.earL = new PIXI.Graphics();
    this.earR = new PIXI.Graphics();
    this.innerL = new PIXI.Graphics();
    this.innerR = new PIXI.Graphics();
    this.eyeLW = new PIXI.Graphics();
    this.eyeRW = new PIXI.Graphics();
    this.eyeLP = new PIXI.Graphics();
    this.eyeRP = new PIXI.Graphics();
    this.mouth = new PIXI.Graphics();
    this.blushL = new PIXI.Graphics();
    this.blushR = new PIXI.Graphics();
    this.shadow = new PIXI.Graphics();

    this.container.addChild(
      this.shadow,
      this.earL,
      this.earR,
      this.body,
      this.innerL,
      this.innerR,
      this.blushL,
      this.blushR,
      this.eyeLW,
      this.eyeRW,
      this.eyeLP,
      this.eyeRP,
      this.mouth,
    );
    this.draw();
  }

  private draw() {
    const { container } = this;
    container.pivot.set(150, 150);
    container.position.set(150, 170);

    const eyeY = -26;
    const r = 100;
    const s = 0.85;

    this.shadow.clear();
    this.shadow.beginFill(0x000000, 0.16);
    this.shadow.drawEllipse(0, r * s - 4, 95 * s, 18 * s);
    this.shadow.endFill();
    this.shadow.y = 82;

    this.earL.clear();
    this.earL.beginFill(OUTLINE);
    this.earL.moveTo(-118 * s, -84 * s);
    this.earL.quadraticCurveTo(-150 * s, -84 * s, -140 * s, -40 * s);
    this.earL.quadraticCurveTo(-128 * s, -66 * s, -98 * s, -56 * s);
    this.earL.endFill();

    this.earR.clear();
    this.earR.beginFill(OUTLINE);
    this.earR.moveTo(118 * s, -84 * s);
    this.earR.quadraticCurveTo(150 * s, -84 * s, 140 * s, -40 * s);
    this.earR.quadraticCurveTo(128 * s, -66 * s, 98 * s, -56 * s);
    this.earR.endFill();

    this.body.clear();
    this.body.beginFill(BODY);
    this.body.drawCircle(0, 0, r * s);
    this.body.endFill();
    this.body.lineStyle({
      width: 6,
      color: OUTLINE,
      alpha: 0.9,
      cap: PIXI.LINE_CAP.ROUND,
      join: PIXI.LINE_JOIN.ROUND,
    });
    this.body.drawCircle(0, 0, r * s);
    this.body.lineStyle(0);

    this.innerL.clear();
    this.innerL.beginFill(BLUSH, 0.55);
    this.innerL.drawEllipse(-128 * s, -52 * s, 18 * s, 22 * s);
    this.innerL.endFill();

    this.innerR.clear();
    this.innerR.beginFill(BLUSH, 0.55);
    this.innerR.drawEllipse(128 * s, -52 * s, 18 * s, 22 * s);
    this.innerR.endFill();

    this.eyeLW.clear();
    this.eyeLW.beginFill(0xffffff);
    this.eyeLW.drawEllipse(-46 * s, eyeY, 22 * s, 27 * s);
    this.eyeLW.endFill();

    this.eyeRW.clear();
    this.eyeRW.beginFill(0xffffff);
    this.eyeRW.drawEllipse(46 * s, eyeY, 22 * s, 27 * s);
    this.eyeRW.endFill();

    this.eyeLP.clear();
    this.eyeLP.beginFill(DARK);
    this.eyeLP.drawCircle(-46 * s, eyeY, 10.5 * s);
    this.eyeLP.endFill();

    this.eyeRP.clear();
    this.eyeRP.beginFill(DARK);
    this.eyeRP.drawCircle(46 * s, eyeY, 10.5 * s);
    this.eyeRP.endFill();

    this.mouth.clear();
    this.mouth.lineStyle({
      width: 5,
      color: DARK,
      alpha: 0.9,
      cap: PIXI.LINE_CAP.ROUND,
      join: PIXI.LINE_JOIN.ROUND,
    });
    this.mouth.moveTo(-20 * s, 52 * s);
    this.mouth.quadraticCurveTo(0, 66 * s, 20 * s, 52 * s);
    this.mouth.endFill();
    this.mouth.lineStyle(0);

    this.blushL.clear();
    this.blushL.beginFill(BLUSH, 0.4);
    this.blushL.drawEllipse(-62 * s, 26 * s, 20 * s, 11 * s);
    this.blushL.endFill();

    this.blushR.clear();
    this.blushR.beginFill(BLUSH, 0.4);
    this.blushR.drawEllipse(62 * s, 26 * s, 20 * s, 11 * s);
    this.blushR.endFill();
  }

  update(d: PetDriver, dt: number) {
    this.t += dt;
    const { container } = this;
    const s = 0.85;

    // 按压呼吸：节奏 2.4s + 音乐低频相融合
    const breathe = Math.sin(d.breathing) * 0.02;
    const music = this.swayEnabled ? d.bass * 0.09 : 0;
    const bobAmt = d.bob * (0.035 + d.mid * 0.02);
    const beatPulse = this.swayEnabled ? d.beat * 0.05 : 0;

    const gob = this.decay(this.gobblePulse, dt, 4.2);
    this.gobblePulse = gob;
    const click = this.decay(this.clickPulse, dt, 5.5);
    this.clickPulse = click;

    const pulse = (breathe + music + beatPulse) * (1 - gob - click);
    const exc = d.excited ?? 0; // 逗猫棒兴奋度：眼神更跟手、瞳孔聚焦、微张嘴

    // 眨眼
    if (this.t > this.blinkAt) {
      this.blinkPhase = 1;
      this.blinkAt = this.t + 2.2 + Math.random() * 2.4;
    }
    this.blinkPhase = Math.max(0, this.blinkPhase - dt * 7);

    // 随机表情：间隔随活动因子拉长；待机时安静
    this.exprT += dt;
    if (d.idle) {
      this.exprKind = 0;
      this.exprT = 0;
      this.exprNext = this.t + 60000;
    } else if (this.t > this.exprNext) {
      this.exprKind = 1 + Math.floor(Math.random() * 5);
      this.exprT = 0;
      this.exprDur = 1.4 + Math.random() * 0.9;
      this.exprNext = this.t + (8 + Math.random() * 8) * getActivityFactor();
    }
    const eProg = Math.min(1, this.exprT / this.exprDur);
    const ew = Math.sin(Math.PI * eProg);
    const exprDone = this.exprT > this.exprDur;
    const wk = exprDone ? 0 : ew;

    // 眼睛追光标（兴奋时更跟手）
    const lookX = Math.max(-1, Math.min(1, d.cursorDx)) * (11 + exc * 4) * s;
    const lookY = Math.max(-1, Math.min(1, d.cursorDy)) * (8 + exc * 3) * s;

    this.eyeLP.position.set(lookX, lookY);
    this.eyeRP.position.set(lookX, lookY);

    // 眨眼 + 表情（wink 单眼 / 眯眼 / 惊讶瞪眼）
    const eyeScale = 1 - this.blinkPhase * 0.93;
    const winkL = this.exprKind === 1 ? wk : 0;
    const winkR = this.exprKind === 2 ? wk : 0;
    const squint = this.exprKind === 3 ? 0.55 * wk : 0;
    const pupilGrow = this.exprKind === 5 ? 1 + 0.28 * wk : 1;
    const eyeWScale = eyeScale * (1 - winkL - squint);
    const eyeRScale = eyeScale * (1 - winkR - squint);
    this.eyeLW.scale.set(1, eyeWScale);
    this.eyeRW.scale.set(1, eyeRScale);
    this.eyeLP.scale.set(1, Math.min(1.3, eyeWScale * pupilGrow));
    this.eyeRP.scale.set(1, Math.min(1.3, eyeRScale * pupilGrow));

    // 嘴：音乐开合 + 吞咽 + 表情（嘟嘴/惊讶张嘴）+ 兴奋微张嘴
    const mouthOpen = this.swayEnabled ? d.mid * 1.4 + d.beat * 0.8 : 0;
    const pout = this.exprKind === 4 ? wk : 0;
    const surpriseMouth = this.exprKind === 5 ? 0.9 * wk : 0;
    const mouthScale = 1 + mouthOpen + gob * 2.2 + pout * 0.7 + surpriseMouth + exc * 0.4;
    this.mouth.scale.set(mouthScale, 1 + gob * 1.4 + pout * 0.25 + exc * 0.2);

    // 顺风耳：随节奏小幅摆耳
    const earSway = this.swayEnabled ? d.treble * 0.35 : 0;
    this.earL.rotation = -earSway + d.vx * 0.06;
    this.earR.rotation = earSway + d.vx * 0.06;
    this.earL.pivot.set(-120 * s, -50 * s);
    this.earR.pivot.set(120 * s, -50 * s);

    // 主体：投影+蹦跶+摇摆+瞄准鼠标（待机顶部 → 平滑倒挂 180°）
    const bounceY = (breathe + pulse + bobAmt * 0.5) * 18;
    const lean = d.vx * 0.12 + (this.swayEnabled ? d.treble * 0.18 : 0) * Math.sin(this.t * 3.1);
    this.rotSmooth += ((d.idleTop ? Math.PI : 0) - this.rotSmooth) * Math.min(1, dt * 5);
    container.rotation = this.rotSmooth + lean;
    container.scale.set(
      1 + pulse * 0.4 - bobAmt * 0.12,
      1 - pulse * 0.4 + bobAmt * 0.12,
    );
    container.y = 170 - bounceY;

    this.shadow.scale.set(1 + bounceY * 0.012, Math.max(0.6, 1 - bounceY * 0.02));
    this.shadow.alpha = Math.max(0.28, 0.55 - bounceY * 0.018);

    // 粒子爆发
    if (this.gobblePulse > 0.5) this.spawnBurst();
    this.updateBurst(dt);
  }

  private decay(v: number, dt: number, rate: number): number {
    return Math.max(0, v - dt * rate);
  }

  playGobble() {
    this.gobblePulse = 1;
  }

  playClick() {
    this.clickPulse = 1;
  }

  setSwayEnabled(on: boolean) {
    this.swayEnabled = on;
  }

  attachTo(_stage: HTMLElement, pixiStage: PIXI.Container) {
    pixiStage.addChild(this.container);
  }

  unmount() {
    this.container.destroy({ children: true });
  }

  private spawnBurst() {
    if (this.burst && !this.burst.destroyed) {
      this.burst.destroy({ children: true });
    }
    this.burst = new PIXI.Container();
    this.burstTimer = 0.8;
    for (let i = 0; i < 24; i++) {
      const p = new PIXI.Graphics();
      const c = [0xffb3d1, 0xffe08a, 0xb3e5ff, 0xd9b3ff][i % 4];
      p.beginFill(c, 0.95);
      p.drawCircle(0, 0, 3 + Math.random() * 4);
      p.endFill();
      p.position.set(0, 0);
      const ang = Math.random() * Math.PI * 2;
      const spd = 120 + Math.random() * 160;
      p.angle = ang;
      (p as unknown as { vx: number; vy: number }).vx = Math.cos(ang) * spd;
      (p as unknown as { vx: number; vy: number }).vy = Math.sin(ang) * spd - 60;
      this.burst.addChild(p);
    }
    this.container.addChild(this.burst);
  }

  private updateBurst(dt: number) {
    if (!this.burst || this.burst.destroyed) return;
    this.burstTimer -= dt;
    for (const c of this.burst.children) {
      const p = c as unknown as { vx: number; vy: number };
      c.x += p.vx * dt;
      c.y += p.vy * dt;
      p.vy += 240 * dt;
      c.alpha = Math.max(0, this.burstTimer / 0.8);
    }
    if (this.burstTimer <= 0) {
      this.burst.destroy({ children: true });
      this.burst = null;
    }
  }
}