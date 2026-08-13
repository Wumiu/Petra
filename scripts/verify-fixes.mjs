/**
 * 验证脚本：实机验证本轮修复。
 * 1) cursor_pos 的 rx/ry 是否等于 光标 - 真实窗口中心（物理像素）
 * 2) launch_application 各应用启动结果
 * 用法: node scripts/verify-fixes.mjs [port]
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
    console.log("CDP 不可达");
    return;
  }
  const page = pages.find((p) => p.type === "page") ?? pages[0];
  const ws = await connect(page.webSocketDebuggerUrl);
  await send(ws, "Runtime.enable");

  const ev = async (expr) => {
    const r = await send(ws, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    }
    return r.result?.value;
  };

  // ---------- 1. cursor_pos 相对偏移验证 ----------
  console.log("=== cursor_pos 相对窗口中心验证 ===");
  const cp = await ev(
    `window.__TAURI_INTERNALS__.invoke('cursor_pos')`,
  );
  console.log("cursor_pos:", JSON.stringify(cp));
  if (cp && typeof cp.x === "number") {
    const scale = await ev(`window.__TAURI_INTERNALS__.invoke('plugin:window|scale_factor')`).catch(() => 1);
    const scaleNum = typeof scale === "number" && scale > 0 ? scale : 1;
    const pos = await ev(
      `window.__TAURI_INTERNALS__.invoke('plugin:window|outer_position')`,
    );
    console.log("outer_position(物理):", JSON.stringify(pos));
    // 窗口逻辑尺寸 300x300；物理尺寸 = 300 * scale
    const winPhys = 300 * scaleNum;
    const expectRx = cp.x - (pos.x + winPhys / 2);
    const expectRy = cp.y - (pos.y + winPhys / 2);
    console.log(`scaleFactor=${scaleNum}`);
    console.log(`期望 rx=${Math.round(expectRx)} 实际 rx=${cp.rx}  -> ${Math.abs(expectRx - cp.rx) < 2 ? "MATCH" : "MISMATCH"}`);
    console.log(`期望 ry=${Math.round(expectRy)} 实际 ry=${cp.ry}  -> ${Math.abs(expectRy - cp.ry) < 2 ? "MATCH" : "MISMATCH"}`);
  }

  // ---------- 2. launch_application 验证 ----------
  console.log("\n=== launch_application 验证 ===");
  const apps = ["记事本", "计算器", "网易云音乐", "VS Code", "浏览器"];
  for (const appName of apps) {
    const r = await ev(
      `window.__TAURI_INTERNALS__.invoke('launch_application', { application: ${JSON.stringify(appName)} })`,
    );
    console.log(`launch_application("${appName}") ->`, JSON.stringify(r));
    await ms(1500);
  }

  // ---------- 3. 危险输入拦截验证 ----------
  console.log("\n=== launch_application 危险输入拦截 ===");
  for (const bad of ["del /f", "shutdown", "powershell -enc", "a&&b", "cmd /c calc"]) {
    const r = await ev(
      `window.__TAURI_INTERNALS__.invoke('launch_application', { application: ${JSON.stringify(bad)} })`,
    );
    console.log(`launch_application(${JSON.stringify(bad)}) ->`, JSON.stringify(r));
  }

  ws.close();
}

main().catch((e) => {
  console.error("验证失败:", e.message);
  process.exit(1);
});
