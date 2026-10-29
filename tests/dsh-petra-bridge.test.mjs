/**
 * dsh-petra-bridge 的协议级测试：不启动真实 dsh，用 fake agent 验证
 * /petra/ask 路由、会话选择、followup 发送、turn/end 后收集回复。
 */
import http from "node:http";
import assert from "node:assert";
import { apply } from "../dsh-petra-bridge/index.js";

const events = [];
const agent = {
  session: {
    header: { id: "s1", cwd: "D:/tmp" },
    ownEvents: () => events,
  },
  async followup() {
    setTimeout(() => {
      events.push({
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text: "视频看完了，测试通过。" }] } },
      });
      events.push({ type: "turn/end", data: { reason: { kind: "ok" } } });
    }, 60);
  },
};

const routes = [];
const ctx = {
  get(name) {
    if (name === "agents") return { get: () => agent };
    if (name === "sessionPersistence") return { list: async () => [{ header: { id: "s1" } }] };
    return undefined;
  },
  inject(_names, cb) {
    cb({
      effect(fn) {
        const dispose = fn();
        return () => dispose?.();
      },
      webServer: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
    });
  },
};

apply(ctx, { token: "" });
assert.equal(routes.length, 1, "route should be registered");
const server = http.createServer(routes[0].handler);
await new Promise((resolve) => server.listen(3100, "127.0.0.1", resolve));
try {
  const res = await fetch("http://127.0.0.1:3100/petra/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "看视频", url: "https://example.com/a.mp4" }),
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.match(data.reply, /测试通过/);
  console.log("dsh-petra-bridge.test: passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
