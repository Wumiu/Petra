import { invoke } from "@tauri-apps/api/core";
import { chatStream, extractCommand, stripCommand, PROVIDERS, isProviderReady, type ChatMessage, type ToolCall, type MemoryEntry, type MemoryStore } from "./AssistantClient";
import { classifyEmotion, classifyAssistantEmotion, reactNow, emotionEmoji, boostMood, getMood, type EmotionTag } from "./EmotionEngine";
import type { AssistantProvider } from "../utils/settings";
import { trackEvent } from "../features/diary/DiaryEventTracker";
import { dailyDraw, hasDrawnToday, getTodayDraw, getCollectionProgress } from "../features/card/DailyCardManager";
import { loadDiaries, getDiary } from "../features/diary/DiaryManager";
import { loadSettings, saveSettings } from "../utils/settings";
import { ToolLoopBudget, formatToolError, toolNames, truncateToolResult, validateToolArgs } from "./toolRuntime";
import { getVisibleRect } from "../ui/visible";
import { toast } from "../ui/Toast";

const MAX_BUBBLES = 2;
const HIST_KEY = "live2d-pet-assistant-history";
const MEM_KEY = "live2d-pet-assistant-memory";

let inputBar: HTMLElement | null = null;
let bubbles: HTMLElement | null = null;
let input: HTMLInputElement;
let allowAllShell: HTMLInputElement;
let history: ChatMessage[] = [];
let memory: MemoryStore = [];
let timer: number | null = null;
let blurTimer: number | null = null;
let busy = false;
let lifecycleOnOpen: (() => void) | null = null;
let lifecycleOnClose: (() => void) | null = null;

// API Key 存 Rust 侧（DPAPI 加密），前端只缓存
let apiKeyCache = "";
let apiKeyLoaded = false;

async function ensureApiKey(): Promise<string> {
  if (apiKeyLoaded) return apiKeyCache;
  try {
    apiKeyCache = await invoke<string>("get_api_key");
  } catch {
    apiKeyCache = "";
  }
  apiKeyLoaded = true;
  return apiKeyCache;
}

export function clearApiKeyCache() {
  apiKeyLoaded = false;
  apiKeyCache = "";
}

/** 小助手是否正在对话中（麻将 AI 点评用：正忙就跳过，避免抢话） */
export function isAssistantBusy(): boolean {
  return busy;
}

export function setLifecycle(onOpen: () => void, onClose: () => void) {
  lifecycleOnOpen = onOpen;
  lifecycleOnClose = onClose;
}

function loadMemory() {
  try {
    const raw = JSON.parse(localStorage.getItem(MEM_KEY) || "[]");
    if (Array.isArray(raw) && raw.length > 0) {
      // 迁移旧格式（string[] → MemoryEntry[]）
      if (typeof raw[0] === "string") {
        memory = (raw as string[]).map((s, i) => ({
          id: `migrated_${i}`,
          category: "other" as const,
          content: s,
          keywords: [],
          source: "user_said" as const,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          importance: 2 as const,
        }));
        saveMemory(); // 持久化新格式
      } else {
          memory = raw as MemoryStore;
      }
      // 记忆衰减：importance=3 且超过 30 天未引用 → 归档
      const now = Date.now();
      const DECAY_DAYS = 30 * 86400000;
      const ARCHIVE_KEY = MEM_KEY + "-archive";
      const toArchive = memory.filter(m => m.importance === 3 && (now - m.lastUsedAt) > DECAY_DAYS);
      if (toArchive.length > 0) {
        // 追加到归档存储
        try {
          const archived = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]") as MemoryStore;
          archived.push(...toArchive);
          localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archived.slice(-200)));
        } catch { /* 忽略 */ }
        // 从活跃记忆中移除
        memory = memory.filter(m => !(m.importance === 3 && (now - m.lastUsedAt) > DECAY_DAYS));
        saveMemory();
      }
    } else {
      memory = [];
    }
  } catch {
    memory = [];
  }
}
function saveMemory() {
  try {
    localStorage.setItem(MEM_KEY, JSON.stringify(memory.slice(-80)));
  } catch {
    /* 忽略 */
  }
}
function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    if (Array.isArray(h)) {
      // 校验清理：移除孤立 tool 消息 + 不完整的 tool_calls 序列（防持久化坏数据触发 400）
      const cleaned: ChatMessage[] = [];
      let i = 0;
      while (i < h.length) {
        const m = h[i] as ChatMessage;
        if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const need = m.tool_calls.length;
          let ok = true;
          for (let j = 1; j <= need; j++) {
            const t = h[i + j] as ChatMessage | undefined;
            if (!t || t.role !== "tool") {
              ok = false;
              break;
            }
          }
          if (ok) {
            cleaned.push(m);
            for (let j = 1; j <= need; j++) cleaned.push(h[i + j]);
            i += need + 1;
          } else {
            i++;
            while (i < h.length && (h[i] as ChatMessage)?.role === "tool") i++;
          }
        } else if (m?.role === "tool") {
          i++; // 孤立 tool 消息丢弃
        } else {
          cleaned.push(m);
          i++;
        }
      }
      history = cleaned.slice(-30);
    }
  } catch {
    history = [];
  }
}
function saveHistory() {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(history.slice(-30)));
  } catch {
    /* 忽略 */
  }
}

