/**
 * 麻将桌上的 AI 实时互动（可选，仅在配置了 API Key 时启用）。
 *
 * 省 token + 不打扰的设计：
 * - 轻量提示词：system 里只有人设 + 一句任务约束，不带 BASE_PROMPT、不带工具定义、不带记忆；
 * - 只在少数高价值事件点评（开局/立直/鸣牌/和了/流局/中段），全局最小间隔 + 每局上限 + 每场上限；
 * - 牌况快照尽量短（手牌按花色压缩，只给"桌宠"的公开信息，不泄露它的暗牌）；
 * - 小助手正在对话中（busy）时直接跳过，避免抢话。
 */
import { invoke } from "@tauri-apps/api/core";
import { chatStream } from "../../assistant/AssistantClient";
import { loadSettings } from "../../utils/settings";
import type { RiichiGame } from "./engine";
import { isHonor, rankOf, suitOf } from "./tiles";

/** 两次 AI 点评的最小间隔（毫秒）：宁可少说，也别刷屏 */
const MIN_INTERVAL_MS = 18_000;
/** 每局最多点评次数 */
const MAX_PER_HAND = 3;
/** 每场（一个游戏窗口）最多点评次数 */
const MAX_PER_SESSION = 20;
/** 模型表示"没什么可说"的暗号：收到它就整句不出 */
const SILENCE_TOKEN = "沉默";
/** 单次请求超时（毫秒） */
const TIMEOUT_MS = 20_000;

const HONOR_CHARS = ["东", "南", "西", "北", "白", "发", "中"];

let apiKeyCache: string | null = null;
let apiKeyCachedAt = 0;
/** Key 缓存有效期：设置里改了 Key 也能自动生效（无需重开游戏） */
const KEY_TTL_MS = 60_000;
let lastTalkAt = 0;
let talksThisHand = 0;
let talksThisSession = 0;
let countedHandNo = -1;
let inFlight = false;
/** 最近说过的几句台词：喂回提示词避免复读（比记忆省得多） */
const recentLines: string[] = [];

/** 清空计数（重开一局/新开一场时调用） */
export function resetPetTalk(): void {
  talksThisHand = 0;
  talksThisSession = 0;
  countedHandNo = -1;
  lastTalkAt = 0;
  inFlight = false;
  recentLines.length = 0;
}

let wantedCache = { value: false, at: 0 };

/**
 * 同步判断（只看设置，不查 Key，2 秒记忆化）：
 * 用于在异步探测 API Key 之前就决定"走 AI 吐槽还是本地台词池"。
 */
export function petTalkWanted(): boolean {
  const now = Date.now();
  if (now - wantedCache.at > 2000) {
    const s = loadSettings();
    wantedCache = { value: s.gameTalk !== false && s.assistant.enabled === true, at: now };
  }
  return wantedCache.value;
}

/** 是否具备 AI 互动条件：助手已开启 + 设置允许 + 存在 API Key */
export async function petTalkAvailable(): Promise<boolean> {
  const s = loadSettings();
  if (!s.assistant.enabled) return false;
  if (s.gameTalk === false) return false;
  if (apiKeyCache === null || Date.now() - apiKeyCachedAt > KEY_TTL_MS) {
    try {
      apiKeyCache = await invoke<string>("get_api_key");
    } catch {
      apiKeyCache = "";
    }
    apiKeyCachedAt = Date.now();
  }
  return !!apiKeyCache;
}

/** API Key 可能在设置里被改过，切换游戏时重新读一次 */
export function clearPetTalkKeyCache(): void {
  apiKeyCache = null;
  apiKeyCachedAt = 0;
}

/** 手牌压缩表示：万123 筒345 索678 东东（尽量短） */
function compactHand(tiles: number[]): string {
  const buckets: string[][] = [[], [], [], []];
  for (const t of tiles) {
    const s = suitOf(t);
    buckets[s].push(isHonor(t) ? HONOR_CHARS[rankOf(t) - 1] : String(rankOf(t)));
  }
  const names = ["万", "筒", "索"];
  const out: string[] = [];
  for (let s = 0; s < 3; s++) if (buckets[s].length) out.push(names[s] + buckets[s].join(""));
  if (buckets[3].length) out.push(buckets[3].join(""));
  return out.join(" ");
}

