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
  DEFAULT_LISTEN_TIMING,
  decideListenStop,
  isFatalWebSpeechError,
  isMicProblemError,
  isReportableWebSpeechError,
  isTooShort,
  pickBackend,
  pickFinalText,
  rmsFromTimeDomain,
  type AsrBackend,
  type ListenState,
  type ListenTiming,
} from "./asrLogic";
import { loadSettings } from "../utils/settings";

/** 用户在设置里要求「先走云端模型」吗（默认就是先走云端） */
function preferCloudAsr(): boolean {
  try {
    return loadSettings().asr?.cloudFirst !== false;
  } catch {
    return true;
  }
}

/** 把 ASR 每一步写进应用日志（用户报「说话没反应」时靠它定位到底卡在哪一步） */
function asrLog(msg: string): void {
  void invoke("debug_mark", { msg: `[asr] ${msg}` }).catch(() => {});
}

/**
 * 把两次增量识别的结果拼起来：切点处有 200ms 重叠，文本也会重叠几个字，
 * 这里找出「旧文本的后缀 == 新文本的前缀」的最长匹配并去掉，避免出现「你好你好好」。
 */
function mergePartial(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  const max = Math.min(prev.length, next.length, 12);
  for (let n = max; n > 0; n--) {
    if (prev.slice(-n) === next.slice(0, n)) return prev + next.slice(n);
  }
  // 没有任何重叠：直接拼（中文不需要空格）
  return prev + next;
}

// ---------- 配置 ----------
/**
 * 收尾时长统一放在 asrLogic 的 DEFAULT_LISTEN_TIMING 里（默认：说完停 **5 秒** 收尾，
 * 跟 Windows 语音输入一个手感）。放那边是为了能被单测锁住，
 * 也避免"网页原生识别"和"录音 VAD"两条路各写一套数。
 */
const LISTEN_TIMING: ListenTiming = DEFAULT_LISTEN_TIMING;
/**
 * 云端录音（非流式）专用的收尾参数：
 * 说到停顿 1.6 秒就收（默认 5 秒是给"边说边出字"的原生识别留的手感，
 * 云端这边等 5 秒只会让用户以为没反应）；一个字没听到 6 秒放弃。
 */
const CLOUD_LISTEN_TIMING: ListenTiming = {
  ...DEFAULT_LISTEN_TIMING,
  silenceMs: 1600,
  giveUpMs: 6000,
};
/**
 * 录音后端 VAD：音量 RMS 低于此值算静音。
 * 原来是 0.015，实测普通笔记本麦克风说话时 RMS 常常只有 0.01 上下（尤其是离得远、
 * 系统增益低的时候），会被整段判成"一直没听到人声"，最后收尾只得到一句
 * 「没听到内容」——用户看到的就是"说话没反应"。降到 0.006 后正常说话能触发。
 */
