import type { RigParams } from "./psd/PsdRuntime";

/**
 * 动作系统：把 RigParams 参数按时序编排成"一个完整动作"。
 * 动作库 PSD 无关、全自动通用——一键 rig 后即可播放。
 * 关键帧间 smoothstep 插值，动作层参数在渲染时覆盖对应通道。
 */

export interface ActionKeyframe {
  t: number; // 0..1 归一化进度
  params: Partial<RigParams>;
}

export interface ActionDef {
  id: string;
  label: string;
  duration: number; // 秒
  bpmSync?: boolean; // 跟随 BPM：播放速度随 BPM 缩放（bpm 越高越快）
  randomEye?: boolean; // 随机闭左/右眼（播放时随机镜像）
  pool?: "low" | "mid"; // 动作池分级：low=低频率可用，mid=中高可用
  keys: ActionKeyframe[];
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export const ACTIONS: ActionDef[] = [
  {
    id: "nod", label: "点头", duration: 1.2, pool: "low",
    keys: [
      { t: 0, params: { angleY: 0 } },
      { t: 0.5, params: { angleY: -1.0 } },
      { t: 1, params: { angleY: 0 } },
    ],
  },
  {
    id: "shake", label: "摇头", duration: 1.1, pool: "mid",
    keys: [
      { t: 0, params: { angleX: 0 } },
      { t: 0.25, params: { angleX: -1.0 } },
      { t: 0.5, params: { angleX: 0 } },
      { t: 0.75, params: { angleX: 1.0 } },
      { t: 1, params: { angleX: 0 } },
    ],
  },
  {
    id: "tilt", label: "歪头", duration: 1.0, pool: "low",
    keys: [
      { t: 0, params: { angleZ: 0 } },
      { t: 0.5, params: { angleZ: -0.9 } },
      { t: 1, params: { angleZ: 0 } },
    ],
  },
  {
    id: "lookAround", label: "张望", duration: 3.0, pool: "low",
    keys: [
      { t: 0, params: { angleX: 0, angleY: 0, eyeX: 0, eyeY: 0 } },
      { t: 0.25, params: { angleX: 0.5, angleY: -0.2, eyeX: 0.5, eyeY: -0.15 } },
      { t: 0.5, params: { angleX: 0, angleY: 0, eyeX: 0, eyeY: 0 } },
      { t: 0.75, params: { angleX: -0.5, angleY: -0.2, eyeX: -0.5, eyeY: -0.15 } },
      { t: 1, params: { angleX: 0, angleY: 0, eyeX: 0, eyeY: 0 } },
    ],
  },
  {
    id: "lookSide", label: "左顾右盼", duration: 1.3, pool: "mid",
    keys: [
      { t: 0, params: { angleX: 0, eyeX: 0 } },
      { t: 0.3, params: { angleX: 0.7, eyeX: 0.7 } },
      { t: 0.6, params: { angleX: -0.7, eyeX: -0.7 } },
      { t: 1, params: { angleX: 0, eyeX: 0 } },
    ],
  },
  {
    id: "wave", label: "挥手", duration: 1.6, pool: "mid",
    keys: [
      { t: 0, params: { armY: 0, armPos: 0 } },
      { t: 0.25, params: { armY: 1.2, armPos: 0.5 } },
      { t: 0.5, params: { armY: 0, armPos: 0 } },
      { t: 0.75, params: { armY: 1.2, armPos: 0.5 } },
      { t: 1, params: { armY: 0, armPos: 0 } },
    ],
  },
  {
    id: "raiseHand", label: "举手", duration: 1.3, pool: "mid",
    keys: [
      { t: 0, params: { armY: 0, armPos: 0 } },
      { t: 0.5, params: { armY: 1.2, armPos: 0.6 } },
      { t: 0.75, params: { armY: 1.2, armPos: 0.6 } },
      { t: 1, params: { armY: 0, armPos: 0 } },
    ],
  },
  {
    id: "yawn", label: "打哈欠", duration: 2.5, pool: "low",
    keys: [
      { t: 0, params: { mouthOpen: 0, eyeOpenL: 1, eyeOpenR: 1, angleY: 0 } },
      { t: 0.4, params: { mouthOpen: 1.2, eyeOpenL: 0.2, eyeOpenR: 0.2, angleY: -0.4 } },
      { t: 0.75, params: { mouthOpen: 0.9, eyeOpenL: 0.25, eyeOpenR: 0.25, angleY: -0.35 } },
      { t: 1, params: { mouthOpen: 0, eyeOpenL: 1, eyeOpenR: 1, angleY: 0 } },
    ],
  },
  {
    id: "stretch", label: "伸懒腰", duration: 2.2, pool: "mid",
    keys: [
      { t: 0, params: { body: 0, armY: 0 } },
      { t: 0.4, params: { body: 0.45, armY: 1 } },
      { t: 0.7, params: { body: 0.45, armY: 1 } },
      { t: 1, params: { body: 0, armY: 0 } },
    ],
  },
  {
    id: "happy", label: "开心跳", duration: 1.6, pool: "mid",
    keys: [
      { t: 0, params: { body: 0, armY: 0 } },
      { t: 0.2, params: { body: 0.5, armY: 0.6 } },
      { t: 0.4, params: { body: -0.4, armY: 0 } },
      { t: 0.6, params: { body: 0.5, armY: 0.6 } },
      { t: 0.8, params: { body: -0.4, armY: 0 } },
      { t: 1, params: { body: 0, armY: 0 } },
    ],
  },
  {
    id: "surprised", label: "惊讶", duration: 1.4, pool: "mid",
    keys: [
      { t: 0, params: { eyeOpenL: 1, eyeOpenR: 1, irisScale: 1, mouthOpen: 0.3, angleY: 0 } },
      { t: 0.35, params: { eyeOpenL: 1.08, eyeOpenR: 1.08, irisScale: 0.6, mouthOpen: 0.75, angleY: -0.35 } },
      { t: 0.75, params: { eyeOpenL: 1.08, eyeOpenR: 1.08, irisScale: 0.6, mouthOpen: 0.75, angleY: -0.35 } },
      { t: 1, params: { eyeOpenL: 1, eyeOpenR: 1, irisScale: 1, mouthOpen: 0.3, angleY: 0 } },
    ],
  },
  {
    id: "sleepy", label: "打盹", duration: 3.0, pool: "low",
    keys: [
      { t: 0, params: { eyeOpenL: 1, eyeOpenR: 1, body: 0, angleY: 0 } },
      { t: 0.3, params: { eyeOpenL: 0.35, eyeOpenR: 0.35, body: 0.15, angleY: -0.15 } },
      { t: 0.7, params: { eyeOpenL: 0.25, eyeOpenR: 0.25, body: 0.2, angleY: -0.2 } },
      { t: 1, params: { eyeOpenL: 1, eyeOpenR: 1, body: 0, angleY: 0 } },
    ],
  },
  {
    id: "sway", label: "摇摆", duration: 2.0, bpmSync: true, pool: "low",
    keys: [
      { t: 0, params: { body: 0, angleZ: 0 } },
      { t: 0.25, params: { body: 1.0, angleZ: 0.5 } },
      { t: 0.5, params: { body: 0, angleZ: 0 } },
      { t: 0.75, params: { body: -1.0, angleZ: -0.5 } },
      { t: 1, params: { body: 0, angleZ: 0 } },
    ],
  },
  {
    id: "wink", label: "眨眼", duration: 1.8, randomEye: true, pool: "low",
    keys: [
      { t: 0, params: { eyeOpenL: 1, eyeOpenR: 1 } },
      { t: 0.1, params: { eyeOpenL: 0.08, eyeOpenR: 1 } },
      { t: 0.7, params: { eyeOpenL: 0.08, eyeOpenR: 1 } },
      { t: 1, params: { eyeOpenL: 1, eyeOpenR: 1 } },
    ],
  },
];

export function listActions(): { id: string; label: string }[] {
  return ACTIONS.map((a) => ({ id: a.id, label: a.label }));
}

export function findAction(id: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.id === id);
}

