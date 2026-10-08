/**
 * TTSPlayer 的实时静音。
 *
 * 锁的是一个真实 bug：TTS 的音频元素是 `new Audio()` 出来的、**不在 DOM 里**，
 * 老代码按静音键时用 `document.querySelectorAll("audio")` 去改 volume —— 一个都查
 * 不到，于是"按了静音键，正在播的这一段照样出声，要等下一句才安静"。
 * 同一个根因还让 `stop()` 里的 `querySelector("audio.tts-current")` 变成死代码，
 * 关掉语音输出时当前这句也停不下来。
 *
 * 这里用替身把浏览器环境补齐（Audio / window / @tauri-apps/api），
 * 只验证 TTSPlayer 自己的行为，不碰真实播放。
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

// ---------- 浏览器环境替身 ----------
/** 所有被 new 出来的音频替身，用来断言"正在播的那一段" */
const created = [];
class FakeAudio {
  constructor(src) {
    this.src = src;
    this.volume = 1;
    this.paused = true;
    this.played = 0;
    this.onended = null;
    this.onerror = null;
    created.push(this);
  }
  play() {
    this.paused = false;
    this.played++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  /** 模拟这一段播完 */
  finish() {
    if (this.onended) this.onended();
  }
}

global.Audio = FakeAudio;
// TTSPlayer 模块加载时会把自己挂到 window 上
global.window = {};

const playerPath = require.resolve("./build/tts/TTSPlayer.js");
const originalLoad = Module._load;
let ttsPlayer;
try {
  Module._load = function (request, parent, ...rest) {
    // Node 里加载不了这个浏览器包：只用到 invoke，替身即可
    if (request === "@tauri-apps/api/core") {
      return { invoke: async () => Buffer.from([1, 2, 3]).toString("base64") };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  ({ ttsPlayer } = require(playerPath));
} finally {
  Module._load = originalLoad;
}

/** 等预加载链（invoke → atob → Blob → new Audio）跑完 */
const settle = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  check("模块导出单例", typeof ttsPlayer?.setMuted === "function");
  check("默认不静音", ttsPlayer.muted === false);

  ttsPlayer.setConfig(true, "test-key", "test-speaker");
  ttsPlayer.pushDelta("今天天气不错哦。");
  await settle();
  await settle();
  await settle();

  const first = created[0];
  check("整句推入后开始播放", created.length === 1 && first.played === 1, `created=${created.length}`);
  check("默认音量是 1", first.volume === 1, String(first?.volume));

  // ★ 核心 1：正在播的时候按下静音 → 立刻安静
  ttsPlayer.setMuted(true);
  check("按下静音：正在播的这一段立刻静音", first.volume === 0, String(first.volume));
  check(
    "静音不暂停播放（队列要继续走完，否则气泡永远不消失）",
    first.paused === false,
    String(first.paused),
  );
  check("静音状态被记住", ttsPlayer.muted === true);

  // ★ 核心 2：再按一次（放声）→ 立刻出声
  ttsPlayer.setMuted(false);
  check("再按一次：立刻放声", first.volume === 1, String(first.volume));

  // 静音状态下进来的下一段，开播时也必须是静音
  ttsPlayer.setMuted(true);
  ttsPlayer.pushDelta("第二句也要安静。");
  await settle();
  await settle();
  await settle();
  check("第二段已预加载但还没开播", created.length === 2 && created[1].played === 0);

  first.finish(); // 第一段播完 → 队列前进
  const second = created[1];
  check("第二段接着播", second.played === 1, String(second.played));
  check("第二段开播时仍然是静音", second.volume === 0, String(second.volume));

  // 关掉语音输出：当前这一段必须真的停下来（老代码这里是死代码）
  ttsPlayer.setConfig(false, "test-key", "test-speaker");
  check("关掉语音输出会暂停当前这一段", second.paused === true, String(second.paused));

  // 没有在播的时候切静音不应崩
  ttsPlayer.setMuted(false);
  ttsPlayer.setMuted(true);
  check("空闲时切换静音不炸", ttsPlayer.muted === true);

  console.log(`\ntts-mute: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
})();
