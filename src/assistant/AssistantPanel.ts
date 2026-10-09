import { invoke } from "@tauri-apps/api/core";
import { readingHoldMs } from "../ui/bubbleTiming";
import { chatStream, extractCommand, stripCommand, PROVIDERS, isProviderReady, type ChatMessage, type ToolCall, type MemoryEntry, type MemoryStore } from "./AssistantClient";
import { classifyEmotion, classifyAssistantEmotion, moodFallbackEmotion, reactNow, emotionEmoji, boostMood, getMood, type EmotionTag } from "./EmotionEngine";
import type { AssistantProvider } from "../utils/settings";
import { trackEvent } from "../features/diary/DiaryEventTracker";
import { dailyDraw, hasDrawnToday, getTodayDraw, getCollectionProgress } from "../features/card/DailyCardManager";
import { loadDiaries, getDiary } from "../features/diary/DiaryManager";
import { loadSettings, saveSettings } from "../utils/settings";
import { buildLanguageInstruction, buildLanguageReminder, langNameOf, splitTranslation } from "../utils/outputLanguage";
import {
  buildCardCommentPrompt,
  buildGreetingPrompt,
  proactiveLangInstruction,
} from "./proactivePrompts";
import { ToolLoopBudget, formatToolError, toolNames, truncateToolResult, validateToolArgs } from "./toolRuntime";
import { ttsPlayer } from "../tts/TTSPlayer";
import { getVisibleRect } from "../ui/visible";
import { deleteWrongHistory } from "./ChatHistory";
import { toast } from "../ui/Toast";
import { getSpeechRecognizer, type SpeechRecognizer } from "../asr/SpeechRecognizer";

const MAX_BUBBLES = 2;
/** 输入条空闲多久自动收起（毫秒）。只认"真的在用"：点它、打字、用语音 */
const IDLE_HIDE_MS = 20000;
const HIST_KEY = "live2d-pet-assistant-history";
const MEM_KEY = "live2d-pet-assistant-memory";

let inputBar: HTMLElement | null = null;
let bubbles: HTMLElement | null = null;
let input: HTMLTextAreaElement;
let allowAllShell: HTMLInputElement;
let history: ChatMessage[] = [];
let lastChatLang = "";
let memory: MemoryStore = [];
let timer: number | null = null;
let busy = false;
let lifecycleOnOpen: (() => void) | null = null;
let lifecycleOnClose: (() => void) | null = null;

/**
 * 语音输入。模块级持有：`closeAssistant` 必须能停掉它。
 *
 * 之前只有 ensureInput 的闭包里攥着这个引用，结果是"关掉小助手"跟麦克风毫无关系 ——
 * 面板关了，录音还在跑（Mac/Linux 上环境噪音一直有的话 VAD 永远不判静音，
 * 麦克风就一直亮着），而且说完还会触发一次发送，气泡在输入框已经隐藏的情况下冒出来。
 */
let recognizer: SpeechRecognizer | null = null;
let micBtn: HTMLButtonElement | null = null;

/** 麦克风图标：细描边的胶囊 + 拾音弧 + 支架，24 网格便于缩放 */
const MIC_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="2.6" width="6" height="10.8" rx="3"></rect>' +
  '<path d="M5.6 11.2a6.4 6.4 0 0 0 12.8 0"></path>' +
  '<path d="M12 17.6V21"></path></svg>';

/** 录音中的律动条（4 根，错开相位；纯 CSS 动画） */
const MIC_WAVE_HTML =
  '<span class="as-mic-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';

function getRecognizer(): SpeechRecognizer {
  if (!recognizer) recognizer = getSpeechRecognizer();
  return recognizer;
}

/** 输入框最多长到几行（再高就自己内部滚动），大约 6 行 */
const INPUT_MAX_HEIGHT = 96;

/**
 * 输入框随内容向下长高。
 *
 * 语音识别一次能吐一大段，单行框只能横向滚 —— 用户既看不全刚识别出来的字，
 * 也没机会在发送前扫一眼。这里按 scrollHeight 长高，超过上限就内部滚动。
 */
function autoGrowInput(): void {
  if (!input) return;
  input.style.height = "auto";
  const next = Math.min(input.scrollHeight, INPUT_MAX_HEIGHT);
  input.style.height = `${next}px`;
  input.style.overflowY = input.scrollHeight > INPUT_MAX_HEIGHT ? "auto" : "hidden";
  keepInputBarOnScreen();
}

/** 设置输入框内容并同步高度（程序赋值不会触发 input 事件，必须手动长高） */
function setInputValue(text: string): void {
  input.value = text;
  autoGrowInput();
}

/**
 * 长高之后把整条输入条拉回窗口可见区。
 *
 * 输入条是往下长的，桌宠贴屏幕下边缘时会长到屏幕外 —— 挡住的部分正好是
 * 用户要看的那几行字。这里只往上挪输入条，不改变它左右位置。
 */
