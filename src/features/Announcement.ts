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