import { invoke } from "@tauri-apps/api/core";
import { clamp } from "../utils/math";

interface XY {
  x: number;
  y: number;
}

const WIN = 300;
const EDGE_PAD = 4; // 离屏幕边缘留 4px 间隙
const POLL_CURSOR_MS = 120;
const TARGET_INTERVAL = 100;

// 运动参数（调小=更慢更温和）
const BASE_SPEED = 32;        // 闲逛速度 px/s（原 55~110）
const FLEE_SPEED = 140;       // 逃跑速度 px/s（原 210~270）
const BOUNCE_DAMP = 0.55;     // 撞墙后速度衰减
const RADIUS_DIV = 4.5;       // 目标半径除数（越大半径越小，原 2.5）
const REST_BASE = 4000;       // 到达目标后基础休息 ms（原 1500）
const REST_LONG_CHANCE = 0.45; // 长休息概率（原 0.35）
const REST_LONG = 8000;       // 长休息额外 ms（原 4000）

/**
 * 自主漫游引擎：
 * - 在"当前所在显示器的工作区"内随机找目标点闲逛
 * - 鼠标靠近时主动躲避
 * - 结束漫游后小憩，再挑新目标
 * - 目标点经 set_pet_target 发给 Rust mover 线程原生平滑移动（60fps）
 */
export class BehaviorEngine {
  private pos: XY;
  private cursor: XY = { x: 0, y: 0 };
  private target: XY | null = null;
  private area: { left: number; top: number; width: number; height: number } | null = null;
  private dwellUntil = 0;
  private fleeUntil = 0;
  private suspendUntil = 0;
  private lastCursorPoll = 0;
  private lastTarget = 0;
  private areaAt = 0;
  private activityFactor = 2.6;
  private tracking = false;
  private trackAt = 0;
  private lastCursor: XY = { x: 0, y: 0 };
  private vel: XY = { x: 0, y: 0 }; // 上一帧速度（供碰撞反弹用）
  private bounceDir: "none" | "left" | "right" | "top" | "bottom" = "none";

  vx = 0; // -1..1
  bob = 0; // 0..1
  cursorDx = 0; // -1..1
  cursorDy = 0;

  constructor(start: XY, private rng: () => number = Math.random) {
    this.pos = { ...start };
  }

  get position(): XY {
    return { ...this.pos };
  }

  async teleportRandom() {
    await this.refreshArea();
    this.pickTarget(true);
    this.dwellUntil = 0;
    await this.pushTarget();
  }

  /** 活动频率因子（菜单切换）：越大活动越少 */
  setActivityFactor(f: number) {
    this.activityFactor = Math.max(1, f);
  }

  /** 鼠标追踪：缓慢靠近鼠标并保持距离（开启时暂停漫游/躲避） */
  setTracking(on: boolean) {
    this.tracking = on;
    this.target = null;
    this.fleeUntil = 0;
    if (on) {
      this.dwellUntil = 0;
    } else {
      this.dwellUntil = performance.now() + 2000;
    }
  }

  /** 暂停自主漫游（用户拖动时）；再次调用以新时长覆盖 */
  suspend(ms: number) {
    this.suspendUntil = performance.now() + ms;
    void invoke("clear_pet_target");
    this.target = null;
  }

  /** 外部直接设置位置（拖动跟随） */
  setPos(x: number, y: number) {
    this.pos = { x, y };
    this.target = null;
  }

  private async refreshArea() {
    try {
      this.area = await invoke<{ left: number; top: number; width: number; height: number }>(
        "work_area_at",
        { x: Math.round(this.pos.x), y: Math.round(this.pos.y) },
      );
    } catch {
      this.area = { left: 0, top: 0, width: 1920, height: 1080 };
    }
  }

