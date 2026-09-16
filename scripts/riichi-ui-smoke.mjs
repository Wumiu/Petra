/** Petra dev WebView riichi UI smoke test (requires `npm run tauri dev`). */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

const port = process.argv[2] ?? "9222";
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = pages.find((p) => p.type === "page") ?? pages[0];
if (!page?.webSocketDebuggerUrl) throw new Error("Petra WebView CDP page not found");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  const onMessage = (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== mid) return;
    ws.off("message", onMessage);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  };
  ws.on("message", onMessage);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
  return out.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
await evaluate(`window.__riichiSmokeWarnings=[];window.__riichiSmokeWarn=console.warn;console.warn=(...a)=>{window.__riichiSmokeWarnings.push(a.map(x=>x?.stack||String(x)).join(' '));window.__riichiSmokeWarn(...a)}`);
await send("Page.reload", { ignoreCache: true });
await wait(7000);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 350, y: 350, button: "right", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 350, y: 350, button: "right", clickCount: 1 });
await wait(120);
await evaluate(`(()=>{const parent=[...document.querySelectorAll('#menu>.mi')].find(x=>x.textContent.includes('小游戏'));parent?.click();const game=[...document.querySelectorAll('#menu .mi')].find(x=>x.textContent.includes('立直麻将'));game?.click();return !!game})()`);
await wait(500);
const openResult = await evaluate(`({opened:!!document.querySelector('.mg-riichi'),menu:document.getElementById('menu')?.textContent||''})`);
if (!openResult.opened) {
  const warnings = await evaluate(`window.__riichiSmokeWarnings`);
  throw new Error(`openMiniGame returned false: ${JSON.stringify({openResult,warnings})}`);
}
await wait(500);

const before = await evaluate(`(()=>{
  const clickable=document.querySelector('.mg-tile-click');
  const r=clickable?.getBoundingClientRect();
  const stage=getComputedStyle(document.getElementById('stage'));
  return {
    open:!!document.querySelector('.mg-riichi'),
    imageTiles:document.querySelectorAll('img.mg-tile-art').length,
    textTiles:[...document.querySelectorAll('.mg-tile')].filter(e=>e.textContent.trim()).length,
    wallStacks:document.querySelectorAll('.mg-wall-stack').length,
    visibleWallStacks:document.querySelectorAll('.mg-wall-stack:not(.mg-wall-empty)').length,
    deadStacks:document.querySelectorAll('.mg-dead-stack').length,
    doraFaces:document.querySelectorAll('.mg-dead-stack .mg-tile:not(.mg-tile-back)').length,
    handTiles:document.querySelectorAll('.mg-hand>.mg-tile').length,
    myRiver:document.querySelectorAll('.mg-river-me .mg-river-slot').length,
    petRiver:document.querySelectorAll('.mg-river-pet .mg-river-slot').length,
    petHit:!!document.querySelector('.mg-pet-hit'),
    stageTransform:stage.transform,
    clickPoint:r?{x:r.left+r.width/2,y:r.top+r.height/2}:null,
    viewport:{w:innerWidth,h:innerHeight},
  };
})()`);

if (!before.open || before.imageTiles < 50 || before.textTiles !== 0) throw new Error(`tile image mapping failed: ${JSON.stringify(before)}`);
if (before.wallStacks !== 48 || before.deadStacks !== 7 || before.doraFaces < 1) throw new Error(`wall rendering failed: ${JSON.stringify(before)}`);
if (!before.petHit || before.stageTransform === "none") throw new Error(`pet seat failed: ${JSON.stringify(before)}`);
if (!before.clickPoint) throw new Error("no clickable player tile");

await send("Input.dispatchMouseEvent", { type: "mousePressed", x: before.clickPoint.x, y: before.clickPoint.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: before.clickPoint.x, y: before.clickPoint.y, button: "left", clickCount: 1 });
await wait(1200);

const after = await evaluate(`(()=>({
  myRiver:document.querySelectorAll('.mg-river-me .mg-river-slot').length,
  petRiver:document.querySelectorAll('.mg-river-pet .mg-river-slot').length,
  imageTiles:document.querySelectorAll('img.mg-tile-art').length,
  calledSlots:document.querySelectorAll('.mg-river-called').length,
  hasActions:!!document.querySelector('.mg-actions'),
}))()`);
if (after.myRiver < 1 || !after.hasActions || after.imageTiles < 50) throw new Error(`transformed tile click failed: ${JSON.stringify(after)}`);

const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
const outPath = join(process.env.TEMP ?? process.cwd(), "petra-riichi-smoke.png");
await writeFile(outPath, Buffer.from(shot.data, "base64"));

await evaluate(`(()=>{const b=[...document.querySelectorAll('.mg-head-btns button')].find(x=>x.textContent==='重开');b?.click();return !!b})()`);
await wait(250);
const restarted = await evaluate(`(()=>({
  overlays:document.querySelectorAll('.mg-view').length,
  handTiles:document.querySelectorAll('.mg-hand>.mg-tile').length,
  myRiver:document.querySelectorAll('.mg-river-me .mg-river-slot').length,
  deadStacks:document.querySelectorAll('.mg-dead-stack').length,
  hasActions:!!document.querySelector('.mg-actions'),
}))()`);
if (restarted.overlays !== 1 || restarted.handTiles !== 14 || restarted.myRiver !== 0 || restarted.deadStacks !== 7) {
  throw new Error(`restart cleanup failed: ${JSON.stringify(restarted)}`);
}

await send("Emulation.setDeviceMetricsOverride", { width: 560, height: 560, deviceScaleFactor: 1, mobile: false });
await wait(150);
const responsive = await evaluate(`(()=>{const hand=document.querySelector('.mg-hand')?.getBoundingClientRect();const actions=document.querySelector('.mg-actions')?.getBoundingClientRect();return {viewport:{w:innerWidth,h:innerHeight},overflowX:document.documentElement.scrollWidth>innerWidth,hand:hand?{left:hand.left,right:hand.right,bottom:hand.bottom}:null,actions:actions?{left:actions.left,right:actions.right,bottom:actions.bottom}:null}})()`);
if (responsive.overflowX || !responsive.hand || responsive.hand.left < 0 || responsive.hand.right > responsive.viewport.w || !responsive.actions || responsive.actions.bottom > responsive.viewport.h) {
  throw new Error(`responsive layout failed: ${JSON.stringify(responsive)}`);
}
await send("Emulation.clearDeviceMetricsOverride");

console.log(JSON.stringify({ pass: true, before, after, restarted, responsive, screenshot: outPath }, null, 2));
ws.close();
