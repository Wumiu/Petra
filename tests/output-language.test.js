/**
 * 语言指令的**位置**——主动问候"偶尔说中文"的根因测试。
 *
 * 事实链：
 *   1. 语言指令只放在 prompt 中段时，后面还跟着中文要求（"要求：简短（1-2句）、
 *      口语化、不要像客服"），模型顺着最近的中文继续写 → 整句中文；
 *   2. 连 "第一行原文 + --- + 中文翻译" 的格式也一起丢，TTS 只读 `---` 之前的部分
 *      （TTSPlayer.pushDelta 里遇 "\n---" 就截断），于是中文被念出来。
 * 所以这里锁的不是"指令内容对不对"，而是"指令必须压在最后一行、后面不许再有中文"。
 */
const path = require("node:path");
const fs = require("node:fs");

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

const ol = require("./build/utils/outputLanguage.js");
const pp = require("./build/assistant/proactivePrompts.js");

// ---------- 基础语义 ----------
const jaInstruction = ol.buildLanguageInstruction("ja", { withTranslation: true });
check("system 侧指令要求用日语", jaInstruction.includes("日语"));
check("system 侧指令给出 --- 翻译格式", jaInstruction.includes("---"));

const jaReminder = ol.buildLanguageReminder("ja", { withTranslation: true });
check("末尾提醒用日语且点明第 1 行", jaReminder.includes("日语") && jaReminder.includes("第 1 行"));
check("末尾提醒带上 --- 分隔符要求", jaReminder.includes("---"));
check("中文/自动时不给提醒（不干扰中文用户）", ol.buildLanguageReminder("zh-cn") === "" && ol.buildLanguageReminder("") === "");

const noTrans = ol.buildLanguageReminder("ja");
check("非翻译场景的提醒更短（主聊天用）", noTrans.includes("日语") && !noTrans.includes("第 1 行"));

// ---------- 问候：语言提醒必须在最后一行 ----------
const parts = {
  timeStr: "2026/10/7 09:32:42",
  dayOfWeek: "星期三",
  ctx: "正在使用：VS Code",
  memoryBlock: "\n关于用户的记忆：\n- [habit] 早上背单词",
  comfortLine: "",
  outputLanguage: "ja",
};
const greet = pp.buildGreetingPrompt(parts);

check("问候 prompt 以语言提醒结尾", greet.trimEnd().endsWith(jaReminder), JSON.stringify(greet.slice(-60)));
check(
  "★ 语言提醒排在中文要求之后（口语化 / 不要像客服 都在它前面）",
  greet.indexOf(jaReminder) > greet.indexOf("口语化") && greet.indexOf(jaReminder) > greet.indexOf("不要像客服"),
);
check(
  "★ 提醒之后不再有任何中文要求",
  greet.slice(greet.indexOf(jaReminder) + jaReminder.length).trim() === "",
  JSON.stringify(greet.slice(greet.indexOf(jaReminder) + jaReminder.length)),
);
check("问候正文仍是中文 prompt（指令语言与输出语言无关）", greet.includes("[主动问候]") && greet.includes("自然地和用户打个招呼"));
check("旧的「把语言指令埋在中段」的写法已消失", !greet.includes("【最高优先级·最终指令】"));

// ---------- 抽卡点评：同一不变式 ----------
const card = { rarity: "SSR", theme: "晨光", baseText: "今天也要加油", aiText: "今天也要加油" };
const comment = pp.buildCardCommentPrompt(card, "ja");
check("抽卡点评 prompt 也以语言提醒结尾", comment.trimEnd().endsWith(jaReminder));
check("抽卡点评的提醒也在中文要求之后", comment.indexOf(jaReminder) > comment.indexOf("直接对用户说话"));
check("抽卡点评正文保留卡面信息", comment.includes("SSR") && comment.includes("晨光"));

// ---------- 中文用户：一个字都不能变 ----------
const zhGreet = pp.buildGreetingPrompt({ ...parts, outputLanguage: "zh-cn" });
check("中文时不追加提醒", !zhGreet.includes("[系统提醒"));
check("中文时问候正文以中文要求收尾", zhGreet.trimEnd().endsWith("不要说\"作为AI\"之类的话。"));
const autoGreet = pp.buildGreetingPrompt({ ...parts, outputLanguage: "" });
check("语言为自动时同样不追加提醒", autoGreet === zhGreet);

// ---------- 双保险：system 侧那份也不能丢 ----------
check(
  "system 侧指令与 buildLanguageInstruction 一致",
  pp.proactiveLangInstruction("ja") === jaInstruction,
);
check("中文时 system 侧指令为空（不干预）", pp.proactiveLangInstruction("zh-cn") === "");

// ---------- 出口覆盖检查：三条 AI 出口都必须带提醒 ----------
// 语言问题以前就是"某个出口漏了一条指令"——这里用源码级检查防止再漏。
const panelSrc = fs.readFileSync(path.join(__dirname, "..", "src", "assistant", "AssistantPanel.ts"), "utf8");
const greetingCall = /buildGreetingPrompt\(/;
const cardCall = /buildCardCommentPrompt\(/;
check("问候出口走 buildGreetingPrompt", greetingCall.test(panelSrc));
check("抽卡点评出口走 buildCardCommentPrompt", cardCall.test(panelSrc));
check("主聊天出口也用了末尾提醒", /buildLanguageReminder\(outLang/.test(panelSrc));
check(
  "三条出口都通过 proactivePrompts / 提醒函数带语言指令（没有裸 prompt 直拼）",
  (panelSrc.match(/proactiveLangInstruction\(/g) || []).length >= 2,
);

console.log(`\noutput-language: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
