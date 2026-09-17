/**
 * 更新公告系统
 * 每次版本更新后首次打开弹出公告，之后不再显示。
 */

const ANNOUNCE_KEY = "petra-announced-version";

export interface Announcement {
  version: string;
  title: string;
  lines: string[];
}

/** 当前版本的公告内容 */
const ANNOUNCEMENTS: Announcement[] = [
  {
    version: "0.2.4",
    title: "🌸 Petra v0.2.4 更新",
    lines: [
      "【新增】",
      "· 桌宠跟唱（其实就是显示歌词，不消耗 token）。注意！！！只能从一开始播放开始跟踪，如果拖动了进度条会失效！！！在 交互 / 跟随音乐 里可以自己选择是否开启翻译。该功能也许有些羸弱，若有 bug 请反馈",
      "· 小游戏：立直麻将（玩玩就好，还在优化）。配置 API 后，桌宠还能实时读取牌况跟你互动（有限流，不会刷屏）",
      "",
      "【优化】",
      "· token 消耗",
      "· 人格化陪伴体验",
      "",
      "【未来计划】",
      "· mac 与 linux 的适配（手机端 emmm 老实说有点困难）",
      "· 更好的人格陪伴与日志",
      "· 可自定义的语音功能，让你的桌宠说话（兴许真能跟唱）",
      "",
      "【作者的话】",
      "我更新好慢...也有些被 gpt6 打击到了，感觉要不了多久就会被优化迭代，有点悲观，不过开始构思桌宠的时候又感到了神秘的美好（）",
      "嘛，还是会做下去的。我在想要是自己都不想打开那大伙肯定也不想打开，所以我在想怎么样才能让桌宠更具陪伴力。所以加了非常神秘的小游戏，当然也只是实验性。",
      "各位的反馈我都有收到，但是没有回复渠道可能有些神秘，不过我还是有好好看到的，比如眼睛看不到啊，天气指向不对啊等等。",
      "这个公告似乎有些长了，抱歉，感谢各位使用 petra 以及提供的反馈与建议。",
    ],
  },
  {
    version: "0.2.3",
    title: "✨ Petra v0.2.3 更新",
    lines: [
      "修复桌宠的多个交互与窗口问题：",
      "· 待机模式瞬移和出屏",
      "· 活动频率切换瞬移",
      "· 逗猫棒边缘闪动和穿出屏幕边界",
      "· cmd/PowerShell/reg/shutdown 子进程弹窗",
      "· 开机自启时弹出控制台窗口",
      "· 开机自启状态显示错误",
      "· 鼠标穿透状态未立即生效",
      "· 置顶状态不稳定",
      "· 启动加载阶段透明窗口拦截屏幕中央",
      "· 移除启动后诊断探针",
      "· 修正 SetWindowPos 参数类型错误",
      "",
      "自定义 API 更加兼容",
      "修复日记本不生成的问题",
    ],
  },
];


/**
 * 公告指纹：版本号 + 文案哈希。
 * 这样同一版本里改了公告文案也能重新弹一次，而不是因为"这个版本已读"就永远看不到。
 */
function contentKey(version: string, lines: string[]): string {
  const text = version + "\u0000" + lines.join("\n");
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${version}#${hash.toString(36)}`;
}

/** 未读公告：只看最新的一条（ANNOUNCEMENTS[0]，列表必须最新在前） */
export function getUnreadAnnouncement(): Announcement | null {
  const latest = ANNOUNCEMENTS[0];
  if (!latest) return null;
  // 注意：不要遍历整个列表去找"版本号不等于已读版本"的那条，
  // 否则已读过 0.2.4 之后会把更老的 0.2.3 当成未读弹出来。
  return localStorage.getItem(ANNOUNCE_KEY) === contentKey(latest.version, latest.lines) ? null : latest;
}

/** 标记当前版本公告已读 */
export function markAnnounced(version: string, lines: string[]): void {
  localStorage.setItem(ANNOUNCE_KEY, contentKey(version, lines));
}