const SILENCE_THRESHOLD = 0.006;
/** 最短录音时长，太短丢弃 */
const MIN_RECORD_MS = 500;

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
  /** 录音结束、正在上传识别（提示"识别中…"，否则这几秒看起来像卡住） */
  onTranscribing?: () => void;
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
  /** 边录边认：持续累积的 PCM（单声道，采样率 = audioCtx.sampleRate） */
  private pcmAll: Float32Array[] = [];
  private pcmRate = 48000;
  /** 已经送去识别到第几个采样（增量识别用） */
  private pcmSent = 0;
  private pcmTimer: number | null = null;
  /** 边说边出的文字（增量拼出来的，收尾时会用整段重认覆盖） */
  private partialText = "";
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
    this.backend = pickBackend(getSpeechRecognitionCtor() !== null, this.webSpeechBroken, preferCloudAsr());
  }

  setHandlers(handlers: RecognizerHandlers): void { this.handlers = handlers; }
  private refreshBackend(): void {
    // Never switch the backend of an active recording; apply preferences next time.
    if (!this.isRecording()) {
      this.backend = pickBackend(getSpeechRecognitionCtor() !== null, this.webSpeechBroken, preferCloudAsr());
    }
  }
  getBackendName(): AsrBackend { this.refreshBackend(); return this.backend; }

  /**
   * 这个后端需不需要用户先配 Key。
   * Windows 的原生识别不需要；在线识别（Mac/Linux、以及降级后的 Windows）需要。
   */
  needsApiKey(): boolean { return this.getBackendName() === "siliconflow"; }

  /** "正在听"（含正在要麦克风权限的那一下）：按钮用它决定显示 🎤 还是 🔴 */
  isRecording(): boolean {
    return this.active || this.starting;
  }

  start(): void {
    if (this.isRecording() || this.starting) return;
    this.refreshBackend();
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
    // 无条件作废当前 token：VAD 已经自动收尾（isRecording() 为 false）时，
    // 识别请求可能还在路上，早退会让它回来照样 onFinal → 关掉面板后还莫名其妙发出一条消息。
    this.startToken++;
    if (!this.isRecording()) return;
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
      // 收尾之后引擎还会补一两个迟到的结果（停麦的那一瞬），别再写回输入框 ——
      // 否则用户刚发出去，输入框里又冒出半句没头没尾的话
      if (this.finishing || this.recognition !== rec) return;
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
      if (isMicProblemError(err)) {
        // 麦克风权限/设备问题：换后端也一样拿不到麦克风，别再降级，直接告诉用户去哪开
        this.handlers.onError?.(
          err === "audio-capture"
            ? "找不到麦克风设备：确认设备插好并在系统里启用"
            : "麦克风权限被拒：右键 →「🎤 语音识别设置」→ 麦克风权限，点「开启麦克风」",
        );
        this.finishWebSpeech(false); // 丢弃这一轮，不再继续等
        return;
      }
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
    this.backend = pickBackend(getSpeechRecognitionCtor() !== null, this.webSpeechBroken, preferCloudAsr());
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

      asrLog(`录音开始 mime=${mime}`);
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
        asrLog(`录音结束 elapsed=${elapsed}ms bytes=${blob.size}`);
        // 太短/太小：多半是误触——但也可能是麦克风没真的收到声音，别静默吞掉
        if (isTooShort(elapsed, blob.size, MIN_RECORD_MS)) {
          this.handlers.onNoSpeech?.();
          return;
        }
        // 带上本次会话的 token：识别请求在途的 1~3 秒里用户关掉面板/开了小游戏/重新按麦克风，
        // cancel() 会让 token 失配，回来时就把这条结果丢掉（以前会把它直接发出去）
        this.handlers.onTranscribing?.();
        // ⚠️ 必须用**当前** token，不能用 startSiliconFlow 里那个：
        // finishSiliconFlow() 收尾时已经 startToken++ 作废了旧值，用旧 token 会让
        // transcribe() 一进门就判定"已取消"、把结果整个丢掉 —— 表现就是"说话完全没反应"。
        // 用当前值仍满足原意：请求在途时用户再取消/重开录音，token 会再次变化。
        void this.transcribe(blob, this.startToken);
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
      // NotAllowedError / NotFoundError 都是"麦克风这一层"的问题，直接指到权限开关去
      const name = e instanceof DOMException ? e.name : "";
      asrLog(`录音启动失败 name=${name} msg=${e instanceof Error ? e.message : String(e)}`);
      this.handlers.onError?.(
        name === "NotAllowedError" || name === "SecurityError"
          ? "麦克风权限被拒：右键 →「🎤 语音识别设置」→ 麦克风权限，点「开启麦克风」"
          : name === "NotFoundError"
            ? "找不到麦克风设备：确认设备插好并在系统里启用"
            : `麦克风启动失败：${e instanceof Error ? e.message : String(e)}`,
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
      this.pcmRate = this.audioCtx.sampleRate;
      this.pcmAll = [];
      this.pcmSent = 0;
      this.partialText = "";
      const source = this.audioCtx.createMediaStreamSource(stream);
      // 边录边出字：用 ScriptProcessor 拿到原始 PCM，定时把「新增的那一段」送去识别。
      // 不是媒体录音（webm）——webm 中途拿不到可解码的完整文件，只有 PCM 能随时切片。
      if (this.backend === "siliconflow") {
        try {
          const proc = this.audioCtx.createScriptProcessor(4096, 1, 1);
          proc.onaudioprocess = (ev) => {
            if (!this.active) return;
            this.pcmAll.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
          };
          source.connect(proc);
          // 必须连到 destination 才会触发回调，但直接连会把自己的声音放出来（啸叫）。
          // 中间垫一个 0 增益，既满足"有下游"又不发声。
          const mute = this.audioCtx.createGain();
          mute.gain.value = 0;
          proc.connect(mute);
          mute.connect(this.audioCtx.destination);
          this.pcmTimer = window.setInterval(() => void this.transcribeDelta(), 900);
        } catch (e) {
          asrLog(`PCM 采集不可用，退回整段识别：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      const buf = new Uint8Array(this.analyser.fftSize);
      const timing = this.backend === "siliconflow" ? CLOUD_LISTEN_TIMING : LISTEN_TIMING;
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
          if (now - this.listen.startedAt >= timing.giveUpMs) { this.stop(); return; }
        } else {
          if (this.silenceSince === 0) this.silenceSince = now;
          else if (now - this.silenceSince >= timing.silenceMs) { this.stop(); return; }
        }
        if (now - this.listen.startedAt >= timing.maxMs) { this.stop(); return; }
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

  /** 把累积 PCM 转成 16k 单声道 WAV（增量与整段共用） */
  private pcmToWav(chunks: Float32Array[], rate: number): Uint8Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    const target = 16000;
    const ratio = rate / target;
    const outLen = Math.max(1, Math.floor(pcm.length / ratio));
    const wav = new Uint8Array(44 + outLen * 2);
    const dv = new DataView(wav.buffer);
    const ws = (off: number, str: string) => { for (let i = 0; i < str.length; i++) wav[off + i] = str.charCodeAt(i); };
    ws(0, "RIFF"); dv.setUint32(4, 36 + outLen * 2, true); ws(8, "WAVE");
    ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, target, true); dv.setUint32(28, target * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ws(36, "data"); dv.setUint32(40, outLen * 2, true);
    for (let i = 0; i < outLen; i++) {
      const v = Math.max(-1, Math.min(1, pcm[Math.floor(i * ratio)]));
      dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return wav;
  }

  /** 把「自上次之后新录到的那一小段」送去识别，追加到输入框（带 200ms 重叠防吞字） */
  private async transcribeDelta(): Promise<void> {
    if (!this.active || this.pcmTimer === null) return;
    let now = 0;
    for (const c of this.pcmAll) now += c.length;
    const overlap = Math.floor(this.pcmRate * 0.2);
    const from = Math.max(0, this.pcmSent - overlap);
    if (now - from < this.pcmRate * 0.5) return; // 新音频不到半秒，先攒着
    // 切出 [from, now) 这一段
    const slice: Float32Array[] = [];
    let pos = 0;
    let remainStart = from;
    let remainLen = now - from;
    for (const c of this.pcmAll) {
      const cEnd = pos + c.length;
      if (cEnd > remainStart && remainLen > 0) {
        const s = Math.max(0, remainStart - pos);
        const take = Math.min(c.length - s, remainLen);
        slice.push(c.subarray(s, s + take));
        remainLen -= take;
        remainStart = 0;
      }
      pos = cEnd;
      if (remainLen <= 0) break;
    }
    this.pcmSent = now;
    try {
      const wav = this.pcmToWav(slice, this.pcmRate);
      let bin = "";
      for (let i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode(...wav.subarray(i, i + 0x8000));
      const text = (await invoke<string>("asr_transcribe", { audio: btoa(bin) })).trim();
      if (!this.active || !text) return;
      this.partialText = mergePartial(this.partialText, text);
      this.handlers.onPartial?.(this.partialText);
    } catch {
      /* 增量失败不打扰用户，收尾还有整段识别兜底 */
    }
  }

  private stopPcm(): void {
    if (this.pcmTimer !== null) { clearInterval(this.pcmTimer); this.pcmTimer = null; }
    this.pcmAll = [];
    this.pcmSent = 0;
  }

  private stopVad(): void {
    this.stopPcm();
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
  /**
   * 录音是 webm/opus，但硅基流动的识别接口对 webm 基本不认（实测：两个模型都返回
   * 200 + 空文本，而同一段音频转成 wav 就能识别出来）。所以上传前先解码成 PCM，
   * 重采样到 16k 单声道再封成 wav —— Rust 侧按 RIFF 头会自动用 audio.wav 的
   * filename/mime，不用改接口。
   */
  private async toWav(blob: Blob): Promise<Uint8Array | null> {
    try {
      const Ctx = window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const rate = 16000;
      const Offline = window.OfflineAudioContext ||
        (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      const off = new Offline(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      await ctx.close();
      const pcm = rendered.getChannelData(0);
      const wav = new Uint8Array(44 + pcm.length * 2);
      const dv = new DataView(wav.buffer);
      const ws = (o: number, str: string) => { for (let i = 0; i < str.length; i++) wav[o + i] = str.charCodeAt(i); };
      ws(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); ws(8, "WAVE");
      ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      ws(36, "data"); dv.setUint32(40, pcm.length * 2, true);
      for (let i = 0; i < pcm.length; i++) {
        const v = Math.max(-1, Math.min(1, pcm[i]));
        dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
      return wav;
    } catch (e) {
      asrLog(`转 wav 失败，改发原始录音：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async transcribe(blob: Blob, token: number): Promise<void> {
    try {
      const wav = await this.toWav(blob);
      const bytes = wav ?? new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const CHUNK = 0x8000; // 一次 apply 太多参数会爆栈，分块拼
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const audio = btoa(binary);
      asrLog(`开始识别 bytes=${bytes.length}`);
      const text = await invoke<string>("asr_transcribe", { audio });
      // 在途期间被取消/新开了一轮录音：这条结果作废，不能弹也不能自动发送
      if (token !== this.startToken) return;
      const trimmed = (text || "").trim();
      asrLog(`识别返回 ${trimmed.length} 字：「${trimmed.slice(0, 40)}」`);
      if (trimmed) this.handlers.onFinal?.(trimmed);
      else this.handlers.onNoSpeech?.(); // 服务返回空 = 没听清，不是错误
    } catch (e) {
      if (token !== this.startToken) return;
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
