/** 歌词模块单元测试（Node，ASCII 输出）：npm run test:music */
const P = require("./build/music/LrcParser.js");
const E = require("./build/assistant/EmotionEngine.js");
const { LyricClock } = require("./build/music/LyricClock.js");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra !== undefined ? " -> " + JSON.stringify(extra) : "")); }
}

// ---------- parseLrc ----------
const lrc = ["[ar:测试]", "[ti:标题]", "[00:12.34]第一句", "[00:13.5]第二句", "[00:20.00][00:40.00]副歌", "", "[01:05.345]结尾"].join("\n");
const lines = P.parseLrc(lrc);
ok("parseLrc skips metadata and blank lines", lines.length === 5, lines.map(function (l) { return l.timeMs + ":" + l.text; }));
ok("parseLrc 2-digit fraction", lines[0].timeMs === 12340 && lines[0].text === "第一句", lines[0]);
ok("parseLrc 1-digit fraction", lines[1].timeMs === 13500, lines[1]);
ok("parseLrc 3-digit fraction", lines[4].timeMs === 65345, lines[4]);
ok("parseLrc multi-tag expands", lines[2].text === "副歌" && lines[3].text === "副歌" && lines[2].timeMs === 20000 && lines[3].timeMs === 40000, [lines[2], lines[3]]);
ok("parseLrc sorted ascending", lines.every(function (l, i) { return i === 0 || lines[i - 1].timeMs <= l.timeMs; }));
ok("parseLrc empty input", P.parseLrc("").length === 0);

// ---------- lineIndexAt ----------
ok("lineIndexAt empty -> -1", P.lineIndexAt([], 5000) === -1);
ok("lineIndexAt before first -> -1", P.lineIndexAt(lines, 100) === -1);
ok("lineIndexAt exact hit", P.lineIndexAt(lines, 12340) === 0);
ok("lineIndexAt between", P.lineIndexAt(lines, 13000) === 0);
ok("lineIndexAt last", P.lineIndexAt(lines, 999999) === lines.length - 1);

// ---------- cleanTitle / normalizeKey ----------
ok("cleanTitle strips (Live)", P.cleanTitle("晴天 (Live)") === "晴天", P.cleanTitle("晴天 (Live)"));
ok("cleanTitle strips 伴奏", P.cleanTitle("夜曲（伴奏）") === "夜曲", P.cleanTitle("夜曲（伴奏）"));
ok("cleanTitle keeps plain name", P.cleanTitle("海阔天空") === "海阔天空");
ok("normalizeKey ignores case/space/punct", P.normalizeKey("Hello, World!") === P.normalizeKey("helloworld"));

// ---------- pickBestLyrics ----------
const items = [
  { trackName: "晴天", artistName: "周杰伦", duration: 269, syncedLyrics: null, plainLyrics: "x" },
  { trackName: "晴天", artistName: "周杰伦", duration: 269, syncedLyrics: "[00:01.00]a" },
  { trackName: "晴天 (Live)", artistName: "周杰伦", duration: 300, syncedLyrics: "[00:02.00]b" },
  { trackName: "无关歌曲", artistName: "别人", duration: 200, syncedLyrics: "[00:03.00]c" },
];
const best = P.pickBestLyrics(items, "晴天", "周杰伦", 269000);
ok("pickBestLyrics requires synced lyrics", best && best.syncedLyrics === "[00:01.00]a", best);
const best2 = P.pickBestLyrics(items, "晴天", "周杰伦", 300000);
ok("pickBestLyrics prefers closer duration", best2 && best2.duration === 300, best2 && best2.duration);
ok("pickBestLyrics returns null when none synced", P.pickBestLyrics([items[0]], "晴天", "周杰伦", 0) === null);
ok("pickBestLyrics tolerates non-array", P.pickBestLyrics(null, "a", "b", 0) === null);
ok("pickBestLyrics rejects unrelated title", P.pickBestLyrics([{ trackName: "完全无关的歌", artistName: "别人", syncedLyrics: "[00:01.00]x" }], "晴天", "周杰伦", 0) === null);
ok("pickBestLyrics accepts title with extra suffix", P.pickBestLyrics([{ trackName: "夜明けを乞う。", artistName: "酔シグレ", syncedLyrics: "[00:01.00]x" }], "夜明けを乞う。 (feat. むト)", "酔シグレ", 0) !== null);

// ---------- LyricClock ----------
let now = 1000000;
const clock = new LyricClock(function () { return now; });
ok("setTrack first time true", clock.setTrack("歌", "人") === true);
ok("setTrack same track false", clock.setTrack("歌", "人") === false);
clock.setPlaying(true);
now += 5000;
ok("clock advances while playing", clock.positionMs() === 5000, clock.positionMs());
clock.setPlaying(false);
now += 10000;
ok("clock frozen while paused", clock.positionMs() === 5000, clock.positionMs());
clock.setPlaying(true);
now += 2000;
ok("clock resumes after pause", clock.positionMs() === 7000, clock.positionMs());

