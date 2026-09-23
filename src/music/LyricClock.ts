/**
 * 歌词时钟（纯状态机，可注入时钟函数，便于单测）
 *
 * 由于部分播放器（实测网易云）不通过 SMTC 提供时间轴，进度只能靠本地推算：
 *   起播/换歌 → 归零；暂停 → 停表；继续 → 起表；
 *   "数字静音"长间隔后重新起播 → 判定单曲循环 → 归零；
 *   中等静音间隔 → 疑似拖动进度 → 标记失准（歌词暂停显示，换歌自动恢复）。
 */
export interface ClockOptions {
  /** 长静音判定为"单曲循环重播"的阈值（毫秒） */
  repeatGapMs?: number;
  /** 中等静音判定为"疑似拖动进度"的阈值（毫秒） */
  seekGapMs?: number;
  /** 判定"无声"的能量阈值（0~1） */
  levelThreshold?: number;
  /**
   * 判定"真的没声音"（数字静音）的能量阈值（0~1）。
   * 安静段落仍有微弱信号，只有拖动进度/换歌/播放器断流才会接近 0 ——
   * 以前只要静音超过 600ms 就判定"拖动进度、本首不再跟唱"，安静段落被误伤，
   * 表现就是"有时候会漏跟"。现在要求同时满足"深度静音"才算拖动。
   */
  deepSilenceLevel?: number;
  /** 判定"第一声响起"的能量阈值（略高于无声阈值即可，避免低音量前奏被跳过） */
  onsetThreshold?: number;
  /** 换歌后等待"第一声"的最长时间（毫秒），超时则退回按发现时刻计时 */
  onsetDeadlineMs?: number;
}

/** 播放器时间轴抖动容差：小于这个幅度的回退当作噪声（有的播放器只报整秒） */
const TIMELINE_JITTER_MS = 400;
/** 超过这个幅度的回退才算"真的往后拖了进度" */
const BACKWARD_SEEK_MS = 1200;

const DEFAULTS: Required<ClockOptions> = {
  repeatGapMs: 1600,
  seekGapMs: 600,
  levelThreshold: 0.02,
  deepSilenceLevel: 0.004,
  onsetThreshold: 0.03,
  // 只等 1.5 秒：真·起播通常在一秒内出声；长时间无声说明是安静前奏，
  // 此时"第一声"并不等于 0 秒，宁可按发现时刻计时。
  onsetDeadlineMs: 1500,
};

export class LyricClock {
  private title = "";
  private artist = "";
  private baseMs = 0;
  private anchorAt = 0;
  private playing = false;
  private serverPos = false;
  private silenceMs = 0;
  private drifted = false;
  /** 等待"第一声"来把进度锚定到 0（比 SMTC 轮询发现时刻更准） */
  private pendingOnset = false;
  private onsetDeadline = 0;
  /** 深度静音累计（真·没声音），与 silenceMs 分开统计 */
  private deepSilenceMs = 0;
  /** "换歌 / 明显往后拖动"的代数：跟唱器据此重置已显示行 */
  private generation = 0;

  private now: () => number;
  private opts: Required<ClockOptions>;

