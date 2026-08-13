/**
 * 四角测试：固定鼠标不动，把窗口移到左上/右上/左下/右下，
 * 验证视线方向（cursorDx/cursorDy）始终以窗口（模型）中心为基准翻转。
 * 用法: node scripts/four-corner-test.mjs [port]
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
    } catch {}
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

  const scale = await ev(`window.__TAURI_INTERNALS__.invoke('plugin:window|scale_factor')`).catch(() => 1);
  const scaleNum = typeof scale === "number" && scale > 0 ? scale : 1;
  const sw = await ev(`screen.width`);
  const sh = await ev(`screen.height`);
  const WIN = 300; // 窗口逻辑尺寸

  // 四个角（逻辑坐标），右下角按屏幕尺寸计算
  const corners = {
    左上: [0, 0],
    右上: [sw - WIN, 0],
    左下: [0, sh - WIN],
    右下: [sw - WIN, sh - WIN],
  };

  console.log(`scaleFactor=${scaleNum} 屏幕逻辑=${sw}x${sh} 鼠标位置保持不变`);
  const cp0 = await ev(`window.__TAURI_INTERNALS__.invoke('cursor_pos')`);
  console.log(`鼠标(物理)=(${cp0.x},${cp0.y}) 逻辑=(${(cp0.x / scaleNum).toFixed(1)},${(cp0.y / scaleNum).toFixed(1)})`);

  let allPass = true;
  for (const [name, [wx, wy]] of Object.entries(corners)) {
    await ev(`window.__pet.setPos(${wx}, ${wy})`);
    await ms(1500); // 等 Rust cursor_pos 轮询 + 平滑收敛
    const info = await ev(`window.__pet.info()`);
    const dx = info.cursorDx;
    const dy = info.cursorDy;
    // 理论：窗口中心 = 窗口位置 + 150（逻辑）；鼠标逻辑坐标 - 中心
    const centerX = wx + WIN / 2;
    const centerY = wy + WIN / 2;
    const mouseLx = cp0.x / scaleNum;
    const mouseLy = cp0.y / scaleNum;
    const expectSignX = Math.sign(mouseLx - centerX);
    const expectSignY = Math.sign(mouseLy - centerY);
    const okX = Math.sign(dx) === expectSignX;
    const okY = Math.sign(dy) === expectSignY;
    const pass = okX && okY;
    if (!pass) allPass = false;
    console.log(
      `${name} 窗口(${wx},${wy}) 中心(${centerX},${centerY}) ` +
        `| cursorDx=${dx.toFixed(2)}(期望${expectSignX > 0 ? "+" : "-"}) ` +
        `cursorDy=${dy.toFixed(2)}(期望${expectSignY > 0 ? "+" : "-"}) -> ${pass ? "PASS" : "FAIL"}`,
    );
  }

  // 恢复原位置（左上）
  await ev(`window.__pet.setPos(0, 0)`);
  console.log(allPass ? "\n=== 四角测试全部通过 ===" : "\n=== 四角测试存在失败 ===");
  ws.close();
}

main().catch((e) => {
  console.error("四角测试失败:", e.message);
  process.exit(1);
});
