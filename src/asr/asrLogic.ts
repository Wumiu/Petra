/**
 * 语音识别里**与浏览器无关**的那部分判断。
 *
 * 单独拆出来是为了能像其它模块一样跑单元测试（tests/asr-logic.test.js）：
 * SpeechRecognizer 本身依赖 window / MediaRecorder / Tauri invoke，在 node 里跑不起来，
 * 但"用哪个后端、啥时候算说完、错误算不算致命"这些纯判断可以、也应该被测住。
 */

/** 识别后端：Windows 走浏览器原生，Mac/Linux 走在线（Rust 侧转发） */
export type AsrBackend = "web-speech" | "siliconflow";

/** 这些错误说明浏览器原生识别在这台机器上根本用不了，而不是"这次没听清" */
const FATAL_WEB_SPEECH_ERRORS = [
  "network", // 在线识别服务连不上（国内 WebView2 最常见）
  "service-not-allowed",
  "not-allowed", // 系统/WebView 层面禁了麦克风
  "audio-capture", // 找不到麦克风设备
  "language-not-supported",
];

/**
 * 选后端。
 *
 * 有原生识别且它没被证明坏掉 → 原生（边说边出字、不花识别费）；
 * 否则走在线识别（Rust 侧调硅基流动，需要用户配 Key）。
 */
export function pickBackend(hasWebSpeech: boolean, webSpeechBroken: boolean): AsrBackend {
  return hasWebSpeech && !webSpeechBroken ? "web-speech" : "siliconflow";
}

/** 原生识别的这个错误码，是不是"用不了"级别的（而不是没听清/用户主动中断） */
export function isFatalWebSpeechError(code: string): boolean {
  return FATAL_WEB_SPEECH_ERRORS.includes(code);
}

/** 这个错误码该不该弹给用户看：no-speech / aborted 都是正常现象，别吓人 */
export function isReportableWebSpeechError(code: string): boolean {
  return code !== "no-speech" && code !== "aborted";
}

/** 距上次有结果多久了 → 该不该自动收尾（停顿判定） */
export function shouldAutoStop(lastResultAt: number, now: number, silenceMs: number): boolean {
  return now - lastResultAt >= silenceMs;
}

/**
 * 收尾时到底发什么文本。
 *
 * 原生识别只把 isFinal 的片段累进 finalText，interim（还没定稿的尾句）另存。
 * 用户"说完立刻点停"时最后一段往往还没 final，只发 finalText 就会吞掉半句话，
 * 所以有全量文本时优先用它——它是 final + interim，永远是 finalText 的超集。
 */
export function pickFinalText(finalText: string, fullText: string): string {
  const full = fullText.trim();
  return full || finalText.trim();
}

/** 录音太短/太小就别发了：多半是误触 */
export function isTooShort(durationMs: number, byteSize: number, minMs: number): boolean {
  return durationMs < minMs || byteSize < 1000;
}

/** 时域波形 → RMS 音量（0~1），静音判定用它 */
export function rmsFromTimeDomain(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

// ---------- 原生识别：什么时候可以收尾 ----------

/** 一次监听的状态（SpeechRecognizer 在事件回调里维护） */
export interface ListenState {
  /** 开始监听的时刻 */
  startedAt: number;
  /** 最后一次"有动静"的时刻：出结果、听到声音、开始/结束说话都算 */
  lastActivityAt: number;
  /** 人正在说话（speechstart 与 speechend 之间）—— 说话期间绝不收尾 */
  speaking: boolean;
  /** 听到过声音（哪怕还没出文字） */
  heardSound: boolean;
  /** 拿到过至少一条识别结果 */
  gotResult: boolean;
}

export interface ListenTiming {
  /** 说完停顿多久算收尾 */
  silenceMs: number;
  /** 还没拿到任何结果时允许多等多久（引擎连识别服务本身就要几秒） */
  firstResultMs: number;
  /** 一直没听到声音时最多等多久，到点收尾并给用户一句交代 */
  giveUpMs: number;
  /** 单次监听硬上限：引擎死活不出结果时也不能让麦克风一直开着 */
  maxMs: number;
}

/**
 * 该不该收尾。
 *
 * 这条判定就是"点了麦克风说话却没反应"的根因：引擎从 start 到第一个 result
 * 实测要 **6 秒**（还要 ~0.8s 才 audiostart），而以前的实现把"start 那一刻"
 * 当静音起点，2.5 秒就把麦克风掐了 —— 用户还在说，既没识别、也没提示。
 */
export function decideListenStop(
  s: ListenState,
  now: number,
  t: ListenTiming,
): "keep" | "stop" {
  // 还没出过结果时，只要人在说话就绝不收：引擎连识别服务要几秒，
  // 这正是"点了麦克风说话没反应"的根源（以前 2.5 秒就把开头切了）。
  // 注意：出过结果之后不再看 speaking —— WebView2 的 speechend 不保证会来
  // （实测常常只有 speechstart），拿它当"永远别收"的条件会把麦克风挂到硬上限。
  if (s.speaking && !s.gotResult) return "keep";
  if (!s.heardSound && !s.gotResult) {
    // 一点声音都没听到：给足时间（等麦克风打开 + 引擎连上），到点收尾（收尾时给提示）
    return now - s.startedAt >= t.giveUpMs ? "stop" : "keep";
  }
  // 有声音但还没出结果时多等一会儿：识别结果本来就要几秒才回来
  const grace = s.gotResult ? t.silenceMs : Math.max(t.silenceMs, t.firstResultMs);
  if (now - s.lastActivityAt >= grace) return "stop";
  return now - s.startedAt >= t.maxMs ? "stop" : "keep";
}