  constructor(now: () => number = () => Date.now(), opts: ClockOptions = {}) {
    this.now = now;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** 是否检出失准（歌词应暂停显示） */
  get drift(): boolean {
    return this.drifted;
  }

  /** 播放器是否提供了真实进度 */
  get hasServerTimeline(): boolean {
    return this.serverPos;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get trackKey(): string {
    return this.title + "|" + this.artist;
  }

  /** 代数：换歌或明显往后拖动时自增，跟唱器用它决定要不要重置显示行 */
  get generationCount(): number {
    return this.generation;
  }

  /** 换歌 → 归零并清除失准标记；返回是否真的换了歌 */
  setTrack(title: string, artist: string): boolean {
    if (title === this.title && artist === this.artist) return false;
    this.title = title;
    this.artist = artist;
    this.baseMs = 0;
    this.anchorAt = this.now();
    this.playing = false;
    this.serverPos = false;
    this.silenceMs = 0;
    this.deepSilenceMs = 0;
    this.drifted = false;
    this.pendingOnset = false;
    this.generation += 1;
    return true;
  }

  /**
   * 标记"等第一声"：SMTC 轮询发现换歌时，真实播放可能已经开始了几百毫秒。
   * 仅当换歌这一刻音频是安静的（说明正处在两首歌之间的空隙）才启用，
   * 因为只有那时"第一声响起"才真的等于 0 秒；否则（播放中途才发现换歌）不锚。
   */
  markPendingOnset(audioSilentAtChange: boolean): void {
    if (!audioSilentAtChange) return;
    this.pendingOnset = true;
    this.onsetDeadline = this.now() + this.opts.onsetDeadlineMs;
  }

  /** 是否仍在等待起播锚点（调试用） */
  get waitingOnset(): boolean {
    return this.pendingOnset;
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    if (playing) {
      this.anchorAt = this.now();
    } else {
      this.baseMs = this.positionMs();
      this.silenceMs = 0;
    }
    this.playing = playing;
  }

  /**
   * 采用播放器上报的真实进度（Spotify / 新版 QQ 音乐有）。
   * 时间轴有粒度（有的播放器只报整秒）且每 500ms 轮询一次，直接照单全收会让进度
   * 来回抖、歌词在相邻两行之间跳；这里：小幅回退当噪声忽略，明显回退才算真拖动。
   */
  setServerPosition(ms: number): void {
    if (ms <= 0) return;
    this.serverPos = true;
    // 有真实时间轴就不再是"猜"了：之前误判的失准要恢复
    this.drifted = false;
    const now = this.now();
    if (!this.playing) {
      this.baseMs = ms;
      this.anchorAt = now;
      return;
    }
    const predicted = this.baseMs + (now - this.anchorAt);
    const delta = ms - predicted;
    if (delta <= -BACKWARD_SEEK_MS) {
      // 真的往后拖了：重新锚定并换代（跟唱器会重置显示行，允许往回显示）
      this.baseMs = ms;
      this.anchorAt = now;
      this.generation += 1;
      return;
    }
    if (delta < -TIMELINE_JITTER_MS) {
      // 小幅回退：多半是时间轴粒度/抖动，保持现有推算，别让歌词回跳
      return;
    }
    this.baseMs = ms;
    this.anchorAt = now;
  }

  positionMs(): number {
    const pos = this.playing ? this.baseMs + (this.now() - this.anchorAt) : this.baseMs;
    return Math.max(0, Math.round(pos));
  }

  /**
   * 音频能量输入（由主循环每帧调用）
   * - 未播放时不累计静音，避免"暂停期间静音"被误判为循环/拖动
   */
  noteAudio(level: number, dtMs: number): void {
    if (!this.playing || this.serverPos) {
      this.silenceMs = 0;
      this.deepSilenceMs = 0;
      this.pendingOnset = false;
      return;
    }
    // 起播锚点：限时内第一声响起 → 此刻就是 0 秒；超时则放弃（回到按发现时刻计时）
    if (this.pendingOnset) {
      if (this.now() > this.onsetDeadline) {
        this.pendingOnset = false;
      } else if (level >= this.opts.onsetThreshold) {
        this.pendingOnset = false;
        this.baseMs = 0;
        this.anchorAt = this.now();
        this.silenceMs = 0;
        return;
      } else {
        this.silenceMs = 0;
        return;
      }
    }
    if (level < this.opts.levelThreshold) {
      this.silenceMs += dtMs;
      if (level < this.opts.deepSilenceLevel) this.deepSilenceMs += dtMs;
      return;
    }
    const gap = this.silenceMs;
    const deepGap = this.deepSilenceMs;
    this.silenceMs = 0;
    this.deepSilenceMs = 0;
    if (gap >= this.opts.repeatGapMs && deepGap >= this.opts.repeatGapMs * 0.6) {
      // 长时间**真的没声音**：判定单曲循环/重播，从头对齐
      // （安静段落哪怕超过 1.6 秒也不重置，否则安静前奏会把整首歌的进度拽回 0）
      this.baseMs = 0;
      this.anchorAt = this.now();
      // 重播等于重新来过：把之前的"失准"清掉并换代，否则重播后整首歌仍然不显示歌词
      this.drifted = false;
      this.generation += 1;
    } else if (gap >= this.opts.seekGapMs && deepGap >= this.opts.seekGapMs * 0.6) {
      // 中等时长的**深度**静音：才认为用户拖了进度条
      this.drifted = true;
    }
    // 只是安静段落（有微弱信号）→ 时钟不动，继续跟唱
  }

  /** 手动对齐到某一行的时间戳 */
  alignTo(timeMs: number): void {
    this.baseMs = Math.max(0, timeMs);
    this.anchorAt = this.now();
    this.drifted = false;
    this.silenceMs = 0;
    this.deepSilenceMs = 0;
  }

  /** 当前推算进度是否可信 */
  get trusted(): boolean {
    return !this.drifted;
  }
}
