/**
 * 日记本逻辑测试（不依赖浏览器/API）：
 * - 导出 Markdown 的内容与顺序
 * - 缺失日期检测（有事件但还没写日记）
 * - 日记开关 / 自动生成开关的门禁
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
  const r3 = await dm.checkAndGenerateDiary({ manual: true });
  check("手动补写在无 API 时写模板纪要", r3.length === 1 && r3[0].aiGenerated === false);
  check("生成后清掉当天事件", !store.has(eventsKey(-1)));
  check("模板日记带日期标题", r3[0].content.includes("的日记"));

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
