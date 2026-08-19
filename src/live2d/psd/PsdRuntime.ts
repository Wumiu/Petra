// Anime2.5DRig 运行时抽离（MIT）
// 来源: https://github.com/852wa/Anime2.5DRig (index.html 内嵌渲染核心)
// 保留: GL 网格渲染 / 顶点变形 / 发丝弹簧物理 / 闭眼闭口渐变 / 虹膜模板裁剪
// 剥离: UI 面板 / 摄像头 / 麦克风 / README / 背景切换

import { readPsd } from "ag-psd";
import { clamp } from "../../utils/math";

// vendor 的 rigger/genericparts 是 UMD 格式（无 ESM export），
// 通过 index.html 的 <script> 标签在应用代码前加载（副作用 import 会被 Vite 生产构建 tree-shake 掉）。
// Anime2.5DRig UMD 格式，通过 index.html 的 <script> 标签在应用代码前加载。
// 加载后自动挂到 window.Rigger / window.GenericParts。
// 注意：不能在模块顶层直接获取（Vite dev 模块加载时序问题），
// 必须在 load() 调用时延迟获取，确保 <script> 已执行。

interface RiggerApi {
  buildRig(psd: any, opts?: any): any;
  baseName(n: string): string;
  cleanPsdLayers(psd: any): { noisy: number; layers: number };
}
interface GenericPartsApi {
  get(k: "eyeL" | "eyeR" | "mouth"): { width: number; height: number; data: Uint8ClampedArray } | null;
}

function getRigger(): RiggerApi {
  const r = (window as unknown as { Rigger: RiggerApi }).Rigger;
  if (!r) throw new Error("Rigger 未加载，请检查 index.html 是否正确引入 vendor/anime2dr/rigger.js");
  return r;
}
function getGenericParts(): GenericPartsApi {
  const g = (window as unknown as { GenericParts: GenericPartsApi }).GenericParts;
  if (!g) throw new Error("GenericParts 未加载，请检查 index.html 是否正确引入 vendor/anime2dr/genericparts.js");
  return g;
}

export interface RigParams {
  angleX: number;
  angleY: number;
  angleZ: number;
  eyeOpenL: number;
  eyeOpenR: number;
  eyeX: number;
  eyeY: number;
  brow: number;
  browAngL: number;
  browAngR: number;
  browAngSym: number;
  mouthOpen: number;
  mouthForm: number;
  mouthCY: number;
  mouthCAng: number;
  mouthScale: number;
  eyeCY: number;
  eyeCAng: number;
  eyeScaleL: number;
  eyeScaleR: number;
  body: number;
  bodySwing: number;
  armY: number;
  armPos: number;
  bust: number;
  bustY: number;
  bangL: number;
  bangC: number;
  bangR: number;
  physAmp: number;
  soft: number;
  fhAmp: number;
  fhSoft: number;
  irisScale: number;
  eyeEase: number;
  mouthEase: number;
}

const DEFAULTS: RigParams = {
  angleX: 0, angleY: 0, angleZ: 0, eyeOpenL: 1, eyeOpenR: 1, eyeX: 0, eyeY: 0,
  brow: 0, browAngL: 0, browAngR: 0, browAngSym: 0, mouthOpen: 0, mouthForm: 0,
  mouthCY: 0, mouthCAng: 0, mouthScale: 1, eyeCY: 0, eyeCAng: 0,
  eyeScaleL: 1, eyeScaleR: 1, body: 0, bodySwing: 0, armY: 0, armPos: 0, bust: 2.5, bustY: 1,
  bangL: 0, bangC: 0, bangR: 0, physAmp: 2, soft: 2, fhAmp: 2, fhSoft: 0.4,
  irisScale: 1, eyeEase: 0.3, mouthEase: 0.45,
};

interface Layer {
  name: string;
  bn: string;
  x: number; y: number; w: number; h: number;
  z: number;
  depth: number;
  group: "head" | "body";
  phys: string | null;
  fade: string | null;
  side: string | null;
  strands: { x: number; tipY: number; rootY: number }[] | null;
  base: Float32Array;
  cur: Float32Array;
  nIdx: number;
  sw?: Float32Array;
  su?: Float32Array;
  bw?: Float32Array;
  spr?: { stiff: { x: number; v: number; dx: number }; soft: { x: number; v: number; dx: number }; phase: number }[];
  vboPos: WebGLBuffer;
  vboUV: WebGLBuffer;
  ibo: WebGLBuffer;
  tex: WebGLTexture;
}