// 单曲循环：数字静音 2s 后重新起播 -> 归零
clock.noteAudio(0.5, 16);
clock.noteAudio(0.001, 2000);
clock.noteAudio(0.5, 16);
ok("long silence resets clock (repeat)", clock.positionMs() < 200, clock.positionMs());

// 疑似拖动：静音 800ms（介于 seek/repeat 之间）
const c2 = new LyricClock(function () { return now; });
c2.setTrack("歌2", "人2");
c2.setPlaying(true);
c2.noteAudio(0.5, 16);
c2.noteAudio(0.001, 800);
c2.noteAudio(0.5, 16);
ok("medium silence marks drift", c2.drift === true && c2.trusted === false);
c2.alignTo(60000);
ok("alignTo clears drift and sets position", c2.drift === false && c2.positionMs() === 60000, c2.positionMs());

// 暂停期间的静音不应被当成循环
const c3 = new LyricClock(function () { return now; });
c3.setTrack("歌3", "人3");
c3.setPlaying(true);
now += 30000;
c3.setPlaying(false);
c3.noteAudio(0.001, 5000);
c3.setPlaying(true);
c3.noteAudio(0.5, 16);
ok("silence while paused is ignored", c3.positionMs() >= 30000 && c3.drift === false, c3.positionMs());

// 有服务端进度时不用音频猜
const c4 = new LyricClock(function () { return now; });
c4.setTrack("歌4", "人4");
c4.setPlaying(true);
c4.setServerPosition(42000);
c4.noteAudio(0.001, 3000);
c4.noteAudio(0.5, 16);
ok("server timeline disables audio guessing", c4.hasServerTimeline === true && c4.positionMs() >= 42000 && c4.drift === false, c4.positionMs());

// 换歌后重置
c4.setTrack("歌5", "人5");
ok("track change resets clock", c4.positionMs() === 0 && c4.drift === false && c4.hasServerTimeline === false);

// [offset:±ms] 整体平移
const offLrc = ["[offset:-500]", "[00:10.00]A", "[00:20.00]B"].join("\n");
const offLines = P.parseLrc(offLrc);
ok("parseLrc applies negative offset", offLines.length === 2 && offLines[0].timeMs === 9500 && offLines[1].timeMs === 19500, offLines);
const offLrc2 = ["[offset:+1000]", "[00:10.00]A"].join("\n");
const offLines2 = P.parseLrc(offLrc2);
ok("parseLrc applies positive offset", offLines2.length === 1 && offLines2[0].timeMs === 11000, offLines2);
ok("parseLrc without offset unchanged", P.parseLrc("[00:05.00]X")[0].timeMs === 5000);

// 网易云形状的候选（source/trackName/artistName/duration/syncedLyrics）
const neItems = [
  { source: "netease", trackName: "オノマトペ", artistName: "羽生まゐご", duration: 166, syncedLyrics: "[00:00.00]作曲 : 羽生まゐご\n[00:06.87]そう言ったのは真夏の午後さ\n[00:10.37]どうやったってしんどいわ" },
];
const neBest = P.pickBestLyrics(neItems, "オノマトペ", "羽生まゐご", 166000);
ok("pickBestLyrics accepts netease-shaped item", neBest && neBest.source === "netease", neBest && neBest.trackName);
const neLines = P.parseLrc(neBest.syncedLyrics);
ok("parseLrc drops credit line", neLines.length === 2 && neLines[0].text.indexOf("そう言った") === 0, neLines);

// 起播锚点：换歌时处于静音空隙 → 第一声把进度归零
let n2 = 500000;
const c5 = new LyricClock(function () { return n2; });
c5.setTrack("歌6", "人6");
c5.markPendingOnset(true);
c5.setPlaying(true);
n2 += 400;                        // 轮询晚发现 400ms（音频仍静音）
c5.noteAudio(0.001, 100);
n2 += 120;                        // 第一声响起
c5.noteAudio(0.5, 16);
ok("onset anchor pins position to 0", c5.positionMs() < 60, c5.positionMs());
n2 += 5000;
ok("position advances after onset anchor", c5.positionMs() > 4900, c5.positionMs());

// 换歌时音频是响的（播放中途才发现）→ 不锚，保持原计时
let n3 = 600000;
const c6 = new LyricClock(function () { return n3; });
c6.setTrack("歌7", "人7");
c6.markPendingOnset(false);
c6.setPlaying(true);
n3 += 2000;
c6.noteAudio(0.5, 16);
ok("no anchor when audio already loud", c6.positionMs() >= 1900, c6.positionMs());