  /** 随机挑一个可达目标点：低活动频率下只在小半径内溜达 */
  private pickTarget(force = false) {
    const a = this.area;
    if (!a) return;
    if (!force && this.target && this.dwellUntil > performance.now()) return;
    const minX = a.left + EDGE_PAD;
    const maxX = a.left + a.width - WIN - EDGE_PAD;
    const minY = a.top + EDGE_PAD;
    const maxY = a.top + a.height - WIN - EDGE_PAD;
    if (maxX <= minX || maxY <= minY) {
      this.target = null;
      return;
    }
    // 半径随活动因子缩小：低活动时原地小范围溜达
    const radius = Math.min(maxX - minX, maxY - minY) / Math.max(3, RADIUS_DIV * (1 / this.activityFactor)) + 60;
    this.target = {
      x: clamp(this.pos.x + (this.rng() * 2 - 1) * radius, minX, maxX),
      y: clamp(this.pos.y + (this.rng() * 2 - 1) * radius, minY, maxY),
    };
  }

  private async pushTarget() {
    if (!this.target) return;
    try {
      await invoke("set_pet_target", {
        x: Math.round(this.target.x),
        y: Math.round(this.target.y),
      });
    } catch {
      /* 忽略 */
    }
  }

  async update(now: number, dt: number) {
    // 定频拉光标（拖拽暂停期间不拉，避免触发躲避）
    if (now - this.lastCursorPoll > POLL_CURSOR_MS) {
      try {
        const c = await invoke<{ x: number; y: number }>("cursor_pos");
        this.cursor = c;
      } catch {
        /* 忽略 */
      }
      this.lastCursorPoll = now;
    }

    // 相对窗口中心的鼠标偏移（供角色视线跟随）
    this.cursorDx = Math.max(-1, Math.min(1, (this.cursor.x - this.pos.x) / 260));
    this.cursorDy = Math.max(-1, Math.min(1, (this.cursor.y - this.pos.y) / 260));

    // 用户拖拽中：不漫游、不避鼠标
    if (now < this.suspendUntil) {
      this.vx = 0;
      this.bob = 0;
      return;
    }

    let velX = 0;
    let velY = 0;

    // 逗猫棒模式：鼠标快速移动 → 扑；静止 → 停看，偶尔偷摸靠近
    if (this.tracking) {
      if (now > this.trackAt) {
        this.trackAt = now + 250;
        // 估算鼠标移动速度（光标轮询 120ms，这里用上一段位移）
        const cdx = this.cursor.x - this.lastCursor.x;
        const cdy = this.cursor.y - this.lastCursor.y;
        const cSpeed = Math.hypot(cdx, cdy) * (1000 / Math.max(60, now - this.trackAt + 190));
        const d2 = Math.hypot(this.pos.x - this.cursor.x, this.pos.y - this.cursor.y);
        if (cSpeed > 30 && d2 > 90) {
          // 逗！扑向鼠标当前位置
          this.target = { x: this.cursor.x, y: this.cursor.y };
          this.dwellUntil = now + 500;
        } else if (d2 < 90) {
          // 已经贴很近：停住看
          this.target = null;
          this.dwellUntil = now + 400;
          void invoke("clear_pet_target").catch(() => {});
        } else if (d2 > 260 && this.rng() < 0.2) {
          // 离得远且鼠标不动：偶尔偷摸靠近一点
          this.target = { x: this.cursor.x, y: this.cursor.y };
          this.dwellUntil = now + 800;
        }
      }
      this.lastCursor = { ...this.cursor };
    } else {
      // 鼠标靠太近 → 逃跑
      const dx = this.pos.x - this.cursor.x;
      const dy = this.pos.y - this.cursor.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 165 && dist > 1) {
        this.fleeUntil = now + 900 + this.rng() * 600;
        this.target = null;
        this.dwellUntil = now + 400;
      }
    }

    // 鼠标与窗口距离（供逃跑/追踪共用）
    const mdx = this.pos.x - this.cursor.x;
    const mdy = this.pos.y - this.cursor.y;
    const mdist = Math.hypot(mdx, mdy) || 1;