function keepInputBarOnScreen(): void {
  if (!inputBar || inputBar.classList.contains("hidden")) return;
  const vr = getVisibleRect();
  const r = inputBar.getBoundingClientRect();
  const overflow = r.bottom - (vr.bottom - 8);
  if (overflow > 0) {
    const curTop = parseFloat(inputBar.style.top || "0") || r.top;
    const minTop = vr.top + 8;
    inputBar.style.top = `${Math.round(Math.max(minTop, curTop - overflow))}px`;
  }
}

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
async function loadHistory() {
  try {
    // 从用户数据目录读（app_data_dir/chat-history.json），卸载重装后仍保留
    let raw = await invoke<string>("load_chat_history");
    // 一次性迁移：老版本历史存在 localStorage，若文件里还没有，把 localStorage 的搬过来并写文件
    if (!raw) {
      const legacy = localStorage.getItem(HIST_KEY);
      if (legacy) {
        raw = legacy;
        void invoke("save_chat_history", { content: legacy }).catch(() => {});
        localStorage.removeItem(HIST_KEY);
      }
    }
    const h = JSON.parse(raw || "[]");
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
      history = cleaned; // 全量保留，不截断
    }
  } catch {
    history = [];
  }
}
function saveHistory() {
  // 整体覆盖写到 app_data_dir/chat-history.json；fire-and-forget，失败不阻塞对话
  void invoke("save_chat_history", { content: JSON.stringify(history) }).catch(() => {});
}

function ensureInput() {
  if (inputBar) return inputBar;
  inputBar = document.createElement("div");
  inputBar.id = "as-inputbar";
  inputBar.className = "as-inputbar hidden";

  const row = document.createElement("div");
  row.className = "as-input-row";
  // 用 textarea 而不是 input：语音识别可能说出一大段，单行框只能横向滚，
  // 看着就是"识别出了什么我看不全"。textarea 会随内容向下长高（见 autoGrowInput）。
  input = document.createElement("textarea");
  input.className = "as-input";
  input.rows = 1;
  input.placeholder = "问点什么…";
  input.addEventListener("input", () => {
    resetTimer();
    autoGrowInput();
  });
  // 失焦不再自动关闭输入框（点麦克风按钮会失焦，之前 2.5 秒就被关了）
  // 关闭只靠 20 秒无操作超时，或者用户主动关闭。
  input.addEventListener("keydown", (e) => {
    // Enter 发送，Shift+Enter 换行（多行框的常规约定）
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const t = input.value.trim();
      if (t) {
        setInputValue("");
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
      setInputValue("");
      void send(t);
    }
  });

  // 语音输入按钮：点一下开始听，边说边出字，说完停顿自动发送；正在听时再点一下取消。
  // 取消语义很重要 —— 之前"再点一下"走的是 stop()，会把手里的识别结果直接发出去，
  // 用户想反悔却把话发出去了。
  //
  // 图标用内联 SVG 而不是 🎤 emoji：emoji 在不同系统/字体下长得不一样，缩放也糊，
  // 塞进 26px 圆钮里显廉价。录音中的"律动音量条"同样交给 CSS 动画（纯装饰，
  // 不依赖真实音量——浏览器原生识别那条路拿不到音量）。
  const mic = document.createElement("button");
  mic.className = "as-mic";
  mic.type = "button";
  mic.innerHTML = MIC_ICON_SVG + MIC_WAVE_HTML;
  mic.title = "语音输入（说完自动发送，再点一下取消）";
  mic.setAttribute("aria-label", "语音输入");
  mic.setAttribute("aria-pressed", "false");
  mic.addEventListener("click", () => void toggleVoiceInput());
  micBtn = mic;

  row.append(input, mic, btn);

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
  // 点输入条也算"人在用它"：重置空闲计时（顺带阻止事件穿透到桌宠的拖动/摸头）
  inputBar.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    resetTimer();
  });
  document.body.appendChild(inputBar);
  return inputBar;
}

/** 由 main.ts 注入：拿到桌宠（模型）当前位置，用来把气泡放到不挡它的地方 */
let modelRectProvider: (() => { left: number; top: number; right: number; bottom: number } | null) | null = null;

export function setModelRectProvider(fn: () => { left: number; top: number; right: number; bottom: number } | null): void {
  modelRectProvider = fn;
}

/**
 * 给气泡区定位：优先放在**模型上方**，上方放不下就放到下方/可见区内，
 * 并整体钳制在可见区内。以前气泡固定贴在窗口底部中间，正好把桌宠挡住。
 *
 * 例外：「对话记录」面板（#chat-history-panel）打开时，气泡一律挪到面板正下方，
 * 绝不遮挡面板内容；下方放不下才退到面板上方。
 */
function positionBubbles() {
  if (!bubbles) return;
  const vr = getVisibleRect();
  const availW = Math.max(140, vr.right - vr.left - 16);
  const width = Math.min(300, availW);
  bubbles.style.width = `${width}px`;

  const h = bubbles.offsetHeight || 80;
  const clampLeft = (l: number) => Math.min(Math.max(l, vr.left + 8), Math.max(vr.left + 8, vr.right - width - 8));
  const clampTop = (t: number) => Math.min(Math.max(t, vr.top + 8), Math.max(vr.top + 8, vr.bottom - h - 8));

  // 对话记录面板打开：气泡贴到面板正下方，不遮挡面板
  const historyPanel = document.getElementById("chat-history-panel") as HTMLElement | null;
  if (historyPanel && historyPanel.isConnected) {
    const pr = historyPanel.getBoundingClientRect();
    const gap = 8;
    let belowTop = pr.bottom + gap;
    let top = belowTop + h <= vr.bottom - 8 ? belowTop : pr.top - h - gap;
    bubbles.style.left = `${clampLeft(pr.left)}px`;
    bubbles.style.top = `${clampTop(top)}px`;
    return;
  }

  const rect = modelRectProvider?.() ?? null;
  if (!rect) {
    // 没有模型位置：贴可见区左上角，绝不压住窗口中心
    bubbles.style.left = `${vr.left + 8}px`;
    bubbles.style.top = `${vr.top + 8}px`;
    return;
  }

  const above = rect.top - h - 8;
  // 往下放时要躲开输入条（输入条就在模型下方），否则气泡会压在输入框上
  const inputOpen = inputBar !== null && !inputBar.classList.contains("hidden");
  const below = rect.bottom + 8 + (inputOpen ? (inputBar!.offsetHeight || 60) + 8 : 0);
  const canAbove = above >= vr.top + 8;
  const canBelow = below + h <= vr.bottom - 8;
  const top = canAbove ? above : canBelow ? below : clampTop(above);
  bubbles.style.left = `${clampLeft(rect.left)}px`;
  bubbles.style.top = `${clampTop(top)}px`;
}

