/**
 * TTSPlayer 的播放顺序。
 *
 * 锁的是另一个真实 bug：合成是**并发预取**的（每断出一句就立刻发请求，谁先返回不一定），
 * 而老代码出队时取的是"第一个已经合成好的"（`queue.findIndex(i => i.ready)`）——
 * 于是第一句合成慢、第二句合成快时，第二句先播，听起来就是"先说下面的，再说上面的"。
 * 正确行为：**预取可以乱序，播必须严格按文字顺序**，队首没好就等它。
 *
 * 浏览器环境用替身补齐（Audio / Blob / URL / window / @tauri-apps/api），
 * 用 base64 载荷的首字节给每一句编号，从而能断言"播的到底是哪一句、按什么顺序"。
 * 注意：断言必须看 **play() 被调用的顺序**，不能看 Audio 对象被创建的顺序 ——
 * 后者正是"合成完成的顺序"，本来就是乱的。
 */
const path = require("node:path");
const Module = require("node:module");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 替身 ----------
const created = [];
/** 每一句"开始播"的顺序（编号），这才是用户听到的顺序 */
const playOrder = [];
class FakeAudio {
  constructor(src) {
    this.src = src;
    this.volume = 1;
    this.paused = true;
    this.played = 0;
    this.onended = null;
    this.onerror = null;
    this.id = Number(src.slice("blob:".length));
    created.push(this);
  }
  play() {
    this.paused = false;
    this.played++;
    playOrder.push(this.id);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  finish() {
    if (this.onended) this.onended();
  }
}

const warnings = [];
console.warn = (...a) => warnings.push(a.join(" "));

global.Audio = FakeAudio;
global.window = {};
// 字节 → 编号 → blob URL，这样能从 audio.src 看出这是第几句
global.Blob = class {
  constructor(parts) {
    this.parts = parts;
  }
};
URL.createObjectURL = (blob) => `blob:${blob.parts[0][0]}`;

/** 每句的合成耗时（毫秒）与编号；慢的那句故意放最前面 */
const PLAN = {
  "第一句。": { id: 1, ms: 60 },
  "第二句。": { id: 2, ms: 5 },
  "第三句。": { id: 3, ms: 5 },
  "第四句。": { id: 4, ms: 5 },
  "第五句。": { id: 5, ms: 5, fail: true },
  "第六句。": { id: 6, ms: 5 },
};
/** 合成"完成"的先后顺序（用来证明乱序合成这件事真的发生了） */
const finished = [];

const playerPath = require.resolve("./build/tts/TTSPlayer.js");
const originalLoad = Module._load;
let ttsPlayer;
try {
  Module._load = function (request, parent, ...rest) {
    if (request === "@tauri-apps/api/core") {
      return {
        invoke: async (_cmd, args) => {
          const plan = PLAN[args.text];
          await sleep(plan.ms);
          finished.push(args.text);
          if (plan.fail) throw new Error("synthesis failed");
          return Buffer.from([plan.id]).toString("base64");
        },
      };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  ({ ttsPlayer } = require(playerPath));
} finally {
  Module._load = originalLoad;
}

const audioOf = (id) => created.find((a) => a.id === id);
const order = () => playOrder.join(",");

(async () => {
  ttsPlayer.setConfig(true, "test-key", "test-speaker");

  // ---------- 场景 A：第一句合成最慢 ----------
  ttsPlayer.pushDelta("第一句。");
  ttsPlayer.pushDelta("第二句。");
  ttsPlayer.pushDelta("第三句。");
  await sleep(120); // 等三句的合成都回来（第一句最慢）

  check(
    "前提：合成确实是乱序完成的（后面的句子先回来）",
    finished[0] !== "第一句。",
    finished.join(" → "),
  );
  check("三句都预取到了", created.length === 3, `created=${created.length}`);
  check(
    "★ 先播的是第一句（尽管它合成最慢）",
    order() === "1" && audioOf(1).played === 1,
    `播放顺序=[${order()}]`,
  );

  audioOf(1).finish();
  check("第一句播完才轮到第二句", order() === "1,2", `播放顺序=[${order()}]`);
  check("第二句没播完时第三句不许抢播", audioOf(3).played === 0);

  audioOf(2).finish();
  check("第二句播完才轮到第三句", order() === "1,2,3", `播放顺序=[${order()}]`);

  audioOf(3).finish();
  check("全部播完后不再多播", order() === "1,2,3", `播放顺序=[${order()}]`);

  // ---------- 场景 B：中间那句合成失败 ----------
  finished.length = 0;
  const warnsBefore = warnings.length;
  ttsPlayer.pushDelta("第四句。");
  ttsPlayer.pushDelta("第五句。");
  ttsPlayer.pushDelta("第六句。");
  await sleep(120);

  check(
    "★ 中间那句合成失败时，仍按顺序播第四句（跳过第五句）",
    order() === "1,2,3,4",
    `播放顺序=[${order()}]`,
  );
  check(
    "合成失败有告警（不是静默吞掉）",
    warnings.slice(warnsBefore).some((w) => w.includes("failed")),
    warnings.slice(warnsBefore).join(" | "),
  );

  audioOf(4).finish();
  check(
    "失败的第五句被跳过，不卡住后面的第六句",
    order() === "1,2,3,4,6",
    `播放顺序=[${order()}]`,
  );
  audioOf(6).finish();

  console.log(`\ntts-order: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
})();
