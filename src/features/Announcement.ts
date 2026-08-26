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
    version: "0.2.2",
    title: "✨ Petra v0.2.2 更新",
    lines: [
      "🎴 新增今日抽卡功能 — 每天抽一张运势卡牌，图鉴收集全卡",
      "📖 新增日记本功能 — AI 根据每天互动自动生成日记（需配置 API）",
      "🔌 新增多家 API 供应商 — OpenAI、Moonshot、通义千问、Groq、Ollama 等",
      "🎨 模型调节（测试）— 模型设置中可调节物理幅度、发丝、胸腔等参数",
      "",
      "🗑️ 被遗忘的功能：把文件拖给桌宠，会帮你吃掉（送进回收站）~",
    ],
  },
];


export function getUnreadAnnouncement(): Announcement | null {
  const announced = localStorage.getItem(ANNOUNCE_KEY);
  // 从最新的开始找未读的
  for (const a of ANNOUNCEMENTS) {
    if (a.version !== announced) {
      return a;
    }
  }
  return null;
}

/** 标记当前版本公告已读 */
export function markAnnounced(version: string): void {
  localStorage.setItem(ANNOUNCE_KEY, version);
}