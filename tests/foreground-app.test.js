/**
 * "主人在用什么软件"的纯逻辑测试：
 * - 桌宠自己的窗口必须被识别出来（用户点桌宠时它就是前台窗口）
 * - 不能被标题里带 Petra 的**别的**窗口带偏（例如浏览器里"我的 Petra 仓库"）
 * - 标题 → 软件短名 的映射
 *
 * 背景：主动问候会把前台窗口喂给模型，之前它会说"Petra 还开着呢"——它自己就是 Petra。
 *
 * 运行：npm run test:app
 */
const fg = require("./build/utils/foregroundApp.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 桌宠自己 ----------
check("★ 桌宠自己的窗口（Rust 的真实格式：标题 [进程名]）", fg.isOwnWindow("Petra [petra.exe]") === true);
check("★ 大小写不敏感", fg.isOwnWindow("PETRA [PETRA.EXE]") === true);
check("★ 只有进程名也能认出来", fg.isOwnWindow("随便什么标题 [petra.exe]") === true);
check("标题恰好是 Petra（拿不到进程名时）", fg.isOwnWindow("petra") === true);
check("空串不算自己", fg.isOwnWindow("") === false);
check("undefined 不炸", fg.isOwnWindow(undefined) === false);

// ---------- 不能误判：标题里带 Petra 的别的窗口 ----------
check("浏览器里看 Petra 仓库不算自己", fg.isOwnWindow("Wumiu/Petra: 桌面宠物 - Google Chrome [chrome.exe]") === false);
check("没有进程名时也不按 includes 判", fg.isOwnWindow("我的 Petra 仓库 - 浏览器") === false);
check("普通软件照旧", fg.isOwnWindow("main.ts - petra-project - Visual Studio Code [Code.exe]") === false);

// ---------- 喂给模型的文本 ----------
check("★ 是自己时明说是自己", fg.frontWindowForModel("Petra [petra.exe]").includes("桌宠自己的窗口"));
check("是别人时原样透传", fg.frontWindowForModel("某文档 - Word [WINWORD.EXE]") === "某文档 - Word [WINWORD.EXE]");
check("空串透传成空串", fg.frontWindowForModel("") === "");

// ---------- 标题 → 软件短名 ----------
check("VS Code", fg.appNameFromTitle("main.ts - Petra - Visual Studio Code") === "VS Code");
check("浏览器（取最后一段）", fg.appNameFromTitle("某页面 - Google Chrome") === "浏览器");
check("B站", fg.appNameFromTitle("首页 - 哔哩哔哩") === "B站");
check("终端", fg.appNameFromTitle("PowerShell") === "终端");
check("不认识的软件截断到 20 字", fg.appNameFromTitle("A - SomeVeryLongUnknownAppName").length <= 20);
check("空标题给空串", fg.appNameFromTitle("") === "");

console.log("foreground-app: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
