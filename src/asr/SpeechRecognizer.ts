/**
 * 语音识别（ASR）统一封装。
 *
 * 后端一：浏览器原生 SpeechRecognition（Windows 的 WebView2）
 *   - continuous=true，边说边出字到输入框（onPartial）
 *   - 用"多久没新结果"判断静音，停顿 2.5 秒自动收尾发送
 *   - 一旦报 network / not-allowed 这类"用不了"的错误，本次会话内永久降级到后端二
 *     （WebView2 的原生识别依赖在线服务，国内经常直接 network）
 *
 * 后端二：录音 + Rust 侧转发在线识别（Mac / Linux，以及原生不可用时的 Windows）
 *   - MediaRecorder 录 webm + AnalyserNode 做 VAD，静音 2.5 秒自动停
 *   - 音频发给 Rust 命令 asr_transcribe，密钥留在 Rust（DPAPI / Keychain / 600 文件），
 *     前端拿不到 Key，也不需要知道 endpoint —— 详见 src-tauri/src/lib.rs
 *
 * 语义约定（很重要，曾经混在一起出过 bug）：
 *   stop()   停止录音并**提交**识别结果（说完自动发送走的就是它）
 *   cancel() 停止录音并**丢弃**结果（用户点错了、不想发了走的就是它）
 */

import { invoke } from "@tauri-apps/api/core";
import {
  decideListenStop,
  isFatalWebSpeechError,
  isReportableWebSpeechError,
  isTooShort,
  pickBackend,
  pickFinalText,
  rmsFromTimeDomain,
  type AsrBackend,
  type ListenState,
  type ListenTiming,
} from "./asrLogic";

// ---------- 配置 ----------
/** 说完停顿多久算"说完了"，自动收尾发送 */
const SILENCE_MS = 2500;
/** 还没拿到任何结果时允许多等多久 —— 实测引擎连服务到第一个 result 要 6 秒 */
const FIRST_RESULT_MS = 6000;
/** 一直没听到声音时等多久就给用户一句交代（而不是一直挂着麦克风） */
const NO_SPEECH_GIVEUP_MS = 8000;
/** 单次监听硬上限：引擎死活不出结果也不能让麦克风一直开着 */
const MAX_LISTEN_MS = 60000;
/** 录音后端 VAD：音量 RMS 低于此值算静音 */
const SILENCE_THRESHOLD = 0.015;
/** 最短录音时长，太短丢弃 */
const MIN_RECORD_MS = 500;

const LISTEN_TIMING: ListenTiming = {
  silenceMs: SILENCE_MS,
  firstResultMs: FIRST_RESULT_MS,
  giveUpMs: NO_SPEECH_GIVEUP_MS,
  maxMs: MAX_LISTEN_MS,
};

// ---------- 浏览器原生 SpeechRecognition 类型 ----------
interface SpeechRecognitionResultItem { transcript: string; confidence: number; }
interface SpeechRecognitionResult {
  isFinal: boolean; length: number;
  item(index: number): SpeechRecognitionResultItem;
  [index: number]: SpeechRecognitionResultItem;
}
interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
  /** 下面几个"有没有声音/人在不在说"的信号用来决定何时收尾（可能不存在） */
  onaudiostart?: (() => void) | null;
  onsoundstart?: (() => void) | null;
  onsoundend?: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
}
type RecognitionCtor = new () => SpeechRecognitionLike;
function getSpeechRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition as RecognitionCtor) ||
         (w.webkitSpeechRecognition as RecognitionCtor) ||
         null;
}

// ---------- 对外事件 ----------
export interface RecognizerHandlers {
  /** 流式中间结果（实时显示在输入框） */
  onPartial?: (text: string) => void;
  /** 最终识别结果（整句，交给调用方决定发不发） */
  onFinal?: (text: string) => void;
  /** 录音开始（提示"正在听…"） */
  onRecordingStart?: () => void;
  /**
   * 听了半天什么都没识别到（没声音、或引擎没给结果）。
   * 必须给用户一句交代 —— 以前这种情况是完全静默的，用户看到的就是"点了没反应"。
   */
  onNoSpeech?: () => void;
  onError?: (message: string) => void;
  onStateChange?: (recording: boolean) => void;
}

export class SpeechRecognizer {
  private handlers: RecognizerHandlers = {};
  private backend: AsrBackend;
  /** 原生识别被判过死刑（network / not-allowed…），本次运行不再尝试 */
  private webSpeechBroken = false;

