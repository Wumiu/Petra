/**
 * CDP 诊断：连接 WebView2 远程调试端口，抓取页面加载失败/脚本拒执行的真实原因。
 * 用法: node scripts/cdp-diag.mjs [port]
 */
import WebSocket from "ws";

const PORT = process.argv[2] ?? "9222";
const BASE = `http://127.0.0.1:${PORT}`;

async function getPages() {
  const res = await fetch(`${BASE}/json/list`);
  return await res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

let id = 0;
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === mid) {
        ws.off("message", handler);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

const ms = (n) => new Promise((r) => setTimeout(r, n));

async function main() {
  let pages;
  for (let i = 0; i < 10; i++) {
    try {
      pages = await getPages();
      if (pages.length) break;
    } catch {
      /* devtools 未就绪 */
    }
    await ms(1000);
  }
  if (!pages?.length) {
    console.log("CDP 不可达，确认应用已启动且 remote-debugging-port 生效");
    return;
  }
  const page = pages.find((p) => p.type === "page") ?? pages[0];
  console.log("页面:", page.url, page.webSocketDebuggerUrl ? "" : "(无 ws)");
  if (!page.webSocketDebuggerUrl) return;

  const ws = await connect(page.webSocketDebuggerUrl);
  const events = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push(msg);
  });

  await send(ws, "Runtime.enable");
  await send(ws, "Log.enable");
  await send(ws, "Network.enable");
  await send(ws, "Page.enable");

  // 读当前状态
  const ev = async (expr) => {
    const r = await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result?.value;
  };

  console.log("--- 当前页面状态 ---");
  console.log("location:", await ev("location.href"));
  console.log("readyState:", await ev("document.readyState"));
  console.log("__BOOT__:", await ev("!!window.__BOOT__"));
  console.log("dbg:", await ev("(document.getElementById('dbg')||{}).textContent || ''"));
  console.log("scripts:", await ev("[].map.call(document.scripts, function(s){return (s.type||'?')+':'+(s.src||'inline');})"));

  // 刷新并监听
  events.length = 0;
  console.log("--- 重新加载，监听 8 秒 ---");
  await send(ws, "Page.reload", { ignoreCache: true });
  await ms(8000);

  const summary = {
    exceptions: [],
    logs: [],
    failed: [],
    badResponses: [],
  };
  for (const m of events) {
    const p = m.params;
    if (!p) continue;
    if (m.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails;
      summary.exceptions.push(
        `${d.exception?.description ?? d.text} @${d.url}:${d.lineNumber}`,
      );
    }
    if (m.method === "Log.entryAdded") {
      summary.logs.push(`[${p.entry.level}] ${p.entry.text}${p.entry.url ? " (" + p.entry.url + ")" : ""}`);
    }
    if (m.method === "Network.loadingFailed") {
      summary.failed.push(`${p.type} ${p.errorText}`);
    }
    if (m.method === "Network.responseReceived") {
      const r = p.response;
      const bad =
        r.status === 200 &&
        (r.mimeType && !/javascript|text|json/i.test(r.mimeType) ? " MIME=" + r.mimeType : "");
      if (bad || r.status >= 400) {
        summary.badResponses.push(`${r.status} ${p.type} ${r.mimeType} ${r.url}`);
      }
    }
  }

  console.log("--- 异常 (Runtime.exceptionThrown) ---");
  console.log(summary.exceptions.length ? summary.exceptions.join("\n") : "(无)");
  console.log("--- 日志 (Log.entryAdded) ---");
  console.log(summary.logs.length ? summary.logs.slice(0, 20).join("\n") : "(无)");
  console.log("--- 加载失败 (loadingFailed) ---");
  console.log(summary.failed.length ? summary.failed.join("\n") : "(无)");
  console.log("--- 异常响应 ---");
  console.log(summary.badResponses.length ? summary.badResponses.join("\n") : "(无)");

  // 抓 main.ts 的响应体
  const got = events.filter(
    (m) => m.method === "Network.responseReceived" && /main\.ts/.test(m.params?.response?.url),
  );
  if (got.length) {
    const reqId = got[0].params.requestId;
    try {
      const body = await send(ws, "Network.getResponseBody", { requestId: reqId });
      console.log("--- /src/main.ts 响应体前 200 字符 ---");
      console.log(JSON.stringify(body.body?.slice(0, 200)));
      console.log("base64Encoded:", body.base64Encoded);
    } catch (e) {
      console.log("取响应体失败:", e.message);
    }
  }

  console.log("--- 重载后状态 ---");
  console.log("__BOOT__:", await ev("!!window.__BOOT__"));
  console.log("dbg:", await ev("(document.getElementById('dbg')||{}).textContent || ''"));
  ws.close();
}

main().catch((e) => {
  console.error("诊断失败:", e.message);
  process.exit(1);
});