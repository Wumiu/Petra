import type { ChatMessage } from "./AssistantClient";

/** 删除命中的旧对话轮次，保留当前轮次和完整的 tool_calls / tool 序列。 */
export function deleteWrongHistory(messages: ChatMessage[], keywords: string[]): ChatMessage[] {
  const terms = keywords.map(k => k.trim()).filter(Boolean);
  if (!terms.length) return messages;
  let currentTurn = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { currentTurn = i; break; }
  }
  if (currentTurn < 0) return messages;

  const kept: ChatMessage[] = [];
  for (let start = 0; start < currentTurn;) {
    let end = start + 1;
    while (end < currentTurn && messages[end].role !== "user") end++;
    const turn = messages.slice(start, end);
    const matches = turn.some(m =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" && terms.some(k => m.content!.includes(k)),
    );
    if (!matches) kept.push(...turn);
    start = end;
  }
  return [...kept, ...messages.slice(currentTurn)];
}
