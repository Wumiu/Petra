import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const DEV = import.meta.env.DEV;

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
  private buf: AudioBuffer; // 复用，避免每帧重建
  private unlisten?: UnlistenFn;
  private lastBeat = 0;
  private bassAvg = 0;
  private pcmCount = 0;
  private beatTimes: number[] = [];
  private lastBpmAt = 0;

  bass = 0;
  mid = 0;
  treble = 0;
  beat = 0;
  bpm = 0;
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
    // 预分配一次 AudioBuffer，每帧只更新采样数据
    this.buf = this.ctx.createBuffer(1, 1024, this.ctx.sampleRate);
  }

  async start(): Promise<void> {
    if (DEV) console.log("[audio] start() 注册 audio:pcm 监听器...");
    this.unlisten = await listen<number[]>("audio:pcm", (e) => {
      this.available = true;
      const arr = e.payload;
      this.pcmCount++;
      if (DEV && this.pcmCount % 50 === 1) {
        const min = Math.min(...arr);
        const max = Math.max(...arr);
        const rms = Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length);
        console.log(`[audio] PCM #${this.pcmCount}: ${arr.length}采样, range=[${min.toFixed(4)}, ${max.toFixed(4)}], rms=${rms.toFixed(4)}`);
      }
      for (const v of arr) {
        this.ring[this.writePos] = v;
        this.writePos = (this.writePos + 1) % this.ring.length;
      }
    });
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
    const data = this.buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      data[i] = this.ring[(start + i) % this.ring.length];
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buf;
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
      // BPM：累计 beat 时间戳，取间隔中位数推算
      const nowMs = performance.now();
      this.beatTimes.push(nowMs);
      while (this.beatTimes.length > 1 && nowMs - this.beatTimes[0] > 4000) this.beatTimes.shift();
      if (this.beatTimes.length >= 3) {
        const iv: number[] = [];
        for (let i = 1; i < this.beatTimes.length; i++) iv.push(this.beatTimes[i] - this.beatTimes[i - 1]);
        const sorted = iv.slice().sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        if (med >= 250 && med <= 1500) {
          const inst = 60000 / med;
          this.bpm = this.bpm === 0 ? inst : this.bpm * 0.6 + inst * 0.4;
        }
      }
      this.lastBpmAt = nowMs;
    }
    this.lastBeat = Math.max(0, this.lastBeat - 0.06);

    const sn = (v: number) => v * v;
    this.bass = this.bass * 0.82 + sn(bass) * 0.18;
    this.mid = this.mid * 0.82 + sn(midN ? midE / midN : 0) * 0.18;
    this.treble = this.treble * 0.82 + sn(trebleN ? trebleE / trebleN : 0) * 0.18;
    this.beat = Math.max(this.lastBeat, this.beat * 0.9);

    // BPM 超时衰减（超过 3s 无 beat 视为无音乐）
    if (this.bpm > 0 && performance.now() - this.lastBpmAt > 3000) {
      this.bpm *= 0.95;
      if (this.bpm < 5) this.bpm = 0;
    }

    if (DEV && this.pcmCount > 0 && this.pcmCount % 30 === 0) {
      console.log(`[audio] 频谱 bass=${this.bass.toFixed(4)} mid=${this.mid.toFixed(4)} treble=${this.treble.toFixed(4)} beat=${this.beat.toFixed(4)}`);
    }
  }

  private analyserReady(): boolean {
    return this.ctx.state === "running" || this.ctx.state === "suspended";
  }
}
