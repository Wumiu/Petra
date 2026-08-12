import { invoke } from "@tauri-apps/api/core";
import { chat, extractCommand, stripCommand, type ChatMessage } from "./AssistantClient";
import { loadSettings } from "../utils/settings";

const MAX_BUBBLES = 2; // 左上角最多保留 2 条回复气泡

let inputBar: HTMLElement | null = null;
let bubbles: HTMLElement | null = null;
let input: HTMLInputElement;
let history: ChatMessage[] = [];
let timer: number | null = null;
let busy = false;
let lifecycleOnOpen: (() => void) | null = null;
let lifecycleOnClose: (() => void) | null = null;

/** 对话生命周期回调（main 注册：开→静止，关→恢复漫游） */
export function setLifecycle(onOpen: () => void, onClose: () => void) {
  lifecycleOnOpen = onOpen;
  lifecycleOnClose = onClose;
}

function ensureInput() {
  if (inputBar) return inputBar;
  inputBar = document.createElement("div");
  inputBar.id = "as-inputbar";
  inputBar.className = "as-inputbar hidden";
  input = document.createElement("input");
  input.className = "as-input";
  input.placeholder = "问点什么…（Enter 发送）";
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
  inputBar.append(input, btn);
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

/** 气泡淡出移除（临时气泡不常驻屏幕） */
function scheduleFade(el: HTMLElement, ms: number) {
  setTimeout(() => {
    if (!el.isConnected) return;
    el.style.transition = "opacity 0.4s ease";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 450);
  }, ms);
}

/** 只保留最近 MAX_BUBBLES 条 AI/状态气泡（确认气泡结束后移除自身） */
function trimBubbles() {
  const kids = Array.from(bubbles!.children);
  while (kids.length > MAX_BUBBLES) {
    kids.shift()?.remove();
  }
}

export function openAssistant() {
  ensureInput();
  ensureBubbles();
  inputBar!.classList.remove("hidden");
  input.focus();
  resetTimer();
  lifecycleOnOpen?.();
}

export function closeAssistant() {
  if (timer) clearTimeout(timer);
  inputBar?.classList.add("hidden");
  lifecycleOnClose?.();
}

export function resetHistory() {
  history = [];
  if (bubbles) bubbles.innerHTML = "";
}

async function send(text: string) {
  if (busy) return;
  const s = loadSettings();
  if (!s.assistant.apiKey) {
    const b = addBubble("sys", "未配置 API Key，请到「小助手设置」填写");
    scheduleFade(b, 4000);
    return;
  }
  // 用户消息不显示气泡
  history.push({ role: "user", content: text });
  busy = true;
  const loading = addBubble("ai", "…");
  try {
    const content = await chat(s.assistant.provider, s.assistant.apiKey, s.assistant.model, history, s.assistant.persona);
    loading.textContent = stripCommand(content) || "(空回复)";
    history.push({ role: "assistant", content });
    scheduleFade(loading, 8000);
    const cmd = extractCommand(content);
    if (cmd) addConfirm(cmd);
  } catch (e) {
    loading.textContent = String(e);
    scheduleFade(loading, 6000);
  } finally {
    busy = false;
    resetTimer();
  }
}

function addConfirm(cmd: string) {
  ensureBubbles();
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

  yes.addEventListener("click", async () => {
    yes.disabled = no.disabled = true;
    label.textContent = "执行中…";
    try {
      const r = await invoke<string>("run_shell", { command: cmd });
      label.textContent = `✓ ${r || "(无输出)"}`;
      scheduleFade(row, 3500);
    } catch (e) {
      label.textContent = `✗ ${e}`;
      scheduleFade(row, 4000);
    }
  });
  no.addEventListener("click", () => {
    row.remove();
    const b = addBubble("sys", "已拒绝执行命令");
    scheduleFade(b, 3500);
  });
}