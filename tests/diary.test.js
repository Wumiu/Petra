/**
 * 日记本逻辑测试（不依赖浏览器/API）：
 * - 导出 Markdown 的内容与顺序
 * - 缺失日期检测（有记录但还没写日记）
 * - 门禁：没配 API Key / 关掉日记 / 关掉自动生成都不写
 * - 素材采集：前台应用时长聚合、听歌去重计数
 * - 提示词组装：时间线、复盘要求、字符预算
 * - localStorage 配额不足时的降级保存与告警
 *
 * 运行：npm run test:diary
 */
const Module = require("module");
// DiaryManager 会 invoke("get_api_key")，测试里直接桩掉 Tauri API
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@tauri-apps/api/core") return { invoke: async () => "" };
  return origLoad.apply(this, arguments);
};

const store = new Map();
global.localStorage = {
  get length() { return store.size; },
  key: (i) => Array.from(store.keys())[i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const dm = require("./build/features/diary/DiaryManager.js");
const tr = require("./build/features/diary/DiaryEventTracker.js");
const dg = require("./build/features/diary/DiaryDigest.js");

const SETTINGS_KEY = "live2d-pet-settings";
const DIARY_KEY = "petra-diaries";
let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};
const dstr = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};
const reset = () => {
  store.clear();
  while (dm.takeDiaryStorageWarning() !== null) { /* 清掉遗留告警 */ }
};
const eventsKey = (offsetDays) => "petra-diary-events-" + dstr(offsetDays);
const evt = () => JSON.stringify([{ type: "chat", summary: "聊了天", timestamp: Date.now() }]);

