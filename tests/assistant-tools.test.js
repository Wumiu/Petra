/**
 * 小助手工具调用运行时测试（纯逻辑，不需要浏览器/API）：
 * - 参数校验：未知工具 / 缺必填参数 / 空串 / 数字 0
 * - 结果截断：默认上限 + 按工具覆盖
 * - 参数解析：非法 JSON / 数组 / 空串都要有明确结果
 * - 调用指纹：键顺序无关，用于识别重复调用
 * - 循环预算：轮数、次数、重复提示、收尾说明
 *
 * 运行：npm run test:assistant
 */
const fs = require("fs");
const path = require("path");
const rt = require("./build/assistant/toolRuntime.js");
const ac = require("./build/assistant/AssistantClient.js");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
};

// ---------- 工具清单 ----------
check("工具清单非空", rt.toolNames().length >= 18, rt.toolNames().length + " 个");
check("认识的工具", rt.isKnownTool("run_shell") && rt.isKnownTool("view_diary"));
check("不认识编造的工具", !rt.isKnownTool("get_time") && !rt.isKnownTool("browse_web"));

// ---------- 参数校验 ----------
const unknown = rt.validateToolArgs("get_time", {});
check("未知工具被拦下", unknown.ok === false);
check("未知工具提示带可用工具", !unknown.ok && unknown.message.includes("未知工具") && unknown.message.includes("run_shell") && unknown.message.includes("不要编造"));

const miss = rt.validateToolArgs("run_shell", {});
check("缺必填参数被拦下", miss.ok === false && miss.message.includes("缺少必填参数") && miss.message.includes("command"));
const blank = rt.validateToolArgs("open_url", { url: "   " });
check("空字符串算缺失", blank.ok === false);
const zero = rt.validateToolArgs("set_reminder", { minutes: 0, message: "喝 water" });
check("数字 0 不算缺失", zero.ok === true);
check("无必填参数的工具通过", rt.validateToolArgs("get_weather", {}).ok === true);
check("参数齐全通过", rt.validateToolArgs("run_shell", { command: "dir" }).ok === true);
check("每个工具都有规格", rt.toolNames().every((n) => typeof rt.TOOL_SPECS[n] === "object"));

// ---------- 结果截断 ----------
const short = "ok: 3 files";
check("短结果不动", rt.truncateToolResult("run_shell", short) === short);

const long = "A".repeat(3000) + "中".repeat(3000) + "Z".repeat(3000);
const cut = rt.truncateToolResult("get_weather", long);
check("长结果被截断", cut.length < long.length);
check("截断有省略提示", cut.includes("省略"));
check("截断保留开头", cut.startsWith("A"));
check("截断保留结尾", cut.endsWith("Z"));
check("截断长度接近上限", cut.length <= rt.TOOL_SPECS.get_weather.maxResultChars + 60, String(cut.length));

const medium = "x".repeat(3000);
check("按工具覆盖上限（run_shell 4000 不截断）", rt.truncateToolResult("run_shell", medium) === medium);
check("默认上限对无配置工具生效", rt.truncateToolResult("set_volume", "y".repeat(3000)).includes("省略"));

// ---------- 参数解析 ----------
const okArgs = rt.parseArgsSafe('{"command":"dir"}');
check("合法 JSON 解析", okArgs.error === undefined && okArgs.args.command === "dir");
const emptyArgs = rt.parseArgsSafe("");
check("空参数不报错", emptyArgs.error === undefined && Object.keys(emptyArgs.args).length === 0);
const badArgs = rt.parseArgsSafe('{"command": "dir"');
check("非法 JSON 有原因", typeof badArgs.error === "string" && badArgs.error.includes("JSON"), String(badArgs.error));
check("非法 JSON 参数退化为空对象", Object.keys(badArgs.args).length === 0);
const arrArgs = rt.parseArgsSafe("[1,2]");
check("数组参数被拒", typeof arrArgs.error === "string" && arrArgs.error.includes("JSON 对象"));

// ---------- 错误措辞 ----------
const errText = rt.formatToolError("open_path", "路径不存在", "请确认路径后重试");
check("错误文本含工具名/原因/提示", errText.includes("open_path") && errText.includes("路径不存在") && errText.includes("提示："));
check("没有提示时不加提示行", !rt.formatToolError("open_path", "路径不存在").includes("提示："));