function ensureInput() {
  if (inputBar) return inputBar;
  inputBar = document.createElement("div");
  inputBar.id = "as-inputbar";
  inputBar.className = "as-inputbar hidden";

  const row = document.createElement("div");
  row.className = "as-input-row";
  input = document.createElement("input");
  input.className = "as-input";
  input.placeholder = "问点什么…";
  input.addEventListener("input", resetTimer);
  input.addEventListener("blur", () => {
    // 失焦后5秒自动关闭
    blurTimer = setTimeout(() => {
      closeAssistant();
    }, 2500);
  });
  input.addEventListener("focus", () => {
    // 获得焦点时清除失焦定时器
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = null;
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const t = input.value.trim();
      if (t) {
        input.value = "";
        void send(t);
      }
    }
  });
  const btn = document.createElement("button");
  btn.className = "as-send";
  btn.textContent = "发送";
  btn.addEventListener("click", () => {
    const t = input.value.trim();
    if (t) {
      input.value = "";
      void send(t);
    }
  });
  row.append(input, btn);

  // 发送下面：允许所有 shell 复选框（持久化到设置，重启后保持）
  const allowRow = document.createElement("label");
  allowRow.className = "as-allow";
  allowAllShell = document.createElement("input");
  allowAllShell.type = "checkbox";
  allowAllShell.checked = loadSettings().allowAllShell;
  allowAllShell.addEventListener("change", () => {
    const s = loadSettings();
    s.allowAllShell = allowAllShell.checked;
    saveSettings(s);
    resetTimer();
  });
  const lbl = document.createElement("span");
  lbl.textContent = "免确认 shell";
  allowRow.append(allowAllShell, lbl);

  inputBar.append(row, allowRow);
  inputBar.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.body.appendChild(inputBar);
  return inputBar;
}

function ensureBubbles() {
  if (bubbles) return bubbles;
  bubbles = document.createElement("div");
  bubbles.id = "as-bubbles";
  bubbles.className = "as-bubbles";
  bubbles.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.body.appendChild(bubbles);
  return bubbles;
}

function resetTimer() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(closeAssistant, 15000);
  // 重置失焦定时器
  if (blurTimer) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }
}

function addBubble(kind: "ai" | "sys" | "confirm", text: string): HTMLElement {
  ensureBubbles();
  const b = document.createElement("div");
  b.className = `as-bubble as-${kind}`;
  b.textContent = text;
  bubbles!.appendChild(b);
  trimBubbles();
  return b;
}

function scheduleFade(el: HTMLElement, ms: number) {
  setTimeout(() => {
    if (!el.isConnected) return;
    el.style.transition = "opacity 0.4s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 450);
  }, ms);
}

function trimBubbles() {
  const kids = Array.from(bubbles!.children);
  while (kids.length > MAX_BUBBLES) {
    kids.shift()?.remove();
  }
}

export function openAssistant(modelRect?: { left: number; top: number; right: number; bottom: number }) {
  ensureInput();
  ensureBubbles();
  loadMemory();
  loadHistory();
  inputBar!.classList.remove("hidden");
  // 定位到模型（绿框）附近：默认放底部，放不下翻到上方；始终钳制在窗口可见区内（贴边自适应）
  if (modelRect) {
    const vr = getVisibleRect();
    const barW = inputBar!.offsetWidth || 185;
    const barH = inputBar!.offsetHeight || 60;
    // 避开已显示的信息板（避免叠放遮挡：信息板先于输入框定位）
    const infoEl = document.getElementById("info-panel");
    const infoRect =
      infoEl && !infoEl.classList.contains("hidden") ? infoEl.getBoundingClientRect() : null;
    const collides = (l: number, t: number) =>
      infoRect !== null &&
      l < infoRect.right && l + barW > infoRect.left &&
      t < infoRect.bottom && t + barH > infoRect.top;
    const cands = [
      { left: modelRect.left, top: modelRect.bottom + 10 }, // 模型下方（默认）
      { left: modelRect.left, top: vr.bottom - barH }, // 可见区底部（贴底时允许盖住模型下半部分）
      { left: modelRect.left, top: modelRect.top - barH - 10 }, // 模型上方（最后尝试）
    ];
    let pick: { left: number; top: number } | null = null;
    for (const c of cands) {
      if (
        !collides(c.left, c.top) &&
        c.top >= vr.top && c.top + barH <= vr.bottom &&
        c.left >= vr.left && c.left + barW <= vr.right
      ) {
        pick = c;
        break;
      }
    }
    if (!pick) {
      for (const c of cands) {
        if (
          c.top >= vr.top && c.top + barH <= vr.bottom &&
          c.left >= vr.left && c.left + barW <= vr.right
        ) {
          pick = c;
          break;
        }
      }
    }
    if (!pick) pick = cands[0];
    const left = Math.max(vr.left, Math.min(pick.left, vr.right - barW));
    const top = Math.max(vr.top, Math.min(pick.top, vr.bottom - barH));
    inputBar!.style.left = `${Math.round(left)}px`;
    inputBar!.style.top = `${Math.round(top)}px`;
    inputBar!.style.bottom = "auto";
    inputBar!.style.maxWidth = `${Math.max(60, vr.right - vr.left - 8)}px`;
  } else {
    inputBar!.style.left = "";
    inputBar!.style.bottom = "";
    inputBar!.style.top = "";
    inputBar!.style.maxWidth = "";
  }
  input.focus();
  resetTimer();
  lifecycleOnOpen?.();
}

