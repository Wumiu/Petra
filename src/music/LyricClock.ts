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
  /** 判定"第一声响起"的能量阈值（略高于无声阈值即可，避免低音量前奏被跳过） */
  onsetThreshold?: number;
  /** 换歌后等待"第一声"的最长时间（毫秒），超时则退回按发现时刻计时 */
  onsetDeadlineMs?: number;
}

const DEFAULTS: Required<ClockOptions> = {
  repeatGapMs: 1600,
  seekGapMs: 600,
  levelThreshold: 0.02,
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
    this.drifted = false;
    this.pendingOnset = false;
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

  /** 采用播放器上报的真实进度（Spotify / 新版 QQ 音乐有） */
  setServerPosition(ms: number): void {
    if (ms <= 0) return;
    this.serverPos = true;
    this.baseMs = ms;
    this.anchorAt = this.now();
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
      return;
    }
    const gap = this.silenceMs;
    this.silenceMs = 0;
    if (gap >= this.opts.repeatGapMs) {
      this.baseMs = 0;
      this.anchorAt = this.now();
    } else if (gap >= this.opts.seekGapMs) {
      this.drifted = true;
    }
  }

  /** 手动对齐到某一行的时间戳 */
  alignTo(timeMs: number): void {
    this.baseMs = Math.max(0, timeMs);
    this.anchorAt = this.now();
    this.drifted = false;
    this.silenceMs = 0;
  }

  /** 当前推算进度是否可信 */
  get trusted(): boolean {
    return !this.drifted;
  }
}
