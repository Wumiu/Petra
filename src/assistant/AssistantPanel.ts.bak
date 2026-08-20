import { invoke } from "@tauri-apps/api/core";
import { chatStream, extractCommand, stripCommand, type ChatMessage, type ToolCall } from "./AssistantClient";
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
let memory: string[] = [];
let timer: number | null = null;
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
    memory = JSON.parse(localStorage.getItem(MEM_KEY) || "[]");
  } catch {
    memory = [];
  }
}
function saveMemory() {
  try {
    localStorage.setItem(MEM_KEY, JSON.stringify(memory.slice(-50)));
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
      if (content && !memory.includes(content)) {
        memory.push(content);
        saveMemory();
      }
      history.push({ role: "tool", tool_call_id: tc.id, content: "已记住" });
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

/** 主动问候：拿当前前台窗口标题/进程喂给 AI，智能打招呼 */
export async function triggerProactive() {
  if (busy) return;
  const s = loadSettings();
  const apiKey = await ensureApiKey();
  if (!s.assistant.enabled || !apiKey) return;
  let activity = "";
  try {
    activity = await invoke<string>("active_window_title");
  } catch {
    /* 忽略 */
  }
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  history.push({ role: "user", content: `[主动问候] 现在是 ${now}，用户当前正忙：${activity || "未知"}。请据此自然地和主人打个招呼或提醒（简短一句）。` });
  busy = true;
  lifecycleOnOpen?.(); // 主动说话时桌宠静止
  const bubble = addBubble("ai", "");
  try {
    await chatStream(s.assistant.provider, apiKey, s.assistant.model, history, s.assistant.persona, memory, s.assistant.customBaseUrl, (d) => {
      bubble.textContent += d;
    });
    history.push({ role: "assistant", content: bubble.textContent });
    saveHistory();
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