export function closeAssistant() {
  if (timer) clearTimeout(timer);
  if (blurTimer) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }
  inputBar?.classList.add("hidden");
  lifecycleOnClose?.();
}

/** 清空左上角气泡区（关闭小助手模式时用） */
export function clearBubbles() {
  if (bubbles) bubbles.innerHTML = "";
}

/** 清空对话历史（保留长期记忆 memory） */
export function clearHistory() {
  history = [];
  try {
    localStorage.removeItem(HIST_KEY);
  } catch {
    /* 忽略 */
  }
  clearBubbles();
}

export function resetHistory() {
  history = [];
  saveHistory();
  if (bubbles) bubbles.innerHTML = "";
}

function lastBubble(): HTMLElement | null {
  if (!bubbles) return null;
  const kids = bubbles.children;
  return kids.length ? (kids[kids.length - 1] as HTMLElement) : null;
}

/** 当前时段 key（记忆召回用） */
function timeOfDayKey(): string {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 10) return "morning";
  if (hour >= 10 && hour < 14) return "midday";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  if (hour >= 22 || hour < 2) return "night";
  return "late_night";
}

/** 陪伴时长（与 main.ts 共用 localStorage 起始时间） */
function formatCompanion(): string {
  try {
    const saved = localStorage.getItem("petra-companion-start");
    const start = saved ? parseInt(saved, 10) : Date.now();
    const ms = Math.max(0, Date.now() - start);
    const hours = Math.floor(ms / 3600000);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}天${hours % 24}小时`;
    if (hours > 0) return `${hours}小时`;
    return `${Math.floor(ms / 60000)}分钟`;
  } catch {
    return "一段时间";
  }
}

/**
 * 流式着色钩子：气泡边显示文字边识别情绪，让颜色尽早出现（原来要等整段输出完才变色）。
 * 识别到的情绪会被记住，供收尾时复用（避免"中途有色、收尾又变白/丢 emoji"）。
 */
function makeStreamColorHook(el: HTMLElement): {
  push: (delta: string) => void;
  lastEmotion: () => EmotionTag;
} {
  let lastEmo: EmotionTag = "neutral";
  let lastAt = 0;
  return {
    push: (delta: string) => {
      el.textContent += delta;
      const now = Date.now();
      if (now - lastAt < 250) return; // 节流：最多每 250ms 重新判定一次
      lastAt = now;
      const emo = classifyAssistantEmotion(el.textContent);
      if (emo !== "neutral") {
        lastEmo = emo;
        if (el.dataset.emotion !== emo) el.dataset.emotion = emo;
      }
    },
    lastEmotion: () => lastEmo,
  };
}

/** 把原始 API 错误翻译成友善提示（402 余额不足 / 401 Key 无效 / 429 限流等） */
function friendlyApiError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/402|insufficient balance|余额不足|欠费/i.test(raw)) {
    return "💸 API 余额不足（402）：请到「小助手设置」充值，或换一个可用的 API Key。\n（AI 暂时下线，但右键 →「🎮 小游戏」，桌宠还能陪你打麻将哦～）";
  }
  if (/401|invalid_api_key|unauthorized|令牌|鉴权/i.test(raw)) {
    return "🔑 API Key 无效或已过期，请到「小助手设置」重新填写。";
  }
  if (/429|rate limit|too many requests|限流/i.test(raw)) {
    return "⏳ 请求太频繁了（429），缓一缓再聊吧～";
  }
  if (/timeout|超时|failed to fetch|networkerror|网络/i.test(raw)) {
    return "🌐 网络不可用或超时，检查网络/代理后再试。";
  }
  if (/404|model not found|模型/i.test(raw)) {
    return "🤖 模型名无效（404）：请在设置里点「自动获取模型」重新选一个。";
  }
  return raw;
}

/** 注入 system prompt 的紧凑环境上下文（约 20-30 token：称呼 + 时间 + 陪伴时长，增强陪伴感） */
function buildChatContext(nickname: string): string {
  const now = new Date();
  const hour = now.getHours();
  let tod = "晚上";
  if (hour >= 5 && hour < 9) tod = "早晨";
  else if (hour >= 9 && hour < 12) tod = "上午";
  else if (hour >= 12 && hour < 14) tod = "中午";
  else if (hour >= 14 && hour < 18) tod = "下午";
  else if (hour >= 18 && hour < 23) tod = "晚上";
  else tod = "深夜";
  const day = now.toLocaleDateString("zh-CN", { weekday: "long" });
  const parts: string[] = [];
  if (nickname) parts.push(`对用户的称呼：${nickname}`);
  parts.push(`现在：${day}${tod}${hour}点`);
  parts.push(`已陪伴用户${formatCompanion()}`);
  return `[环境] ${parts.join("；")}`;
}

async function send(text: string) {
  if (busy) return;
  const s = loadSettings();
  const apiKey = await ensureApiKey();
  if (!s.assistant.enabled) {
    const b = addBubble("sys", "小助手模式没开：右键 →「小助手模式」打开");
    scheduleFade(b, 4000);
    return;
  }
  // 本地 Ollama / 本机自定义端点不需要 Key，这里不能再按"Key 为空"拦下
  if (!isProviderReady(s.assistant, apiKey)) {
    const b = addBubble("sys", "未配置 API Key，请到「小助手设置」填写（本地 Ollama 可以留空）");
    scheduleFade(b, 4000);
    return;
  }
  history.push({ role: "user", content: text });
  saveHistory();
  // 情感反馈：先分析用户消息（零 token），立即驱动角色表情/动作 + 心情
  const userEmo = classifyEmotion(text);
  reactNow(userEmo);
  boostMood("chat");
  if (userEmo !== "neutral") boostMood(userEmo);
  busy = true;
  const loading = addBubble("ai", "");
  const colorHook = makeStreamColorHook(loading);
  let streamed = false;
  try {
    // 循环处理：每轮 chatStream → 若有工具调用则执行并继续，否则结束。
    // 轮数与调用次数双上限（见 ToolLoopBudget）：模型偶尔会在同一件事上反复试探，
    // 没有预算就会一直循环烧 token；预算用尽会给用户一句明确交代。
    const budget = new ToolLoopBudget({ maxRounds: 6, maxCalls: 12 });
    let finished = false;
    let streamEmo: EmotionTag = "neutral";
    while (budget.nextRound()) {
      if (budget.rounds > 1) loading.textContent = "";
      // token 优化：记忆按场景/话题召回（≤6 条），而非全量注入 system prompt
      const ctxMemories = recallRelevantMemories({ timeOfDay: timeOfDayKey(), userText: text }).slice(0, 6);
      const res = await chatStream(
        s.assistant.provider,
        apiKey,
        s.assistant.model,
        history,
        s.assistant.persona,
        ctxMemories,
        s.assistant.customBaseUrl,
        (delta) => {
          streamed = true;
          colorHook.push(delta);
        },
        true,
        buildChatContext(s.assistant.nickname),
      );
      if (colorHook.lastEmotion() !== "neutral") streamEmo = colorHook.lastEmotion();

      if (res.toolCalls.length) {
        // 工具调用：执行后进入下一轮
        if (budget.rounds === 1 && !streamed) loading.textContent = "";
        await handleToolCalls(res.toolCalls, loading, budget);
        continue;
      }

      // 无工具调用：文字入历史
      const finalText = loading.textContent || res.text;
      history.push({ role: "assistant", content: finalText });
      // 情感反馈：AI 回复带情绪 → 角色表情/动作 + 气泡 emoji 前缀 + 气泡着色 + 心情变化
      // 流式期间已识别到的情绪优先复用（否则"～/！"这类结尾标记在接续文本后可能失效）
      const finalEmo = classifyAssistantEmotion(finalText);
      const aiEmo = finalEmo !== "neutral" ? finalEmo : streamEmo;
      if (aiEmo !== "neutral") {
        reactNow(aiEmo);
        loading.textContent = `${emotionEmoji(aiEmo)} ${finalText}`;
        loading.dataset.emotion = aiEmo;
        boostMood(aiEmo);
      }
      // 记录对话事件（日记系统）：记用户说的话（tracker 内部 safeSlice 截到 80 字）
      trackEvent({ type: "chat", summary: text });
      // CMD 兜底（非 function calling provider）
      const cmd = extractCommand(finalText);
      if (cmd) {
        loading.textContent = stripCommand(finalText) || "(执行中…)";
        await handleToolCalls(
          [{ id: `cmd_${Date.now()}`, name: "run_shell", args: { command: cmd } }],
          loading,
          budget,
        );
        continue;
      }
      finished = true;
      break;
    }
    if (!finished) {
      // 工具循环被预算刹住了：明确告诉用户，而不是留一个空气泡
      const note = addBubble("sys", "工具调用到达上限先停住了，可以直接说「继续」。");
      scheduleFade(note, 6000);
    }
    saveHistory();

    // P3 主动学习：每 5 条对话自动提取新记忆（后台运行，不阻塞 UI）
    if (history.length % 5 === 0) {
      void extractMemoriesFromChat(s, apiKey);
    }
    if (!loading.textContent.trim()) loading.textContent = "(空回复)";
    scheduleFade(loading, 8000);
  } catch (e) {
    loading.textContent = friendlyApiError(e);
    loading.dataset.emotion = "worried";
    // 出错时桌宠也难过一下，但不消耗任何 token
    reactNow("worried");
    scheduleFade(loading, 9000);
  } finally {
    busy = false;
    resetTimer();
  }
}

/** 把提示合并到工具结果前面（一个 tool_call 只能对应一条 tool 消息，不能多发一条） */
function withHint(text: string, hint: string): string {
  return hint ? `${hint}\n${text}` : text;
}

/** 处理工具调用：先 push assistant tool_calls 消息，再逐个执行并 push tool 消息 */
async function handleToolCalls(calls: ToolCall[], loading: HTMLElement, budget: ToolLoopBudget) {
  // assistant 消息带 tool_calls（content 为 null 规范格式；DeepSeek 要求 tool 消息紧跟它）
  history.push({
    role: "assistant",
    content: null,
    tool_calls: calls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    })),
  });

  /** 通用工具调用：invoke 后 push 结果到 history */
  const invokeTool = async (tcItem: ToolCall, name: string, args: Record<string, unknown> = {}) => {
    try {
      const result = await invoke<string>(name, args);
      // tool 消息的 content 必须是字符串：数字/对象类返回值（如空闲秒数）统一转成文本
      const text = typeof result === "string" ? result : JSON.stringify(result);
      history.push({ role: "tool", tool_call_id: tcItem.id, content: text });
    } catch (e) {
      history.push({ role: "tool", tool_call_id: tcItem.id, content: `失败：${e}` });
    }
  };

  for (const tc of calls) {
    const before = history.length;
    // 次数预算用尽：不再执行，但**仍然**回一条明确结果 ——
    // 留下一条悬空的 tool_calls 会让下一轮请求直接 400。
    if (!budget.canCall()) {
      history.push({
        role: "tool",
        tool_call_id: tc.id,
        content: formatToolError(
          tc.name,
          `本轮工具调用已达上限 ${budget.maxCalls} 次`,
          "请直接根据已有信息回答用户，不要再调用工具。",
        ),
      });
      continue;
    }
    const repeatHint = budget.noteCall(tc.name, tc.argsError ? { __raw: tc.args } : tc.args);
    // 参数不是合法 JSON：让模型知道要重发（静默丢弃会让它以为调过了）
    if (tc.argsError) {
      history.push({
        role: "tool",
        tool_call_id: tc.id,
        content: withHint(
          formatToolError(tc.name, tc.argsError, "请重新发起一次调用，arguments 必须是合法的 JSON 对象。"),
          repeatHint,
        ),
      });
      continue;
    }
    // 未知工具 / 缺必填参数：不开 IPC，直接回可执行的提示
    const check = validateToolArgs(tc.name, tc.args);
    if (!check.ok) {
      history.push({
        role: "tool",
        tool_call_id: tc.id,
        content: withHint(formatToolError(tc.name, check.message), repeatHint),
      });
      continue;
    }
    if (tc.name === "remember") {
      const content = String(tc.args.content ?? "").trim();
      const category = String(tc.args.category ?? "other") as MemoryEntry["category"];
      const importance = Math.min(3, Math.max(1, Number(tc.args.importance) || 2)) as MemoryEntry["importance"];
      if (content) {
        // 去重：检查已有记忆是否包含相同内容
        const existing = memory.find(m => m.content === content || (m.keywords.length > 0 && m.keywords.some(k => content.includes(k))));
        if (existing) {
          existing.lastUsedAt = Date.now();
          existing.importance = Math.min(existing.importance, importance) as MemoryEntry["importance"];
          history.push({ role: "tool", tool_call_id: tc.id, content: "已更新记忆" });
        } else {
          // 提取关键词（简单分词）
          const keywords = extractKeywords(content);
          memory.push({
            id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            category,
            content,
            keywords,
            source: "user_said",
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            importance,
          });
          history.push({ role: "tool", tool_call_id: tc.id, content: "已记住" });
        }
        saveMemory();
      } else {
        history.push({ role: "tool", tool_call_id: tc.id, content: "内容为空" });
      }
      continue;
    }
    if (tc.name === "launch_application") {
      const app = String(tc.args.application ?? "").trim();
      if (!app) {
        history.push({ role: "tool", tool_call_id: tc.id, content: "应用名称为空" });
        continue;
      }
      loading.textContent = "启动中…";
      // 启动软件只接受应用名、不接受任意命令，安全免确认
      let result: string;
      try {
        const r = await invoke<{ success: boolean; message: string; resolved: string | null }>(
          "launch_application",
          { application: app },
        );
        result = JSON.stringify(r);
      } catch (e) {
        result = JSON.stringify({ success: false, message: `执行失败：${e}`, resolved: null });
      }
      history.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    if (tc.name === "run_shell") {
      const cmd = String(tc.args.command ?? "").trim();
      if (!cmd) {
        // 空命令也必回传 tool 消息，保证 tool_calls 序列完整（否则 DeepSeek 报 400）
        history.push({ role: "tool", tool_call_id: tc.id, content: "命令为空" });
        continue;
      }
      const doRun = allowAllShell.checked
        ? true
        : await new Promise<boolean>((resolve) => {
            const row = document.createElement("div");
            row.className = "as-bubble as-confirm";
            const label = document.createElement("span");
            label.textContent = `小助手想执行：${cmd}`;
            const yes = document.createElement("button");
            yes.className = "as-btn";
            yes.textContent = "允许";
            const no = document.createElement("button");
            no.className = "as-btn as-btn-no";
            no.textContent = "拒绝";
            row.append(label, yes, no);
            bubbles!.appendChild(row);
            yes.addEventListener("click", () => {
              row.remove();
              resolve(true);
            });
            no.addEventListener("click", () => {
              row.remove();
              resolve(false);
            });
          });
      let result: string;
      if (!doRun) {
        result = "用户拒绝了执行命令";
      } else {
        loading.textContent = "执行中…";
        try {
          result = await invoke<string>("run_shell", { command: cmd });
        } catch (e) {
          result = `执行失败：${e}`;
        }
      }
      history.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    if (tc.name === "set_volume") {
      await invokeTool(tc, "set_volume", { level: tc.args.level, mute: tc.args.mute });
    }
    if (tc.name === "set_reminder") {
      const minutes = Number(tc.args.minutes) || 1;
      const message = String(tc.args.message || "时间到了");
      const ms = Math.max(5000, Math.min(86400000, minutes * 60000));
      setTimeout(() => {
        boostMood("reminder_done");
        toast(`提醒：${message}`, "info");
      }, ms);
      history.push({ role: "tool", tool_call_id: tc.id, content: `已设定 ${minutes} 分钟后提醒：${message}` });
    }
    if (tc.name === "get_weather") {
      await invokeTool(tc, "get_weather");
    }
    if (tc.name === "schedule_shutdown") {
      await invokeTool(tc, "schedule_shutdown", { minutes: Number(tc.args.minutes) || 60 });
    }
    if (tc.name === "cancel_shutdown") {
      await invokeTool(tc, "cancel_shutdown");
    }
    if (tc.name === "search_web") {
      const query = String(tc.args.query || "");
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      try {
        await invoke("open_url", { url });
        history.push({ role: "tool", tool_call_id: tc.id, content: `已打开浏览器搜索：${query}` });
      } catch (e) {
        history.push({ role: "tool", tool_call_id: tc.id, content: `打开失败：${e}` });
      }
    }
    if (tc.name === "open_url") {
      await invokeTool(tc, "open_url", { url: String(tc.args.url || "") });
    }
    if (tc.name === "open_path") {
      await invokeTool(tc, "open_path", { path: String(tc.args.path || "") });
    }
    if (tc.name === "list_installed_apps") {
      await invokeTool(tc, "list_installed_apps");
    }
    if (tc.name === "active_window_title") {
      await invokeTool(tc, "active_window_title");
    }
    if (tc.name === "get_idle_seconds") {
      await invokeTool(tc, "get_idle_seconds");
    }
    if (tc.name === "send_notification") {
      await invokeTool(tc, "send_notification", {
        title: String(tc.args.title || "Petra"),
        body: String(tc.args.body || ""),
      });
    }
    if (tc.name === "lock_screen") {
      await invokeTool(tc, "lock_screen");
    }
    if (tc.name === "daily_card") {
      try {
        // skipAiText：聊天里小助手会用自己的人设重新演绎祝福语，无需再单独生成一次
        const result = await dailyDraw({ skipAiText: true });
        const { collected, total } = getCollectionProgress();
        const lines = [
          "【抽卡结果】",
          `稀有度：${result.rarity}`,
          `主题：${result.card.theme}`,
          `原文案：${result.card.baseText}`,
        ];
        if (result.aiText !== result.card.baseText) lines.push(`AI文案：${result.aiText}`);
        lines.push(`图鉴：${collected}/${total}`, "", "请用你的人设风格重新演绎上面的文案，加入自己的点评或吐槽，不要原样复述。直接对用户说话。");
        history.push({ role: "tool", tool_call_id: tc.id, content: lines.join("\n") });
      } catch (e) {
        history.push({ role: "tool", tool_call_id: tc.id, content: `抽卡失败：${e}` });
      }
    }
    if (tc.name === "view_diary") {
      const date = String(tc.args.date || "").trim();
      if (date) {
        const entry = getDiary(date);
        if (entry) {
          history.push({ role: "tool", tool_call_id: tc.id, content: `📖 ${date} 的日记：\n${entry.content}` });
        } else {
          history.push({ role: "tool", tool_call_id: tc.id, content: `${date} 没有日记哦~` });
        }
      } else {
        const diaries = loadDiaries().slice(0, 3);
        if (diaries.length === 0) {
          history.push({ role: "tool", tool_call_id: tc.id, content: "还没有日记呢~跟我互动就会自动生成啦！" });
        } else {
          const summary = diaries.map(d => `📖 ${d.date}: ${d.content.slice(0, 30)}...`).join("\n");
          history.push({ role: "tool", tool_call_id: tc.id, content: `最近的日记：\n${summary}` });
        }
      }
    }

    // 兜底：所有分支都没命中（例如工具表里加了名字但忘了接处理）也必须回一条结果
    if (history.length === before) {
      history.push({
        role: "tool",
        tool_call_id: tc.id,
        content: formatToolError(
          tc.name,
          "没有对应的处理分支（工具可能还没接上）",
          `可用工具：${toolNames().join("、")}`,
        ),
      });
    } else if (repeatHint) {
      // 重复调用提示合并进同一条 tool 结果（不能多发一条同 id 的消息）
      const last = history[history.length - 1];
      if (last?.role === "tool" && typeof last.content === "string") {
        last.content = withHint(last.content, repeatHint);
      }
    }

    // 统一截断这次调用产生的结果，避免一次 run_shell 把上下文吃掉
    for (let i = before; i < history.length; i++) {
      const msg = history[i];
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = truncateToolResult(tc.name, msg.content);
      }
    }
  }
}

/** 从中文文本中提取关键词（简单规则，不依赖分词库） */
function extractKeywords(text: string): string[] {
  // 提取引号内容、2-6字中文词组、英文单词
  const keywords: string[] = [];
  // 引号内容
  const quoted = text.match(/[""「」『』]([^""「」『』]{1,20})[""「」『』]/g);
  if (quoted) keywords.push(...quoted.map(q => q.slice(1, -1)));
  // 英文单词
  const english = text.match(/[a-zA-Z]{2,}/g);
  if (english) keywords.push(...english.map(w => w.toLowerCase()));
  // 中文2-6字片段（滑动窗口取高频）
  const cnRuns = text.match(/[\u4e00-\u9fff]{2,}/g);
  if (cnRuns) {
    for (const run of cnRuns) {
      for (let len = Math.min(6, run.length); len >= 2; len--) {
        for (let i = 0; i <= run.length - len; i++) {
          keywords.push(run.slice(i, i + len));
        }
      }
    }
  }
  return [...new Set(keywords)].slice(0, 20);
}

/** 根据当前场景召回相关记忆（返回最重要的几条） */
function recallRelevantMemories(context: {
  timeOfDay?: string;
  currentApp?: string;
  currentTitle?: string;
  idleMinutes?: number;
  userText?: string;
}): MemoryEntry[] {
  if (memory.length === 0) return [];
  
  const now = Date.now();
  const scored = memory.map(m => {
    let score = 0;
    // 重要度权重
    score += (4 - m.importance) * 3;
    // 最近使用过的加分
    const daysSinceUsed = (now - m.lastUsedAt) / 86400000;
    score += Math.max(0, 3 - daysSinceUsed * 0.1);
    
    // 场景相关性加分
    const ctx = `${context.currentApp ?? ""} ${context.currentTitle ?? ""} ${context.timeOfDay ?? ""}`;
    for (const kw of m.keywords) {
      if (ctx.toLowerCase().includes(kw.toLowerCase())) {
        score += 5;
      }
    }
    // 与用户当前消息相关的记忆显著加分
    const ut = (context.userText ?? "").toLowerCase();
    if (ut) {
      for (const kw of m.keywords) {
        if (ut.includes(kw.toLowerCase())) {
          score += 6;
        }
      }
    }
    // 时间相关记忆加分
    if (m.category === "schedule" || m.category === "habit") {
      if (context.timeOfDay) score += 2;
    }
    if (m.category === "identity") score += 1; // 身份记忆总是重要
    
    return { entry: m, score };
  });
  
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map(s => s.entry);
}


/** P3 主动学习：从最近对话中提取用户信息，后台轻量调用 */
async function extractMemoriesFromChat(s: any, apiKey: string) {
  if (memory.length > 80) return; // 记忆已满，不再提取
  const recentMsgs = history.slice(-10).filter(m => m.role === "user" || m.role === "assistant");
  if (recentMsgs.length < 3) return;
  const transcript = recentMsgs.map(m => `${m.role}: ${m.content}`).join("\n");
  const extractPrompt = [
    { role: "system", content: "你是记忆提取器。从对话中提取用户透露的个人信息、偏好、习惯、情绪、计划。输出JSON数组，每条 {content, category, importance}。category: identity/preference/habit/schedule/relationship/event/other。importance: 1-3。如果没有值得记住的信息，输出空数组 []。只输出JSON，不要其他文字。" },
    { role: "user", content: transcript },
  ];
  try {
    // 修复：按实际 provider 解析端点（此前非 custom 一律硬编码 DeepSeek，其他厂商记忆提取静默失败）
    const base = s.assistant.provider === "custom"
      ? s.assistant.customBaseUrl
      : PROVIDERS[s.assistant.provider as AssistantProvider]?.base ?? "https://api.deepseek.com";
    const model = s.assistant.model || PROVIDERS[s.assistant.provider as AssistantProvider]?.defaultModel || "deepseek-chat";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: extractPrompt, temperature: 0.1 }),
    });
    if (!res.ok) return;
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const items = JSON.parse(match[0]);
    if (!Array.isArray(items)) return;
    let added = 0;
    for (const item of items) {
      if (!item.content || typeof item.content !== "string") continue;
      const content = item.content.trim();
      if (memory.some(m => m.content === content)) continue; // 去重
      memory.push({
        id: `auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        category: item.category || "other",
        content,
        keywords: extractKeywords(content),
        source: "ai_inferred",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        importance: Math.min(3, Math.max(1, Number(item.importance) || 2)) as MemoryEntry["importance"],
      });
      added++;
    }
    if (added > 0) saveMemory();
  } catch { /* 静默失败，不影响用户体验 */ }
}

