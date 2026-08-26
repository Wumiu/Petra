/**
 * 卡池定义
 * 预设卡牌 + 自定义图片支持。
 */

export type Rarity = "R" | "SR" | "SSR";

export interface CardDef {
  id: string;
  theme: string;
  emoji: string;
  baseText: string;
  rarity: Rarity;
  image?: string; // 自定义卡面图片路径
}

export const RARITY_RATES: Record<Rarity, number> = {
  R: 0.70,
  SR: 0.25,
  SSR: 0.05,
};

export const RARITY_COLORS: Record<Rarity, string> = {
  R: "#a8b8c8",
  SR: "#f0c040",
  SSR: "linear-gradient(135deg, #ff6b6b, #feca57, #48dbfb, #ff9ff3)",
};

export const RARITY_LABELS: Record<Rarity, string> = {
  R: "R · 普通",
  SR: "SR · 稀有",
  SSR: "SSR · 超稀有！",
};

/** 预设卡池 */
export const DEFAULT_POOL: CardDef[] = [
  // R 卡 (20张)
  { id: "starry_sky", theme: "星空", emoji: "✨ · ✦ · ✨\n·  ⭐  ·  ⭐  ·\n  ✦  ·  ✦\n⭐  ·  ·  ⭐\n✨ · ✦ · ✨", baseText: "今晚的星空很美，就像你的眼睛一样闪亮~", rarity: "R" },
  { id: "cat_nap", theme: "猫咪午睡", emoji: "    /\\_/\\  \n   (=^._.^=)\n    (\")  (\")~~zzZ", baseText: "喵~ 今天也要像猫咪一样，累了就休息哦。", rarity: "R" },
  { id: "coffee", theme: "咖啡时光", emoji: "    (  )\n   (    )\n  (______)\n   )    (\n  (______)", baseText: "喝杯咖啡，享受一个安静的下午吧~", rarity: "R" },
  { id: "rain", theme: "雨天", emoji: "  ☁ ☁ ☁\n 💧💧💧💧\n  💧💧💧\n~~~~~~~~~", baseText: "雨天也很好呀，可以窝在家里听雨声~", rarity: "R" },
  { id: "sunrise", theme: "日出", emoji: "     \\  |  /\n      \\ | /\n   --- ☀ ---\n      / | \\\n     /  |  \\", baseText: "新的一天开始了，今天也要元气满满哦！", rarity: "R" },
  { id: "flower", theme: "小花", emoji: "    🌸\n   🌸🌸🌸\n    🌸\n     |\n    /|\\", baseText: "送你一朵小花，愿你今天心情美美的~", rarity: "R" },
  { id: "moon", theme: "月亮", emoji: "      _.._\n    .'      '.\n   /   ☾  ☽   \\\n  |            |\n   '.        .'\n     '-....-'", baseText: "晚安好梦，月亮会替我守护你~", rarity: "R" },
  { id: "music", theme: "音乐", emoji: "  ♪ ♫ ♪\n ♫  ♪  ♫\n♪  ♫  ♪\n ♫  ♪  ♫\n  ♪ ♫ ♪", baseText: "戴上耳机，让音乐治愈一切吧~", rarity: "R" },
  { id: "book", theme: "读书", emoji: "  ┌────────┐\n  │ ╱╲  ╱╲ │\n  │╱  ╲╱  ╲│\n  │ ╲╱  ╲╱ │\n  │╱  ╲╱  ╲│\n  └────────┘", baseText: "今天读了什么好书吗？知识就是力量！", rarity: "R" },
  { id: "tea", theme: "下午茶", emoji: "    ) )\n   ( (\n    ) )\n  ──────\n  │    │\n  └────┘", baseText: "来杯热茶，放松一下吧~", rarity: "R" },
  { id: "star", theme: "星星", emoji: "      ✦\n     ✦✦✦\n      ✦\n       \n      ✦\n     ✦✦✦\n      ✦", baseText: "你是夜空中最亮的那颗星~", rarity: "R" },
  { id: "cloud", theme: "云朵", emoji: "     .--.\n  .-(    )-.\n (___.__)__))\n  (         )\n   '-.....-'", baseText: "像云朵一样自由自在地飘吧~", rarity: "R" },
  { id: "cookie", theme: "曲奇", emoji: "   .---.\n  /  o o  \\\n |  o  o  |\n  \\  o o  /\n   '---'", baseText: "送你一块小曲奇，甜甜蜜蜜每一天！", rarity: "R" },
  { id: "rainbow", theme: "彩虹", emoji: "      🌈\n   🌈    🌈\n  🌈      🌈\n 🌈        🌈\n🌈          🌈", baseText: "风雨过后总会有彩虹的！", rarity: "R" },
  { id: "leaf", theme: "落叶", emoji: "       🍃\n      🍃\n     🍃\n    🍃\n   🍃\n  🍃\n 🍃", baseText: "秋天的落叶也很美呢，每一片都是独一无二的~", rarity: "R" },
  { id: "snowflake", theme: "雪花", emoji: "   *  *  *\n  * * * * *\n *   *   *\n  * * * * *\n   *  *  *", baseText: "每一片雪花都是独特的，就像你一样~", rarity: "R" },
  { id: "pencil", theme: "画笔", emoji: "      /|\n     / |\n    /  |\n   /   |\n  /    |\n /_____|\n |  ●  |\n |_____|", baseText: "用画笔描绘你心中的美好世界吧！", rarity: "R" },
  { id: "heart", theme: "小心心", emoji: "   ♥♥   ♥♥\n  ♥  ♥ ♥  ♥\n  ♥   ♥   ♥\n   ♥     ♥\n    ♥   ♥\n     ♥ ♥\n      ♥", baseText: "送你一颗小心心，要开心哦！", rarity: "R" },
  { id: "butterfly", theme: "蝴蝶", emoji: "    \\   /\n     \\ /\n    (o o)\n    /   \\\n   /     \\\n  /       \\", baseText: "像蝴蝶一样自由自在地飞舞吧~", rarity: "R" },
  { id: "candle", theme: "烛光", emoji: "     🔥\n     |\n    | |\n    | |\n    | |\n   |___|", baseText: "烛光虽小，却能照亮整个世界~", rarity: "R" },

  // SR 卡 (10张)
  { id: "cherry_blossom", theme: "樱花", emoji: "  🌸  🌸  🌸\n 🌸 🌸🌸🌸 🌸\n🌸  🌸🌸🌸  🌸\n 🌸 🌸🌸🌸 🌸\n  🌸  🌸  🌸", baseText: "樱花飘落的速度是每秒五厘米，而我在想你的速度是每秒无数次~", rarity: "SR" },
  { id: "ocean", theme: "大海", emoji: "  ~~~~~~~~~~~~\n ~~~~~~~~~~~~~~\n~~~~~~~~~~~~~~~\n ~~~~~~~~~~~~~~\n  ~~~~~~~~~~~~", baseText: "大海那么大，装得下所有的烦恼。深呼吸，放松~", rarity: "SR" },
  { id: "mountain", theme: "登山", emoji: "       /\\\n      /  \\\n     /    \\\n    /  ☁   \\\n   /        \\\n  /          \\\n /____________\\", baseText: "山再高，一步步也能登顶。今天也要加油哦！", rarity: "SR" },
  { id: "garden", theme: "花园", emoji: "  🌷🌻🌹🌺🌸\n 🌷🌻🌹🌺🌸🌷\n🌷🌻🌹🌺🌸🌷🌻\n  🌷🌻🌹🌺🌸", baseText: "你的内心就像一座花园，种满了美好的事物~", rarity: "SR" },
  { id: "telescope", theme: "望远镜", emoji: "   ★ · ★ · ★\n  · ★ · ★ · \n    ╱═══╲\n   ╱ ═══ ╲\n  ╱═══════╲", baseText: "用望远镜看星星，用放大镜看你的优点~你超棒的！", rarity: "SR" },
  { id: "campfire", theme: "篝火", emoji: "     🔥🔥🔥\n    🔥🔥🔥🔥\n   🔥🔥🔥🔥🔥\n  ───────────\n  │  ┌───┐  │\n  └──┘   └──┘", baseText: "围坐在篝火旁，听故事的夜晚最温馨~", rarity: "SR" },
  { id: "piano", theme: "钢琴", emoji: "  ┌─┬─┬┬─┬─┬─┬─┬┬─┬─┐\n  │ │█│││█│ │█│││█│ │\n  │ │█│││█│ │█│││█│ │\n  │ └┘ └┘└┘ └┘ └┘└┘ │\n  └─────────────────┘", baseText: "弹一首喜欢的曲子，让心情随音乐起舞~", rarity: "SR" },
  { id: "library", theme: "图书馆", emoji: "  ┌──────┐\n  │██████│\n  │──────│\n  │██████│\n  │──────│\n  │██████│\n  └──────┘", baseText: "图书馆里藏着无限的可能，去探索吧！", rarity: "SR" },
  { id: "sunflower", theme: "向日葵", emoji: "    🌻\n   🌻🌻🌻\n  🌻  🌻  🌻\n   🌻🌻🌻\n    |  |\n    |  |\n   /|  |\\", baseText: "像向日葵一样，永远面朝阳光！", rarity: "SR" },
  { id: "galaxy", theme: "星系", emoji: "  · ★  ·  ★ ·\n ★  · ✦ ·  ★\n  · ★ · ★ · ★\n★  · ★ ·  ★\n  · ★  ·  ★ ·", baseText: "在浩瀚的宇宙中，你是最特别的存在~", rarity: "SR" },

  // SSR 卡 (5张)
  { id: "aurora", theme: "极光", emoji: "≋≋≋≋≋≋≋≋≋≋\n 🌈✨极光✨🌈\n≋≋≋≋≋≋≋≋≋≋\n  ✨  ✨  ✨", baseText: "你见过极光吗？那是宇宙写给地球的情书。而你，是我生命中最美的风景~", rarity: "SSR" },
  { id: "phoenix", theme: "凤凰", emoji: "       🔥\n      🔥🔥\n     🔥🔥🔥\n    🔥  🔥  🔥\n   🔥    🔥    🔥\n  🔥      🔥      🔥", baseText: "凤凰涅槃，浴火重生。无论遇到什么困难，你都能重新站起来！", rarity: "SSR" },
  { id: "diamond", theme: "钻石", emoji: "      ◇\n     ◆◆◆\n    ◆◆◆◆◆\n     ◆◆◆\n      ◆", baseText: "你就像钻石一样，在压力下闪耀出最美的光芒！", rarity: "SSR" },
  { id: "cosmos", theme: "宇宙", emoji: "  ✧ · ★ · ✧\n ·  ☆  ·  ☆  ·\n★  ·  ✦  ·  ★\n ·  ☆  ·  ☆  ·\n  ✧ · ★ · ✧", baseText: "整个宇宙都在为你闪耀，因为你值得所有的美好！", rarity: "SSR" },
  { id: "dragon", theme: "神龙", emoji: "    ╱╲   ╱╲\n   ╱  ╲_╱  ╲\n  ╱    🐉    ╲\n ╱   ╱    ╲   ╲\n╱   ╱      ╲   ╲", baseText: "神龙现身！许个愿吧，今天的运气会超级好！", rarity: "SSR" },
];

/** 获取卡池（预设 + 自定义） */
export function getCardPool(): CardDef[] {
  return [...DEFAULT_POOL, ...loadCustomCards()];
}

/** 加载自定义卡牌（从 localStorage） */
function loadCustomCards(): CardDef[] {
  try {
    const raw = localStorage.getItem("petra-custom-cards");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** 保存自定义卡牌 */
export function saveCustomCard(card: CardDef): void {
  const cards = loadCustomCards();
  cards.push(card);
  localStorage.setItem("petra-custom-cards", JSON.stringify(cards));
}

/** 按稀有度获取卡牌 */
export function getCardsByRarity(rarity: Rarity): CardDef[] {
  return getCardPool().filter(c => c.rarity === rarity);
}

/** 根据概率随机选择稀有度 */
export function rollRarity(): Rarity {
  const rand = Math.random();
  let sum = 0;
  for (const [rarity, rate] of Object.entries(RARITY_RATES)) {
    sum += rate;
    if (rand < sum) return rarity as Rarity;
  }
  return "R";
}

/** 从指定稀有度中随机选一张卡 */
export function rollCard(rarity: Rarity): CardDef {
  const pool = getCardsByRarity(rarity);
  return pool[Math.floor(Math.random() * pool.length)];
}
