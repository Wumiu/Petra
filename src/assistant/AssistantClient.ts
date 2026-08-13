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

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

const PROVIDERS: Record<AssistantProvider, { base: string; defaultModel: string }> = {
  deepseek: { base: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  custom: { base: "", defaultModel: "" },
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
  "当用户透露出重要个人信息、偏好或习惯时（如名字、作息、喜欢的东西），请自动调用 remember 工具归档到长期记忆。" +
  "用户明确说\"记住 xx\"时也必须调用 remember。\n" +
  "对话历史较长时只需记住最新上下文。";

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
        "执行一条 Windows cmd 命令（仅查询类/受支持命令，如 ipconfig、dir）。严格注意：路径用反斜杠\\，禁止用//；命令必须完整可执行，不得含注释。普通“打开软件”请求不要用本工具，请用 launch_application。执行结果返回后请用自然语言转述。",
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
      description: "把用户的个人信息/偏好/习惯归档到长期记忆，之后一直记得。",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "要记住的内容" } },
        required: ["content"],
      },
    },
  },
];

function systemPrompt(persona: string, memory: string[]): string {
  const mem =
    memory.length > 0 ? `\n\n用户的长期记忆：\n${memory.map((m) => `- ${m}`).join("\n")}` : "";
  return `${persona ? persona + "\n\n" : ""}${BASE_PROMPT}${mem}`;
}

/** 上下文窗口管理：截断 history（最近 N 条 + 字符上限），记忆并入 system。
 *  截断时不切断 tool_calls 序列（不删除紧跟 tool 消息的 assistant 消息）。 */
function buildMessages(
  history: ChatMessage[],
  persona: string,
  memory: string[],
): ChatMessage[] {
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

/** OpenAI 兼容流式 chat；返回完整文本 + 工具调用 */
export async function chatStream(
  provider: AssistantProvider,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  persona: string,
  memory: string[],
  customBaseUrl: string,
  onDelta: (t: string) => void,
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
      tools: TOOLS,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`API 错误 ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

/** 拉取模型列表（OpenAI 兼容 /models）；5s 超时，失败返回空数组（手填） */
export async function listModels(
  provider: AssistantProvider,
  apiKey: string,
  customBaseUrl: string,
): Promise<string[]> {
  const base = resolveBase(provider, customBaseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    const arr = Array.isArray(json?.data) ? json.data : [];
    return arr.map((x: { id?: string }) => x.id).filter(Boolean);
  } catch {
    return [];
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