/** 主动问候：收集丰富上下文 + 召回相关记忆，让 AI 有温度地关心用户 */
/**
 * 让桌宠说一句**本地**文案（零 token、不调模型）：整点播报等本地事件用。
 * 复用助手气泡与情绪着色，情绪由文案本身推断。
 */
export function sayPetLine(text: string, holdMs = 6000): void {
  const line = text.trim();
  if (!line) return;
  const emo = classifyAssistantEmotion(line);
  if (emo !== "neutral") reactNow(emo);
  const b = addBubble("ai", emo !== "neutral" ? `${emotionEmoji(emo)} ${line}` : line);
  if (emo !== "neutral") b.dataset.emotion = emo;
  scheduleFade(b, holdMs);
}

export async function triggerProactive() {
  if (busy) return;
  const s = loadSettings();
  const apiKey = await ensureApiKey();
  if (!s.assistant.enabled || !isProviderReady(s.assistant, apiKey)) return;

  // 收集上下文
  let currentTitle = "";
  let currentApp = "";
  try {
    currentTitle = await invoke<string>("active_window_title");
  } catch { /* 忽略 */ }
  const tl = currentTitle.toLowerCase();
  if (tl.includes("code") || tl.includes("vscode")) currentApp = "VS Code";
  else if (tl.includes("chrome") || tl.includes("edge") || tl.includes("firefox")) currentApp = "浏览器";
  else if (tl.includes("wechat") || tl.includes("微信")) currentApp = "微信";
  else if (tl.includes("steam")) currentApp = "Steam";
  else if (tl.includes("bilibili") || tl.includes("哔哩哔哩")) currentApp = "B站";
  else if (tl.includes("netease") || tl.includes("网易云")) currentApp = "网易云音乐";

  const now = new Date();
  const hour = now.getHours();
  let timeOfDay = "afternoon";
  if (hour >= 6 && hour < 10) timeOfDay = "morning";
  else if (hour >= 10 && hour < 14) timeOfDay = "midday";
  else if (hour >= 14 && hour < 18) timeOfDay = "afternoon";
  else if (hour >= 18 && hour < 22) timeOfDay = "evening";
  else if (hour >= 22 || hour < 2) timeOfDay = "night";
  else timeOfDay = "late_night";

  const dayOfWeek = now.toLocaleDateString("zh-CN", { weekday: "long" });
  const timeStr = now.toLocaleString("zh-CN", { hour12: false });

  // 召回相关记忆
  const relevantMemories = recallRelevantMemories({ timeOfDay, currentApp, currentTitle });

  // 构建 prompt
  const memoryBlock = relevantMemories.length > 0
    ? "\n关于用户的记忆：\n" + relevantMemories.map(m => `- [${m.category}] ${m.content}`).join("\n")
    : "";
  const ctx = [currentApp ? `正在使用：${currentApp}` : "", currentTitle ? `窗口标题：${currentTitle.slice(0, 60)}` : ""].filter(Boolean).join("；");

  // 心情低谷 → 安慰模式（心情随主人情绪联动，低落说明最近主人不开心）
  const comfortLine = getMood().happiness < 0.35
    ? "\n【安慰模式】主人的心情最近有些低落，用你的人设温柔地安慰、陪伴一句，别提\"心情指数\"这类系统概念。"
    : "";
  const prompt = `[主动问候] ${timeStr}（${dayOfWeek}）${ctx ? "，" + ctx : ""}${memoryBlock}${comfortLine}\n\n` +
    "自然地和主人打个招呼或说一句关心的话，保持你的人设风格。\n" +
    "\n要求：简短（1-2句）、口语化、有温度、不要像客服。" +
    "如果有相关记忆可以自然引用，但不要生硬堆砌。\n" +
    "不要说\"作为AI\"之类的话，你就是桌宠伙伴。";

  // token 优化：问候用独立临时历史，不污染主对话历史（后续请求不携带问候上下文）
  const tmpHistory: ChatMessage[] = [{ role: "user", content: prompt }];
  busy = true;
  lifecycleOnOpen?.();
  const bubble = addBubble("ai", "");
  const colorHook = makeStreamColorHook(bubble);
  try {
    // enableTools=false：问候不需要工具，省掉整套工具定义的输入 token
    await chatStream(s.assistant.provider, apiKey, s.assistant.model, tmpHistory, s.assistant.persona, memory, s.assistant.customBaseUrl, (d) => {
      colorHook.push(d);
    }, false);
    for (const m of relevantMemories) {
      const orig = memory.find(e => e.id === m.id);
      if (orig) orig.lastUsedAt = Date.now();
    }
    saveMemory();
    boostMood("greeting_sent");
    const finalEmo = classifyAssistantEmotion(bubble.textContent);
    const emo = finalEmo !== "neutral" ? finalEmo : colorHook.lastEmotion();
    if (emo !== "neutral") {
      reactNow(emo);
      bubble.dataset.emotion = emo;
    }
    scheduleFade(bubble, 10000);
  } catch {
    bubble.remove();
  } finally {
    busy = false;
    lifecycleOnClose?.();
  }
}