  // web-speech 后端
  private recognition: SpeechRecognitionLike | null = null;
  /** 已定稿的文本（isFinal 片段累加） */
  private webFinalText = "";
  /** 全量文本（final + interim），收尾时优先用它，避免吞掉未定稿的尾句 */
  private webFullText = "";
  private autoStopTimer: number | null = null;
  /** 这次监听的"活不活动"状态，交给 asrLogic.decideListenStop 判定何时收尾 */
  private listen: ListenState = {
    startedAt: 0,
    lastActivityAt: 0,
    speaking: false,
    heardSound: false,
    gotResult: false,
  };

  // 录音后端
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadTimer: number | null = null;
  private silenceSince = 0;
  /** 录音是否处于活动状态：VAD 循环靠它判断，不能查 mediaRecorder 的状态
   *  （getUserMedia 是异步的，刚起步那几帧 mediaRecorder 还没赋值） */
  private active = false;
  /** getUserMedia 还没返回 —— 防双击开出两路录音（第一路会漏掉麦克风） */
  private starting = false;
  /** 每次 start 递增，用来识别"这一路请求已经被取消/被后来者取代" */
  private startToken = 0;
  /** 本次录音是否要丢弃结果（cancel 语义） */
  private discard = false;
  /** 是否正在"我们自己主动收尾"：用来区分 onend 是收尾回调还是引擎自己断了 */
  private finishing = false;

  constructor(handlers: RecognizerHandlers = {}) {
    this.handlers = handlers;
    this.backend = pickBackend(getSpeechRecognitionCtor() !== null, this.webSpeechBroken);
  }

  setHandlers(handlers: RecognizerHandlers): void { this.handlers = handlers; }
  getBackendName(): AsrBackend { return this.backend; }

  /**
   * 这个后端需不需要用户先配 Key。
   * Windows 的原生识别不需要；在线识别（Mac/Linux、以及降级后的 Windows）需要。
   */
  needsApiKey(): boolean { return this.backend === "siliconflow"; }

  /** "正在听"（含正在要麦克风权限的那一下）：按钮用它决定显示 🎤 还是 🔴 */
  isRecording(): boolean {
    return this.active || this.starting;
  }

  start(): void {
    if (this.isRecording() || this.starting) return;
    if (this.backend === "web-speech") this.startWebSpeech();
    else void this.startSiliconFlow();
  }

  /** 停止并提交（停顿自动收尾走这里；按钮上的"再点一下"是 cancel，不是它） */
  stop(): void {
    if (!this.isRecording()) return;
    if (this.backend === "web-speech") this.finishWebSpeech(true);
    else this.finishSiliconFlow(false);
  }

  /** 停止并丢弃（关掉小助手、用户反悔时用） */
  cancel(): void {
    if (!this.isRecording()) return;
    // 递增 token：就算 getUserMedia 正在路上，它回来时也会发现"这一路已作废"，
    // 自己把刚拿到的音轨关掉，不会留下一个没人管、还在录的麦克风
    this.startToken++;
    if (this.backend === "web-speech") this.finishWebSpeech(false);
    else this.finishSiliconFlow(true);
  }

  // =============== 后端 1：Web Speech（Windows） ===============
  private startWebSpeech(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.degradeToSiliconFlow("WebView 不支持浏览器语音识别", false);
      return;
    }
    const rec = new Ctor();
    // 固定用中文识别：用户说的是中文，outputLanguage 是 AI 回复语言，两者别混
    rec.lang = "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.webFinalText = "";
    this.webFullText = "";
    const now = Date.now();
    this.listen = {
      startedAt: now,
      lastActivityAt: now,
      speaking: false,
      heardSound: false,
      gotResult: false,
    };
    this.discard = false;
    this.finishing = false;

