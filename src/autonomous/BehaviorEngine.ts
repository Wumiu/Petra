import { invoke } from "@tauri-apps/api/core";
import { clamp } from "../utils/math";

interface XY {
  x: number;
  y: number;
}

const WIN = 300;
const EDGE_PAD = 4; // 离屏幕边缘留 4px 间隙
const POLL_CURSOR_MS = 60;
const TARGET_INTERVAL = 100;

// 运动参数（逗猫棒追速等）
const CHASE_SPEED = 160;   // 逗猫棒追鼠标速度 px/s
const FLEE_SPEED = 140;    // 逃跑速度 px/s
const BOUNCE_DAMP = 0.55;  // 撞墙后速度衰减

const EXPOSE_TOP = 150;    // 顶部待机露出 px（旋转后多露一点，到眼睛）
const EXPOSE_BOTTOM = 95;  // 底部待机露出 px（少露一点，从肩头缩回）

// 活动频率三档显著区分（休息时长/长歇概率/移动半径/闲逛速度）
interface ActivityParams {
  restBase: number; // 到达后休息 base ms
  restChance: number; // 休息后再歇概率 / 长歇概率
  radiusDiv: number; // 目标半径除数（越小半径越大）
  speed: number; // 闲逛速度 px/s
}
const ACTIVITY_LEVELS: Record<"low" | "mid" | "high", ActivityParams> = {
  low: { restBase: 600000, restChance: 0.95, radiusDiv: 8, speed: 12 }, // 几乎不动：10~20 分钟才可能挪一下
  mid: { restBase: 8000, restChance: 0.3, radiusDiv: 3.5, speed: 55 },
  high: { restBase: 1500, restChance: 0.05, radiusDiv: 2, speed: 120 },
};

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
  // 光标相对真实窗口中心的偏移（逻辑坐标，Rust 侧基于 GetWindowRect 计算，免疫引擎 pos 漂移）
  private cursorRel: XY = { x: 0, y: 0 };
  private target: XY | null = null;
  private area: { left: number; top: number; width: number; height: number } | null = null;
  private dwellUntil = 0;
  private fleeUntil = 0;
  private suspendUntil = 0;
  private lastTarget = 0;
  private actParams: ActivityParams = ACTIVITY_LEVELS.mid;
  private activityLevel: "low" | "mid" | "high" = "mid";
  private tracking = false;
  private cursorSpeed = 0; // 鼠标移动速度 px/s（按 120ms 轮询间隔真实计算）
  private vel: XY = { x: 0, y: 0 }; // 上一帧速度（供碰撞反弹用）
  // 逗猫棒（追鼠标）
  private excitement = 0; // 0~1 兴奋度（鼠标越快越兴奋，渲染表现用）
  private trackAt = 0;
  private lastCursor: XY = { x: 0, y: 0 };
  private fleeSpeed = FLEE_SPEED;
  private lastPushSpeed = ACTIVITY_LEVELS.mid.speed;
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
      await this.pollArea();
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
  cursorVx = 0; // 鼠标横向速度（逻辑 px/s，拖拽摆动用）

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
    await this.pollArea();
    this.pickTarget(true);
    this.dwellUntil = 0;
    await this.pushTarget();
  }

  /** 活动频率（菜单切换）：三档显著区分，查表 */
  setActivityLevel(level: "low" | "mid" | "high") {
    this.activityLevel = level;
    this.actParams = ACTIVITY_LEVELS[level] ?? this.actParams;
    if (level === "low") {
      // 低频率：停止一切移动（含逗猫棒与 Rust mover 残留目标），保证原地静止
      this.target = null;
      this.fleeUntil = 0;
      this.trackAt = 0;
      this.excitement = 0;
      this.clearTarget();
    }
  }

  /** 逗猫棒开关（开启后追着鼠标跑） */
  setTracking(on: boolean) {
    this.tracking = on;
    this.target = null;
    this.fleeUntil = 0;
    if (on) {
      this.dwellUntil = 0;
      this.excitement = 0;
      this.cursorSpeed = 0;
    } else {
      this.dwellUntil = performance.now() + 2000;
    }
  }

  /** 暂停自主漫游（用户拖动时）；再次调用以新时长覆盖 */
  suspend(ms: number) {
    this.suspendUntil = performance.now() + ms;
    this.clearTarget();
    this.target = null;
  }

  /** 清除 Rust mover 目标，停止移动 */
  private clearTarget() {
    void invoke("clear_pet_target").catch(() => {});
  }


  /** 外部直接设置位置（拖动跟随） */
  setPos(x: number, y: number) {
    this.pos = { x, y };
    this.target = null;
  }

  /** 光标轮询（独立定时器调用，避免渲染热路径 await IPC） */
  async pollCursor() {
    try {
      const c = await invoke<{ x: number; y: number; rx: number; ry: number }>("cursor_pos");
      const prev = this.cursor;
      // Rust 返回物理像素 → 转逻辑
      this.cursor = { x: c.x / this.scaleFactor, y: c.y / this.scaleFactor };
      this.cursorRel = { x: c.rx / this.scaleFactor, y: c.ry / this.scaleFactor };
      // 鼠标移动速度：按真实轮询间隔计算（逻辑 px/s）
      const moved = Math.hypot(this.cursor.x - prev.x, this.cursor.y - prev.y);
      this.cursorSpeed = moved / (POLL_CURSOR_MS / 1000);
      this.cursorVx = (this.cursor.x - prev.x) / (POLL_CURSOR_MS / 1000);
    } catch {
      /* 忽略 */
    }
  }

  /** 工作区轮询（独立定时器调用） */
  async pollArea() {
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
    // 半径随活动档位变化：低档小范围溜达，高档接近全屏
    const radius = Math.min(maxX - minX, maxY - minY) / Math.max(3, this.actParams.radiusDiv) + 60;
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

  update(now: number, dt: number) {
    // 光标/工作区由 pollCursor()/pollArea() 独立定时器更新，热路径不做 IPC

    // 视线跟随：基准是真实窗口中心（Rust 侧计算），而不是引擎本地积分 pos，
    // 否则漫游漂移（逻辑速度 vs 物理速度单位不一致）会累积成“以屏幕中心为基准”的方向错误。
    // 死区 + 平滑：靠近中心不剧烈转头，lerp 避免 120ms 轮询跳变。
    const relDist = Math.hypot(this.cursorRel.x, this.cursorRel.y);
    const dead = Math.max(0, Math.min(1, (relDist - 20) / 40)); // 20~60px 过渡带
    const tdx = clamp((this.cursorRel.x / 260) * dead, -1, 1);
    const tdy = clamp((this.cursorRel.y / 260) * dead, -1, 1);
    const k = 1 - Math.exp(-dt * 8); // 约 125ms 时间常数，平滑追赶
    this.cursorDx += (tdx - this.cursorDx) * k;
    this.cursorDy += (tdy - this.cursorDy) * k;

    // 待机：完全静止（不漫游/不躲避/不追踪），保留视线跟随
    if (this.idle) {
      this.vx = 0;
      this.bob = 0;
      return;
    }

    // low 档：很安静地在原地（不漫游、不躲避鼠标），仅保留呼吸/眨眼/表情/视线
    if (this.activityLevel === "low") {
      this.vx = 0;
      this.bob = 0;
      this.target = null;
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

    // 逗猫棒模式：追着鼠标跑（简化为直接跟随，去掉复杂状态机）
    if (this.tracking) {
      if (now > this.trackAt) {
        this.trackAt = now + 250;
        const dist = Math.hypot(this.pos.x - this.cursor.x, this.pos.y - this.cursor.y);
        if (dist > 60) {
          // 离得远 → 朝鼠标当前位置追
          this.target = { x: this.cursor.x, y: this.cursor.y };
          this.dwellUntil = now + 400;
        } else {
          // 够近 → 停住看
          this.target = null;
          this.dwellUntil = now + 300;
          this.clearTarget();
        }
        // 兴奋度简化为鼠标速度轻量映射（渲染表现用）
        this.excitement = clamp(this.excitement + Math.min(1, this.cursorSpeed / 400) * 0.1 - 0.015, 0, 1);
      }
      this.lastCursor = { ...this.cursor };
    } else {
      // 鼠标靠太近 → 逃跑（用相对窗口中心的偏移判定，免疫 pos 漂移）
      const dist = relDist;
      if (dist < 165 && dist > 1) {
        this.fleeUntil = now + 900 + this.rng() * 600;
        this.target = null;
        this.dwellUntil = now + 400;
      }
    }

    // 鼠标与窗口距离（供逃跑/追踪共用）：直接用相对窗口中心偏移
    const mdx = -this.cursorRel.x; // 从窗口中心指向鼠标的反方向（背离鼠标）
    const mdy = -this.cursorRel.y;
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
      if (!this.area) {
        // 工作区尚未就绪：用默认（pollArea 定时器很快会更新）
        this.area = { left: 0, top: 0, width: 1920, height: 1080 };
      }
      if (!this.target || now >= this.dwellUntil) {
        // 休息结束后按档位概率继续歇（低档爱歇，高档几乎不歇）
        if (this.rng() < this.actParams.restChance) {
          this.dwellUntil = now + this.actParams.restBase + this.rng() * this.actParams.restBase;
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
          // 到达后按档位休息（低档几十秒，高档几秒）
          this.dwellUntil = now + this.actParams.restBase + this.rng() * this.actParams.restBase;
          velX = 0;
          velY = 0;
          this.clearTarget();
        } else {
          // 逗猫棒：追鼠标速度；非追踪按档位闲逛速度（本地积分与 mover 同一速度）
          const speed = this.tracking ? CHASE_SPEED : this.actParams.speed;
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
    } else if (this.pos.x >= right) {
      this.pos.x = right;
      this.vel.x = -Math.abs(this.vel.x) * BOUNCE_DAMP;
      bounced = true;
    }

    if (this.pos.y <= top) {
      this.pos.y = top;
      this.vel.y = Math.abs(this.vel.y) * BOUNCE_DAMP;
      bounced = true;
    } else if (this.pos.y >= bottom) {
      this.pos.y = bottom;
      this.vel.y = -Math.abs(this.vel.y) * BOUNCE_DAMP;
      bounced = true;
    }

    if (bounced) {
      // 撞墙后清除当前目标，稍后重新选方向
      this.target = null;
      this.dwellUntil = performance.now() + 2000 + this.rng() * 3000;
      // 立即清除 Rust mover 目标，防止 mover 继续把窗口推过边界
      this.clearTarget();
    }
  }
}