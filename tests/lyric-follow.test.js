/**
 * 歌词跟唱节流器测试（纯逻辑）：npm run test:music
 * 重点回归：被节流的行**不能丢**（旧实现记完账才判断节流，密集段落每 2.5 秒白丢一行）。
 */
const { LyricFollower, DEFAULT_FOLLOW_OPTIONS } = require("./build/music/LyricFollow.js");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra !== undefined ? " -> " + JSON.stringify(extra) : "")); }
}

ok("默认最小换行间隔", DEFAULT_FOLLOW_OPTIONS.minGapMs > 0 && DEFAULT_FOLLOW_OPTIONS.minGapMs <= 1500, DEFAULT_FOLLOW_OPTIONS);

// 第一行立刻显示
const f1 = new LyricFollower();
ok("first line shows immediately", f1.next(0, 1000, 0) === 0);
ok("index getter reflects shown line", f1.index === 0);
ok("same line does not re-show", f1.next(0, 9000, 0) === null);

// 关键回归：节流后的行不会丢，下个 tick 用最新行号补显示
const f2 = new LyricFollower({ minGapMs: 700 });
ok("line 0 shows", f2.next(0, 1000, 0) === 0);
ok("line 1 throttled (not shown yet)", f2.next(1, 1100, 0) === null);
ok("throttle marks deferred", f2.hasDeferred === true);
ok("line 1 shows once gap passed", f2.next(1, 1800, 0) === 1);
ok("deferred cleared after showing", f2.hasDeferred === false);

// 密集段落：中间被节流的行折叠成"当前最新的一行"，绝不补一句过时的
const f3 = new LyricFollower({ minGapMs: 700 });
f3.next(0, 0, 0);
ok("intermediate line throttled", f3.next(1, 100, 0) === null);
ok("another intermediate throttled", f3.next(2, 200, 0) === null);
ok("collapses to current line", f3.next(5, 900, 0) === 5);
ok("stale line never shown", f3.index === 5);

// 换代（换歌 / 往后拖进度）→ 立刻允许显示，且允许往回
const f4 = new LyricFollower();
f4.next(10, 0, 0);
ok("next line throttled before seek", f4.next(11, 100, 0) === null);
ok("generation bump resets and shows at once", f4.next(10, 130, 1) === 10);
ok("same generation after reset still throttled", f4.next(11, 200, 1) === null);

// reset 后立刻可显示
const f5 = new LyricFollower();
f5.next(3, 0, 0);
f5.reset();
ok("reset clears shown index", f5.index === -1);
ok("shows immediately after reset", f5.next(3, 50, 0) === 3);

// 最小间隔为 0 时不节流
const f6 = new LyricFollower({ minGapMs: 0 });
f6.next(0, 0, 0);
ok("zero gap shows every change", f6.next(1, 1, 0) === 1 && f6.next(2, 2, 0) === 2);

// 无效行号
const f7 = new LyricFollower();
ok("negative index ignored", f7.next(-1, 0, 0) === null);
ok("negative index keeps state clean", f7.index === -1 && f7.hasDeferred === false);

console.log("");
console.log("lyric-follow: pass=" + pass + " fail=" + fail);
process.exit(fail > 0 ? 1 : 0);