function ensureBubbles() {
  if (bubbles) return bubbles;
  bubbles = document.createElement("div");
  bubbles.id = "as-bubbles";
  bubbles.className = "as-bubbles";
  bubbles.addEventListener("pointerdown", (e) => e.stopPropagation());
  // 鼠标停在气泡上时别把输入条收起来：用户大概率还在读回复 / 想接着打字
  // 注意：气泡的 pointerenter / pointerleave **不碰**空闲计时器。
  // 以前 pointerenter 会把计时器清掉、pointerleave 再续上，于是只要鼠标停在气泡上
  // （气泡就贴在桌宠上方，鼠标经常正好在那儿），输入条就永远不收了 —— 那正是
  // "长时间没点没打字却一直杵着"的另一半原因。气泡自己悬停不淡出由 scheduleFade 管，
  // 跟输入条的空闲收起是两件事。
  document.body.appendChild(bubbles);
  return bubbles;
}

function resetTimer() {
  if (timer) clearTimeout(timer);
  // 5 分钟没在用（没点输入条、没打字、没语音）就把输入条收起来
  timer = setTimeout(() => {
    timer = null;
    // 正在听语音时不收：麦克风还开着，把面板收掉等于打断用户说话。
    // 这跟以前那个 `if (busy) 续一轮` 不一样 —— 识别器自己有上限
    // （说完了 / 一直没声音 / 硬上限 60 秒都会结束），不会无限续下去。
    if (recognizer?.isRecording()) {
      resetTimer();
      return;
    }
    // 这里**不能**再看 busy 续命：桌宠流式回话、卡在工具循环里时 busy 可能长时间为真，
    // 输入条就永远收不掉了（用户实际遇到的就是这个）。收起只隐藏输入条，气泡与回复
    // 照常显示，所以"等它说完再收"本来就没必要。
    closeAssistant();
  }, IDLE_HIDE_MS);
}

/** 把识别器的事件接到输入框上（每次点麦克风都重接一遍，反正很便宜） */
function wireRecognizer(): SpeechRecognizer {
  const r = getRecognizer();
  r.setHandlers({
    onPartial: (text) => {
      // 边说边出字：长句子会自动向下长高，用户能看清识别成了什么
      setInputValue(text);
      // 程序改 value **不会**触发 input 事件，语音必须自己续命，
      // 否则"只靠说话"的用户会在面板空闲超时那一刻被自动关闭（录音一起被掐）
      resetTimer();
    },
    onFinal: (text) => {
      const t = text.trim();
      resetTimer();
      if (!t) return;
      if (busy) {
        // send() 忙的时候会直接 return；不留住的话用户刚说的话就凭空消失了
        setInputValue(t);
        toast("上一句还没答完，这句先放进输入框了", "warn");
        return;
      }
      setInputValue("");
      // 把你刚说的话以气泡形式留在屏幕上：语音是"说完就自动发送"，输入框立刻被清空，
      // 不 echo 的话用户根本没机会看清这次识别成了什么（原来的体验就是"还没看到就发出去了"）
      addBubble("user", t);
      void send(t);
    },
    onRecordingStart: () => { input.placeholder = "正在听…"; },
    // 听了半天一个字都没识别到：必须出声，不然就是"点了麦克风没反应"
    onNoSpeech: () => { toast("没听到内容，再说一次试试（确认麦克风没被静音）", "warn"); },
    onError: (msg) => { toast(msg, "warn"); },
    onStateChange: (recording) => {
      if (!micBtn) return;
      // 外观全部交给 CSS（图标↔律动条、光环、渐变都挂在 .as-mic-recording 上）：
      // 这里千万不要再动 textContent，否则会把内联 SVG 一起抹掉
      micBtn.classList.toggle("as-mic-recording", recording);
      micBtn.setAttribute("aria-pressed", recording ? "true" : "false");
      micBtn.title = recording
        ? "正在听…（再点一下取消）"
        : "语音输入（说完自动发送，再点一下取消）";
      input.placeholder = recording ? "正在听…" : "问点什么…";
    },
  });
  return r;
}

