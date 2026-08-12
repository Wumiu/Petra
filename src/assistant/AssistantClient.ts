import type { AssistantProvider } from "../utils/settings";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const PROVIDERS: Record<AssistantProvider, { base: string; defaultModel: string }> = {
  deepseek: { base: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  mimo: { base: "https://api.minimax.chat/v1", defaultModel: "" },
};

const BASE_PROMPT =
  "你是桌面小助手，回复简洁友好。如需要执行系统命令（如打开应用、查信息），" +
  "在回复最后单独一行写 CMD: <命令>，例如：CMD: start notepad。一次只给一条命令。";

function systemPrompt(persona: string): string {
  return persona ? `${persona}\n\n${BASE_PROMPT}` : BASE_PROMPT;
}

/** OpenAI 兼容 chat 调用 */
export async function chat(
  provider: AssistantProvider,
  apiKey: string,
  model: string,
  history: ChatMessage[],
  persona: string,
): Promise<string> {
  const p = PROVIDERS[provider];
  const m = model || p.defaultModel;
  if (!m) throw new Error("未设置模型名");
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: m,
      messages: [{ role: "system", content: systemPrompt(persona) }, ...history],
    }),
  });
  if (!res.ok) {
    throw new Error(`API 错误 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("API 返回格式异常");
  return content;
}

/** 拉取模型列表（OpenAI 兼容 /models）；失败返回空数组（手填） */
export async function listModels(
  provider: AssistantProvider,
  apiKey: string,
): Promise<string[]> {
  const p = PROVIDERS[provider];
  try {
    const res = await fetch(`${p.base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const arr = Array.isArray(json?.data) ? json.data : [];
    return arr.map((x: { id?: string }) => x.id).filter(Boolean);
  } catch {
    return [];
  }
}

/** 从 AI 自由文本中提取 CMD: <命令> 行 */
export function extractCommand(text: string): string | null {
  const m = /(?:^|\n)\s*CMD:\s*([^\n]+)/.exec(text);
  return m ? m[1].trim() : null;
}

/** 去掉文本中的 CMD 行（气泡只显示正文） */
export function stripCommand(text: string): string {
  return text.replace(/(?:^|\n)\s*CMD:\s*[^\n]+/g, "").trim();
}