function sh(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
  return s;
}

function smooth(t: number) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

export class PsdRuntime {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private layers: Layer[] = [];
  private A: any = null;
  private CW = 768;
  private CH = 768;
  private charBounds: { left: number; top: number; right: number; bottom: number } | null = null;
  private FS = 1;
  private NP: any = null;
  private BP: any = null;
  private FC: any = null;
  private CHEST: any = null;
  private bounce = { x: 0, v: 0, dy: 0 };
  private cur: RigParams;
  private tgt: RigParams;
  private t = 0;
  private blinkT = -1;
  private nextBlink = 0;
  private rnd = { ax: 0, ay: 0, az: 0, bd: 0, ex: 0, ey: 0 };
  private rndTarget = { ax: 0, ay: 0, az: 0, bd: 0, ex: 0, ey: 0 };
  private nextRnd = 0;
  private autoIdle = true;
  private autoBlink = true;
  private autoRand = true;
  private locPos: number;
  private locUV: number;
  private locRes: WebGLUniformLocation | null;
  private locCut: WebGLUniformLocation | null;
  private locAl: WebGLUniformLocation | null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", {
      alpha: true, stencil: true, antialias: true, premultipliedAlpha: true,
    }) as WebGLRenderingContext | null;
    if (!this.gl) throw new Error("WebGL 不可用");

    const gl = this.gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl, gl.VERTEX_SHADER,
      "attribute vec2 aPos; attribute vec2 aUV; uniform vec2 uRes; varying vec2 vUV;" +
      "void main(){ vUV=aUV; vec2 c = aPos/uRes*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0); }"));
    gl.attachShader(prog, sh(gl, gl.FRAGMENT_SHADER,
      "precision mediump float; varying vec2 vUV; uniform sampler2D uTex; uniform float uCut; uniform float uAlpha;" +
      "void main(){ vec4 c=texture2D(uTex,vUV); if(c.a<uCut) discard; gl_FragColor=c*uAlpha; }"));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.locPos = gl.getAttribLocation(prog, "aPos");
    this.locUV = gl.getAttribLocation(prog, "aUV");
    this.locRes = gl.getUniformLocation(prog, "uRes");
    this.locCut = gl.getUniformLocation(prog, "uCut");
    this.locAl = gl.getUniformLocation(prog, "uAlpha");
    gl.enableVertexAttribArray(this.locPos);
    gl.enableVertexAttribArray(this.locUV);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    this.cur = { ...DEFAULTS };
    this.tgt = { ...DEFAULTS };
  }

  get warnings(): string[] {
    return this._warnings;
  }
  /** 角色包围盒（画布坐标，模型边缘补偿用） */
  get characterBounds(): { left: number; top: number; right: number; bottom: number } | null {
    return this.charBounds;
  }
  /** 画布宽（PSD 尺寸） */
  get canvasWidth(): number {
    return this.CW;
  }
  private _warnings: string[] = [];
  partsCount = 0;
  strandCount = 0;

  /** 解析 PSD 字节并构建 rig，返回 warnings */
  async load(u8: Uint8Array): Promise<string[]> {
    const gl = this.gl!;
    for (const L of this.layers) {
      gl.deleteTexture(L.tex);
      gl.deleteBuffer(L.vboPos);
      gl.deleteBuffer(L.vboUV);
      gl.deleteBuffer(L.ibo);
    }
    this.layers = [];

    const psd = readPsd(u8, { useImageData: true, skipThumbnail: true }) as any;
    const Rigger = getRigger();
    const GenericParts = getGenericParts();
    Rigger.cleanPsdLayers(psd);
    const g = {
      eyeL: GenericParts.get("eyeL"),
      eyeR: GenericParts.get("eyeR"),
      mouth: GenericParts.get("mouth"),
    };
    const rig = Rigger.buildRig(psd, { generic: g });
    this._warnings = rig.warnings ?? [];

    this.CW = rig.canvas.w;
    this.CH = rig.canvas.h;
    if (Math.abs(this.CW - this.CH) / Math.max(this.CW, this.CH) > 0.05) {
      this._warnings.push(`画布 ${this.CW}x${this.CH} 非正方形，动画可能变形（建议正方形 768~2048）`);
    }
    // 角色包围盒：所有图层 x/y/w/h 并集（画布坐标），供模型边缘补偿判断"模型而非窗口"出屏量
    {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const Lr of rig.layers) {
        if (Lr.x < minX) minX = Lr.x;
        if (Lr.y < minY) minY = Lr.y;
        if (Lr.x + Lr.w > maxX) maxX = Lr.x + Lr.w;
        if (Lr.y + Lr.h > maxY) maxY = Lr.y + Lr.h;
      }
      this.charBounds = { left: minX, top: minY, right: maxX, bottom: maxY };
    }
    this.A = rig.anchors;
    this.FS = this.A.faceScale;
    this.NP = this.A.neckPivot;
    this.BP = this.A.bodyPivot;
    this.FC = { x: this.A.face.cx, y: this.A.face.cy };
    this.CHEST = {
      cx: this.NP.cx,
      cy: this.A.neckBottom + (this.A.face.y1 - this.A.face.y0) * 0.6,
      rx: (this.A.face.x1 - this.A.face.x0) * 0.6,
      ry: (this.A.face.y1 - this.A.face.y0) * 0.45,
    };

    for (const Lr of rig.layers) {
      const L: Layer = { ...Lr, bn: Rigger.baseName(Lr.name.replace(/_(l|r)$/, "")) };
      const cell = (L.phys ? 30 : 42) * Math.max(0.6, this.CW / 768);
      const nx = Math.max(2, Math.round(L.w / cell));
      const ny = Math.max(2, Math.round(L.h / cell));
      const nv = (nx + 1) * (ny + 1);
      const base = new Float32Array(nv * 2);
      const uv = new Float32Array(nv * 2);
      let k = 0;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        base[k] = L.x + L.w * i / nx; base[k + 1] = L.y + L.h * j / ny;
        uv[k] = i / nx; uv[k + 1] = j / ny; k += 2;
      }
      const idx: number[] = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
      L.base = base;
      L.cur = new Float32Array(base);
      L.nIdx = idx.length;

      if (L.strands && L.strands.length) {
        const S = L.strands, nS = S.length;
        let spacing = 120;
        if (nS > 1) {
          const ds: number[] = [];
          for (let s = 1; s < nS; s++) ds.push(S[s].x - S[s - 1].x);
          ds.sort((a, b) => a - b);
          spacing = ds[ds.length >> 1];
        }
        const sig = spacing * 0.6;
        L.sw = new Float32Array(nv * nS);
        L.su = new Float32Array(nv);
        L.spr = S.map((s: any, i: number) => ({
          stiff: { x: 0, v: 0, dx: 0 }, soft: { x: 0, v: 0, dx: 0 },
          phase: i * 1.37 + L.z,
        }));
        for (let v = 0; v < nv; v++) {
          const x = base[v * 2], y = base[v * 2 + 1];
          let tot = 0;
          for (let s = 0; s < nS; s++) {
            const w = Math.exp(-Math.pow((x - S[s].x) / sig, 2));
            L.sw[v * nS + s] = w; tot += w;
          }
          let rY = 0, tY = 0;
          if (tot > 1e-6) {
            for (let s = 0; s < nS; s++) {
              L.sw[v * nS + s] /= tot;
              rY += L.sw[v * nS + s] * S[s].rootY;
              tY += L.sw[v * nS + s] * S[s].tipY;
            }
          } else {
            L.sw[v * nS + 0] = 1; rY = S[0].rootY; tY = S[0].tipY;
          }
          L.su[v] = Math.min(1, Math.max(0, (y - rY) / Math.max(1, tY - rY)));
        }
        if (L.bn === "front hair") {
          const fw = this.A.face.x1 - this.A.face.x0, fcx = this.A.face.cx;
          const f = 36, b1 = fcx - fw * 0.22, b2 = fcx + fw * 0.22;
          L.bw = new Float32Array(nv * 3);
          for (let v = 0; v < nv; v++) {
            const x = base[v * 2];
            const s1 = smooth((x - b1) / f + 0.5), s2 = smooth((x - b2) / f + 0.5);
            L.bw[v * 3] = 1 - s1;
            L.bw[v * 3 + 1] = s1 * (1 - s2);
            L.bw[v * 3 + 2] = s2;
          }
        }
      }

      L.vboPos = gl.createBuffer()!;
      L.vboUV = gl.createBuffer()!;
      L.ibo = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, L.vboUV);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
      const idata = new ImageData(new Uint8ClampedArray(Lr.img.data), Lr.img.width, Lr.img.height);
      L.tex = this.mkTex(idata);
      this.layers.push(L);
    }

    this.canvas.width = this.CW;
    this.canvas.height = this.CH;
    this.partsCount = this.layers.length;
    this.strandCount = this.layers.reduce((s, L) => s + (L.strands ? L.strands.length : 0), 0);
    this.cur = { ...DEFAULTS };
    this.tgt = { ...DEFAULTS };
    return this._warnings;
  }

  private mkTex(imgData: ImageData): WebGLTexture {
    const gl = this.gl!;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  set autoIdleOn(v: boolean) { this.autoIdle = v; }
  set autoBlinkOn(v: boolean) { this.autoBlink = v; }
  set autoRandOn(v: boolean) { this.autoRand = v; }

  /** 每帧调用。overrides 为外部驱动（音乐/鼠标/点击）目标值 */
  update(dt: number, overrides?: Partial<RigParams>) {
    const gl = this.gl!;
    if (!this.layers.length || !this.A) return;
    const now = performance.now() / 1000;
    const t = now;
    this.t = t;
    dt = Math.min(0.05, dt);

    if (overrides) {
      for (const k in overrides) {
        const v = (overrides as any)[k];
        if (v !== undefined) (this.tgt as any)[k] = v;
      }
    }

    // ---- 自动待机（轻微晃头） ----
    if (this.autoIdle) {
      this.tgt.angleX += 0.13 * Math.sin(t * 0.42) + 0.05 * Math.sin(t * 1.13);
      this.tgt.angleY += 0.08 * Math.sin(t * 0.31 + 1.7);
      this.tgt.angleZ += 0.07 * Math.sin(t * 0.23 + 0.5);
      this.tgt.body += 0.1 * Math.sin(t * 0.19 + 2.1);
    }
    // ---- 随机小动作（平滑漂移，避免突变弹跳） ----
    if (this.autoRand) {
      if (now * 1000 > this.nextRnd) {
        this.nextRnd = now * 1000 + 1400 + Math.random() * 2600;
        this.rndTarget.ax = (Math.random() * 2 - 1) * 0.4;
        this.rndTarget.ay = (Math.random() * 2 - 1) * 0.22;
        this.rndTarget.az = (Math.random() * 2 - 1) * 0.12;
        this.rndTarget.bd = (Math.random() * 2 - 1) * 0.1;
        this.rndTarget.ex = (Math.random() * 2 - 1) * 0.6;
        this.rndTarget.ey = (Math.random() * 2 - 1) * 0.35;
      }
      const k = Math.min(1, dt * 1.0);
      this.rnd.ax += (this.rndTarget.ax - this.rnd.ax) * k;
      this.rnd.ay += (this.rndTarget.ay - this.rnd.ay) * k;
      this.rnd.az += (this.rndTarget.az - this.rnd.az) * k;
      this.rnd.bd += (this.rndTarget.bd - this.rnd.bd) * k;
      this.rnd.ex += (this.rndTarget.ex - this.rnd.ex) * k;
      this.rnd.ey += (this.rndTarget.ey - this.rnd.ey) * k;
      this.tgt.angleX = clamp(this.tgt.angleX + this.rnd.ax, -1, 1);
      this.tgt.angleY = clamp(this.tgt.angleY + this.rnd.ay, -1, 1);
      this.tgt.angleZ = clamp(this.tgt.angleZ + this.rnd.az, -1, 1);
      this.tgt.body = clamp(this.tgt.body + this.rnd.bd, -1, 1);
      this.tgt.eyeX = clamp(this.tgt.eyeX + this.rnd.ex, -1, 1);
      this.tgt.eyeY = clamp(this.tgt.eyeY + this.rnd.ey, -1, 1);
    }
    // ---- 自动眨眼 ----
    if (this.autoBlink) {
      const ms = now * 1000;
      if (this.blinkT < 0 && ms > this.nextBlink) {
        this.blinkT = 0;
        this.nextBlink = ms + 1600 + Math.random() * 3800;
        if (Math.random() < 0.18) this.nextBlink = ms + 280;
      }
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const d = this.blinkT;
        let v: number;
        if (d < 0.08) v = 1 - d / 0.08;
        else if (d < 0.42) v = 0;
        else if (d < 0.58) v = (d - 0.42) / 0.16;
        else { v = 1; this.blinkT = -1; }
        this.tgt.eyeOpenL = Math.min(this.tgt.eyeOpenL, v);
        this.tgt.eyeOpenR = Math.min(this.tgt.eyeOpenR, v);
      }
    }

    // ---- 参数平滑 ----
    for (const k in this.cur) {
      (this.cur as any)[k] += ((this.tgt as any)[k] - (this.cur as any)[k]) * Math.min(1, dt * 14);
    }
    const e: any = { ...this.cur };

    e.breath = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.4);
    e.breathHead = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.4 - 0.6);

    // ---- 发丝弹簧 ----
    const headDX = (e.angleX * 14 + e.angleZ * 0.07 * (this.NP.cy - this.FC.y)) * this.FS;
    for (const L of this.layers) {
      if (!L.spr) continue;
      for (const sp of L.spr) {
        const wind = this.autoIdle
          ? (1.8 * Math.sin(t * 0.8 + sp.phase) + 1.0 * Math.sin(t * 1.9 + sp.phase * 2.3))
          : 0;
        const txv = headDX + wind * this.FS;
        let kk = 70, cc = 9;
        let axv = -kk * (sp.stiff.x - txv) - cc * sp.stiff.v;
        sp.stiff.v += axv * dt;
        sp.stiff.x += sp.stiff.v * dt;
        sp.stiff.dx = -(sp.stiff.x - txv) * 2.2;
        kk = 16; cc = 1.3;
        axv = -kk * (sp.soft.x - txv) - cc * sp.soft.v;
        sp.soft.v += axv * dt;
        sp.soft.x += sp.soft.v * dt;
        sp.soft.dx = -(sp.soft.x - txv) * 3.0;
      }
    }
    // ---- 胸弹 ----
    const bustTgt = (e.breath * 3.0 - e.angleY * 6.0 + e.body * 4.0) * this.FS;
    const kk2 = 140, cc2 = 4.2;
    const aa = -kk2 * (this.bounce.x - bustTgt) - cc2 * this.bounce.v;
    this.bounce.v += aa * dt;
    this.bounce.x += this.bounce.v * dt;
    this.bounce.dy = -(this.bounce.x - bustTgt) * 3.0;

    // ---- 渲染 ----
    gl.viewport(0, 0, this.CW, this.CH);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.uniform2f(this.locRes, this.CW, this.CH);

    for (const L of this.layers) {
      const fa = this.fadeAlpha(L, e);
      if (fa < 0.004 && !(L.fade === "eyeOpen" && L.name.indexOf("eyewhite") === 0)) continue;
      this.deform(L, e);
      gl.uniform1f(this.locAl, fa);
      gl.bindBuffer(gl.ARRAY_BUFFER, L.vboPos);
      gl.bufferData(gl.ARRAY_BUFFER, L.cur, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, L.vboUV);
      gl.vertexAttribPointer(this.locUV, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, L.tex);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, L.ibo);
      if (L.name.indexOf("eyewhite") === 0) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.uniform1f(this.locCut, 0.25);
        gl.drawElements(gl.TRIANGLES, L.nIdx, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.STENCIL_TEST);
        gl.uniform1f(this.locCut, 0.0);
      } else if (L.name.indexOf("irides") === 0) {
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.EQUAL, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.drawElements(gl.TRIANGLES, L.nIdx, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.STENCIL_TEST);
      } else {
        gl.drawElements(gl.TRIANGLES, L.nIdx, gl.UNSIGNED_SHORT, 0);
      }
    }

    // ---- 动态更新角色包围盒（基于变形后的实际顶点，每帧更新） ----
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const L of this.layers) {
      if (this.fadeAlpha(L, e) < 0.01) continue; // 不可见层跳过
      const n = L.cur.length;
      for (let i = 0; i < n; i += 2) {
        const cx = L.cur[i], cy = L.cur[i + 1];
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
      }
    }
    if (minX < maxX) this.charBounds = { left: minX, top: minY, right: maxX, bottom: maxY };
  }

  private fadeAlpha(L: Layer, e: any): number {
    if (!L.fade) return 1;
    if (L.fade === "eyeOpen") {
      const v = L.side === "L" ? e.eyeOpenL : e.eyeOpenR;
      return smooth((v - (0.1 + e.eyeEase * 0.45)) / 0.15);
    }
    if (L.fade === "eyeClose") {
      const v = L.side === "L" ? e.eyeOpenL : e.eyeOpenR;
      return 1 - smooth((v - (0.1 + e.eyeEase * 0.45)) / 0.15);
    }
    if (L.fade === "mouthOpen") return smooth((e.mouthOpen - (0.05 + e.mouthEase * 0.35)) / 0.12);
    if (L.fade === "mouthClose") return 1 - smooth((e.mouthOpen - (0.05 + e.mouthEase * 0.35)) / 0.12);
    return 1;
  }

  private deform(L: Layer, e: any) {
    const b = L.base, o = L.cur, n = b.length;
    const A = this.A;
    const isHead = L.group === "head";
    const az = e.angleZ * 0.2, cz = Math.cos(az), sz = Math.sin(az);
    const ab = e.body * 0.085, cb = Math.cos(ab), sb = Math.sin(ab);
    const bn = L.bn;
    const eyeSide = L.side;
    const EA = eyeSide === "L" ? A.eyeL : eyeSide === "R" ? A.eyeR : null;
    const vOpen = eyeSide === "L" ? e.eyeOpenL : e.eyeOpenR;
    const mo = e.mouthOpen;
    const mHalfW = (A.mouth.x1 - A.mouth.x0) / 2;
    const nS = L.strands ? L.strands.length : 0;
    const bcx = L.x + L.w / 2, bcy = L.y + L.h / 2;
    const isFH = bn === "front hair";

    for (let k = 0; k < n; k += 2) {
      let x = b[k], y = b[k + 1];
      const vi = k >> 1;

      if (EA && bn === "eye_close") {
        const sE = eyeSide === "L" ? e.eyeScaleL : e.eyeScaleR;
        if (sE !== 1) {
          const cxE = (EA.x0 + EA.x1) / 2, cyE = (EA.y0 + EA.y1) / 2;
          x = cxE + (x - cxE) * sE; y = cyE + (y - cyE) * sE;
        }
      }
      if (bn === "mouth_open" || bn === "mouth_close") {
        const sM = e.mouthScale;
        if (sM !== 1) { x = A.mouth.cx + (x - A.mouth.cx) * sM; y = A.mouth.cy + (y - A.mouth.cy) * sM; }
      }
      if (L.fade === "eyeOpen" && EA) {
        if (bn === "irides") {
          const isc = e.irisScale;
          x = EA.icx + (x - EA.icx) * isc; y = EA.icy + (y - EA.icy) * isc;
          x += e.eyeX * 11 * this.FS; y += e.eyeY * 6 * this.FS;
          const tl = smooth((0.32 - vOpen) / 0.32);
          y = EA.closeY + (y - EA.closeY) * (1 - 0.8 * tl);
        } else {
          y = EA.closeY + (y - EA.closeY) * (1 - 0.85 * (1 - vOpen));
        }
      }
      if (L.fade === "eyeClose" && EA) {
        y -= vOpen * 3;
        y += e.eyeCY * 14 * this.FS;
        const thE = e.eyeCAng * 0.3 * (eyeSide === "L" ? 1 : -1);
        if (thE) {
          const ct = Math.cos(thE), st = Math.sin(thE), rx = x - bcx, ry = y - bcy;
          x = bcx + rx * ct - ry * st; y = bcy + rx * st + ry * ct;
        }
      }
      if (bn === "eyebrow") {
        y += (-e.brow * 9 + (1 - vOpen) * 3.5) * this.FS;
        const th = (eyeSide === "L" ? (e.browAngL + e.browAngSym) : (e.browAngR - e.browAngSym)) * 0.3;
        if (th) {
          const ct = Math.cos(th), st = Math.sin(th), rx = x - bcx, ry = y - bcy;
          x = bcx + rx * ct - ry * st; y = bcy + rx * st + ry * ct;
        }
      }
      if (L.fade === "mouthOpen") {
        y = A.mouth.y0 + (y - A.mouth.y0) * (0.5 + 0.5 * mo);
        const q = Math.pow(Math.abs(x - A.mouth.cx) / (mHalfW + 4), 1.5);
        y -= e.mouthForm * 6 * this.FS * (q - 0.35);
      }
      if (L.fade === "mouthClose") {
        y += e.mouthCY * 14 * this.FS;
        const thM = e.mouthCAng * 0.35;
        if (thM) {
          const ct = Math.cos(thM), st = Math.sin(thM), rx = x - A.mouth.cx, ry = y - A.mouth.cy;
          x = A.mouth.cx + rx * ct - ry * st; y = A.mouth.cy + rx * st + ry * ct;
        }
      }
      if (bn === "face" && y > A.mouth.cy) {
        y += mo * 6 * this.FS * smooth((y - A.mouth.cy) / (A.face.y1 - A.mouth.cy));
      }

      let hw = isHead ? 1 : (L.group === "body" ? 0.16 : 0);
      if (bn === "neck") hw = 0.55 * smooth((A.neckBottom - y) / Math.max(1, A.neckBottom - A.neckTop));
      if (hw > 0) {
        let rx = x - this.NP.cx, ry = y - this.NP.cy;
        const rx2 = rx * cz - ry * sz, ry2 = rx * sz + ry * cz;
        x += (rx2 - rx) * hw; y += (ry2 - ry) * hw;
        const dd = L.depth;
        x += hw * this.FS * (e.angleX * (18 + 40 * (dd - 1)) + e.angleX * (this.NP.cy - y) * 0.075);
        y += hw * this.FS * (-e.angleY * (16 + 30 * (dd - 1)) - e.angleY * (dd - 1) * (y - this.FC.y) * 0.05);
      }

      // 身体绕颈枢摆动（下半身摆，头部稳定）：绕颈枢旋转，越靠下摆越大
      if (L.group === "body" && L.bn !== "neck" && e.bodySwing !== 0) {
        const ang = e.bodySwing * 0.35;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const rx = x - this.NP.cx, ry = y - this.NP.cy;
        x = this.NP.cx + rx * ca - ry * sa;
        y = this.NP.cy + rx * sa + ry * ca;
      }

      y -= (L.group === "body" ? e.breath * 2.0 : e.breathHead * 1.6) * this.FS;
      if (bn === "topwear" && y < this.CHEST.cy) {
        y -= e.breath * 2.2 * this.FS * smooth((this.CHEST.cy - y) / (this.CHEST.ry * 2));
      }
      if (bn === "topwear") x = this.NP.cx + (x - this.NP.cx) * (1 + e.breath * 0.003);
      if (bn === "topwear") {
        const gx = (x - this.CHEST.cx) / this.CHEST.rx;
        const gy = (y - (this.CHEST.cy + e.bustY * 70 * this.FS)) / this.CHEST.ry;
        y += this.bounce.dy * e.bust * Math.exp(-gx * gx - gy * gy);
      }
      if (bn === "handwear") {
        const w = smooth((y - L.y) / L.h * 1.15);
        y -= e.armY * 85 * this.FS * w;
        y += e.armPos * 100 * this.FS;
        x += e.armY * 14 * this.FS * w * (x < this.NP.cx ? 1 : -1);
      }
      if (L.bw && L.su) {
        const m = Math.pow(L.su[vi], 1.4) * 22 * this.FS;
        x += (e.bangL * L.bw[vi * 3] + e.bangC * L.bw[vi * 3 + 1] + e.bangR * L.bw[vi * 3 + 2]) * m;
      }
      if (nS) {
        const u = isFH ? Math.min(1, L.su![vi] * 1.6) : L.su![vi];
        const amp = Math.pow(u, isFH ? 1.8 : 2.1) * (isFH ? e.fhAmp : e.physAmp);
        const softMix = Math.pow(u, 1.2) * (isFH ? e.fhSoft : e.soft);
        let dx = 0;
        for (let s = 0; s < nS; s++) {
          const w = L.sw![vi * nS + s];
          if (w < 0.001) continue;
          const sp = L.spr![s];
          dx += w * (sp.stiff.dx * (1 - softMix) + sp.soft.dx * softMix);
        }
        x += dx * amp;
        y += Math.abs(dx) * amp * 0.12;
      }
      o[k] = x; o[k + 1] = y;
    }
    if (Math.abs(ab) > 1e-4) {
      for (let k = 0; k < n; k += 2) {
        const rx = o[k] - this.BP.cx, ry = o[k + 1] - this.BP.cy;
        o[k] = this.BP.cx + rx * cb - ry * sb;
        o[k + 1] = this.BP.cy + rx * sb + ry * cb;
      }
    }
  }

  destroy() {
    const gl = this.gl;
    if (!gl) return;
    for (const L of this.layers) {
      gl.deleteTexture(L.tex);
      gl.deleteBuffer(L.vboPos);
      gl.deleteBuffer(L.vboUV);
      gl.deleteBuffer(L.ibo);
    }
    this.layers = [];
  }
}