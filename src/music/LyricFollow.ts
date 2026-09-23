/**
 * 歌词跟唱节流器（纯逻辑，可单测：tests/lyric-follow.test.js）。
 *
 * 原来 NowPlaying.tick 里的写法是：
 *     if (idx < 0 || idx === lastIndex) return;
 *     lastIndex = idx;                          // ← 先记账
 *     if (now - lastBubbleAt < 2500) return;     // ← 再判断节流
 * 被这 2.5 秒窗口挡掉的那一行**永远不会再显示**，于是密集段落每 2.5 秒白丢一行，
 * 听感就是"有时候会漏跟"。而且换歌时 lastBubbleAt 没清，新歌第一行也常被吃掉。
 *
 * 这里改成两条规矩：
 *  1. 只有**真的显示了**才记账（shownIndex / lastShownAt）；
 *  2. 被节流时不消费这一行，下个 tick 用"当时最新的一行"再试 ——
 *     歌词必须跟着音乐走，不能补一句已经过时的。
 */
export interface FollowOptions {
  /**
   * 相邻两次换行的最小间隔（毫秒）。只用来合并极密集的换行：
   * 正常歌词行间隔 1.5~4 秒，远大于它，所以实际几乎不会丢行。
   */
  minGapMs?: number;
}

export const DEFAULT_FOLLOW_OPTIONS: Required<FollowOptions> = { minGapMs: 700 };

export class LyricFollower {
  private shownIndex = -1;
  /** 用 -Infinity 表示"从未显示过"：重置后必须立刻能显示，不受最小间隔限制 */
  private lastShownAt = Number.NEGATIVE_INFINITY;
  private generation = -1;
  private deferred = false;
  private readonly minGapMs: number;

  constructor(opts: FollowOptions = {}) {
    this.minGapMs = opts.minGapMs ?? DEFAULT_FOLLOW_OPTIONS.minGapMs;
  }

  /** 当前实际显示的行号（-1 = 还没显示过） */
  get index(): number {
    return this.shownIndex;
  }

  /** 是否有被节流、等着补显示的行 */
  get hasDeferred(): boolean {
    return this.deferred;
  }

  /** 换歌 / 清空状态：下次 tick 允许立刻显示 */
  reset(): void {
    this.shownIndex = -1;
    this.lastShownAt = Number.NEGATIVE_INFINITY;
    this.generation = -1;
    this.deferred = false;
  }

  /**
   * 传入"此刻应该显示的行号"，返回真正要显示的行号（null = 这一 tick 不动）。
   * generation 变化（换歌 / 往后拖了进度）时自动重置，允许往回显示。
   */
  next(computedIndex: number, now: number, generation = 0): number | null {
    if (generation !== this.generation) {
      this.generation = generation;
      this.shownIndex = -1;
      this.lastShownAt = Number.NEGATIVE_INFINITY;
      this.deferred = false;
    }
    if (computedIndex < 0) return null;
    if (computedIndex === this.shownIndex) return null;
    if (now - this.lastShownAt < this.minGapMs) {
      // 只是往后推，不消费：下次 tick 会拿最新行号再试
      this.deferred = true;
      return null;
    }
    this.shownIndex = computedIndex;
    this.lastShownAt = now;
    this.deferred = false;
    return computedIndex;
  }
}
