import { invoke } from "@tauri-apps/api/core";
import { chatStream, extractCommand, stripCommand, type ChatMessage, type ToolCall, type MemoryEntry, type MemoryStore } from "./AssistantClient";
import { loadSettings } from "../utils/settings";
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

  // 发送下面：允许所有 shell 复选框（会话临时，不持久化）
  const allowRow = document.createElement("label");
  allowRow.className = "as-allow";
  allowAllShell = document.createElement("input");
  allowAllShell.type = "checkbox";
  allowAllShell.addEventListener("change", resetTimer);
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
  // 定位到模型（绿框）底部，不依赖 DOM 元素
  if (modelRect) {
    inputBar!.style.left = `${Math.round(modelRect.left)}px`;
    inputBar!.style.bottom = "auto";
    inputBar!.style.top = `${Math.min(modelRect.bottom + 10, window.innerHeight - 60)}px`;
  } else {
    inputBar!.style.left = "";
    inputBar!.style.bottom = "";
    inputBar!.style.top = "";
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

async function send(text: string) {
  if (busy) return;
  const s = loadSettings();
  const apiKey = await ensureApiKey();
  if (!apiKey) {
    const b = addBubble("sys", "未配置 API Key，请到「小助手设置」填写");
    scheduleFade(b, 4000);
    return;
  }
  history.push({ role: "user", content: text });
  saveHistory();
  busy = true;
  const loading = addBubble("ai", "");
  let streamed = false;
  try {
    // 循环处理：每轮 chatStream → 若有工具调用则执行并继续，否则结束（最多 4 轮）
    const MAX_ROUNDS = 4;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (round > 0) loading.textContent = "";
      const res = await chatStream(
        s.assistant.provider,
        apiKey,
        s.assistant.model,
        history,
        s.assistant.persona,
        memory,
        s.assistant.customBaseUrl,
        (delta) => {
          streamed = true;
          loading.textContent += delta;
        },
      );

      if (res.toolCalls.length) {
        // 工具调用：执行后进入下一轮
        if (round === 0 && !streamed) loading.textContent = "";
        await handleToolCalls(res.toolCalls, loading);
        continue;
      }

      // 无工具调用：文字入历史
      const finalText = loading.textContent || res.text;
      history.push({ role: "assistant", content: finalText });
      // CMD 兜底（非 function calling provider）
      const cmd = extractCommand(finalText);
      if (cmd) {
        loading.textContent = stripCommand(finalText) || "(执行中…)";
        await handleToolCalls(
          [{ id: `cmd_${Date.now()}`, name: "run_shell", args: { command: cmd } }],
          loading,
        );
        continue;
      }
      break;
    }
    saveHistory();

    // P3 主动学习：每 5 条对话自动提取新记忆（后台运行，不阻塞 UI）
    if (history.length % 5 === 0) {
      void extractMemoriesFromChat(s, apiKey);
    }
    if (!loading.textContent.trim()) loading.textContent = "(空回复)";
    scheduleFade(loading, 8000);
  } catch (e) {
    loading.textContent = String(e);
    scheduleFade(loading, 6000);
  } finally {
    busy = false;
    resetTimer();
  }
}

/** 处理工具调用：先 push assistant tool_calls 消息，再逐个执行并 push tool 消息 */
async function handleToolCalls(calls: ToolCall[], loading: HTMLElement) {
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
      history.push({ role: "tool", tool_call_id: tcItem.id, content: result });
    } catch (e) {
      history.push({ role: "tool", tool_call_id: tcItem.id, content: `失败：${e}` });
    }
  };

  for (const tc of calls) {
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
    const base = s.assistant.provider === "custom" ? s.assistant.customBaseUrl : "https://api.deepseek.com";
    const model = s.assistant.model || "deepseek-chat";
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
export async function triggerProactive() {
  if (busy) return;
  const s = loadSettings();
  const apiKey = await ensureApiKey();
  if (!s.assistant.enabled || !apiKey) return;

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

  const prompt = `[主动问候] ${timeStr}（${dayOfWeek}）${ctx ? "，" + ctx : ""}${memoryBlock}\n\n` +
    "自然地和主人打个招呼或说一句关心的话，保持你的人设风格。\n" +
    "\n要求：简短（1-2句）、口语化、有温度、不要像客服。" +
    "如果有相关记忆可以自然引用，但不要生硬堆砌。\n" +
    "不要说\"作为AI\"之类的话，你就是桌宠伙伴。";

  history.push({ role: "user", content: prompt });
  busy = true;
  lifecycleOnOpen?.();
  const bubble = addBubble("ai", "");
  try {
    await chatStream(s.assistant.provider, apiKey, s.assistant.model, history, s.assistant.persona, memory, s.assistant.customBaseUrl, (d) => {
      bubble.textContent += d;
    });
    history.push({ role: "assistant", content: bubble.textContent });
    saveHistory();
    for (const m of relevantMemories) {
      const orig = memory.find(e => e.id === m.id);
      if (orig) orig.lastUsedAt = Date.now();
    }
    saveMemory();
    scheduleFade(bubble, 10000);
  } catch {
    bubble.remove();
  } finally {
    busy = false;
    lifecycleOnClose?.();
  }
}
// 记忆初始化
loadMemory();








