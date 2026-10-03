import type { AssistantProvider } from "../utils/settings";
import { parseArgsSafe } from "./toolRuntime";
// Vite ?raw：打包时把 CHANGELOG.md 全文作为字符串打进 bundle；package.json 取版本号
// 让 AI 知道自己当前版本与最近更新了什么，主人聊到新功能时接得上话。
// @ts-ignore
import changelogRaw from "../../CHANGELOG.md?raw";
// @ts-ignore
import pkg from "../../package.json";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}


/** 结构化记忆条目 */
export interface MemoryEntry {
  id: string;                          // 唯一标识
  category: "identity" | "preference" | "habit" | "schedule" | "relationship" | "event" | "other";
  content: string;                     // "用户叫小明"
  keywords: string[];                  // ["名字", "小明"]
  source: "user_said" | "ai_inferred"; // 谁发现的
  createdAt: number;                   // 首次记录时间戳
  lastUsedAt: number;                  // 最近一次被引用的时间
  importance: 1 | 2 | 3;              // 1=核心 2=重要 3=琐碎
}

export type MemoryStore = MemoryEntry[];

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 模型给的参数不是合法 JSON 时的原因（调用仍会回一条 tool 消息，让模型自我纠正） */
  argsError?: string;
}

export interface ProviderInfo {
  label: string;
  base: string;
  defaultModel: string;
  placeholder: string;
}

export const PROVIDERS: Record<AssistantProvider, ProviderInfo> = {
  deepseek:     { label: "DeepSeek",         base: "https://api.deepseek.com",              defaultModel: "deepseek-chat",           placeholder: "sk-..." },
  openai:       { label: "OpenAI",           base: "https://api.openai.com/v1",             defaultModel: "gpt-4o-mini",             placeholder: "sk-..." },
  moonshot:     { label: "Moonshot (Kimi)",   base: "https://api.moonshot.cn/v1",            defaultModel: "moonshot-v1-8k",          placeholder: "sk-..." },
  zhipu:        { label: "智谱 (GLM)",        base: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash",             placeholder: "..." },
  qwen:         { label: "通义千问",          base: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-turbo", placeholder: "sk-..." },
  siliconflow:  { label: "SiliconFlow",      base: "https://api.siliconflow.cn/v1",         defaultModel: "Qwen/Qwen2.5-7B-Instruct", placeholder: "sk-..." },
  openrouter:   { label: "OpenRouter",       base: "https://openrouter.ai/api/v1",         defaultModel: "openai/gpt-4o-mini",     placeholder: "sk-or-..." },
  groq:         { label: "Groq",             base: "https://api.groq.com/openai/v1",       defaultModel: "llama-3.1-8b-instant",    placeholder: "gsk_..." },
  ollama:       { label: "Ollama (本地)",     base: "http://localhost:11434/v1",             defaultModel: "qwen2.5:7b",              placeholder: "通常无需填写" },
  custom:       { label: "自定义",            base: "",                                      defaultModel: "",                        placeholder: "API Key" },
};

/**
 * 有些供应商根本不需要 API Key（本地 Ollama；指向本机的自定义端点如 LM Studio / llama.cpp）。
 * 以前所有门禁都只看"Key 是否非空"，于是设置面板里明明写着「Ollama：API Key 留空」，
 * 照做的用户却会被拦下说"未配置 API Key"。
 */
export function isKeylessProvider(provider: AssistantProvider, customBaseUrl = ""): boolean {
  if (provider === "ollama") return true;
  if (provider !== "custom") return false;
  const base = (customBaseUrl || "").trim().toLowerCase();
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:\/]|$)/.test(base);
}

/** 这个配置是否已经可以用来发请求（不需要 Key 的供应商不填也算就绪） */
export function isProviderReady(
  assistant: { provider: AssistantProvider; customBaseUrl?: string },
  apiKey: string,
): boolean {
  if (isKeylessProvider(assistant.provider, assistant.customBaseUrl ?? "")) return true;
  return Boolean((apiKey ?? "").trim());
}