/** 点麦克风：没在听就开始听，正在听就取消（取消 = 丢弃，不发送） */
async function toggleVoiceInput(): Promise<void> {
  const r = wireRecognizer();
  resetTimer(); // 碰麦克风也算"人在互动"，别让空闲超时把面板收走
  if (r.isRecording()) {
    r.cancel();
    return;
  }
  // 在线识别（Mac/Linux，以及原生识别降级后的 Windows）要有可用的 Key，
  // 否则点下去只是白录一轮再报错。这里问 asr_key_ready 而不是 get_asr_key：
  // 后者只报"用户自己填的"，内置的默认 Key 是隐藏的（不能显示到界面上）
  if (r.needsApiKey()) {
    const ready = await invoke<boolean>("asr_key_ready").catch(() => false);
    if (!ready) {
      toast("未配置语音识别 API Key：右键 →「🎤 语音识别设置」", "warn");
      return;
    }
  }
  // 抢话：麦克风开着时 TTS 还在响，识别会把桌宠自己的声音也听进去
  if (ttsPlayer.isSpeaking()) ttsPlayer.stop();
  r.start();
}

/**
 * 文件写操作的确认气泡。
 *
 * 与 run_shell 的「允许 / 拒绝」同一套交互，额外给一个「以后不再确认」勾选框
 * （勾了就把 settings.allowAllFileWrite 置真并持久化，和 allowAllShell 一个路子）。
 * 读文件不弹：agent 要先看才能改，读又不会破坏东西，沙箱在 Rust 侧兜着。
 */
async function confirmFileWrite(action: string): Promise<boolean> {
  if (loadSettings().allowAllFileWrite) return true;
  return await new Promise<boolean>((resolve) => {
    ensureBubbles();
    const row = document.createElement("div");
    row.className = "as-bubble as-confirm";
    const label = document.createElement("span");
    label.textContent = action;
    const yes = document.createElement("button");
    yes.className = "as-btn";
    yes.textContent = "允许";
    const no = document.createElement("button");
    no.className = "as-btn as-btn-no";
    no.textContent = "拒绝";
    const remember = document.createElement("label");
    remember.className = "as-allow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const cbText = document.createElement("span");
    cbText.textContent = "以后不再确认";
    remember.append(cb, cbText);
    row.append(label, yes, no, remember);
    bubbles!.appendChild(row);
    positionBubbles();
    const finish = (ok: boolean) => {
      if (ok && cb.checked) {
        const s = loadSettings();
        s.allowAllFileWrite = true;
        saveSettings(s);
      }
      row.remove();
      positionBubbles();
      resolve(ok);
    };
    yes.addEventListener("click", () => finish(true));
    no.addEventListener("click", () => finish(false));
  });
}

/** 文件禁止目录：每次现读设置，改了立刻生效（不用重开面板） */
function fileDenyPaths(): string[] {
  return loadSettings().fileDenyPaths ?? [];
}

/**
 * 气泡正文容器。
 *
 * 文字**必须**写进它，不能写 `.as-bubble` —— 右上角那个「×」是气泡的子节点，
 * 一旦 `bubble.textContent = ...` 就把叉一起抹掉了（以前气泡里没有子元素，才能这么写）。
 */
function bubbleBody(b: HTMLElement): HTMLElement {
  return (b.querySelector(".as-bubble-body") as HTMLElement | null) ?? b;
}

function setBubbleText(b: HTMLElement, text: string): void {
  bubbleBody(b).textContent = text;
}

function getBubbleText(b: HTMLElement): string {
  return bubbleBody(b).textContent ?? "";
}

/** 气泡右上角的「×」：点一下删掉这条气泡（0.19s 淡出，别硬闪没了） */
function attachBubbleClose(b: HTMLElement): void {
  const x = document.createElement("button");
  x.className = "as-bubble-close";
  x.type = "button";
  x.textContent = "×";
  x.title = "关闭";
  x.setAttribute("aria-label", "关闭这条气泡");
  // 和气泡里的静音键一样登记成可交互元素，免得点击被窗口的穿透逻辑吃掉
  x.setAttribute("data-petra-interactive", "true");
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    b.style.transition = "opacity 0.18s ease";
    b.style.opacity = "0";
    window.setTimeout(() => {
      b.remove();
      positionBubbles();
    }, 190);
  });
  b.appendChild(x);
}

function addBubble(kind: "ai" | "sys" | "confirm" | "user", text: string): HTMLElement {
  ensureBubbles();
  const b = document.createElement("div");
  b.className = `as-bubble as-${kind}`;
  const body = document.createElement("div");
  body.className = "as-bubble-body";
  body.textContent = text;
  b.appendChild(body);
  // 对话类气泡给一个「×」；确认类气泡（自带允许/拒绝）不走这里，也就没有叉
  if (kind !== "confirm") attachBubbleClose(b);
  bubbles!.appendChild(b);
  trimBubbles();
  positionBubbles(); // 气泡数量变化会改高度，重新算一次位置
  return b;
}

/**
 * 定时淡出气泡。
 * 鼠标悬停时**暂停**倒计时（用户还在看），移开后继续、并至少再留 1.5 秒。
 * 以前是死等 ms 毫秒，悬停没有任何用，长回复常被"抢走"。
 */
function scheduleFade(el: HTMLElement, ms: number) {
  let remaining = Math.max(1000, ms);
  let startedAt = Date.now();
  let handle: number | null = null;

  const fade = () => {
    handle = null;
    if (!el.isConnected) return;
    el.style.transition = "opacity 0.4s ease";
    el.style.opacity = "0";
    window.setTimeout(() => el.remove(), 450);
  };
  const arm = () => {
    startedAt = Date.now();
    handle = window.setTimeout(fade, remaining);
  };
  const pause = () => {
    if (handle === null) return;
    window.clearTimeout(handle);
    handle = null;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  };
  const resume = () => {
    if (handle !== null || !el.isConnected) return;
    remaining = Math.max(remaining, 1500);
    arm();
  };

  el.addEventListener("pointerenter", pause);
  el.addEventListener("pointerleave", resume);
  arm();
}