/** 按活动频率从动作池随机抽取（low 只抽 low 池，mid/high 抽全部） */
export function pickPoolAction(level: "low" | "mid" | "high"): ActionDef | null {
  const allowed = level === "low" ? ACTIONS.filter((a) => a.pool === "low") : ACTIONS;
  if (!allowed.length) return null;
  return allowed[Math.floor(Math.random() * allowed.length)];
}

/** 按进度采样动作参数（关键帧间 smoothstep 插值，仅含动作涉及的通道） */
export function sampleAction(action: ActionDef, progress: number): Partial<RigParams> {
  const keys = action.keys;
  if (keys.length === 0) return {};
  if (progress <= keys[0].t) return { ...keys[0].params };
  if (progress >= keys[keys.length - 1].t) return { ...keys[keys.length - 1].params };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (progress >= a.t && progress <= b.t) {
      const span = b.t - a.t || 1;
      const local = smooth((progress - a.t) / span);
      const out: Partial<RigParams> = {};
      const ak = a.params as Record<string, number>;
      const bk = b.params as Record<string, number>;
      const all = new Set([...Object.keys(ak), ...Object.keys(bk)]);
      for (const k of all) {
        (out as unknown as Record<string, number>)[k] = (ak[k] ?? 0) + ((bk[k] ?? 0) - (ak[k] ?? 0)) * local;
      }
      return out;
    }
  }
  return { ...keys[keys.length - 1].params };
}