/**
 * 是否是 MiniMax 端点（api.minimax.cn / api.minimax.io / api.minimaxi.com 等）。
 *
 * 为什么需要单独判断：**MiniMax 的 M 系列默认开启 thinking**，且默认把思考内容
 * **以 `<think>` 标签保留在 `content` 字段内**（官方文档：`reasoning_split` 为 false 时
 * thinking 以 `<think>` 标签保留在 `content` 内）。
 * 本文件下面的流式解析只取 `delta.content`，于是"思考过程"会被当成正文显示在气泡里
 * —— 用户侧的表现就是"回复里混着思考过程和标签"。
 *
 * 开启 `reasoning_split` 后，thinking 被拆分到 `reasoning_content` 字段，
 * `content` 只留正文，解析逻辑**无需改动**。
 * 该开关对 M3 与 M2.x 都有效，且不依赖"能否关闭 thinking"——
 * 因为 `thinking: { type: "disabled" }` **对 M2.x 无效**，
 * 对 **M3.1-Flash-Preview 更会直接返回 400**（其 thinking 强制开启），
 * 所以不能把它当作通用手段来用。
 */
export function isMiniMaxEndpoint(base: string): boolean {
  return /minimax/i.test(base ?? "");
}

function resolveBase(provider: AssistantProvider, customBaseUrl: string): string {
  if (provider === "custom") {
    const b = (customBaseUrl || "").trim().replace(/\/+$/, "");
    if (!b) throw new Error("未设置自定义 API 端点 URL");
    return b;
  }
  return PROVIDERS[provider].base;
}

const BASE_PROMPT =
  "严格按照上面的人格设定说话，每一句话都符合该人设的语气、口吻、用词和情绪。不要像客服，不要像AI，你就是那个人。\n" +
  "【工具能力】用户需要时可以：打开软件、查天气、调音量、搜网页、开网址、设提醒、锁屏、关机、查当前窗口。工具只在意图明确时调用，结果用符合人设的口语转述，失败就如实说。\n" +
  "【记忆】用户透露偏好/习惯/情绪就调用 remember。\n" +
  "不要主动提工具能力，不要说\"作为AI\"之类的话。";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "launch_application",
      description:
        "打开/启动本机已安装的软件时调用。只传应用名称，系统自动解析安装位置。",
      parameters: {
        type: "object",
        properties: { application: { type: "string", description: "应用名称，如\"网易云音乐\"、\"记事本\"、\"VS Code\"" } },
        required: ["application"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "执行一条 Windows cmd 只读查询命令（白名单：ipconfig/dir/ping/netstat/systeminfo/tasklist/whoami/tree/type/echo 等）。禁止修改/删除类操作。",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "要执行的完整 cmd 命令" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "把用户个人信息/偏好/习惯归档到长期记忆。category: identity/preference/habit/schedule/relationship/event/other；importance: 1核心 2重要 3琐碎。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要记住的内容，用简洁的中文陈述句" },
          category: { type: "string", enum: ["identity", "preference", "habit", "schedule", "relationship", "event", "other"], description: "记忆分类" },
          importance: { type: "number", description: "重要度 1-3，1=核心 2=重要 3=琐碎" },
        },
        required: ["content", "category", "importance"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_volume",
      description:
        "调节系统音量。传 level (0-100) 设置音量百分比，传 mute (true/false) 静音/取消静音。",
      parameters: {
        type: "object",
        properties: {
          level: { type: "number", description: "音量 0-100" },
          mute: { type: "boolean", description: "true=静音, false=取消静音" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "定时提醒用户。传入分钟后触发，显示一条提醒气泡。",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "number", description: "多少分钟后提醒" },
          message: { type: "string", description: "提醒内容" },
        },
        required: ["minutes", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "获取当前天气信息，返回简短天气文字。无需参数。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_shutdown",
      description: "定时关机。传入分钟后自动关机（1~1440分钟）。",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "number", description: "多少分钟后关机" },
        },
        required: ["minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_shutdown",
      description: "取消之前设定的定时关机。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "帮用户搜索网页。传入搜索关键词，自动用浏览器打开搜索结果。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
        },    required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "用系统默认浏览器打开一个网址（http/https）。用户给了具体链接时用它。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "完整网址，需带 http:// 或 https://" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_path",
      description: "用系统默认程序打开本机的文件或文件夹（路径必须真实存在）。如「打开我的下载文件夹」。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件或文件夹的完整路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_installed_apps",
      description: "列出开始菜单里可启动的软件名。用户想打开某个软件但你拿不准名字时，先查一次再调用 launch_application。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "active_window_title",
      description: "查看用户当前正在使用的窗口标题（知道主人在用什么软件）。用户问「我在干嘛/现在开着什么」时可用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_idle_seconds",
      description: "查看用户已经多久没有操作电脑（秒）。用于判断主人在不在，例如要不要轻声问候。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_notification",
      description: "弹一条桌面通知给用户（标题+内容）。适合「帮我记一下/过会儿提醒」这类不需要打断的告知。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "通知标题，简短" },
          body: { type: "string", description: "通知正文" },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lock_screen",
      description: "锁定电脑屏幕。仅在用户明确说「锁屏/离开一下」时调用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "daily_card",
      description:
        "仅在用户明确说「抽卡/今日运势/来一发」时调用（每天一次，已抽过返回今天结果）。其他任何情况都不要调用，也不要主动提起抽卡。拿到结果后用你的人设风格点评，不要原样复述。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "view_diary",
      description:
        "仅在用户明确说「看日记/今天写了什么」时调用。不传日期返回最近 3 条摘要，传日期（YYYY-MM-DD）返回那天完整日记。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "日期，格式 YYYY-MM-DD。留空则返回最近几条摘要。" },
        },
      },
    },
  },
];