(async () => {
  reset();
  check("空日记本导出有提示", dm.diariesToMarkdown().includes("还没有日记"));

  reset();
  store.set(DIARY_KEY, JSON.stringify([
    { date: dstr(-2), content: "前天的事", aiGenerated: false, createdAt: Date.now() },
    { date: dstr(-1), content: "昨天的事", aiGenerated: true, createdAt: Date.now() },
  ]));
  const md = dm.diariesToMarkdown();
  check("导出含日期", md.includes(dstr(-1)) && md.includes(dstr(-2)));
  check("导出含 AI/简单纪要标签", md.includes("AI 生成") && md.includes("简单纪要"));
  check("导出按日期倒序", md.indexOf(dstr(-1)) < md.indexOf(dstr(-2)));
  check("导出含正文", md.includes("昨天的事") && md.includes("前天的事"));

  reset();
  store.set(eventsKey(-2), evt());
  store.set(eventsKey(-1), evt());
  store.set(DIARY_KEY, JSON.stringify([{ date: dstr(-1), content: "昨天写过了", aiGenerated: true, createdAt: Date.now() }]));
  const missing = dm.listMissingDiaryDates();
  check("只报缺日记且有事件的那天", missing.length === 1 && missing[0] === dstr(-2), JSON.stringify(missing));

  reset();
  store.set(eventsKey(-1), evt());
  store.set(SETTINGS_KEY, JSON.stringify({ diary: { enabled: false } }));
  const r1 = await dm.checkAndGenerateDiary();
  check("关闭日记时不生成", r1.length === 0);
  check("关闭日记时保留原始事件", store.has(eventsKey(-1)));
  store.set(SETTINGS_KEY, JSON.stringify({ diary: { autoGenerate: false } }));
  const r2 = await dm.checkAndGenerateDiary();
  check("关闭自动生成时不自动写", r2.length === 0);
  // 没配 API Key（桩里 get_api_key 返回空）→ 日记只由大模型写，什么都不生成，素材保留
  const r3 = await dm.checkAndGenerateDiary({ manual: true });
  check("没配 API 时不写日记", r3.length === 0, JSON.stringify(r3));
  check("没配 API 时保留素材", store.has(eventsKey(-1)));
  check("没配 API 时 hasApiKey 为假", (await dm.hasApiKey()) === false);
  check("本来就没有日记", dm.loadDiaries().length === 0);

  // ---------- 素材采集：应用用量 ----------
  reset();
  tr.trackAppUse("VS Code", 5);
  tr.trackAppUse("VS Code", 5);
  tr.trackAppUse("浏览器", 30);
  const apps = tr.getAppUsage();
  check("应用用量按时长聚合", apps.length === 2 && apps[0].app === "浏览器" && apps[0].minutes === 30, JSON.stringify(apps));
  check("应用用量累计同一软件", apps.find((a) => a.app === "VS Code").minutes === 10);
  check("应用用量按多少排序", apps[0].minutes >= apps[1].minutes);
  tr.trackAppUse("", 5);
  check("空应用名不记", tr.getAppUsage().length === 2);

  // ---------- 素材采集：听歌 ----------
  reset();
  tr.trackMusic("Yesterday", "The Beatles");
  tr.trackMusic("Yesterday", "The Beatles");
  tr.trackMusic("晴天", "周杰伦");
  const tracks = tr.getMusicTracks();
  check("听歌去重计数", tracks.length === 2 && tracks[0].count === 2, JSON.stringify(tracks));
  check("歌名带艺人", tracks[0].label.includes("Yesterday") && tracks[0].label.includes("The Beatles"));
  tr.trackMusic("", "");
  check("空歌名不记", tr.getMusicTracks().length === 2);

  // ---------- 提示词组装 ----------
  reset();
  const prompt = dg.buildDiaryPrompt({
    date: dstr(-1),
    persona: "爱撒娇的猫娘",
    nickname: "主人",
    events: [
      { type: "chat", summary: "聊了毕业论文", timestamp: Date.now() },
      { type: "reminder_done", summary: "喝水", timestamp: Date.now() },
      { type: "game", summary: "陪你玩了🀄立直麻将", timestamp: Date.now() },
      { type: "interaction", summary: "被摸了7次头", timestamp: Date.now() },
    ],
    apps: [{ app: "VS Code", minutes: 130 }, { app: "浏览器", minutes: 40 }],
    tracks: [{ label: "Yesterday - The Beatles", count: 2 }],
    previousTail: "明天也要一起加油。",
  });
  check("提示词含时间线", prompt.includes("【今天的时间线】") && prompt.includes("VS Code（约 2 小时 10 分）"));
  check("提示词含软件时长", prompt.includes("浏览器（40 分钟）"));
  check("提示词含听歌", prompt.includes("【今天的时间线】") && prompt.includes("Yesterday"));
  check("提示词含小游戏", prompt.includes("小游戏：陪你玩了 1 局"));
  check("提示词含摸头", prompt.includes("被摸了7次头"));
  check("提示词含聊天摘要", prompt.includes("【我们聊过的事】") && prompt.includes("聊了毕业论文"));
  check("提示词含上一篇结尾", prompt.includes("上一篇日记的结尾") && prompt.includes("明天也要一起加油"));
  check("提示词含人设与称呼", prompt.includes("爱撒娇的猫娘") && prompt.includes("主人"));
  check("提示词要求先复盘", prompt.includes("先在心里把上面的线索过一遍"));
  check("提示词禁止清单与系统词", prompt.includes("不要罗列清单") && prompt.includes("不要提"));
  check("提示词不含占位符", !/\{[a-z]+\}/.test(prompt));

  check("分钟格式化：少于 1 小时", dg.formatMinutes(40) === "40 分钟", dg.formatMinutes(40));
  check("分钟格式化：整小时", dg.formatMinutes(120) === "约 2 小时", dg.formatMinutes(120));
  check("分钟格式化：带零头", dg.formatMinutes(130) === "约 2 小时 10 分", dg.formatMinutes(130));
  check("分钟格式化：0", dg.formatMinutes(0) === "0 分钟");
  check("空用量不给时间线", dg.formatAppUsage([]) === "" && dg.formatMusic([]) === "");
  check("时间线为空时不出现该段", !dg.buildDiaryPrompt({ events: [] }).includes("【今天的时间线】"));

  const manyEvents = Array.from({ length: 60 }, (_, i) => ({ type: "chat", summary: "第" + i + "条聊天记录", timestamp: Date.now() + i }));
  const digest = dg.buildEventDigest(manyEvents);
  check("事件摘要按预算截断", digest.shown < 60 && digest.dropped === 60 - digest.shown, JSON.stringify({ shown: digest.shown, dropped: digest.dropped }));
  check("事件摘要报告省略条数", dg.buildDiaryPrompt({ events: manyEvents }).includes("条零碎记录没有列出"));

  reset();
  const now = Date.now();
  // 近期日记的快照要保留（重新生成用），总长度超配额 → 逼出降级分支
  store.set(DIARY_KEY, JSON.stringify([
    { date: dstr(-1), content: "昨天", aiGenerated: true, createdAt: now, events: [{ type: "chat", summary: "x".repeat(600), timestamp: now }] },
    { date: dstr(-2), content: "前天", aiGenerated: true, createdAt: now, events: [{ type: "chat", summary: "y".repeat(600), timestamp: now }] },
  ]));
  const realSet = global.localStorage.setItem;
  global.localStorage.setItem = (k, v) => {
    if (String(v).length > 400) {
      const e = new Error("QuotaExceededError");
      e.name = "QuotaExceededError";
      throw e;
    }
    realSet(k, v);
  };
  dm.deleteDiary(dstr(-2));
  global.localStorage.setItem = realSet;
  const warn = dm.takeDiaryStorageWarning();
  check("超配额时给出降级告警", typeof warn === "string" && warn.includes("存储空间"), String(warn));
  const stored = JSON.parse(store.get(DIARY_KEY));
  check("降级后日记仍保存", stored.length === 1 && stored[0].date === dstr(-1));
  check("降级不丢正文", stored[0].content === "昨天");
  check("降级丢掉事件快照", !stored[0].events || stored[0].events.length === 0);
  check("告警只报一次", dm.takeDiaryStorageWarning() === null);

  console.log("diary: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
  process.exit(fail ? 1 : 0);
})();