/** 抽卡点评：用户关闭抽卡面板后，让 AI 根据卡牌结果发表评论 */
/** 抽卡点评：用户关闭抽卡面板后，让 AI 根据卡牌结果发表评论 */
/** 抽卡点评：用户关闭抽卡面板后，让 AI 根据卡牌结果发表评论（不污染聊天历史） */
export async function triggerCardCommentary(card: { rarity: string; theme: string; baseText: string; aiText: string }) {
  if (busy) return;
  const s = loadSettings();
  const apiKey = await ensureApiKey();
  if (!s.assistant.enabled || !isProviderReady(s.assistant, apiKey)) return;

  let cardInfo = `主题「${card.theme}」，祝福语：${card.baseText}`;
  if (card.aiText !== card.baseText) cardInfo += `，AI文案：${card.aiText}`;
  const prompt = `[抽卡点评] 刚才用户抽到了一张 ${card.rarity} 卡，${cardInfo}。用你的人设风格对这张卡发表一句简短的点评或吐槽（1-2句），保持口语化，不要复述祝福语。直接对用户说话。`;

  // 用临时 history，不污染主聊天历史
  const tmpHistory: ChatMessage[] = [{ role: "user", content: prompt }];
  busy = true;
  lifecycleOnOpen?.();
  const bubble = addBubble("ai", "");
  const colorHook = makeStreamColorHook(bubble);
  try {
    // enableTools=false：点评不需要工具，省 token
    await chatStream(s.assistant.provider, apiKey, s.assistant.model, tmpHistory, s.assistant.persona, memory, s.assistant.customBaseUrl, (d) => {
      colorHook.push(d);
    }, false);
    const finalEmo = classifyAssistantEmotion(bubble.textContent);
    const emo = finalEmo !== "neutral" ? finalEmo : colorHook.lastEmotion();
    if (emo !== "neutral") {
      reactNow(emo);
      bubble.dataset.emotion = emo;
    }
    // 不保存到主 history，避免影响主动问候
    scheduleFade(bubble, 8000);
  } catch {
    bubble.remove();
  } finally {
    busy = false;
    lifecycleOnClose?.();
  }
}
// 记忆初始化
loadMemory();