/** system prompt 最多注入的记忆条数（token 控制；聊天时按场景召回后再传入） */
const MAX_MEMORY_IN_PROMPT = 20;

/**
 * 版本与更新日志注入：让 AI 知道自己当前版本号和最近更新了什么。
 * 取 CHANGELOG 第一个 ## 段（Unreleased 或最新版）的 bullet，截断到合理长度，
 * 避免把整份更新历史塞进 system prompt 烧 token。
 */
let _versionInfoCache: string | null = null;
function buildVersionInfo(): string {
  if (_versionInfoCache !== null) return _versionInfoCache;
  const version: string = pkg?.version ?? "未知";
  // 解析 CHANGELOG：第一个 "## [" 段（Unreleased 或最新发布版）里的 "- " 条目
  const lines = (changelogRaw as string).split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith("## [")) {
      if (inSection) break;       // 下一个版本段开始 → 停
      inSection = true;
      continue;
    }
    if (inSection && line.trimStart().startsWith("- ")) {
      items.push(line.trim().replace(/^-\s*/, ""));
    }
  }
  // 截断：最多 12 条；总长不超过 1200 字符，超出就硬切
  let picked = items.slice(0, 12).join("\n· ");
  if (picked.length > 1200) picked = picked.slice(0, 1200) + "…";
  _versionInfoCache =
    `\n\n【你当前的版本】Petra v${version}` +
    `\n【最近更新内容】（主人可能会聊到；知道即可，不要主动推销，被问到时自然地聊）` +
    `\n· ${picked}`;
  return _versionInfoCache;
}

