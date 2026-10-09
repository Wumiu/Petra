/**
 * 语音识别（ASR）里与浏览器无关的那部分判断。
 *
 * 锁的是这次新加语音输入时踩到的两个真 bug：
 *   1. 收尾只发 finalText、丢掉 interim —— 用户"说完立刻点停"时最后一段还没定稿，
 *      半句话就这么没了（pickFinalText 必须优先用 final+interim 的全量文本）；
 *   2. WebView2 的原生识别在国内会直接给 network，老代码把它和 no-speech 一起
 *      静默吞掉，用户对着红点干等、不知道是没听见还是坏了（isFatalWebSpeechError）。
 *
 * 纯函数，不需要浏览器替身。
 */
const path = require("node:path");
const logic = require(path.join(__dirname, "build", "asr", "asrLogic.js"));

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log("FAIL " + name + (extra ? "  → " + extra : ""));
  }
}

// ---------- 后端选择 ----------
check(
  "没有原生识别（Mac/Linux）→ 在线识别",
  logic.pickBackend(false, false) === "siliconflow",
);
check(
  "有原生识别且没坏（Windows）→ 原生识别",
  logic.pickBackend(true, false) === "web-speech",
);
check(
  "原生识别被判过死刑 → 降级在线识别",
  logic.pickBackend(true, true) === "siliconflow",
);

// ---------- 错误分类 ----------
for (const code of ["network", "service-not-allowed", "not-allowed", "audio-capture"]) {
  check(`「用不了」级别的错误：${code}`, logic.isFatalWebSpeechError(code) === true);
}
for (const code of ["no-speech", "aborted"]) {
  check(`不是「用不了」，只是这次没听清：${code}`, logic.isFatalWebSpeechError(code) === false);
  check(`也别弹给用户看：${code}`, logic.isReportableWebSpeechError(code) === false);
}
check("network 要弹给用户看", logic.isReportableWebSpeechError("network") === true);

// ---------- 停顿判定 ----------
check("刚有结果不算说完", logic.shouldAutoStop(1000, 1000 + 100, 2500) === false);
check("差一点不算说完", logic.shouldAutoStop(1000, 1000 + 2499, 2500) === false);
check("刚好到点算说完", logic.shouldAutoStop(1000, 1000 + 2500, 2500) === true);
check("超时很久算说完", logic.shouldAutoStop(1000, 1000 + 9000, 2500) === true);

// ---------- 收尾取哪段文本（核心 1） ----------
check(
  "★ 只有 interim（最后半句没定稿）也要发出去，不能丢",
  logic.pickFinalText("", "今天天气不错") === "今天天气不错",
);
check(
  "★ final 有、全量更长（带未定稿尾句）时用全量",
  logic.pickFinalText("今天天气", "今天天气不错") === "今天天气不错",
);
check("只有 final 时用 final", logic.pickFinalText("今天天气不错", "") === "今天天气不错");
check("两边都空 → 空（调用方据此不发送）", logic.pickFinalText("", "") === "");
check("两边都有空白 → 不要发空白", logic.pickFinalText("  ", "  ") === "");

// ---------- 太短就丢 ----------
check("录了 200ms → 丢", logic.isTooShort(200, 5000, 500) === true);
check("体积不够 1KB → 丢", logic.isTooShort(3000, 200, 500) === true);
check("时长和体积都够 → 发", logic.isTooShort(3000, 5000, 500) === false);

// ---------- VAD 音量 ----------
const silence = new Uint8Array(512).fill(128);
check("静音波形 RMS = 0", logic.rmsFromTimeDomain(silence) === 0);
const loud = new Uint8Array(512);
for (let i = 0; i < loud.length; i++) loud[i] = i % 2 === 0 ? 255 : 1;
const loudRms = logic.rmsFromTimeDomain(loud);
check("满幅波形 RMS 接近 1", loudRms > 0.95, String(loudRms));
check("静音低于阈值而满幅高于阈值（判决确实分得开）", 0 < 0.015 && loudRms > 0.015);

// ---------- 何时收尾（★ 锁"点了麦克风说话没反应"这个 bug） ----------
const T = { silenceMs: 2500, firstResultMs: 6000, giveUpMs: 8000, maxMs: 60000 };
const fresh = () => ({
  startedAt: 1000,
  lastActivityAt: 1000,
  speaking: false,
  heardSound: false,
  gotResult: false,
});
const at = (ms) => 1000 + ms; // 以 startedAt 为基准

check(
  "★ 刚点下去 2.5 秒内绝不能收尾（引擎实测要 6 秒才出第一个结果）",
  logic.decideListenStop(fresh(), at(2500), T) === "keep",
);
check(
  "★ 等了 5 秒还没结果也先别收（firstResultMs=6s 以内）",
  logic.decideListenStop({ ...fresh(), heardSound: true, lastActivityAt: at(1400) }, at(5000), T) === "keep",
);
check(
  "有声音但 6 秒没结果 → 收尾（收尾会给用户一句提示）",
  logic.decideListenStop({ ...fresh(), heardSound: true, lastActivityAt: at(1400) }, at(7500), T) === "stop",
);
check(
  "★ 人正在说话、且还没出过结果时，绝不收尾",
  logic.decideListenStop({ ...fresh(), heardSound: true, speaking: true }, at(50000), T) === "keep",
);
check(
  "★ 已经出过结果后不再看 speaking（WebView2 的 speechend 常常不来，不能靠它永远挂着）",
  logic.decideListenStop(
    { ...fresh(), heardSound: true, gotResult: true, speaking: true, lastActivityAt: at(10000) },
    at(12500),
    T,
  ) === "stop",
);
check(
  "拿到结果后，说完停不到 2.5 秒不收（原有手感不变）",
  logic.decideListenStop({ ...fresh(), heardSound: true, gotResult: true, lastActivityAt: at(10000) }, at(12400), T) === "keep",
);
check(
  "拿到结果后停够 2.5 秒 → 收尾",
  logic.decideListenStop({ ...fresh(), heardSound: true, gotResult: true, lastActivityAt: at(10000) }, at(12500), T) === "stop",
);
check(
  "一直没听到声音 → 要等满 8 秒才放弃（不是 2.5 秒）",
  logic.decideListenStop(fresh(), at(7900), T) === "keep",
);
check("一直没听到声音 → 满 8 秒收尾", logic.decideListenStop(fresh(), at(8000), T) === "stop");
check(
  "硬上限：引擎死活不出结果时 60 秒也要收",
  logic.decideListenStop({ ...fresh(), heardSound: true, lastActivityAt: at(30000) }, at(61000), T) === "stop",
);

console.log(`\nasr-logic: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