    if (now < this.fleeUntil) {
      // 逃跑方向：背离鼠标
      const inv = 1 / mdist;
      const speed = FLEE_SPEED + this.rng() * 30;
      velX = mdx * inv * speed;
      velY = mdy * inv * speed;
    } else {
      if (!this.area || now - this.areaAt > 2500) {
        await this.refreshArea();
        this.areaAt = now;
      }
      if (!this.target || now >= this.dwellUntil) {
        // 低活动：休息结束后仍有概率继续歇着（越低的频率越爱歇）
        const restP = 1 - 1 / this.activityFactor;
        if (this.rng() < restP) {
          this.dwellUntil = now + (8000 + this.rng() * 22000) * this.activityFactor;
          this.target = null;
        } else {
          this.pickTarget(true);
        }
      }
      if (this.target) {
        const tx = this.target.x - this.pos.x;
        const ty = this.target.y - this.pos.y;
        const td = Math.hypot(tx, ty);
        if (td < 14) {
          this.target = null;
          // 到达后小憩（随活动因子变长）；偶尔长休息
          const base = REST_BASE + this.rng() * 2000;
          const longRest = this.rng() < REST_LONG_CHANCE ? REST_LONG + this.rng() * 6000 : 0;
          this.dwellUntil = now + (base + longRest) * this.activityFactor;
          velX = 0;
          velY = 0;
          void invoke("clear_pet_target").catch(() => {});
        } else {
          const speed = this.tracking ? 180 : BASE_SPEED;
          velX = (tx / td) * speed;
          velY = (ty / td) * speed;
        }
      }
    }

    this.pos.x += velX * dt;
    this.pos.y += velY * dt;

    // 保存速度供碰撞检测用
    this.vel = { x: velX, y: velY };

    // 边界碰撞反弹
    this.bounceCollide();

    this.vx = Math.max(-1, Math.min(1, velX / 160));
    this.bob =
      Math.abs(this.vx) > 0.02 && now >= this.dwellUntil
        ? Math.min(1, Math.hypot(velX, velY) / 160)
        : 0;

    // 上报目标点（10Hz，Rust mover 线程负责平滑移动）
    if (now - this.lastTarget >= TARGET_INTERVAL && this.target) {
      this.lastTarget = now;
      void this.pushTarget();
    }
  }

  /** 边界碰撞反弹：撞到侧边或任务栏边缘时反向并减速 */
  private bounceCollide() {
    if (!this.area) return;
    const a = this.area;
    const left = a.left + EDGE_PAD;
    const right = a.left + a.width - WIN - EDGE_PAD;
    const top = a.top + EDGE_PAD;
    const bottom = a.top + a.height - WIN - EDGE_PAD;

    let bounced = false;

    if (this.pos.x <= left) {
      this.pos.x = left;
      this.vel.x = Math.abs(this.vel.x) * BOUNCE_DAMP;
      bounced = true;
      this.bounceDir = "left";
    } else if (this.pos.x >= right) {
      this.pos.x = right;
      this.vel.x = -Math.abs(this.vel.x) * BOUNCE_DAMP;
      bounced = true;
      this.bounceDir = "right";
    }

    if (this.pos.y <= top) {
      this.pos.y = top;
      this.vel.y = Math.abs(this.vel.y) * BOUNCE_DAMP;
      bounced = true;
      this.bounceDir = "top";
    } else if (this.pos.y >= bottom) {
      this.pos.y = bottom;
      this.vel.y = -Math.abs(this.vel.y) * BOUNCE_DAMP;
      bounced = true;
      this.bounceDir = "bottom";
    }

    if (bounced) {
      // 撞墙后清除当前目标，稍后重新选方向
      this.target = null;
      this.dwellUntil = performance.now() + 2000 + this.rng() * 3000;
      // 立即清除 Rust mover 目标，防止 mover 继续把窗口推过边界
      void invoke("clear_pet_target").catch(() => {});
    }
  }
}