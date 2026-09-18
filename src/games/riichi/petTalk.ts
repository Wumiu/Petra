/** 节制、可取消且严格按对手视角裁剪的麻将 AI 互动。 */
import { invoke } from "@tauri-apps/api/core";
import { chatStream, estimateTokens } from "../../assistant/AssistantClient";
import { loadSettings } from "../../utils/settings";
import type { RiichiGame } from "./engine";
import { isHonor, rankOf, suitOf } from "./tiles";

export const PET_TALK_LIMITS = {
  automaticIntervalMs: 30_000,
  maxAutomaticPerHand: 6,
  maxAutomaticPerSession: 20,
  timeoutMs: 15_000,
  rateLimitPauseMs: 120_000,
  inputTokenBudget: 1_500,
  outputTokenBudget: 160,
  manualMinIntervalMs: 2_000,
  manualMaxChars: 240,
} as const;

const SILENCE_TOKEN = "沉默";
const HONOR_CHARS = ["东", "南", "西", "北", "白", "发", "中"];
const KEY_TTL_MS = 60_000;
let apiKeyCache: string | null = null;
let apiKeyCachedAt = 0;
let wantedCache = { value: false, at: 0 };
let lastAutomaticAt = 0;
let automaticThisHand = 0;
let automaticThisSession = 0;
let countedHandNo = -1;
let rateLimitedUntil = 0;
let requestSerial = 0;
let active: { id: number; automatic: boolean; controller: AbortController } | null = null;
let lastManual = { text: "", at: 0 };
const recentLines: string[] = [];
const recentEvents: string[] = [];

export interface ManualTalkResult {
  line: string | null;
  notice?: string;
}

export function cancelPetTalk(): void {
  requestSerial++;
  active?.controller.abort();
  active = null;
}

/** 新开游戏/重开时清掉旧请求与整场预算；普通下一局由 handNo 自动换算。 */
export function resetPetTalk(): void {
  cancelPetTalk();
  lastAutomaticAt = 0;
  automaticThisHand = 0;
  automaticThisSession = 0;
  countedHandNo = -1;
  rateLimitedUntil = 0;
  lastManual = { text: "", at: 0 };
  recentLines.length = 0;
  recentEvents.length = 0;
}

export function petTalkWanted(): boolean {
  const now = Date.now();
  if (now - wantedCache.at > 2_000) {
    const s = loadSettings();
    wantedCache = { value: s.gameTalk === true && s.assistant.enabled === true, at: now };
  }
  return wantedCache.value;
}

export async function petTalkAvailable(): Promise<boolean> {
  const s = loadSettings();
  if (!s.assistant.enabled || s.gameTalk !== true) return false;
  if (s.assistant.provider === "ollama") return true;
  if (apiKeyCache === null || Date.now() - apiKeyCachedAt > KEY_TTL_MS) {
    try { apiKeyCache = await invoke<string>("get_api_key"); }
    catch { apiKeyCache = ""; }
    apiKeyCachedAt = Date.now();
  }
  return !!apiKeyCache;
}

export function clearPetTalkKeyCache(): void {
  apiKeyCache = null;
  apiKeyCachedAt = 0;
  wantedCache.at = 0;
}

function compactTiles(tiles: number[]): string {
  const buckets: string[][] = [[], [], [], []];
  for (const t of tiles) {
    const s = suitOf(t);
    buckets[s].push(isHonor(t) ? HONOR_CHARS[rankOf(t) - 1] : String(rankOf(t)));
  }
  const names = ["万", "筒", "索"];
  const out: string[] = [];
  for (let s = 0; s < 3; s++) if (buckets[s].length) out.push(names[s] + buckets[s].join(""));
  if (buckets[3].length) out.push(buckets[3].join(""));
  return out.join(" ") || "无";
}

function compactMelds(game: RiichiGame, seat: 0 | 1): string {
  const melds = game.players[seat].melds;
  return melds.length ? melds.map((m) => `${m.open ? "明" : "暗"}${m.kind}:${compactTiles(m.tiles)}`).join("；") : "无";
}

/**
 * 给“桌宠作为对手”的字段白名单。刻意不包含玩家暗牌、玩家听牌、牌山顺序、未翻指示牌。
 */
export function buildSnapshot(game: RiichiGame, reason: string, manualText = ""): string {
  const owner = game.players[1];
  const opponent = game.players[0];
  const fields = {
    round: `东${game.handNo}局`,
    scores: { pet: owner.score, opponent: opponent.score },
    wallRemaining: game.wall.length,
    pet: {
      hand: compactTiles(owner.hand),
      melds: compactMelds(game, 1),
      river: compactTiles(owner.discards),
      riichi: owner.riichi,
    },
    opponentPublic: {
      melds: compactMelds(game, 0),
      river: compactTiles(opponent.discards),
      riichi: opponent.riichi,
    },
    doraIndicators: compactTiles(game.doraIndicators),
    recentEvents: recentEvents.length ? recentEvents.slice(-3) : [reason],
    ...(manualText ? { playerMessage: manualText } : {}),
  };
  return JSON.stringify(fields);
}