function systemPrompt(persona: string, memory: MemoryStore, extraContext = ""): string {
  let mem = "";
  if (memory.length > 0) {
    // 按重要度排序，核心记忆在前，超限截断
    const sorted = [...memory].sort((a, b) => a.importance - b.importance).slice(0, MAX_MEMORY_IN_PROMPT);
    mem = "\n\n关于用户的记忆（按重要度排序）：\n" +
      sorted.map((m) => {
        const age = Date.now() - m.createdAt;
        const days = Math.floor(age / 86400000);
        const timeNote = days > 30 ? `（${Math.floor(days / 30)}个月前）` : days > 0 ? `（${days}天前）` : "（今天）";
        return `- [${m.category}] ${m.content} ${timeNote}`;
      }).join("\n");
  }
  return `${persona ? persona + "\n\n" : ""}${extraContext ? extraContext + "\n\n" : ""}${BASE_PROMPT}${mem}`;
}

/** 上下文窗口管理：截断 history（最近 N 条 + 字符上限），记忆并入 system。
 *  截断时不切断 tool_calls 序列（不删除紧跟 tool 消息的 assistant 消息）。 */
function buildMessages(
  history: ChatMessage[],
  persona: string,
  memory: MemoryStore,
  extraContext = "",
  systemOverride = "",
): ChatMessage[] {
  const MAX_MSGS = 120;
  const MAX_CHARS = 30000;
  let msgs = history.slice(-MAX_MSGS);
  let total = msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  while (msgs.length > 2 && total > MAX_CHARS) {
    // 若下一条是 tool 消息，说明当前是带 tool_calls 的 assistant，不能删
    if (msgs[1]?.role === "tool") break;
    total -= msgs[0].content?.length ?? 0;
    msgs = msgs.slice(1);
  }
  // systemOverride：轻量调用（如麻将实时点评）用它替代完整系统提示，省掉 BASE_PROMPT 与记忆
  const system = systemOverride || systemPrompt(persona, memory, extraContext);
  return [{ role: "system", content: system }, ...msgs];
}

