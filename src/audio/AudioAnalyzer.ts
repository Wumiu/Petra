import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 音频分析：订阅 Rust WASAPI 回环捕获推来的 PCM，
 * 经 Web Audio AnalyserNode 做 FFT，输出低频/中频/高频能量与节拍脉冲。
 */
export class AudioAnalyzer {
  readonly ctx: AudioContext;
  private analyser: AnalyserNode;
  private ring: Float32Array;
  private writePos = 0;
  private freqByte: Uint8Array<ArrayBuffer>;
  private unlisten?: UnlistenFn;
  private lastBeat = 0;
  private bassAvg = 0;
  private pcmCount = 0;

  bass = 0;
  mid = 0;
  treble = 0;
  beat = 0;
  available = false;

  constructor() {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    this.analyser.connect(silent);
    silent.connect(this.ctx.destination);

    this.freqByte = new Uint8Array(this.analyser.frequencyBinCount);
    this.ring = new Float32Array(this.analyser.frequencyBinCount);
  }

  async start(): Promise<void> {
    console.log("[audio] start() 已调用，注册 audio:pcm 监听器...");
    this.unlisten = await listen<number[]>("audio:pcm", (e) => {
      this.available = true;
      const arr = e.payload;
      this.pcmCount++;
      if (this.pcmCount % 50 === 1) {
        const min = Math.min(...arr);
        const max = Math.max(...arr);
        console.log(`[audio] PCM #${this.pcmCount}: ${arr.length}采样, range=[${min.toFixed(4)}, ${max.toFixed(4)}], rms=${Math.sqrt(arr.reduce((s,v)=>s+v*v,0)/arr.length).toFixed(4)}`);
      }
      for (const v of arr) {
        this.ring[this.writePos] = v;
        this.writePos = (this.writePos + 1) % this.ring.length;
      }
    });
    console.log("[audio] 监听器注册完成");
  }

  stop() {
    this.unlisten?.();
    this.available = false;
  }

  /** 每帧调用：把最近一段音频喂给 AnalyserNode 并取频谱 */
  tick() {
    if (!this.available || !this.analyserReady()) return;

    const n = 1024;
    const start = (this.writePos - n + this.ring.length) % this.ring.length;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      data[i] = this.ring[(start + i) % this.ring.length];
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    src.start();
    src.onended = () => src.disconnect();

    this.analyser.getByteFrequencyData(this.freqByte);

    const binHz = this.ctx.sampleRate / 2 / this.freqByte.length;
    const bins = this.freqByte.length;
    let bassE = 0, midE = 0, trebleE = 0;
    let bassN = 0, midN = 0, trebleN = 0;

    for (let i = 2; i < bins; i++) {
      const hz = i * binHz;
      const v = this.freqByte[i] / 255;
      if (hz < 250) { bassE += v; bassN++; }
      else if (hz < 3000) { midE += v; midN++; }
      else if (hz < 12000) { trebleE += v; trebleN++; }
    }
    const bass = bassN ? bassE / bassN : 0;

    // 节拍：低频突增脉冲
    this.bassAvg = this.bassAvg * 0.92 + bass * 0.08;
    const spike = bass - this.bassAvg;
    if (spike > 0.14 && this.lastBeat <= 0) {
      this.lastBeat = 1;
    }
    this.lastBeat = Math.max(0, this.lastBeat - 0.06);

    const sn = (v: number) => v * v;
    this.bass = this.bass * 0.82 + sn(bass) * 0.18;
    this.mid = this.mid * 0.82 + sn(midN ? midE / midN : 0) * 0.18;
    this.treble = this.treble * 0.82 + sn(trebleN ? trebleE / trebleN : 0) * 0.18;
    this.beat = Math.max(this.lastBeat, this.beat * 0.9);

    // 调试输出（每秒约60次，取第30次输出避免刷屏）
    if (this.pcmCount > 0 && this.pcmCount % 30 === 0) {
      console.log(`[audio] 频谱 bass=${this.bass.toFixed(4)} mid=${this.mid.toFixed(4)} treble=${this.treble.toFixed(4)} beat=${this.beat.toFixed(4)}`);
    }
  }

  private analyserReady(): boolean {
    return this.ctx.state === "running" || this.ctx.state === "suspended";
  }
}