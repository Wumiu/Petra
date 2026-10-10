/**
 * "主人正在用什么软件"的判断与清洗。
 *
 * 桌宠窗口是**置顶**的：用户点它、用小助手面板时它就变成前台窗口，于是
 * `active_window_title` 会返回 `Petra [petra.exe]`。模型看到"窗口标题：Petra"
 * 就以为主人在用另一个叫 Petra 的软件，主动问候里于是反复出现"Petra 还开着呢"——
 * 可它自己就是 Petra（应用名）。这里统一把"自己"从这类信息里摘掉，
 * 并把窗口标题翻译成软件短名，供问候 / 日记 / 工具结果三处共用。
 */

/** 桌宠自己的进程名（`active_window_title` 会把它附在方括号里） */
const SELF_EXE = ["petra.exe", "petra"];
/**
 * 拿不到进程名时的兜底：**精确匹配标题**。
 * 不用 includes —— 浏览器里"…的 Petra 仓库"这种标题讲的是别的东西，误判会让桌宠
 * 装作没看见主人正在看它的仓库。
 */
const SELF_TITLE = ["petra"];

/** 这条前台窗口信息是不是桌宠自己 */
export function isOwnWindow(rawTitle: string): boolean {
  const raw = (rawTitle || "").trim();
  if (!raw) return false;
  const exe = /\[([^\]]+)\]\s*$/.exec(raw);
  // 有进程名就只认进程名（最权威）
  if (exe) return SELF_EXE.includes(exe[1].trim().toLowerCase());
  return SELF_TITLE.includes(raw.toLowerCase());
}

/**
 * 喂给模型的"前台窗口"文本。
 * 是自己 → 明说"那是我自己的窗口"，而不是把标题丢过去让模型猜（猜就会说"Petra 还开着呢"）。
 */
export function frontWindowForModel(rawTitle: string): string {
  return isOwnWindow(rawTitle) ? "（前台是桌宠自己的窗口，主人没在用别的软件）" : rawTitle || "";
}

/**
 * 从窗口标题猜"主人在用哪个软件"。
 * Windows 标题惯例是 "文档名 - 应用名"，取最后一段；常见软件统一成短名字，
 * 这样日记里的时间线读起来是"你在 VS Code 里泡了一下午"，而不是一串文件名。
 */
export function appNameFromTitle(title: string): string {
  const raw = (title || "").trim();
  if (!raw) return "";
  const seg = raw.split(" - ").pop()?.trim() || raw;
  const tl = seg.toLowerCase();
  const known: Array<[string[], string]> = [
    [["visual studio code", "vscode", "code.exe"], "VS Code"],
    [["chrome", "edge", "firefox", "brave"], "浏览器"],
    [["wechat", "微信"], "微信"],
    [["qq"], "QQ"],
    [["steam"], "Steam"],
    [["bilibili", "哔哩哔哩"], "B站"],
    [["netease", "网易云"], "网易云音乐"],
    [["word"], "Word"],
    [["excel"], "Excel"],
    [["powerpoint"], "PowerPoint"],
    [["powershell", "terminal", "cmd", "windows terminal"], "终端"],
    [["explorer", "文件资源管理器"], "文件管理器"],
    [["typora", "obsidian", "notion"], "笔记"],
  ];
  for (const [keys, name] of known) {
    if (keys.some((k) => tl.includes(k))) return name;
  }
  return seg.slice(0, 20);
}
