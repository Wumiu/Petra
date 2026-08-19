import * as PIXI from "pixi.js";
// 先求值占位，再加载 cubism4 入口（否则模块顶层检查会抛错）
import "./l2d-stub";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import type { PetDriver, PetView } from "./PetDriver";
import { getActivityFactor } from "../utils/settings";

/**
 * Live2D 模型控制器。
 * 模型约定放在 `public/models/<name>/`（含 model3.json）。
 * 前端通过 `/models/manifest.json` 声明使用哪个模型：
 *   { "active": "my-char", "scale": 2.0 }
 */
export class Live2DController implements PetView {
  container!: PIXI.Container;

  private model: Live2DModel | null = null;
  private baseScale = 1;
  private displayW = 300;
  private swayEnabled = true;
  private gobble = 0;
  private click = 0;
  private t = 0;
  private mirror = 1;
  private lastVx = 0;
  private rotSmooth = 0; // 待机倒挂旋转插值
  private exprT = 0;
  private exprDur = 1.8;
  private exprNext = 0;
  private exprKind = 0; // 0 无 1 微笑 2 惊讶 3 眯眼 4 委屈 5 winkL 6 winkR
  private exprW = 0;

  static async create(): Promise<Live2DController | null> {
    try {
      Live2DModel.registerTicker(PIXI.Ticker);
    } catch {
      return null;
    }

    let active = "model";
    let desiredScale = 1;
    try {
      const res = await fetch("/models/manifest.json", { cache: "no-store" });
      if (res.ok) {
        const manifest = await res.json();
        if (manifest.active) active = manifest.active;
        if (typeof manifest.scale === "number") desiredScale = manifest.scale;
      }
    } catch {
      /* manifest 缺失时退回默认 */
    }

    const urls = [
      `/models/${active}/model3.json`,
      `/models/${active}/model.json`, // Cubism2 兜底
    ];

    let model: Live2DModel | null = null;
    for (const url of urls) {
      try {
        model = await Live2DModel.from(url, {
          autoInteract: false,
        });
        break;
      } catch {
        model = null;
      }
    }
    if (!model) return null;

    const ctrl = new Live2DController();
    ctrl.model = model;
    ctrl.baseScale = desiredScale;
    ctrl.fit();
    return ctrl;
  }

  private fit() {
    const m = this.model!;
    const w = this.displayW;
    const h = this.displayW;
    const inner = m.internalModel as unknown as { canvasWidth?: number; canvasHeight?: number } | null;
    const cw = inner?.canvasWidth ?? w;
    const ch = inner?.canvasHeight ?? h;
    const s = Math.min((w * 0.94) / cw, (h * 0.94) / ch);
    m.scale.set(s * this.baseScale, s * this.baseScale);
    m.anchor.set(0.5, 0.5);
    m.position.set(w / 2, h / 2);
    this.container = m;
  }