// ---------- 调用指纹 ----------
check("指纹与键顺序无关", rt.callSignature("set_volume", { level: 1, mute: false }) === rt.callSignature("set_volume", { mute: false, level: 1 }));
check("指纹区分参数", rt.callSignature("set_volume", { level: 1 }) !== rt.callSignature("set_volume", { level: 2 }));

// ---------- 循环预算 ----------
const b = new rt.ToolLoopBudget({ maxRounds: 3, maxCalls: 4 });
check("轮数预算可达上限", b.nextRound() && b.nextRound() && b.nextRound() && !b.nextRound());
check("初始剩余次数", new rt.ToolLoopBudget({ maxCalls: 4 }).remainingCalls() === 4);

const b2 = new rt.ToolLoopBudget({ maxRounds: 5, maxCalls: 2 });
check("首次调用无提示", b2.noteCall("get_weather", {}) === "");
check("重复调用给提示", b2.noteCall("get_weather", {}).includes("不要重复调用"));
check("次数预算用尽", b2.canCall() === false && b2.remainingCalls() === 0);
check("用尽后有收尾说明", b2.exhaustedNote().includes("上限"));
check("还有余量时没有收尾说明", new rt.ToolLoopBudget({ maxCalls: 9 }).exhaustedNote() === "");
check("不同参数不误判重复", new rt.ToolLoopBudget({ maxCalls: 9 }).noteCall("get_weather", { city: "上海" }) === "" && new rt.ToolLoopBudget({ maxCalls: 9 }).noteCall("get_weather", { city: "北京" }) === "");

// ---------- 与模型可见的工具表对齐 ----------
// 如果运行时表里少了某个工具，模型一调用就会被当成"未知工具"拦下，所以这里做交叉检查。
const clientSrc = fs.readFileSync(path.join(__dirname, "..", "src", "assistant", "AssistantClient.ts"), "utf8");
const declared = [...clientSrc.matchAll(/^ {6}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
check("能从源码里读出工具表", declared.length >= 18, declared.length + " 个");
const missingSpec = declared.filter((n) => !rt.isKnownTool(n));
check("每个模型可见的工具都有运行时规格", missingSpec.length === 0, missingSpec.join(","));
const extraSpec = rt.toolNames().filter((n) => !declared.includes(n));
check("运行时表里没有多余工具", extraSpec.length === 0, extraSpec.join(","));

// ---------- 供应商就绪判断（免 Key 的本地模型不能被当成"没配置"）----------
check("ollama 免 Key", ac.isKeylessProvider("ollama") === true);
check("openai 需要 Key", ac.isKeylessProvider("openai") === false);
check("自定义指向 127.0.0.1 免 Key", ac.isKeylessProvider("custom", "http://127.0.0.1:1234/v1") === true);
check("自定义指向 localhost 免 Key", ac.isKeylessProvider("custom", "http://localhost:8080/v1") === true);
check("自定义指向远端需要 Key", ac.isKeylessProvider("custom", "https://api.example.com/v1") === false);
check("自定义空地址需要 Key", ac.isKeylessProvider("custom", "") === false);

check("ollama 空 Key 也算就绪", ac.isProviderReady({ provider: "ollama" }, "") === true);
check("openai 空 Key 不就绪", ac.isProviderReady({ provider: "openai" }, "") === false);
check("openai 有 Key 就绪", ac.isProviderReady({ provider: "openai" }, "sk-x") === true);
check("纯空白 Key 不算就绪", ac.isProviderReady({ provider: "openai" }, "   ") === false);
check("undefined Key 不炸", ac.isProviderReady({ provider: "deepseek" }, undefined) === false);
check("本机自定义端点空 Key 就绪", ac.isProviderReady({ provider: "custom", customBaseUrl: "http://127.0.0.1:11434/v1" }, "") === true);
check("远端自定义端点空 Key 不就绪", ac.isProviderReady({ provider: "custom", customBaseUrl: "https://x.example/v1" }, "") === false);

console.log("assistant-tools: pass=" + (fail === 0 ? "all" : "has failures") + " fail=" + fail);
process.exit(fail ? 1 : 0);