/** 组装紧凑牌况（给模型看的最小信息） */
export function buildSnapshot(game: RiichiGame, reason: string): string {
  const me = game.players[0];
  const pet = game.players[1];
  const lines: string[] = [];
  lines.push(
    `第${game.handNo}局 · 余牌${game.wall.length} · 你${me.score} / 桌宠${pet.score}`,
  );
  lines.push(`我的手牌：${compactHand(me.hand) || "（无）"}`);
  const waits = game.waitsHint(0);
  if (waits.length > 0) lines.push(`我已听牌，等：${waits.map((t) => compactHand([t])).join("、")}`);
  lines.push(`我的副露${me.melds.length}组，牌河${me.discards.length}张；桌宠副露${pet.melds.length}组，牌河${pet.discards.length}张`);
  lines.push(`我${me.riichi ? "已立直" : "未立直"}；桌宠${pet.riichi ? "已立直" : "未立直"}`);
  if (game.doraIndicators.length > 0) {
    lines.push(`宝牌指示牌：${game.doraIndicators.map((t) => compactHand([t])).join(" ")}`);
  }
  lines.push(`刚发生：${reason}`);
  return lines.join("\n");
}

/**
 * 请求一次 AI 点评。返回 null 表示本次跳过（节流 / 不可用 / 失败 / 助手正忙）。
 * 调用方负责把返回的台词显示出来。
 */
export async function requestPetTalk(
  game: RiichiGame,
  reason: string,
  busy: boolean,
): Promise<string | null> {
  if (inFlight || busy) return null;
  if (!(await petTalkAvailable())) return null;

  if (countedHandNo !== game.handNo) {
    countedHandNo = game.handNo;
    talksThisHand = 0;
  }
  const now = Date.now();
  if (now - lastTalkAt < MIN_INTERVAL_MS) return null;
  if (talksThisHand >= MAX_PER_HAND) return null;
  if (talksThisSession >= MAX_PER_SESSION) return null;

  const s = loadSettings();
  const key = apiKeyCache ?? "";
  if (!key) return null;

  inFlight = true;
  lastTalkAt = now;
  talksThisHand++;
  talksThisSession++;

  const persona = s.assistant.persona?.trim();
  const system =
    (persona ? persona + "\n" : "") +
    "你正在和主人打二人立直麻将，桌宠就是你自己。看下面的牌况说一句话，要求：\n" +
    "1. 必须扣住牌局里的具体信息（他刚打的牌、宝牌、剩牌数、听牌、分数差距），说出你真实的判断或心情；\n" +
    "2. 不要空泛的客套夸奖（像「打得不错」这种），不要复述牌况数字，不要解释规则，不要列点，不要用引号；\n" +
    "3. 不超过 24 个字，口语化、符合你的人设，语气每次换一换；\n" +
    `4. 如果这一手确实没什么值得说的，就只回复「${SILENCE_TOKEN}」两个字，不要硬找话说。`;

  const avoid =
    recentLines.length > 0
      ? `\n（你最近说过：${recentLines.map((t) => `「${t}」`).join("、")}；换种说法，别重复）`
      : "";

  try {
    const task = chatStream(
      s.assistant.provider,
      key,
      s.assistant.model,
      [{ role: "user", content: buildSnapshot(game, reason) + avoid }],
      persona ?? "",
      [],
      s.assistant.customBaseUrl,
      () => {},
      false,
      "",
      system,
    );
    const res = await Promise.race([
      task,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const line = (res.text || "").trim().replace(/^["「『]|["」』]$/g, "");
    if (!line) return null;
    // 模型自主选择沉默：不显示气泡，也不占用"最近说过"的记录
    if (line.includes(SILENCE_TOKEN)) return null;
    const out = line.length > 60 ? line.slice(0, 60) : line;
    recentLines.push(out);
    if (recentLines.length > 2) recentLines.shift();
    return out;
  } catch {
    return null;
  } finally {
    inFlight = false;
  }
}
