/**
 * dsh-petra-bridge
 *
 * Petra → dsh 的反向入口。只暴露一个本地 HTTP 路由：
 *   POST /petra/ask { text, url?, sessionId? }
 *
 * 设计边界：
 * - 不自己做 LLM 调用；把消息塞回一个真实 dsh agent，让 dsh 的模型/插件/工具链处理。
 * - 只监听 dsh 已有的 webServer；不额外开端口。
 * - 仅 loopback 使用；可选 x-petra-token。
 */
import { randomUUID } from "node:crypto";

export const name = "dsh-petra-bridge";
export const inject = ["webServer"];

const ROUTE = "/petra/ask";
const MAX_BODY = 256 * 1024;
const TURN_TIMEOUT_MS = 120_000;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-petra-token",
    "access-control-allow-methods": "POST,OPTIONS",
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function eventsOf(agent) {
  const session = agent?.session;
  if (typeof session?.ownEvents === "function") {
    const events = session.ownEvents();
    return Array.isArray(events) ? events : [];
  }
  return Array.isArray(session?.events) ? session.events : [];
}

function assistantTexts(events) {
  const out = [];
  for (const event of events) {
    if (event?.type !== "assistant/message") continue;
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push(block.text.trim());
      }
    }
  }
  return out;
}

function turnEnded(events) {
  return events.some((event) => event?.type === "turn/end");
}

async function findAgent(ctx, sessionId) {
  const agents = ctx.get?.("agents");
  const controller = ctx.get?.("sessionController");
  if (sessionId) {
    if (typeof controller?.resolveAgent === "function") {
      const resolved = await controller.resolveAgent(sessionId);
      const agent = resolved?.agent ?? resolved;
      if (agent) return agent;
    }
    if (typeof agents?.get === "function") {
      const agent = agents.get(sessionId);
      if (agent) return agent;
    }
    if (typeof agents?.resume === "function") {
      const resumed = await agents.resume({ resumeSessionId: sessionId });
      const agent = resumed?.agent ?? resumed;
      if (agent) return agent;
    }
  }

  // 没指定 session 时，选 sessionPersistence.list() 里最近一条主会话。
  const sp = ctx.get?.("sessionPersistence");
  const list = typeof sp?.list === "function" ? await sp.list() : [];
  const candidates = Array.isArray(list) ? list.slice().reverse() : [];
  for (const item of candidates) {
    const id = item?.header?.id ?? item?.id;
    const origin = item?.header?.origin ?? item?.origin;
    if (typeof id !== "string" || id.length === 0) continue;
    if (origin === "subagent") continue;
    const agent = await findAgent(ctx, id);
    if (agent) return agent;
  }
  return null;
}

async function sendAndWait(agent, prompt) {
  const beforeEvents = eventsOf(agent);
  const before = beforeEvents.length;
  const message = {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: prompt }],
    source: { kind: "plugin", plugin: "dsh-petra-bridge" },
  };
  if (typeof agent.followup !== "function") {
    throw new Error("当前 dsh agent 不支持 followup()");
  }
  await agent.followup(message);

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const events = eventsOf(agent).slice(before);
    if (turnEnded(events)) {
      const texts = assistantTexts(events);
      if (texts.length > 0) return texts.join("\n\n");
      return "（dsh 这一轮没有输出文本）";
    }
  }
  throw new Error(`等待 dsh 回复超时（${Math.round(TURN_TIMEOUT_MS / 1000)}s）`);
}

function hasToken(req, token) {
  if (!token) return true;
  return req.headers["x-petra-token"] === token;
}

export function apply(ctx, config) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: ROUTE,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          sendJson(res, 403, { ok: false, error: "only loopback is allowed" });
          return;
        }
        if (req.method === "OPTIONS") {
          sendJson(res, 204, {});
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "method not allowed" });
          return;
        }
        if (!hasToken(req, String(config?.token ?? ""))) {
          sendJson(res, 401, { ok: false, error: "bad token" });
          return;
        }
        const body = await readJson(req);
        if (body === undefined || body === null || typeof body !== "object") {
          sendJson(res, 400, { ok: false, error: "malformed JSON body" });
          return;
        }
        const text = String(body.text ?? "").trim();
        const url = String(body.url ?? "").trim();
        if (!text && !url) {
          sendJson(res, 400, { ok: false, error: "text or url is required" });
          return;
        }
        const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
        try {
          const agent = await findAgent(ctx, sessionId);
          if (!agent) {
            sendJson(res, 409, { ok: false, error: "没有找到可用的 dsh 会话：先在 dsh 里打开一个会话，或在请求里传 sessionId" });
            return;
          }
          const prompt = [
            "这是 Petra 转给 dsh 的请求。",
            text || "请处理下面的链接。",
            url ? `链接：${url}` : "",
            "请直接给出最终结果；如果调用了视频/网页工具，把结论用简洁中文总结。",
          ].filter(Boolean).join("\n");
          const reply = await sendAndWait(agent, prompt);
          sendJson(res, 200, { ok: true, reply });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), "dsh-petra-bridge: /petra/ask route");
  });
}