function rememberEvent(reason: string): void {
  const clean = reason.trim().slice(0, 80);
  if (!clean || recentEvents[recentEvents.length - 1] === clean) return;
  recentEvents.push(clean);
  if (recentEvents.length > 3) recentEvents.shift();
}

function isRateLimit(error: unknown): boolean {
  return /429|rate.?limit|限流/i.test(error instanceof Error ? error.message : String(error));
}

async function runRequest(
  game: RiichiGame,
  reason: string,
  automatic: boolean,
  manualText: string,
  isCurrent: () => boolean,
): Promise<string | null> {
  const s = loadSettings();
  const key = apiKeyCache ?? "";
  const controller = new AbortController();
  const id = ++requestSerial;
  active = { id, automatic, controller };
  const startedAt = Date.now();
  const timer = window.setTimeout(() => controller.abort(), PET_TALK_LIMITS.timeoutMs);
  const persona = s.assistant.persona?.trim() ?? "";
  const system =
    (persona ? persona + "\n" : "") +
    "你是正在与用户对局的桌宠，也是牌桌上的对手。只依据提供的字段白名单说1到2句简短中文。" +
    "不得推测或索取对手暗牌、牌山顺序、未公开指示牌；不决定出牌、计分或合法操作；不输出HTML或命令。" +
    `通常不超过60字；没有值得说的内容时只回复「${SILENCE_TOKEN}」。`;
  let snapshot = buildSnapshot(game, reason, manualText);
  const avoid = recentLines.length ? `\n避免复读：${recentLines.slice(-2).join("｜")}` : "";
  if (estimateTokens(system + snapshot + avoid) > PET_TALK_LIMITS.inputTokenBudget) snapshot = snapshot.slice(0, 2_800);
  let usageLabel = "unavailable";
  try {
    const res = await chatStream(
      s.assistant.provider,
      key,
      s.assistant.model,
      [{ role: "user", content: snapshot + avoid }],
      persona,
      [],
      s.assistant.customBaseUrl,
      () => {},
      false,
      "",
      system,
      {
        signal: controller.signal,
        maxOutputTokens: PET_TALK_LIMITS.outputTokenBudget,
        onUsage: (value) => { usageLabel = `${value.source}:${value.input}/${value.output}`; },
      },
    );
    if (id !== requestSerial || !isCurrent()) return null;
    const line = (res.text || "").trim().replace(/^["「『]|["」』]$/g, "");
    if (!line || line.includes(SILENCE_TOKEN)) return null;
    const out = line.slice(0, 60);
    recentLines.push(out);
    if (recentLines.length > 3) recentLines.shift();
    return out;
  } catch (error) {
    if (isRateLimit(error)) rateLimitedUntil = Date.now() + PET_TALK_LIMITS.rateLimitPauseMs;
    return null;
  } finally {
    window.clearTimeout(timer);
    if (active?.id === id) active = null;
    if (import.meta.env.DEV) {
      console.debug("[riichi-ai] request", {
        automatic,
        elapsedMs: Date.now() - startedAt,
        usage: usageLabel,
      });
    }
  }
}

export async function requestPetTalk(
  game: RiichiGame,
  reason: string,
  busy: boolean,
  isCurrent: () => boolean = () => true,
): Promise<string | null> {
  rememberEvent(reason);
  if (busy || active || Date.now() < rateLimitedUntil) return null;
  if (!(await petTalkAvailable())) return null;
  if (countedHandNo !== game.handNo) {
    countedHandNo = game.handNo;
    automaticThisHand = 0;
  }
  const now = Date.now();
  if (now - lastAutomaticAt < PET_TALK_LIMITS.automaticIntervalMs) return null;
  if (automaticThisHand >= PET_TALK_LIMITS.maxAutomaticPerHand) return null;
  if (automaticThisSession >= PET_TALK_LIMITS.maxAutomaticPerSession) return null;
  lastAutomaticAt = now;
  automaticThisHand++;
  automaticThisSession++;
  return runRequest(game, reason, true, "", isCurrent);
}

export async function requestManualPetTalk(
  game: RiichiGame,
  text: string,
  busy: boolean,
  isCurrent: () => boolean = () => true,
): Promise<ManualTalkResult> {
  const clean = text.trim().slice(0, PET_TALK_LIMITS.manualMaxChars);
  if (!clean) return { line: null, notice: "请输入想说的话" };
  const now = Date.now();
  if (clean === lastManual.text && now - lastManual.at < PET_TALK_LIMITS.manualMinIntervalMs) {
    return { line: null, notice: "这句话刚刚已经发送了" };
  }
  if (busy) return { line: null, notice: "桌宠正在回复其他消息，请稍候" };
  if (!(await petTalkAvailable())) return { line: null, notice: "AI对局互动未开启或尚未配置，将继续使用本地互动" };
  if (Date.now() < rateLimitedUntil) return { line: null, notice: "服务暂时限流，请稍后再试" };
  if (active?.automatic) cancelPetTalk();
  else if (active) return { line: null, notice: "上一条对局消息仍在回复中" };
  lastManual = { text: clean, at: now };
  rememberEvent("用户主动对局聊天");
  const line = await runRequest(game, "用户主动对局聊天", false, clean, isCurrent);
  return line ? { line } : { line: null, notice: "本次未获得回复，已保留本地互动" };
}