function trimBubbles() {
  const kids = Array.from(bubbles!.children);
  while (kids.length > MAX_BUBBLES) {
    kids.shift()?.remove();
  }
  positionBubbles();
}

export async function openAssistant(modelRect?: { left: number; top: number; right: number; bottom: number }) {
  ensureInput();
  ensureBubbles();
  loadMemory();
  await loadHistory();
  inputBar!.classList.remove("hidden");
  // 定位到模型（绿框）附近：默认放底部，放不下翻到上方；始终钳制在窗口可见区内（贴边自适应）
  if (modelRect) {
    const vr = getVisibleRect();
    const barW = inputBar!.offsetWidth || 185;
    const barH = inputBar!.offsetHeight || 60;
    // 水平居中在模型正下方：模型中心 - 输入框半宽
    const modelCenterX = modelRect.left + (modelRect.right - modelRect.left) / 2;
    const centeredLeft = modelCenterX - barW / 2;
    // 避开已显示的信息板（避免叠放遮挡：信息板先于输入框定位）
    const infoEl = document.getElementById("info-panel");
    const infoRect =
      infoEl && !infoEl.classList.contains("hidden") ? infoEl.getBoundingClientRect() : null;
    const collides = (l: number, t: number) =>
      infoRect !== null &&
      l < infoRect.right && l + barW > infoRect.left &&
      t < infoRect.bottom && t + barH > infoRect.top;
    const cands = [
      { left: centeredLeft, top: modelRect.bottom + 10 }, // 模型下方居中（默认）
      { left: centeredLeft, top: vr.bottom - barH }, // 可见区底部居中（贴底时允许盖住模型下半部分）
      { left: centeredLeft, top: modelRect.top - barH - 10 }, // 模型上方居中（最后尝试）
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
  autoGrowInput(); // 面板关着时长高不了（拿不到 scrollHeight），打开时补一次
  resetTimer();
  lifecycleOnOpen?.();
}

export function closeAssistant() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // 面板要关了，麦克风不能还开着：用 cancel（丢弃结果），
  // 否则关掉之后还会因为"识别完成"冒出一次发送和一串气泡
  recognizer?.cancel();
  inputBar?.classList.add("hidden");
  lifecycleOnClose?.();
}

/** 清空左上角气泡区（关闭小助手模式时用） */
export function clearBubbles() {
  if (bubbles) bubbles.innerHTML = "";
}

/** 外部触发重定位（例如对话记录面板打开/关闭时）：让对话气泡避开面板 */
export function repositionAssistantBubbles(): void {
  positionBubbles();
}

/** 清空对话历史（保留长期记忆 memory） */
export function clearHistory() {
  history = [];
  try {
    void invoke("save_chat_history", { content: "[]" }).catch(() => {});
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
 * 上色用的情绪：优先用识别到的；识别不到就用桌宠当前心情兜底。
 * 只影响颜色，不影响表情动作（动作只由真正识别到的情绪触发）。
 */
function bubbleEmotion(detected: EmotionTag): EmotionTag {
  return detected !== "neutral" ? detected : moodFallbackEmotion(getMood());
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
      bubbleBody(el).textContent += delta;
      const now = Date.now();
      if (now - lastAt < 250) return; // 节流：最多每 250ms 重新判定一次
      lastAt = now;
      const emo = classifyAssistantEmotion(getBubbleText(el));
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
function buildChatContext(nickname: string, outputLang: string): string {
  const now = new Date();
  const hour = now.getHours();
  const day = now.toLocaleDateString("zh-CN", { weekday: "long" });
  const parts: string[] = [];
  if (nickname) {
    if (outputLang && outputLang !== "zh-cn") {
      parts.push(`用户昵称：${nickname}（用${langNameOf(outputLang)}自然地称呼用户，不要翻译成中文）`);
    } else {
      parts.push(`对用户的称呼：${nickname}`);
    }
  }
  parts.push(`现在：${day}${hour}点`);
  return `[环境] ${parts.join("；")}`;
}

async function send(text: string) {
  if (busy) return;
  const s = loadSettings();
  const ttsKey = await invoke<string>("get_tts_key").catch(() => "");
  ttsPlayer.setConfig(s.tts.enabled, ttsKey, s.tts.speakerId, s.assistant.outputLanguage ?? "");
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
  if (!s.assistant.persona.trim()) {
    const b = addBubble("sys", "请先到「小助手设置」填写人格设定（必填）");
    scheduleFade(b, 5000);
    return;
  }
  const outLang = s.assistant.outputLanguage;
  // 换语言时清空对话历史
  if (lastChatLang !== outLang && history.length > 0) {
    history = [];
  }
  lastChatLang = outLang;
  // 语言提醒压在用户消息末尾：模型对末尾最敏感，放中段会被后面的中文语境带跑
  const langReminder = buildLanguageReminder(outLang ?? "");
  const userContent = langReminder ? `${text}\n${langReminder}` : text;
  history.push({ role: "user", content: userContent });
  saveHistory();
  // 情感反馈：先分析用户消息（零 token），立即驱动角色表情/动作 + 心情
  const userEmo = classifyEmotion(text);
  reactNow(userEmo);
  boostMood("chat");
  if (userEmo !== "neutral") boostMood(userEmo);
  // 截图：由模型通过 capture_screen 工具触发，不再前端关键词预判。
  // 只在本轮生效、不进历史 —— 图片 base64 很大，进历史会把存储撑爆。
  const screenshot: { image: string | undefined } = { image: undefined };
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
      if (budget.rounds > 1) setBubbleText(loading, "");
      // token 优化：记忆按场景/话题召回（≤6 条），而非全量注入 system prompt
      const ctxMemories = recallRelevantMemories({ timeOfDay: timeOfDayKey(), userText: text });
      const langInstruction = buildLanguageInstruction(s.assistant.outputLanguage ?? "", { pinChinese: true });
      const personaWithLang = s.assistant.persona;
      const extraCtxWithLang = buildChatContext(s.assistant.nickname, s.assistant.outputLanguage ?? "") + "\n\n" + langInstruction;

      const res = await chatStream(
        s.assistant.provider,
        apiKey,
        s.assistant.model,
        history,
        personaWithLang,
        ctxMemories,
        s.assistant.customBaseUrl,
        (delta) => {
          streamed = true;
          colorHook.push(delta);
          ttsPlayer.pushDelta(delta);
        },
        true,
        extraCtxWithLang,
        "",
        // 有截图就传（可能模型第二轮才调用截图工具）
        screenshot.image ? { screenImage: screenshot.image } : undefined,
      );
      if (colorHook.lastEmotion() !== "neutral") streamEmo = colorHook.lastEmotion();

      if (res.toolCalls.length) {
        // 工具调用：执行后进入下一轮
        if (budget.rounds === 1 && !streamed) setBubbleText(loading, "");
        await handleToolCalls(res.toolCalls, loading, budget, screenshot);
        continue;
      }

      // 无工具调用：文字入历史
      const rawText = res.text;
      // 分离翻译：原文 + --- + 翻译
      const split = splitTranslation(rawText);
      const mainText = split.main;
      let transText = split.trans;
      // 历史只存中文翻译（或中文原文）
      history.push({ role: "assistant", content: transText || mainText });
      // 情感反馈
      const finalEmo = classifyAssistantEmotion(mainText);
      const aiEmo = finalEmo !== "neutral" ? finalEmo : streamEmo;
      setBubbleText(loading, "");
      bubbleBody(loading).append(document.createTextNode(aiEmo !== "neutral" ? `${emotionEmoji(aiEmo)} ${mainText}` : mainText));
      if (transText) {
        const div = document.createElement("div");
        div.style.cssText = "font-size:11px;opacity:0.55;margin-top:4px;white-space:pre-wrap;";
        div.textContent = transText;
        bubbleBody(loading).appendChild(div);
      } else if (outLang && outLang !== "zh-cn" && mainText) {
        // 自动翻译：异步请求中文翻译
        const transDiv = document.createElement("div");
        transDiv.style.cssText = "font-size:11px;opacity:0.55;margin-top:4px;white-space:pre-wrap;";
        transDiv.textContent = "翻译中...";
        loading.appendChild(transDiv);
        (async () => {
          try {
            const t = await chatStream(
              s.assistant.provider, apiKey, s.assistant.model,
              [], "你是翻译器，把以下文本翻译成中文，只输出翻译结果：",
              [], "", () => {}, false,
              `翻译：${mainText}`,
            );
            transText = t.text.trim();
            transDiv.textContent = transText;
            history[history.length - 1].content = transText;
          } catch {
            transDiv.remove();
          }
        })();
      }
      if (aiEmo !== "neutral") {
        reactNow(aiEmo);
        boostMood(aiEmo);
      }
      // 颜色：识别不到情绪时用当前心情兜底，避免大部分回复都是白气泡
      loading.dataset.emotion = bubbleEmotion(aiEmo);
      // 小喇叭静音按钮
      const muteBtn = document.createElement("div");
      muteBtn.setAttribute("data-petra-interactive", "true");
      muteBtn.style.cssText = "display:inline-block;margin-top:6px;cursor:pointer;font-size:14px;opacity:0.7;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.1);";
      muteBtn.textContent = ttsPlayer.muted ? "🔇" : "🔊";
      muteBtn.onclick = (e) => {
        e.stopPropagation();
        // 实时静音/放声：交给 TTSPlayer 立刻改正在播的那一段的音量。
        // 不能靠查 DOM 设 volume —— new Audio() 的元素不在 DOM 里，查不到（老 bug）。
        ttsPlayer.setMuted(!ttsPlayer.muted);
        muteBtn.textContent = ttsPlayer.muted ? "🔇" : "🔊";
      };
      loading.appendChild(muteBtn);
      // 记录对话事件（日记系统）：记用户说的话（tracker 内部 safeSlice 截到 80 字）
      trackEvent({ type: "chat", summary: text });
      // CMD 兜底（非 function calling provider）
      const cmd = extractCommand(mainText);
      if (cmd) {
        setBubbleText(loading, stripCommand(mainText) || "(执行中…)");
        await handleToolCalls(
          [{ id: `cmd_${Date.now()}`, name: "run_shell", args: { command: cmd } }],
          loading,
          budget,
          screenshot,
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
    ttsPlayer.flush();

    // P3 主动学习：每 5 条对话自动提取新记忆（后台运行，不阻塞 UI）
    if (history.length % 5 === 0) {
      void extractMemoriesFromChat(s, apiKey);
    }
    if (!getBubbleText(loading).trim()) setBubbleText(loading, "(空回复)");
    // AI 回复气泡不自动消失，一直留着；新气泡进来会自动挤掉旧的（MAX_BUBBLES=2），
    // 关闭助手时整体清空，或者用户点右上角的叉手动删掉。TTS 播完也不淡。
  } catch (e) {
    setBubbleText(loading, friendlyApiError(e));
    loading.dataset.emotion = "worried";
    // 出错时桌宠也难过一下，但不消耗任何 token
    reactNow("worried");
    scheduleFade(loading, readingHoldMs(getBubbleText(loading), 8000));
  } finally {
    busy = false;
    resetTimer(); // 一轮对话结束 = 一次互动，空闲窗口重新开始计时
  }
}

/** 把提示合并到工具结果前面（一个 tool_call 只能对应一条 tool 消息，不能多发一条） */
function withHint(text: string, hint: string): string {
  return hint ? `${hint}\n${text}` : text;
}

/** 处理工具调用：先 push assistant tool_calls 消息，再逐个执行并 push tool 消息 */
async function handleToolCalls(calls: ToolCall[], loading: HTMLElement, budget: ToolLoopBudget, screenshot: { image: string | undefined }) {
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
    if (tc.name === "delete_wrong_history") {
      const keywords = String(tc.args.keywords ?? "").trim().split(/\s+/).filter(Boolean);
      if (keywords.length === 0) {
        history.push({ role: "tool", tool_call_id: tc.id, content: "没有提供关键词" });
        continue;
      }
      // 按完整旧轮次删除，避免留下孤立 tool 消息；当前纠正和正在执行的工具保留。
      const beforeDelete = history.length;
      history = deleteWrongHistory(history, keywords);
      const deleted = beforeDelete - history.length;
      history.push({ role: "tool", tool_call_id: tc.id, content: `已删除旧对话中的${deleted}条消息，保留了本轮纠正。` });
      continue;
    }
    if (tc.name === "launch_application") {
      const app = String(tc.args.application ?? "").trim();
      if (!app) {
        history.push({ role: "tool", tool_call_id: tc.id, content: "应用名称为空" });
        continue;
      }
      setBubbleText(loading, "启动中…");
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
        setBubbleText(loading, "执行中…");
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
    if (tc.name === "close_web_page") {
      // 关哪个由用户说，关不关得掉由 Rust 侧如实回报（找不到 / 匹配到多个都会回候选列表）
      await invokeTool(tc, "close_web_page", { keyword: String(tc.args.keyword || "") });
    }
    if (tc.name === "open_path") {
      await invokeTool(tc, "open_path", { path: String(tc.args.path || "") });
    }
    // ---------- 文件能力 ----------
    // 读/列：直接执行（不改动任何东西，沙箱在 Rust 侧）
    if (tc.name === "read_text_file") {
      await invokeTool(tc, "read_text_file", {
        path: String(tc.args.path || ""),
        startLine: tc.args.start_line,
        maxLines: tc.args.max_lines,
        denyPaths: fileDenyPaths(),
      });
    }
    if (tc.name === "list_directory") {
      await invokeTool(tc, "list_directory", {
        path: String(tc.args.path || ""),
        denyPaths: fileDenyPaths(),
      });
    }
    // 新建/改：先弹确认气泡（可勾「以后不再确认」）
    if (tc.name === "create_entry") {
      const path = String(tc.args.path || "");
      const isDir = tc.args.is_dir === true;
      const ok = await confirmFileWrite(`小助手想新建${isDir ? "文件夹" : "文件"}：${path}`);
      if (!ok) {
        history.push({ role: "tool", tool_call_id: tc.id, content: "用户拒绝了这次新建操作" });
      } else {
        await invokeTool(tc, "create_entry", {
          path,
          isDir,
          content: tc.args.content === undefined ? undefined : String(tc.args.content),
          denyPaths: fileDenyPaths(),
        });
      }
    }
    if (tc.name === "edit_text_file") {
      const path = String(tc.args.path || "");
      const oldStr = String(tc.args.old_string ?? "");
      const newStr = String(tc.args.new_string ?? "");
      // 预览要短：确认气泡只是给用户判断"改的是不是这个文件、动的是哪一段"
      const brief = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
      const ok = await confirmFileWrite(
        `小助手想改文件：${path}\n把「${brief(oldStr)}」换成「${newStr === "" ? "（删除）" : brief(newStr)}」`,
      );
      if (!ok) {
        history.push({ role: "tool", tool_call_id: tc.id, content: "用户拒绝了这次修改" });
      } else {
        await invokeTool(tc, "edit_text_file", {
          path,
          oldString: oldStr,
          newString: newStr,
          replaceAll: tc.args.replace_all === true,
          denyPaths: fileDenyPaths(),
        });
      }
    }
    if (tc.name === "write_text_file") {
      const path = String(tc.args.path || "");
      const mode = tc.args.mode === "append" ? "append" : "overwrite";
      const body = String(tc.args.content ?? "");
      const ok = await confirmFileWrite(
        `小助手想${mode === "append" ? "追加内容到" : "整个写入"}：${path}（${body.length} 字，覆盖会先备份）`,
      );
      if (!ok) {
        history.push({ role: "tool", tool_call_id: tc.id, content: "用户拒绝了这次写入" });
      } else {
        await invokeTool(tc, "write_text_file", {
          path,
          content: body,
          mode,
          denyPaths: fileDenyPaths(),
        });
      }
    }
    if (tc.name === "list_installed_apps") {
      await invokeTool(tc, "list_installed_apps");
    }
    if (tc.name === "active_window_title") {
      await invokeTool(tc, "active_window_title");
    }
    if (tc.name === "capture_screen") {
      try {
        const b64 = await invoke<string>("capture_screen");
        screenshot.image = `data:image/png;base64,${b64}`;
        history.push({ role: "tool", tool_call_id: tc.id, content: "截图成功。屏幕画面已作为图片附加在后续请求中，请根据你看到的屏幕内容回答用户的问题。" });
      } catch (e) {
        history.push({ role: "tool", tool_call_id: tc.id, content: `截图失败：${e}` });
      }
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
  // 只召回高分且相关的记忆，最多2条，避免AI提起无关旧事
  return scored.filter(s => s.score >= 5).slice(0, 2).map(s => s.entry);
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
  b.dataset.emotion = bubbleEmotion(emo);
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

  // 心情低谷 → 安慰模式
  const comfortLine = getMood().happiness < 0.35
    ? "\n【安慰模式】用户的心情最近有些低落，用你的人设温柔地安慰、陪伴一句，别提\"心情指数\"这类系统概念。"
    : "";
  // 语言要求：system 侧一份 + 用户消息末尾一份（位置要求见 proactivePrompts.ts）
  const outLang = s.assistant.outputLanguage ?? "";
  const langInstruction = proactiveLangInstruction(outLang);
  const prompt = buildGreetingPrompt({
    timeStr,
    dayOfWeek,
    ctx,
    memoryBlock,
    comfortLine,
    outputLanguage: outLang,
  });

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
      ttsPlayer.pushDelta(d);
    }, false, langInstruction);
    for (const m of relevantMemories) {
      const orig = memory.find(e => e.id === m.id);
      if (orig) orig.lastUsedAt = Date.now();
    }
    saveMemory();
    boostMood("greeting_sent");
    // 分离翻译
    const { main: mainText, trans: transText } = splitTranslation(getBubbleText(bubble));
    setBubbleText(bubble, "");
    bubbleBody(bubble).append(document.createTextNode(mainText));
    if (transText) {
      const div = document.createElement("div");
      div.style.cssText = "font-size:11px;opacity:0.55;margin-top:4px;white-space:pre-wrap;";
      div.textContent = transText;
      bubbleBody(bubble).appendChild(div);
    }
    ttsPlayer.flush();
    const finalEmo = classifyAssistantEmotion(mainText);
    const emo = finalEmo !== "neutral" ? finalEmo : colorHook.lastEmotion();
    if (emo !== "neutral") reactNow(emo);
    bubble.dataset.emotion = bubbleEmotion(emo);
    // 语音开着等播完再消失
    if (s.tts.enabled && s.tts.apiKey && s.tts.speakerId) {
      ttsPlayer.onIdle(() => scheduleFade(bubble, 3000));
    } else {
      scheduleFade(bubble, 10000);
    }
  } catch {
    bubble.remove();
  } finally {
    busy = false;
    lifecycleOnClose?.();
  }
}

/** 抽卡点评：用户关闭抽卡面板后，让 AI 根据卡牌结果发表评论（不污染聊天历史） */
export async function triggerCardCommentary(card: { rarity: string; theme: string; baseText: string; aiText: string }) {
  if (busy) return;
  const s = loadSettings();
  const apiKey = await ensureApiKey();
  if (!s.assistant.enabled || !isProviderReady(s.assistant, apiKey)) return;

  const outLang = s.assistant.outputLanguage ?? "";
  const prompt = buildCardCommentPrompt(card, outLang);
  const langInstruction = proactiveLangInstruction(outLang);

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
      ttsPlayer.pushDelta(d);
    }, false, langInstruction);
    // 分离翻译：情绪分类与朗读都只用原文，译文和 --- 会干扰分类
    const { main: mainText, trans: transText } = splitTranslation(getBubbleText(bubble));
    setBubbleText(bubble, "");
    bubbleBody(bubble).append(document.createTextNode(mainText));
    if (transText) {
      const div = document.createElement("div");
      div.style.cssText = "font-size:11px;opacity:0.55;margin-top:4px;white-space:pre-wrap;";
      div.textContent = transText;
      bubbleBody(bubble).appendChild(div);
    }
    ttsPlayer.flush();
    const finalEmo = classifyAssistantEmotion(mainText);
    const emo = finalEmo !== "neutral" ? finalEmo : colorHook.lastEmotion();
    if (emo !== "neutral") reactNow(emo);
    bubble.dataset.emotion = bubbleEmotion(emo);
    // 不保存到主 history，避免影响主动问候
    // 语音开着：等播完再消失。onIdle 只在「队列空且未在播放」时触发一次，
    // 短文可能在注册回调前就播完（回调永不触发），故必须带超时兜底。
    if (s.tts.enabled && s.tts.apiKey && s.tts.speakerId) {
      let faded = false;
      ttsPlayer.onIdle(() => { if (!faded) { faded = true; scheduleFade(bubble, 3000); } });
      setTimeout(() => { if (!faded) { faded = true; scheduleFade(bubble, 3000); } }, 120000);
    } else {
      scheduleFade(bubble, 8000);
    }
  } catch {
    bubble.remove();
  } finally {
    busy = false;
    lifecycleOnClose?.();
  }
}
// 记忆初始化
loadMemory();