// 静音空隙但长时间没出声（安静前奏）→ 超时放弃锚点
let n4 = 700000;
const c7 = new LyricClock(function () { return n4; });
c7.setTrack("歌8", "人8");
c7.markPendingOnset(true);
c7.setPlaying(true);
n4 += 3000;                       // 超过 1.5s 限时
c7.noteAudio(0.001, 100);
c7.noteAudio(0.5, 16);
ok("onset deadline gives up on silent intro", c7.positionMs() >= 2900, c7.positionMs());

// 译文按时间戳对齐（网易云 tlyric）
const trans = P.parseLrc("[00:06.87]那样说出口的 是盛夏的午后\n[00:10.37]不管怎么做都好累啊");
ok("parseLrc parses translation lines", trans.length === 2, trans);
ok("lookupTranslation exact match", P.lookupTranslation(trans, 6870) === "那样说出口的 是盛夏的午后", P.lookupTranslation(trans, 6870));
ok("lookupTranslation within tolerance", P.lookupTranslation(trans, 7100) === "那样说出口的 是盛夏的午后");
ok("lookupTranslation returns null when far", P.lookupTranslation(trans, 30000) === null, P.lookupTranslation(trans, 30000));
ok("lookupTranslation handles empty list", P.lookupTranslation([], 5000) === null);
ok("lookupTranslation picks nearest of neighbours", P.lookupTranslation(trans, 10000) === "不管怎么做都好累啊", P.lookupTranslation(trans, 10000));
ok("lookupTranslation respects tolerance", P.lookupTranslation(trans, 9000) === null, P.lookupTranslation(trans, 9000));

// QQ/酷狗歌词：词/曲 制作行过滤
const qqLrc = ["[00:00.00]晴天 (Live) - 周杰伦 (Jay Chou)", "[00:09.00]词：周杰伦", "[00:18.00]曲：周杰伦", "[00:27.01]故事的小黄花", "[00:30.41]从出生那年就飘着"].join("\n");
const qqLines = P.parseLrc(qqLrc);
ok("parseLrc drops 词/曲 credit lines", qqLines.length === 3, qqLines.map(function (l) { return l.text; }));
ok("parseLrc keeps real lyric starting with 曲 only when no colon", P.parseLrc("[00:01.00]曲终人散的时候")[0].text === "曲终人散的时候");
const stripped = P.stripTitleLines(qqLines, "晴天");
ok("stripTitleLines removes title line", stripped.length === 2 && stripped[0].text === "故事的小黄花", stripped.map(function (l) { return l.text; }));
ok("stripTitleLines keeps normal dashed lyric", P.stripTitleLines(P.parseLrc("[00:01.00]你走 - 我也走"), "晴天").length === 1);

// HTML 实体解码
ok("decodeEntities handles &#10;", P.decodeEntities("a&#10;b") === "a\nb");
ok("decodeEntities handles &apos;", P.decodeEntities("it&apos;s") === "it's");
ok("parseLrc decodes entities", P.parseLrc("[00:01.00]it&apos;s me")[0].text === "it's me");

// 情绪识别：用户侧保持严格，桌宠说话侧要能命中常见回复
ok("user side: neutral for 好的", E.classifyEmotion("好的") === "neutral");
ok("user side: happy for 哈哈", E.classifyEmotion("哈哈哈哈") === "happy");
ok("user side: worried for 我好担心", E.classifyEmotion("我好担心考试") === "worried");
ok("assistant side: 好的啦 -> happy", E.classifyAssistantEmotion("好的啦") === "happy", E.classifyAssistantEmotion("好的啦"));
ok("assistant side: 已经帮你打开啦 -> happy", E.classifyAssistantEmotion("已经帮你打开网易云音乐啦") === "happy");
ok("assistant side: wave tail -> happy", E.classifyAssistantEmotion("我记住咯～") === "happy");
ok("assistant side: 别担心 -> worried", E.classifyAssistantEmotion("别担心，我陪着你") === "worried");
ok("assistant side: 早点休息 -> worried", E.classifyAssistantEmotion("记得早点休息哦") === "worried");
ok("assistant side: 抱歉 -> sad", E.classifyAssistantEmotion("抱歉，这个我做不到") === "sad");
ok("assistant side: 当然 -> happy", E.classifyAssistantEmotion("当然可以！") === "happy");
ok("assistant side: 咦 -> surprised", E.classifyAssistantEmotion("咦，你怎么知道的") === "surprised");
ok("assistant side: 哼 -> angry", E.classifyAssistantEmotion("哼！人家才不呢") === "angry");
ok("assistant side: plain text stays neutral", E.classifyAssistantEmotion("今天天气不错") === "neutral", E.classifyAssistantEmotion("今天天气不错"));

console.log("");
console.log("music: pass=" + pass + " fail=" + fail);
process.exit(fail > 0 ? 1 : 0);