/** OpenAI 兼容流式 chat；返回完整文本 + 工具调用。enableTools=false 时不带 tools（纯文本生成，如日记/抽卡文案） */
export async function chatStream(
  provider: AssistantProvider,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  persona: string,
  memory: MemoryStore, customBaseUrl: string,
  onDelta: (t: string) => void,
  enableTools = true,
  extraContext = "",
  systemOverride = "",
  requestOptions: ChatRequestOptions = {},
): Promise<{ text: string; toolCalls: ToolCall[]; usage: ChatUsage }> {
  const base = resolveBase(provider, customBaseUrl);
  const m = model || PROVIDERS[provider].defaultModel;
  if (!m) throw new Error("未设置模型名");
  const messages = buildMessages(history, persona, memory, extraContext, systemOverride);
  // 输入 token 估算（消息 + 工具定义），用于本地用量统计兜底
  const inputTokens = estimateTokens(JSON.stringify(messages)) + (enableTools ? estimateToolsTokens() : 0) + 4;
  // 支持流式 usage 回传的提供商白名单（其余端点可能拒绝未知字段）
  const supportsStreamUsage = USAGE_STREAM_PROVIDERS.has(provider);
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: m,
      messages,
      // 所有 OpenAI 兼容端点（含 custom，如小米 API）都发工具定义；
      // enableTools=false（日记/抽卡等纯文本生成）时一律不带 tools，避免模型返回空正文
      ...(enableTools ? { tools: TOOLS } : {}),
      ...(supportsStreamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(requestOptions.maxOutputTokens ? { max_tokens: requestOptions.maxOutputTokens } : {}),
      // MiniMax：让思考内容与正文分离（详见 isMiniMaxEndpoint 的说明）。
      // 只对 MiniMax 端点发送，避免其他兼容端点拒绝未知字段。
      ...(isMiniMaxEndpoint(base) ? { reasoning_split: true } : {}),
      stream: true,
    }),
    signal: requestOptions.signal,
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    const hint = provider === "custom" ? " (自定义端点请确认URL是否正确，部分API需要/v1后缀)" : "";
    throw new Error(`API 错误 ${res.status}${hint}: ${errText.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolCalls: { id: string; name: string; args: string }[] = [];
  // 服务端真实 usage（最后一个 chunk 返回，需 include_usage）
  let serverUsage: { input: number; output: number; cached: number } | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          onDelta(delta.content);
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            toolCalls[idx] ??= { id: tc.id ?? "", name: "", args: "" };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) {
              // 分片拼接：有的兼容端点第一帧只给名字，有的每帧都重发**完整**名字，
              // 直接 += 会拼出 "run_shellrun_shell"，这里按前缀判断一下
              const cur = toolCalls[idx].name;
              const frag = tc.function.name;
              toolCalls[idx].name = !cur ? frag : frag.startsWith(cur) ? frag : cur.endsWith(frag) ? cur : cur + frag;
            }
            if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
          }
        }
        // 末 chunk 的 usage：{ prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens }
        if (json.usage && typeof json.usage.total_tokens === "number") {
          serverUsage = {
            input: json.usage.prompt_tokens ?? inputTokens,
            output: json.usage.completion_tokens ?? 0,
            cached: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
      } catch {
        /* 忽略不完整 JSON */
      }
    }
  }

  const parsed: ToolCall[] = toolCalls
    .map((tc) => {
      // 参数解析失败也**保留**这次调用：回一条"参数不合法"的 tool 结果让模型重发，
      // 静默丢掉会让模型以为自己调过了，然后一遍遍重复同一个调用。
      const safe = parseArgsSafe(tc.args);
      return {
        id: tc.id || `local_${Math.random().toString(36).slice(2)}`,
        name: tc.name,
        args: safe.args,
        argsError: safe.error,
      };
    })
    .filter((tc) => tc.name);
  const outputTokens = estimateTokens(text) + estimateTokens(toolCalls.map((t) => t.args).join(" "));
  // 服务端有真实 usage 时优先用真实值
  const usage: ChatUsage = serverUsage
    ? { ...serverUsage, source: "server" }
    : { input: inputTokens, output: outputTokens, cached: 0, source: "estimated" };
  recordUsage(usage.input, usage.output, usage.cached);
  requestOptions.onUsage?.(usage);
  return { text, toolCalls: parsed, usage };
}

// ==================== 本地 token 估算与用量统计 ====================
// 说明：不依赖服务端 usage 字段（各厂商流式支持不一致），用字符规则本地估算，
// 仅用于给用户展示相对用量趋势，非计费依据。

export interface UsageStats {
  calls: number;       // 总调用次数
  inputTokens: number; // 输入 token（服务端 usage 可用时用真实值，否则本地估算）
  outputTokens: number; // 输出 token
  cachedTokens: number; // 服务端报告的前缀缓存命中 token（DeepSeek 等）
  lastInput: number;
  lastOutput: number;
  lastCached: number;
  lastAt: number;
}

const USAGE_KEY = "petra-token-usage";
/** 支持流式 stream_options.include_usage 的提供商白名单（OpenAI 兼容且实测支持） */
const USAGE_STREAM_PROVIDERS: ReadonlySet<string> = new Set([
  "deepseek", "openai", "moonshot", "qwen", "siliconflow", "openrouter", "groq",
]);
const DEFAULT_USAGE: UsageStats = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, lastInput: 0, lastOutput: 0, lastCached: 0, lastAt: 0 };
let toolsTokensCache = -1;

/** 估算一段文本的 token 数：中文≈0.8/字，其他≈3.6 字/token，emoji≈1 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0x3000 && code <= 0x30ff) || // CJK 标点/假名
      (code >= 0xff00 && code <= 0xffef) || // 全角
      code > 0x10000;                        // emoji 等
    if (isCjk) cjk++;
    else other++;
  }
  return Math.max(1, Math.round(cjk * 0.8 + other / 3.6));
}

/** 工具定义整体 token 估算（缓存，仅算一次） */
function estimateToolsTokens(): number {
  if (toolsTokensCache < 0) toolsTokensCache = estimateTokens(JSON.stringify(TOOLS)) + 8;
  return toolsTokensCache;
}

export function getUsageStats(): UsageStats {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { ...DEFAULT_USAGE, ...p };
    }
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_USAGE };
}

export function resetUsageStats(): void {
  try {
    localStorage.removeItem(USAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

function recordUsage(input: number, output: number, cached = 0): void {
  try {
    const s = getUsageStats();
    s.calls++;
    s.inputTokens += input;
    s.outputTokens += output;
    s.cachedTokens += cached;
    s.lastInput = input;
    s.lastOutput = output;
    s.lastCached = cached;
    s.lastAt = Date.now();
    localStorage.setItem(USAGE_KEY, JSON.stringify(s));
  } catch {
    /* 忽略 */
  }
}

/**
 * 解析模型列表（纯函数，便于单测）：
 * - OpenAI 兼容格式：{ data: [{ id }] }
 * - Ollama 原生格式：{ models: [{ name/model }] }
 */
export function parseModelList(json: unknown): string[] {
  const j = json as
    | { data?: Array<{ id?: string }>; models?: Array<{ name?: string; model?: string; id?: string }> }
    | null
    | undefined;
  if (!j) return [];
  if (Array.isArray(j.data)) {
    return j.data.map((x) => x?.id).filter((v): v is string => Boolean(v));
  }
  if (Array.isArray(j.models)) {
    return j.models.map((x) => x?.name || x?.model || x?.id).filter((v): v is string => Boolean(v));
  }
  return [];
}

/** Ollama 原生接口在 /api/tags，去掉可能存在的 /v1 尾巴 */
function ollamaOrigin(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** 请求一个端点并解析模型列表 */
async function fetchModelList(url: string, apiKey: string): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? ": " + body.slice(0, 100) : ""}`);
    }
    return parseModelList(await res.json());
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("请求超时（8 秒）");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取可用模型列表。
 *
 * Ollama 优先走**原生接口 /api/tags**：老版本 Ollama 没有 OpenAI 兼容的 /v1/models，
 * 直接查 /v1/models 会 404，于是"明明装了很多模型却列不出来"。失败再退回 /v1/models。
 */