  update(d: PetDriver, dt: number) {
    const m = this.model;
    if (!m) return;
    this.t += dt;
    this.gobble = Math.max(0, this.gobble - dt * 3.2);
    this.click = Math.max(0, this.click - dt * 6);

    // 模型边缘露出偏移
    m.position.set(150 + (d.modelOffsetX || 0), 150 + (d.modelOffsetY || 0));

    // 移动时镜像翻转
    if (Math.abs(d.vx) > 0.02) this.lastVx = d.vx;
    const wantMirror = this.lastVx < 0 ? -1 : 1;
    if (wantMirror !== this.mirror) {
      this.mirror = wantMirror;
      m.scale.x *= -1;
    }

    // 待机顶部 → 平滑倒挂 180°
    this.rotSmooth += ((d.idleTop ? Math.PI : 0) - this.rotSmooth) * Math.min(1, dt * 5);
    m.rotation = this.rotSmooth;

    const sway = this.swayEnabled ? 1 : 0;
    const breathePhase = Math.sin(d.breathing);
    const id = m.internalModel as unknown as {
      coreModel?: {
        parameters?: { setValueById: (id: string, v: number, w?: number) => void };
        setParameterValueById?: (id: string, v: number, w?: number) => void;
      };
    };

    const core = id?.coreModel;
    const set = (param: string, v: number) => {
      if (!core) return;
      try {
        core.parameters?.setValueById(param, v, 1);
      } catch {
        try {
          core.setParameterValueById?.(param, v, 1);
        } catch {
          /* 参数不存在则忽略 */
        }
      }
    };

    const musicX = Math.sin(this.t * 2.1) * d.bass * 16 * sway + d.vx * 10;
    const musicY = d.bass * 6 * sway + d.bob * 6;
    set("ParamBodyAngleX", musicX);
    set("ParamBodyAngleY", musicY);
    set("ParamBodyAngleZ", d.treble * 4 * sway * Math.sin(this.t * 3.3));

    // 随机表情：间隔随活动因子拉长，正弦包络淡入淡出；待机时安静
    this.exprT += dt;
    if (d.idle) {
      this.exprKind = 0;
      this.exprT = 0;
      this.exprNext = this.t + 60000;
    } else if (this.t > this.exprNext) {
      this.exprKind = 1 + Math.floor(Math.random() * 6);
      this.exprT = 0;
      this.exprDur = 1.6 + Math.random() * 0.9;
      this.exprNext = this.t + (8 + Math.random() * 8) * getActivityFactor();
    }
    this.exprW = this.exprT > this.exprDur ? 0 : Math.sin(Math.PI * Math.min(1, this.exprT / this.exprDur));
    const k = this.exprKind;
    const ew = this.exprW;
    const eBrow = k === 1 ? 0.35 * ew : k === 2 ? 0.8 * ew : k === 4 ? -0.4 * ew : 0;
    const eMouth = k === 2 ? 0.5 * ew : k === 1 ? 0.2 * ew : 0;
    const eEyeL = k === 5 || k === 3 ? (1 - 0.85 * ew) : 1;
    const eEyeR = k === 6 || k === 3 ? (1 - 0.85 * ew) : 1;
    const eForm = k === 1 ? 0.8 * ew : k === 3 ? 0.4 * ew : k === 4 ? -0.4 * ew : 0;

    // 顶部待机倒挂（旋转 180°）→ 视线横纵都镜像
    const flip = d.idleTop ? -1 : 1;
    set("ParamAngleX", Math.max(-25, Math.min(25, d.cursorDx * flip * 22)));
    set("ParamAngleY", Math.max(-15, Math.min(15, -d.cursorDy * flip * 12)));
    set("ParamAngleZ", Math.max(-10, Math.min(10, d.vx * 6)));
    // 眼球跟随（标准 Cubism 参数，范围 ±30；兴奋时更跟手）
    const exc = d.excited ?? 0;
    set("ParamEyeBallX", Math.max(-30, Math.min(30, d.cursorDx * flip * (26 + exc * 14))));
    set("ParamEyeBallY", Math.max(-30, Math.min(30, d.cursorDy * flip * (18 + exc * 10))));

    set("ParamBreath", 0.5 + breathePhase * 0.5);
    // 眼睛：中频能量 + 表情（眯眼/眨眼收敛）+ 兴奋睁大
    const baseEye = 1 - d.mid * 0.06 * sway;
    set("ParamEyeLOpen", Math.max(0, Math.min(1.1, baseEye * eEyeL + exc * 0.06)));
    set("ParamEyeROpen", Math.max(0, Math.min(1.1, baseEye * eEyeR + exc * 0.06)));
    set("ParamCheek", Math.max(0, d.bass * 0.7 * sway + (k === 1 ? 0.5 * ew : 0)));
    set("ParamBrowL", Math.max(-1, Math.min(1, d.treble * 0.4 * sway + eBrow)));
    set("ParamBrowR", Math.max(-1, Math.min(1, d.treble * 0.4 * sway + eBrow)));

    // 嘴：中频 + 节拍 + 吞咽/点击 + 表情 + 兴奋微张嘴
    const mouth = Math.min(
      1.5,
      d.mid * 1.2 * sway + d.beat * 0.6 * sway + this.gobble + this.click * 0.8 + eMouth + exc * 0.18,
    );
    set("ParamMouthOpenY", mouth);
    set("ParamMouthForm", Math.max(-1, Math.min(1, 0.5 + d.mid * 0.3 + eForm)));
  }

  playGobble() {
    if (!this.model) return;
    this.gobble = 1;
    this.tryMotion(["TapBody", "TapHead", "FlickHead", "Idle"]);
  }

  playClick() {
    if (!this.model) return;
    this.click = 1;
    this.tryMotion(["TapBody", "FlickHead", "Idle"]);
  }

  playAction(_id: string, _loop = false) {
    // PSD 动作库暂不支持标准 Live2D 后端（此处留空占位）
  }

  stopAction() {
    // 同上
  }

  private tryMotion(names: string[]) {
    const m = this.model;
    if (!m) return;
    for (const n of names) {
      try {
        m.motion(n);
        return;
      } catch {
        /* 该组不存在则换下一个 */
      }
    }
  }

  setSwayEnabled(on: boolean) {
    this.swayEnabled = on;
  }

  setScale(displayW: number) {
    this.displayW = displayW;
    if (this.model) this.fit();
  }

  attachTo(_stage: HTMLElement, pixiStage: PIXI.Container) {
    pixiStage.addChild(this.container);
  }

  unmount() {
    this.container.destroy({ children: true });
  }
}