    const markActivity = () => { this.listen.lastActivityAt = Date.now(); };
    // 引擎的"声音/说话"事件是决定何时收尾的关键：识别结果要几秒才回来，
    // 但"人还在说"这件事引擎是立刻知道的（详见 asrLogic.decideListenStop）
    rec.onsoundstart = () => { this.listen.heardSound = true; markActivity(); };
    rec.onspeechstart = () => { this.listen.speaking = true; this.listen.heardSound = true; markActivity(); };
    rec.onspeechend = () => { this.listen.speaking = false; markActivity(); };
    rec.onsoundend = () => { this.listen.speaking = false; markActivity(); };

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) this.webFinalText += t;
        else interim += t;
      }
      this.listen.gotResult = true;
      markActivity();
      this.webFullText = (this.webFinalText + interim).replace(/\s+/g, " ").trim();
      if (this.webFullText) this.handlers.onPartial?.(this.webFullText);
    };
    rec.onerror = (e) => {
      const err = e.error || "unknown";
      if (isFatalWebSpeechError(err)) {
        // 这台机器上原生识别根本用不了：别再让用户对着红点干等
        this.degradeToSiliconFlow(`浏览器语音识别不可用（${err}）`, true);
        return;
      }
      if (isReportableWebSpeechError(err)) this.handlers.onError?.(`语音识别错误：${err}`);
    };
    rec.onend = () => {
      // 只认当前这一路：旧会话迟到的 onend 不能去动新会话的状态
      // （否则会把刚开始的新一轮录音当成"引擎自己结束了"给收掉）
      if (this.recognition !== rec) return;
      this.recognition = null;
      this.clearAutoStop();
      const wasActive = this.active;
      this.active = false;
      this.handlers.onStateChange?.(false);
      if (!wasActive || this.finishing) return;
      // 引擎自己结束了（连续识别有静默上限、或服务端把连接断了），不是我们调的 stop()。
      // 手里已经识别出来的字不能就这么扔掉 —— 用户看着输入框里有字，结果一条都没发出去。
      const text = pickFinalText(this.webFinalText, this.webFullText);
      this.webFinalText = "";
      this.webFullText = "";
      if (text) this.handlers.onFinal?.(text);
    };

    try {
      rec.start();
      this.recognition = rec;
      this.active = true;
      this.handlers.onStateChange?.(true);
      // 轮询收尾判定：说话期间绝不收；有声音但还没结果时多等几秒；
      // 一直没听到声音就 8 秒给个交代（以前这里 2.5 秒就掐，用户还在说）
      this.autoStopTimer = window.setInterval(() => {
        if (this.recognition !== rec) return;
        if (decideListenStop(this.listen, Date.now(), LISTEN_TIMING) === "stop") this.stop();
      }, 200);
    } catch (e) {
      this.handlers.onError?.(`无法启动录音：${e instanceof Error ? e.message : String(e)}`);
      this.active = false;
      this.handlers.onStateChange?.(false);
    }
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer) { clearInterval(this.autoStopTimer); this.autoStopTimer = null; }
  }

  private finishWebSpeech(submit: boolean): void {
    const text = pickFinalText(this.webFinalText, this.webFullText);
    const rec = this.recognition;
    // 先立旗标再 stop()：onend 是同步/异步都可能来的，旗标晚一步就会重复发一次
    this.finishing = true;
    this.webFinalText = "";
    this.webFullText = "";
    this.clearAutoStop();
    this.active = false;
    try { rec?.stop(); } catch { /* ignore */ }
    this.handlers.onStateChange?.(false);
    if (!submit) return;
    // 收尾时手里一个字都没有 → 必须说一句，别静默（用户看到的就是"点了没反应"）
    if (text) this.handlers.onFinal?.(text);
    else this.handlers.onNoSpeech?.();
  }

  /**
   * 原生识别不可用 → 本次运行内永久改用在线识别。
   *
   * 不在这里自动重开录音：调用方（按钮）需要先确认在线识别配了 Key，
   * 否则一开就报"未配置 Key"，用户看到的是两个连续的错误提示。
   */
  private degradeToSiliconFlow(reason: string, reportToUser: boolean): void {
    this.webSpeechBroken = true;
    this.backend = pickBackend(getSpeechRecognitionCtor() !== null, this.webSpeechBroken);
    const rec = this.recognition;
    this.recognition = null;
    this.finishing = true; // abort 也会触发 onend，别让它再走"引擎自己断了"的分支
    this.clearAutoStop();
    this.active = false;
    try { rec?.abort(); } catch { /* ignore */ }
    this.handlers.onStateChange?.(false);
    if (reportToUser) {
      this.handlers.onError?.(`${reason}：已切换为在线识别，请再点一次麦克风`);
    } else {
      this.handlers.onError?.(`${reason}：需要配置语音识别 Key（右键 →「🎤 语音识别设置」）`);
    }
  }

  // =============== 后端 2：录音 + Rust 转发在线识别 ===============
  private async startSiliconFlow(): Promise<void> {
    if (this.isRecording()) return;
    const token = ++this.startToken;
    this.starting = true;
    this.discard = false;
    // 立刻亮起"正在听"：getUserMedia 可能要等权限弹窗，等它回来再亮就太晚了
    this.handlers.onStateChange?.(true);
    this.handlers.onRecordingStart?.();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000 },
      });
      if (token !== this.startToken) {
        // 这一路已经被 cancel 掉了：把刚拿到的音轨还回去，别让麦克风空转
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      this.chunks = [];
      this.startedAt = Date.now();
      this.silenceSince = 0;
      // VAD 用同一套"活不活动"状态：没听到人声前不按静音收尾
      this.listen = {
        startedAt: this.startedAt,
        lastActivityAt: this.startedAt,
        speaking: false,
        heardSound: false,
        gotResult: false,
      };

      rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: mime });
        this.chunks = [];
        const elapsed = Date.now() - this.startedAt;
        const discard = this.discard;
        this.discard = false;
        this.cleanupAudio();
        this.handlers.onStateChange?.(false);
        if (discard) return;
        // 太短/太小：多半是误触，直接忽略，不花识别费
        if (isTooShort(elapsed, blob.size, MIN_RECORD_MS)) return;
        void this.transcribe(blob);
      };
      rec.start();
      this.mediaRecorder = rec;
      this.active = true;
      this.startVad(stream);
    } catch (e) {
      if (token !== this.startToken) return; // 已取消，别再报错打扰用户
      // 起不来（没权限 / 没设备 / MediaRecorder 不支持）要把已经拿到的东西还回去，
      // 否则麦克风一直亮着、AudioContext 也一直占着
      this.cleanupAudio();
      this.handlers.onStateChange?.(false);
      this.handlers.onError?.(
        `麦克风启动失败：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (token === this.startToken) this.starting = false;
    }
  }

  private startVad(stream: MediaStream): void {
    try {
      const Ctx = window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctx();
      const source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      const buf = new Uint8Array(this.analyser.fftSize);
      const tick = () => {
        // 认 this.active 而不是 mediaRecorder.state：VAD 是在 recorder 就绪前后
        // 开始跑的，早期几帧查 recorder 只会得到"没在录"，循环当场就退出了
        if (!this.analyser || !this.active) return;
        this.analyser.getByteTimeDomainData(buf);
        const rms = rmsFromTimeDomain(buf);
        const now = Date.now();
        if (rms >= SILENCE_THRESHOLD) {
          // 听到人声：记一笔，并从这一刻重新算静音
          this.silenceSince = 0;
          this.listen.heardSound = true;
          this.listen.lastActivityAt = now;
        } else if (!this.listen.heardSound) {
          // 一直没听到人声：给足时间（用户可能正在组织语言），到点收尾并提示，
          // 别像以前那样点一下 2.5 秒就悄悄停掉（那条路上用户同样什么都看不到）
          if (now - this.listen.startedAt >= NO_SPEECH_GIVEUP_MS) { this.stop(); return; }
        } else {
          if (this.silenceSince === 0) this.silenceSince = now;
          else if (now - this.silenceSince >= SILENCE_MS) { this.stop(); return; }
        }
        if (now - this.listen.startedAt >= MAX_LISTEN_MS) { this.stop(); return; }
        this.vadTimer = window.setTimeout(tick, 100);
      };
      tick();
    } catch { /* VAD 失败就算了，用户还能手动点停 */ }
  }

  private finishSiliconFlow(discard: boolean): void {
    this.startToken++; // 作废可能还在路上的 getUserMedia
    this.starting = false;
    this.discard = discard;
    if (!this.active) {
      // 还没真正开始录（权限弹窗还开着就被取消）：没有任何数据可发
      this.cleanupAudio();
      this.handlers.onStateChange?.(false);
      return;
    }
    this.active = false;
    this.stopVad();
    try { this.mediaRecorder?.stop(); } catch { this.cleanupAudio(); }
    // onstop 是唯一收口：它负责 cleanupAudio + onStateChange(false) + 决定发不发
  }

  private stopVad(): void {
    if (this.vadTimer) { clearTimeout(this.vadTimer); this.vadTimer = null; }
  }

  private cleanupAudio(): void {
    this.stopVad();
    this.analyser = null;
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      // close() 返回的 Promise 在旧 WebView 上可能不存在，包一层免得抛
      try { void Promise.resolve(ctx.close()).catch(() => {}); } catch { /* ignore */ }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.mediaRecorder = null;
  }

  /** 把录音交给 Rust 侧转写（密钥不进前端） */
  private async transcribe(blob: Blob): Promise<void> {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const CHUNK = 0x8000; // 一次 apply 太多参数会爆栈，分块拼
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const audio = btoa(binary);
      const text = await invoke<string>("asr_transcribe", { audio });
      const trimmed = (text || "").trim();
      if (trimmed) this.handlers.onFinal?.(trimmed);
      else this.handlers.onNoSpeech?.(); // 服务返回空 = 没听清，不是错误
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.handlers.onError?.(msg.startsWith("未配置") ? msg : `语音识别失败：${msg}`);
    }
  }
}

let singleton: SpeechRecognizer | null = null;
export function getSpeechRecognizer(handlers?: RecognizerHandlers): SpeechRecognizer {
  if (!singleton) singleton = new SpeechRecognizer(handlers || {});
  else if (handlers) singleton.setHandlers(handlers);
  return singleton;
}
