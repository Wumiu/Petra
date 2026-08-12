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

const EXPOSE_TOP = 150;    // 顶部待机露出 px（旋转后多露一点，到眼睛）
const EXPOSE_BOTTOM = 95;  // 底部待机露出 px（少露一点，从肩头缩回）

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
  private cursorSpeed = 0; // 鼠标移动速度 px/s（按 120ms 轮询间隔真实计算）
  private lastCursorMoveAt = 0; // 鼠标最后移动时刻（静止判定用）
  private vel: XY = { x: 0, y: 0 }; // 上一帧速度（供碰撞反弹用）
  private bounceDir: "none" | "left" | "right" | "top" | "bottom" = "none";
  // 逗猫棒状态机
  private excitement = 0; // 0~1 兴奋度（鼠标越快越兴奋）
  private trackState: "idle" | "sneak" | "chase" | "pounce" | "circle" | "bored" = "idle";
  private pounceUntil = 0;
  private boredUntil = 0;
  private circleAngle = 0;
  private lastTrackTime = 0;
  private fleeSpeed = FLEE_SPEED;
  private lastPushSpeed = BASE_SPEED;
  // 待机模式（沉到屏幕边缘，只露头顶+眼睛，完全静止）
  private idle = false;
  private idleTop = false;
  private idlePos: XY = { x: 100, y: 100 };
  private scaleFactor = 1; // 物理↔逻辑（IPC 边界转换用）；引擎内部全逻辑坐标

  /** 是否待机 + 是否倒挂（顶部） */
  get isIdle(): boolean {
    return this.idle;
  }
  get isIdleTop(): boolean {
    return this.idleTop;
  }
  /** 待机定位目标（main 用 win.setPosition 移动，绕过 mover 的 clamp） */
  get idleTarget(): XY {
    return { ...this.idlePos };
  }

  /**
   * 待机模式开关：沉到就近屏幕边缘（窗口在上半→顶部倒挂，下半→底部），露出 200px。
   */
  async setIdle(on: boolean) {
    this.idle = on;
    if (on) {
      await this.refreshArea();
      // 就近边缘：以窗口中心判断（用户直觉：桌宠在屏幕哪半就往哪边沉）
      const a = this.area ?? { left: 0, top: 0, width: 1920, height: 1080 };
      const midY = a.top + a.height / 2;
      this.idleTop = this.pos.y + WIN / 2 < midY;
      void invoke("debug_mark", {
        msg: `idle:posY=${Math.round(this.pos.y)} mid=${Math.round(midY)} top=${this.idleTop}`,
      }).catch(() => {});
      const y = this.idleTop
        ? a.top - WIN + EXPOSE_TOP // 顶部：窗口顶出屏，露窗口底部（旋转后=头部），多露到眼睛
        : a.top + a.height - EXPOSE_BOTTOM; // 底部：露窗口顶部一小截（到眼睛，不露肩头）
      // 防御 clamp：确保窗口有部分留在屏内
      const yClamped = Math.max(a.top - WIN, Math.min(a.top + a.height, y));
      this.idlePos = { x: this.pos.x, y: yClamped };
      this.pos = { ...this.idlePos };
      this.target = null;
      this.fleeUntil = 0;
      this.suspendUntil = performance.now() + 3600_000; // 1 小时防漫游
      // 先清 mover 目标再定位，避免竞态把窗口拉回旧漫游点
      try {
        await invoke("clear_pet_target");
      } catch {
        /* 忽略 */
      }
    } else {
      this.idleTop = false; // 退出待机复位倒挂信号，避免残留倒立
      this.target = null;
      this.suspendUntil = performance.now() + 1500;
    }
  }

  vx = 0; // -1..1
  bob = 0; // 0..1
  cursorDx = 0; // -1..1
  cursorDy = 0;

  /** 逗猫棒兴奋度（0..1），供渲染层表现 */
  get excitementValue(): number {
    return this.excitement;
  }

  constructor(start: XY, private rng: () => number = Math.random) {
    this.pos = { ...start };
  }

  /** 设置缩放因子（物理↔逻辑转换；引擎内部全逻辑坐标） */
  setScale(f: number) {
    this.scaleFactor = Math.max(1, f);
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

  /** 逗猫棒开关（开启时进入猫咪行为状态机） */
  setTracking(on: boolean) {
    this.tracking = on;
    this.target = null;
    this.fleeUntil = 0;
    if (on) {
      this.dwellUntil = 0;
      // 重置状态机残留
      this.pounceUntil = 0;
      this.boredUntil = 0;
      this.excitement = 0;
      this.circleAngle = 0;
      this.lastTrackTime = 0;
      this.cursorSpeed = 0;
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
      // Rust 返回物理像素 → 转逻辑
      const r = await invoke<{ left: number; top: number; width: number; height: number }>(
        "work_area_at",
        { x: Math.round(this.pos.x * this.scaleFactor), y: Math.round(this.pos.y * this.scaleFactor) },
      );
      this.area = {
        left: r.left / this.scaleFactor,
        top: r.top / this.scaleFactor,
        width: r.width / this.scaleFactor,
        height: r.height / this.scaleFactor,
      };
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

  private async pushTarget(speed?: number) {
    if (!this.target) return;
    try {
      // 引擎内部逻辑坐标 → 发给 mover 前转物理
      const x = Math.round(this.target.x * this.scaleFactor);
      const y = Math.round(this.target.y * this.scaleFactor);
      if (speed !== undefined && speed > 0) {
        await invoke("set_pet_target_speed", { x, y, speed });
      } else {
        await invoke("set_pet_target", { x, y });
      }
    } catch {
      /* 忽略 */
    }
  }

  async update(now: number, dt: number) {
    // 定频拉光标（拖拽暂停期间不拉，避免触发躲避）
    if (now - this.lastCursorPoll > POLL_CURSOR_MS) {
      try {
        const c = await invoke<{ x: number; y: number }>("cursor_pos");
        const prev = this.cursor;
        // Rust 返回物理像素 → 转逻辑
        this.cursor = { x: c.x / this.scaleFactor, y: c.y / this.scaleFactor };
        // 鼠标移动速度：按真实轮询间隔计算（逻辑 px/s）
        const moved = Math.hypot(this.cursor.x - prev.x, this.cursor.y - prev.y);
        this.cursorSpeed = moved / (POLL_CURSOR_MS / 1000);
        if (moved > 4) this.lastCursorMoveAt = now;
      } catch {
        /* 忽略 */
      }
      this.lastCursorPoll = now;
    }

    // 相对窗口中心的鼠标偏移（供角色视线跟随）
    this.cursorDx = Math.max(-1, Math.min(1, (this.cursor.x - this.pos.x) / 260));
    this.cursorDy = Math.max(-1, Math.min(1, (this.cursor.y - this.pos.y) / 260));

    // 待机：完全静止（不漫游/不躲避/不追踪），保留视线跟随
    if (this.idle) {
      this.vx = 0;
      this.bob = 0;
      return;
    }

    // 用户拖拽中：不漫游、不避鼠标
    if (now < this.suspendUntil) {
      this.vx = 0;
      this.bob = 0;
      return;
    }

    let velX = 0;
    let velY = 0;

    // 逗猫棒模式：真实猫咪行为状态机
    if (this.tracking) {
      const dtTrack = Math.min(0.3, (now - (this.lastTrackTime || now)) / 1000);
      this.lastTrackTime = now;

      const cSpeed = this.cursorSpeed;
      const dist = Math.hypot(this.pos.x - this.cursor.x, this.pos.y - this.cursor.y);
      const mouseStill = now - this.lastCursorMoveAt > 5000; // 鼠标静止 5s+

      // 兴奋度：鼠标越快越兴奋，自然衰减（阈值按真实速度校准）
      const exciteGain = Math.min(1, cSpeed / 400) * 0.15;
      this.excitement = clamp(this.excitement + exciteGain - 0.02, 0, 1);

      // ---- 状态转换 ----
      if (now < this.pounceUntil) {
        // 扑击中：保持冲向目标
        this.trackState = "pounce";
      } else if (now < this.boredUntil) {
        // 无聊中：东张西望，不追
        this.trackState = "bored";
        if (this.rng() < 0.02) {
          this.target = { x: this.pos.x + (this.cursor.x - this.pos.x) * 0.3, y: this.pos.y + (this.cursor.y - this.pos.y) * 0.3 };
        }
      } else if (dist < 70 && this.excitement > 0.4 && now > this.pounceUntil + 800) {
        // 距离够近 + 兴奋 → 扑！（带提前量：扑向鼠标移动方向前方）
        this.trackState = "pounce";
        this.pounceUntil = now + 300;
        const pvx = this.cursor.x - this.lastCursor.x;
        const pvy = this.cursor.y - this.lastCursor.y;
        const plen = Math.hypot(pvx, pvy);
        const lead = plen > 4 ? 110 : 50;
        this.target = {
          x: this.cursor.x + (plen ? (pvx / plen) * lead : 0),
          y: this.cursor.y + (plen ? (pvy / plen) * lead : 0),
        };
        this.dwellUntil = now + 350;
      } else if (dist < 120 && dist > 40 && !mouseStill) {
        // 近距离且鼠标在动 → 绕圈（像猫咪围着逗猫棒转）
        this.trackState = "circle";
        this.circleAngle += dtTrack * 2.5;
        const r = 55 + Math.sin(now * 0.003) * 18;
        this.target = {
          x: this.cursor.x + Math.cos(this.circleAngle) * r,
          y: this.cursor.y + Math.sin(this.circleAngle) * r,
        };
      } else if (cSpeed > 60 || this.excitement > 0.5) {
        // 鼠标快速移动或高兴奋 → 追
        this.trackState = "chase";
        this.target = { x: this.cursor.x, y: this.cursor.y };
        this.dwellUntil = now + 300;
      } else if (mouseStill && this.excitement < 0.3 && this.rng() < 0.02) {
        // 鼠标静止太久 → 无聊，转移注意力片刻
        this.trackState = "bored";
        this.boredUntil = now + 2000 + this.rng() * 3000;
        this.target = null;
        this.excitement = Math.max(0, this.excitement - 0.25);
      } else {
        // 默认 → 偷偷靠近（始终保证有逼近点）
        this.trackState = "sneak";
        const angle = Math.atan2(this.cursor.y - this.pos.y, this.cursor.x - this.pos.x);
        const offsetAngle = angle + (this.rng() - 0.5) * 1.2;
        const approachDist = Math.max(50, dist * 0.4 + 40);
        this.target = {
          x: this.pos.x + Math.cos(offsetAngle) * approachDist,
          y: this.pos.y + Math.sin(offsetAngle) * approachDist,
        };
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
      // 逃跑方向：背离鼠标（同时设逃跑目标让 mover 原生移动）
      const inv = 1 / mdist;
      const speed = FLEE_SPEED + this.rng() * 30;
      velX = mdx * inv * speed;
      velY = mdy * inv * speed;
      const a = this.area;
      const fleeDist = 260;
      const tx = a ? clamp(this.pos.x + mdx * inv * fleeDist, a.left + EDGE_PAD, a.left + a.width - WIN - EDGE_PAD) : this.pos.x + mdx * inv * fleeDist;
      const ty = a ? clamp(this.pos.y + mdy * inv * fleeDist, a.top + EDGE_PAD, a.top + a.height - WIN - EDGE_PAD) : this.pos.y + mdy * inv * fleeDist;
      this.target = { x: tx, y: ty };
      this.fleeSpeed = speed;
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
          // 速度随逗猫棒状态变化（本地积分与 mover 用同一速度）
          const trackSpeed =
            this.trackState === "pounce" ? 380 + this.excitement * 200 :
            this.trackState === "chase"  ? 180 + this.excitement * 120 :
            this.trackState === "circle" ? 105 :
            this.trackState === "sneak"  ? 35 + this.excitement * 25 :
            20; // idle / bored
          const speed = this.tracking ? trackSpeed : BASE_SPEED;
          this.lastPushSpeed = speed;
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

    // 上报目标点（10Hz，Rust mover 线程按同一速度原生移动）
    if (now - this.lastTarget >= TARGET_INTERVAL && this.target) {
      this.lastTarget = now;
      const pushSpeed = now < this.fleeUntil ? this.fleeSpeed : this.lastPushSpeed;
      void this.pushTarget(pushSpeed);
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