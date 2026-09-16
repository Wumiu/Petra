/**
 * LRC 解析与行定位（纯函数，无 DOM/网络依赖，便于单测）
 */
export interface LyricLine {
  timeMs: number;
  text: string;
}

export interface LrclibItem {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  /** 翻译歌词（网易云 tlyric；时间戳与原文一致） */
  translatedLyrics?: string | null;
  source?: string;
}

const TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
/** 网易云歌词常把制作信息写成第一行（"作曲 : xxx"），这类行不是歌词，过滤掉 */
const CREDIT_RE = /^\s*(作词|作曲|词曲|词|曲|编曲|制作人|制作|出品|监制|混音|母带|录音|吉他|贝斯|鼓|键盘|和声|弦乐|笛|演唱|演奏|OP|SP|PV|MV|企划|统筹|发行|文案|封面|插画|设计|特别感谢|原作|原曲)\s*[:：]/;

/** 解码 QQ 音乐等来源可能带的 HTML 实体（&#10; &apos; 等） */
export function decodeEntities(text: string): string {
  if (!text || text.indexOf("&") < 0) return text;
  return text
    .replace(/&#(\d+);/g, (_m, d: string) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * 去掉"标题行"：QQ / 酷狗歌词常把 "歌名 - 歌手" 作为第一行。
 * 仅当该行以完整歌名开头且含分隔符时才丢弃，避免误删正常歌词。
 */
export function stripTitleLines(lines: LyricLine[], title: string): LyricLine[] {
  const want = normalizeKey(title);
  if (!want) return lines;
  return lines.filter((l) => {
    if (!/[-–—]/.test(l.text)) return true;
    const head = normalizeKey(l.text.split(/[-–—]/)[0] ?? "");
    return !(head && head.startsWith(want));
  });
}
const PUNCT_RE = /[\s\u3000~!@#$%^&*()+\-=\[\]{};:'",.<>/?\\|！￥…（）—【】《》、？：“”；’]/g;

/** 解析 LRC：支持一行多时间戳；跳过 [ar:][ti:] 等元信息与纯空行 */
export function parseLrc(raw: string): LyricLine[] {
  if (!raw) return [];
  const lrc = decodeEntities(raw);
  // [offset:±ms]：部分 LRC 用它标注与音频的整体偏差（正值 = 歌词应延后）
  let offsetMs = 0;
  const om = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(lrc);
  if (om) {
    const v = parseInt(om[1], 10);
    if (Number.isFinite(v)) offsetMs = v;
  }
  const out: LyricLine[] = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    TAG_RE.lastIndex = 0;
    const times: number[] = [];
    let m: RegExpExecArray | null = null;
    let lastEnd = 0;
    while ((m = TAG_RE.exec(rawLine)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = parseInt((m[3] ?? "0").padEnd(3, "0").slice(0, 3), 10);
      times.push(min * 60000 + sec * 1000 + frac);
      lastEnd = m.index + m[0].length;
    }
    if (times.length === 0) continue;
    const text = rawLine.slice(lastEnd).trim();
    if (!text) continue;
    if (CREDIT_RE.test(text)) continue; // 制作信息行，跳过
    for (const t of times) out.push({ timeMs: t, text });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  if (offsetMs !== 0) {
    return out.map((l) => ({ timeMs: Math.max(0, l.timeMs + offsetMs), text: l.text }));
  }
  return out;
}

/** 当前时间对应的行索引；早于第一行返回 -1 */
export function lineIndexAt(lines: LyricLine[], positionMs: number): number {
  if (lines.length === 0) return -1;
  if (positionMs < lines[0].timeMs) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 按时间戳取某行原文对应的译文（网易云 tlyric 与原文时间戳一致）。
 * 允许 toleranceMs 内的偏差；找不到就返回 null（此时只显示原文）。
 */
export function lookupTranslation(
  trans: LyricLine[],
  timeMs: number,
  toleranceMs = 500,
): string | null {
  if (!trans || trans.length === 0) return null;
  let lo = 0;
  let hi = trans.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (trans[mid].timeMs <= timeMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  let best: LyricLine | null = null;
  let bestDiff = Infinity;
  const consider = (l: LyricLine | undefined) => {
    if (!l) return;
    const d = Math.abs(l.timeMs - timeMs);
    if (d < bestDiff) {
      bestDiff = d;
      best = l;
    }
  };
  if (idx >= 0) consider(trans[idx]);
  consider(trans[idx + 1]);
  return best !== null && bestDiff <= toleranceMs ? (best as LyricLine).text : null;
}

/** 匹配用归一化：去空白标点、转小写，并丢掉常见的括号后缀 */
export function normalizeKey(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[（(\[【][^）)\]】]{0,24}(live|伴奏|纯音乐|instrumental|翻自|cover|remix|现场|版)[^）)\]】]{0,24}[）)\]】]/g, "")
    .replace(PUNCT_RE, "")
    .trim();
}

/** 歌名清理：只去掉已知后缀括号，保留正常歌名 */
export function cleanTitle(title: string): string {
  const t = (title || "").trim();
  const cleaned = t
    .replace(/[（(\[【][^）)\]】]{0,24}(live|伴奏|纯音乐|instrumental|翻自|cover|remix|现场|版)[^）)\]】]{0,24}[）)\]】]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || t;
}

/**
 * 从 LRCLIB 结果中挑最合适的一条：必须有同步歌词；标题/艺人匹配优先，时长接近加分。
 * 时长未知（0）时不参与打分。
 */
export function pickBestLyrics(
  items: LrclibItem[],
  title: string,
  artist: string,
  durationMs = 0,
): LrclibItem | null {
  if (!Array.isArray(items)) return null;
  const wantTitle = normalizeKey(title);
  const wantArtist = normalizeKey(artist);
  const wantDur = durationMs > 0 ? durationMs : 0;
  let best: LrclibItem | null = null;
  let bestScore = -Infinity;
  for (const it of items) {
    if (!it || !it.syncedLyrics || !it.syncedLyrics.trim()) continue;
    let score = 0;
    const t = normalizeKey(it.trackName ?? "");
    const a = normalizeKey(it.artistName ?? "");
    if (t && wantTitle) {
      if (t === wantTitle) score += 40;
      else if (t.includes(wantTitle) || wantTitle.includes(t)) score += 15;
      // 标题完全对不上 → 视为别的歌，宁可不出歌词也不出错误歌词
      else continue;
    }
    if (a && wantArtist) {
      if (a === wantArtist) score += 20;
      else if (a.includes(wantArtist) || wantArtist.includes(a)) score += 8;
    }
    const d = typeof it.duration === "number" ? it.duration * 1000 : 0;
    if (wantDur > 0 && d > 0) {
      const diff = Math.abs(d - wantDur);
      if (diff <= 3000) score += 25;
      else if (diff <= 10000) score += 10;
      else score -= 15;
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}
