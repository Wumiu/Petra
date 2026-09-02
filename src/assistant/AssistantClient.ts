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
  "你是桌面小助手，回复简洁友好。工具使用原则：\n" +
  "1. 用户要求打开/启动本机已安装的软件（如网易云音乐、微信、QQ、记事本、计算器、VS Code、浏览器）时，必须调用 launch_application 工具，只需传入应用名称，不要猜路径；\n" +
  "2. 只有明确需要执行受支持的系统命令（如 ipconfig、dir、ping 等查询类操作）时才调用 run_shell；普通“打开软件”请求一律不要用 run_shell；\n" +
  "3. 工具执行结果会以 tool 消息返回，请用简洁自然语言如实转述给用户（如“已经帮你打开网易云音乐啦”）；工具返回失败时如实告知用户失败原因，不要假装成功；\n" +
  "run_shell 是 Windows cmd 命令，必须严格遵守语法：\n" +
  "1. 路径一律用反斜杠（如 C:\\Program Files\\xxx），严禁使用 //；\n" +
  "2. 命令必须一条完整可执行，不要加 // 或任何注释，不要输出解释文字到命令里；\n" +
  "3. 拿不准确切路径时，宁可提示用户不要乱猜路径。\n" +
  "当用户透露出任何个人信息、偏好、习惯、情绪、计划时（如名字、生日、作息、喜欢的东西、最近在忙什么、心情如何），请主动调用 remember 工具归档到长期记忆。" +
  "即使用户只是随口提到（如\"今天好累\"\"我在学吉他\"），也要记录。用户明确说\"记住 xx\"时必须调用 remember。\n" +
  "4. 用户说\"帮我搜/查 xxx\"时调用 search_web 打开浏览器搜索。\n" +
  "5. 用户说\"提醒我/xx分钟后叫我\"时调用 set_reminder。\n" +
  "6. 用户问天气时调用 get_weather 获取实时天气。\n" +
  "7. 用户说\"关机/定时关机/xx分钟后关机\"时调用 schedule_shutdown。\n" +
  "8. 用户说\"取消关机\"时调用 cancel_shutdown。\n" +
  "对话历史较长时只需记住最新上下文。\n" +
    "9. 用户说\"抽卡/今日运势/来一发\"时调用 daily_card。拿到结果后用你的人设风格重新演绎祝福语，加入自己的点评，不要原样复述。\n" +
    "10. 用户问\"日记/今天写了什么/看看日记\"时调用 view_diary 查看日记。";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "launch_application",
      description:
        "当用户要求打开/启动本机已安装的软件（如网易云音乐、微信、QQ、记事本、计算器、VS Code、浏览器）时调用。只需传应用名称，系统会自动解析安装位置。执行结果返回后请用自然语言转述。",
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
        "执行一条 Windows cmd 查询命令（白名单：ipconfig/dir/ping/netstat/systeminfo/tasklist/whoami/tree/type/echo 等只读命令）。禁止执行修改/删除/系统操作，打开软件请用 launch_application。执行结果返回后请用自然语言转述。",
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
      description: "把用户的个人信息/偏好/习惯归档到长期记忆。category 可选：identity(身份如名字生日)、preference(偏好如喜欢咖啡)、habit(习惯如熬夜)、schedule(作息)、relationship(人际关系)、event(事件)、other。importance: 1=核心(名字生日等不会变的)、2=重要(习惯偏好)、3=琐碎。",
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
      description: "帮用户抽取今日运势卡牌。无需参数。返回卡牌主题、稀有度和祝福语。每天只能抽一次，已抽过则返回今天的结果。拿到结果后，用你的人设风格重新包装祝福语，加入你自己的点评或吐槽，不要原样复述。",
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

function systemPrompt(persona: string, memory: MemoryStore): string {
  let mem = "";
  if (memory.length > 0) {
    // 按重要度排序，核心记忆在前
    const sorted = [...memory].sort((a, b) => a.importance - b.importance);
    mem = "\n\n关于用户的记忆（按重要度排序）：\n" +
      sorted.map((m) => {
        const age = Date.now() - m.createdAt;
        const days = Math.floor(age / 86400000);
        const timeNote = days > 30 ? `（${Math.floor(days / 30)}个月前）` : days > 0 ? `（${days}天前）` : "（今天）";
        return `- [${m.category}] ${m.content} ${timeNote}`;
      }).join("\n");
  }
  return `${persona ? persona + "\n\n" : ""}${BASE_PROMPT}${mem}`;
}

/** 上下文窗口管理：截断 history（最近 N 条 + 字符上限），记忆并入 system。
 *  截断时不切断 tool_calls 序列（不删除紧跟 tool 消息的 assistant 消息）。 */
function buildMessages(history: ChatMessage[], persona: string, memory: MemoryStore): ChatMessage[] {
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
  return [{ role: "system", content: systemPrompt(persona, memory) }, ...msgs];
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
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const base = resolveBase(provider, customBaseUrl);
  const m = model || PROVIDERS[provider].defaultModel;
  if (!m) throw new Error("未设置模型名");
  const messages = buildMessages(history, persona, memory);
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
  return { text, toolCalls: parsed };
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