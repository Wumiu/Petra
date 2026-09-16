import type { AssistantProvider } from "../utils/settings";

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

function resolveBase(provider: AssistantProvider, customBaseUrl: string): string {
  if (provider === "custom") {
    const b = (customBaseUrl || "").trim().replace(/\/+$/, "");
    if (!b) throw new Error("未设置自定义 API 端点 URL");
    return b;
  }
  return PROVIDERS[provider].base;
}

const BASE_PROMPT =
  "你是用户的桌面桌宠小助手，回复简洁、口语化、有温度，符合你的人设。\n" +
  "工具原则：\n" +
  "· 打开软件 → launch_application（只传应用名，不猜路径）；查询类系统命令（ipconfig/dir/ping 等）→ run_shell；打开软件一律不要用 run_shell；\n" +
  "· run_shell 语法：路径用反斜杠、一条完整命令、不加注释；拿不准路径就提示用户，不要乱猜；\n" +
  "· 搜/查 → search_web；提醒 → set_reminder；天气 → get_weather；关机/取消关机 → schedule_shutdown/cancel_shutdown；抽卡 → daily_card；看日记 → view_diary；\n" +
  "· 工具结果用简洁口语如实转述，失败就如实告知，不要假装成功。\n" +
  "· 用户透露个人信息/偏好/习惯/情绪/计划（哪怕随口提到，如\"今天好累\"\"我在学吉他\"）就调用 remember 归档；用户说\"记住 xx\"必须调用 remember。\n" +
  "对话历史较长时只需记住最新上下文。";

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
      description: "把用户的个人信息/偏好/习惯归档到长期记忆。category: identity(名字生日)/preference/habit/schedule/relationship/event/other。importance: 1=核心 2=重要 3=琐碎。",
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
      name: "daily_card",
      description: "抽取今日运势卡牌（每天一次，已抽过返回今天结果）。拿到结果后用你的人设风格重新包装祝福语，加入自己的点评，不要原样复述。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "view_diary",
      description: "查看日记本内容。不传日期则返回最近 3 条日记摘要，传日期（YYYY-MM-DD）则返回那天的完整日记。",
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
function buildMessages(history: ChatMessage[], persona: string, memory: MemoryStore, extraContext = ""): ChatMessage[] {
  const MAX_MSGS = 20;
  const MAX_CHARS = 6000;
  let msgs = history.slice(-MAX_MSGS);
  let total = msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  while (msgs.length > 2 && total > MAX_CHARS) {
    // 若下一条是 tool 消息，说明当前是带 tool_calls 的 assistant，不能删
    if (msgs[1]?.role === "tool") break;
    total -= msgs[0].content?.length ?? 0;
    msgs = msgs.slice(1);
  }
  return [{ role: "system", content: systemPrompt(persona, memory, extraContext) }, ...msgs];
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
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const base = resolveBase(provider, customBaseUrl);
  const m = model || PROVIDERS[provider].defaultModel;
  if (!m) throw new Error("未设置模型名");
  const messages = buildMessages(history, persona, memory, extraContext);
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
      stream: true,
    }),
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
            if (tc.function?.name) toolCalls[idx].name += tc.function.name;
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

  const parsed = toolCalls
    .map((tc) => ({
      id: tc.id || `local_${Math.random().toString(36).slice(2)}`,
      name: tc.name,
      args: parseArgs(tc.args),
    }))
    .filter((tc) => tc.name && tc.args);
  const outputTokens = estimateTokens(text) + estimateTokens(toolCalls.map((t) => t.args).join(" "));
  // 服务端有真实 usage 时优先用真实值
  recordUsage(
    serverUsage ? serverUsage.input : inputTokens,
    serverUsage ? serverUsage.output : outputTokens,
    serverUsage ? serverUsage.cached : 0,
  );
  return { text, toolCalls: parsed };
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

function parseArgs(args: string): Record<string, unknown> {
  try {
    const o = JSON.parse(args || "{}");
    return typeof o === "object" && o !== null ? o : {};
  } catch {
    return {};
  }
}

/** 拉取模型列表（OpenAI 兼容 /models）；8s 超时，失败抛出带原因的错误 */
export async function listModels(
  provider: AssistantProvider,
  apiKey: string,
  customBaseUrl: string,
): Promise<string[]> {
  const base = resolveBase(provider, customBaseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 100)}`);
    }
    const json = await res.json();
    // OpenAI 格式: { data: [{ id: "model-name" }] }
    // Ollama 格式: { models: [{ name: "model-name" }] }
    let arr: string[] = [];
    if (Array.isArray(json?.data)) {
      arr = json.data.map((x: { id?: string }) => x.id).filter(Boolean);
    } else if (Array.isArray(json?.models)) {
      arr = json.models.map((x: { name?: string; id?: string }) => x.name || x.id).filter(Boolean);
    }
    if (arr.length === 0) {
      throw new Error("接口返回了空的模型列表，请检查端点是否正确");
    }
    return arr;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("请求超时（8秒），请检查网络或端点地址");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 AI 自由文本中提取 CMD: <命令> 行（兜底，不用 function calling 时） */
export function extractCommand(text: string): string | null {
  const m = /(?:^|\n)\s*CMD:\s*([^\n]+)/.exec(text);
  return m ? m[1].trim() : null;
}

export function stripCommand(text: string): string {
  return text.replace(/(?:^|\n)\s*CMD:\s*[^\n]+/g, "").trim();
}