export async function listModels(
  provider: AssistantProvider,
  apiKey: string,
  customBaseUrl: string,
): Promise<string[]> {
  const base = resolveBase(provider, customBaseUrl);
  const useOllamaApi = provider === "ollama" || /:11434(\/|$)/.test(base);
  const urls = useOllamaApi ? [`${ollamaOrigin(base)}/api/tags`, `${base}/models`] : [`${base}/models`];

  const errors: string[] = [];
  for (const url of urls) {
    try {
      const arr = await fetchModelList(url, apiKey);
      if (arr.length) return arr;
      errors.push(`${url}：返回了空的模型列表`);
    } catch (e: unknown) {
      errors.push(`${url}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const localHint = /(localhost|127\.0\.0\.1)/.test(base)
    ? "（本地服务：若报 Failed to fetch，多半是浏览器跨域被拦——给服务设 OLLAMA_ORIGINS=* 后重启即可）"
    : "";
  throw new Error(errors.join("；") + localHint);
}

/** 从 AI 自由文本中提取 CMD: <命令> 行（兜底，不用 function calling 时） */
export function extractCommand(text: string): string | null {
  const m = /(?:^|\n)\s*CMD:\s*([^\n]+)/.exec(text);
  return m ? m[1].trim() : null;
}

export function stripCommand(text: string): string {
  return text.replace(/(?:^|\n)\s*CMD:\s*[^\n]+/g, "").trim();
}

export interface ChatUsage {
  input: number;
  output: number;
  cached: number;
  source: "server" | "estimated";
}

export interface ChatRequestOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  onUsage?: (usage: ChatUsage) => void;
}
