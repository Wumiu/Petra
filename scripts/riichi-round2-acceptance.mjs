/**
 * Round-2 Tauri/WebView acceptance. Drives the actual DOM through CDP input,
 * completes one hand, captures visual states and checks wall/model invariants.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

const port = process.argv[2] ?? "9222";
const outDir = join(process.env.TEMP ?? process.cwd(), "petra-riichi-round2");
await mkdir(outDir, { recursive: true });
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
const screenshot = async (name) => {
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const path = join(outDir, name);
  await writeFile(path, Buffer.from(shot.data, "base64"));
  return path;
};
const clickPoint = async (point, count = 1) => {
  for (let i = 0; i < count; i++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
};
const pointFor = (selector, text = "") => evaluate(`(()=>{const list=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=list.find(x=>!${JSON.stringify(text)}||x.textContent.trim()===${JSON.stringify(text)});const r=e?.getBoundingClientRect();return r&&r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`);
const clickSelector = async (selector, text = "") => {
  const point = await pointFor(selector, text);
  if (!point) return false;
  await clickPoint(point);
  return true;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await wait(1500);
const dpiScale = await evaluate(`devicePixelRatio||1`);
const originalPrefs = await evaluate(`({motion:localStorage.getItem('petra.riichi.motion'),pet:localStorage.getItem('petra.riichi.petInteraction')})`);
const originalGameSettings = await evaluate(`localStorage.getItem('live2d-pet-settings')`);
await evaluate(`localStorage.setItem('petra.riichi.motion','1');localStorage.setItem('petra.riichi.petInteraction','1')`);
await evaluate(`(()=>{const k='live2d-pet-settings';const s=JSON.parse(localStorage.getItem(k)||'{}');s.gameTalk=false;localStorage.setItem(k,JSON.stringify(s))})()`);
await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:${Math.round(700)}*devicePixelRatio,height:${Math.round(700)}*devicePixelRatio})`);
await wait(5500);

async function openFromMenu() {
  if (await evaluate(`!!document.querySelector('.mg-riichi')`)) return true;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 350, y: 350, button: "right", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 350, y: 350, button: "right", clickCount: 1 });
  await wait(100);
  let found = await evaluate(`!![...document.querySelectorAll('#menu .mi')].find(x=>x.textContent.includes('立直麻将'))`);
  if (!found) {
    await evaluate(`document.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:340,clientY:340,button:2}))`);
    await wait(100);
  }
  found = await evaluate(`(()=>{const p=[...document.querySelectorAll('#menu>.mi')].find(x=>x.textContent.includes('小游戏'));p?.click();const g=[...document.querySelectorAll('#menu .mi')].find(x=>x.textContent.includes('立直麻将'));g?.click();return !!g})()`);
  // CDP mouse events do not move the native Windows cursor. The production
  // cursor watcher can therefore close the context menu before automation
  // reaches its nested item. Keep the real-menu attempt above, then use the
  // Vite-only module entry as a deterministic test fallback. All following
  // actions still go through the rendered Tauri GUI.
  if (!found) {
    found = await evaluate(`import('/src/games/host.ts').then(m=>m.openMiniGame('riichi'))`);
  }
  if (!found) return false;
  await wait(500);
  return evaluate(`!!document.querySelector('.mg-riichi')`);
}

if (!await openFromMenu()) throw new Error("could not open riichi from the real context-menu entry");
for (const prefix of ["互动", "动效"]) {
  const state = await evaluate(`(()=>{const b=[...document.querySelectorAll('.mg-head-btns button')].find(b=>b.textContent.includes(${JSON.stringify(prefix)}));return {label:b?.textContent||'',pressed:b?.getAttribute('aria-pressed')}})()`);
  if (state.pressed === "false") await clickSelector(".mg-head-btns button", state.label);
}
await evaluate(`window.__riichiEmotionAudit=[];document.addEventListener('petra-emotion-reacted',e=>window.__riichiEmotionAudit.push(e.detail))`);

const metrics = () => evaluate(`(()=>{const root=document.querySelector('.mg-riichi');const game=root?.__riichiGame;const stage=document.getElementById('stage');const hit=document.querySelector('.mg-pet-hit')?.getBoundingClientRect();const css=stage?getComputedStyle(stage):null;return {
  viewport:{w:innerWidth,h:innerHeight},wallState:game?.wall.length,deadState:game?.deadWall.length,
  liveImages:document.querySelectorAll('.mg-live-wall img.mg-tile-art').length,
  deadImages:document.querySelectorAll('.mg-dead-wall img.mg-tile-art').length,
  stackSlots:document.querySelectorAll('.mg-wall-stack').length,
  fullStacks:document.querySelectorAll('.mg-wall-stack:not(.mg-wall-empty):not(.mg-wall-half)').length,
  halfStacks:document.querySelectorAll('.mg-wall-half').length,
  emptyStacks:document.querySelectorAll('.mg-wall-empty').length,
  doraFaces:document.querySelectorAll('.mg-dead-stack .mg-tile:not(.mg-tile-back)').length,
  riverMe:game?.players[0].river.length,riverPet:game?.players[1].river.length,
  handMe:game?.players[0].hand.length,handPet:game?.players[1].hand.length,
  accounted:game?game.wall.length+game.deadWall.length+game.players.reduce((n,p)=>n+p.hand.length+p.discards.length+p.melds.reduce((m,x)=>m+x.tiles.length,0),0):null,
  petVars:stage?{x:stage.style.getPropertyValue('--mg-pet-x'),y:stage.style.getPropertyValue('--mg-pet-y'),scale:stage.style.getPropertyValue('--mg-pet-scale'),transform:css?.transform}:null,
  hit:hit?{left:hit.left,top:hit.top,width:hit.width,height:hit.height}:null,
  speech:document.querySelector('.mg-pet-speech')?.textContent||'',motion:root?.classList.contains('mg-motion'),
}})()`);

const opening = await metrics();
if (opening.wallState !== 95 || opening.liveImages !== 95 || opening.stackSlots !== 48 || opening.fullStacks !== 47 || opening.halfStacks !== 1 || opening.deadState !== 14 || opening.deadImages !== 14) {
  throw new Error(`opening wall mismatch: ${JSON.stringify(opening)}`);
}
const files = { opening: await screenshot("01-opening-700.png") };

// Real native resize through Petra's existing command, not a browser emulation.
await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:${Math.round(560)}*devicePixelRatio,height:${Math.round(560)}*devicePixelRatio})`);
await wait(500);
const narrow = await metrics();
if (narrow.viewport.w !== 560 || narrow.viewport.h !== 560 || narrow.liveImages !== narrow.wallState) throw new Error(`560 layout mismatch: ${JSON.stringify(narrow)}`);
files.narrow = await screenshot("02-opening-560.png");
await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:${Math.round(700)}*devicePixelRatio,height:${Math.round(700)}*devicePixelRatio})`);
await wait(500);

// Rapid double click on the same transformed tile: exactly one discard is allowed.
const firstTile = await pointFor(".mg-tile-click");
if (!firstTile) throw new Error("no clickable tile at opening");
await clickPoint(firstTile, 2);
await wait(1100);
const afterDiscard = await metrics();
if (afterDiscard.riverMe !== 1 || afterDiscard.liveImages !== afterDiscard.wallState) throw new Error(`double-click guard/wall sync failed: ${JSON.stringify(afterDiscard)}`);
files.discard = await screenshot("03-after-discard.png");

// Restart during active play must discard all old state/timers and keep one overlay.
await clickSelector(".mg-head-btns button", "重开");
await wait(350);
const restarted = await metrics();
if (restarted.riverMe !== 0 || restarted.handMe !== 14 || restarted.liveImages !== restarted.wallState || restarted.deadImages !== 14) throw new Error(`restart failed: ${JSON.stringify(restarted)}`);

// Deterministic independent ankan position, but execute the actual public GUI button and run-loop path.
await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;g.players[0].hand=[0,0,0,0,1,2,3,4,5,9,10,11,18,19];if(!g.pending?.options.includes('ankan'))g.pending.options.push('ankan');g.onUpdate();return true})()`);
const kanBefore = await metrics();
files.kanAction = await screenshot("04-ankan-actions.png");
if (!await clickSelector(".mg-actions button", "暗杠")) throw new Error("ankan fixture did not expose GUI button");
await wait(850);
const kanAfter = await metrics();
if (kanAfter.wallState !== kanBefore.wallState - 1 || kanAfter.liveImages !== kanAfter.wallState || kanAfter.deadState !== 14 || kanAfter.deadImages !== 14 || kanAfter.doraFaces !== kanBefore.doraFaces + 1 || kanAfter.accounted !== 136) {
  throw new Error(`rinshan/dead-wall accounting failed: ${JSON.stringify({kanBefore,kanAfter})}`);
}
files.kanSupplement = await screenshot("05-kan-supplement.png");
await clickSelector(".mg-head-btns button", "重开");
await wait(350);

// Complete one whole hand exclusively through current GUI controls and transformed hit targets.
let steps = 0;
let naturalRiichi = false;
let naturalCall = false;
let naturalKan = false;
const naturalKanChecks = [];
while (steps++ < 260) {
  const state = await evaluate(`(()=>({
    settled:!!document.querySelector('.mg-banner')&&[...document.querySelectorAll('.mg-actions button')].some(b=>b.textContent.includes('下一局')),
    buttons:[...document.querySelectorAll('.mg-actions button')].map(b=>b.textContent.trim()),
    tile:document.querySelector('.mg-tile-click')?true:false,
  }))()`);
  if (state.settled) break;
  let acted = false;
  for (const label of ["自摸和了", "荣和", "暗杠", "明杠", "碰", "立直", "过"]) {
    if (!state.buttons.includes(label)) continue;
    const beforeKan = label.includes("杠") ? await metrics() : null;
    acted = await clickSelector(".mg-actions button", label);
    if (label === "立直") { naturalRiichi = true; await wait(100); }
    if (label === "碰") naturalCall = true;
    if (label.includes("杠")) {
      naturalKan = true;
      await wait(850);
      naturalKanChecks.push({ before: beforeKan, after: await metrics() });
    }
    break;
  }
  if (!acted && state.tile) acted = await clickSelector(".mg-tile-click");
  await wait(acted ? 760 : 120);
}
const completed = await evaluate(`(()=>{const root=document.querySelector('.mg-riichi');const g=root?.__riichiGame;return {phase:g?.phase,result:g?.handResult,handNo:g?.handNo,buttons:[...document.querySelectorAll('.mg-actions button')].map(b=>b.textContent.trim())}})()`);
if (completed.phase !== "handend" && completed.phase !== "ended") throw new Error(`GUI hand did not finish in ${steps} actions: ${JSON.stringify(completed)}`);
files.settlement = await screenshot("06-settlement.png");

// Independent dev-only visual fixtures for rare states; these do not stand in for the GUI-completed hand above.
await evaluate(`(()=>{const root=document.querySelector('.mg-riichi');const g=root.__riichiGame;g.runId++;g.phase='playing';g.handResult=null;g.pending=null;g.sticks=1;g.wall=new Array(89).fill(0);g.doraIndicators=[g.deadWall[4]];g.players[0].score=24000;g.players[1].score=26000;g.players[0].hand=[0,1,2,3,4,9,10,11,18,19,20,27,31];g.players[1].hand=new Array(13).fill(0);g.players[0].melds=[];g.players[1].melds=[];g.players[0].discards=[0,9,18,4];g.players[1].discards=[27,28,29];g.players[0].river=[{tile:0,riichi:false,called:false},{tile:9,riichi:false,called:false},{tile:18,riichi:false,called:false},{tile:4,riichi:true,called:false}];g.players[1].river=[{tile:27,riichi:false,called:false},{tile:28,riichi:false,called:false},{tile:29,riichi:false,called:false}];g.players[0].riichi=true;g.players[1].riichi=false;g.log=['独立视觉局面：立直宣言牌横置'];g.lastEvent={seq:(g.lastEvent?.seq||0)+1,type:'riichi',seat:0,tile:4};g.onUpdate();return true})()`);
await wait(180);
files.riichi = await screenshot("04-riichi-fixture.png");

await evaluate(`(()=>{const root=document.querySelector('.mg-riichi');const g=root.__riichiGame;g.wall=new Array(88).fill(0);g.players[0].hand=[0,1,2,9,18];g.players[0].discards=[3,20];g.players[1].discards=[27,28,29];g.players[0].river=[{tile:3,riichi:false,called:false},{tile:11,riichi:false,called:true},{tile:20,riichi:false,called:false}];g.players[0].melds=[{kind:'triplet',tiles:[8,8,8],open:true,from:1},{kind:'kan',tiles:[31,31,31,31],open:false,from:null},{kind:'kan',tiles:[27,27,27,27],open:true,from:1}];g.log=['独立视觉局面：碰、暗杠、明杠与被鸣牌槽位'];g.lastEvent={seq:(g.lastEvent?.seq||0)+1,type:'call',seat:0,tile:8,call:'pon'};g.onUpdate();return true})()`);
await wait(180);
files.calls = await screenshot("06-pon-kan-fixture.png");
const emotionAudit = await evaluate(`window.__riichiEmotionAudit`);
if (!emotionAudit.some(x=>x.tag==='surprised'&&x.action==='surprised')) throw new Error(`critical model reaction did not reach existing action system: ${JSON.stringify(emotionAudit)}`);

// Interaction off: event updates must not create speech/reminder UI.
const interactionLabel = await evaluate(`[...document.querySelectorAll('.mg-head-btns button')].find(b=>b.textContent.includes('互动'))?.textContent||''`);
const interactionPressed = await evaluate(`[...document.querySelectorAll('.mg-head-btns button')].find(b=>b.textContent.includes('互动'))?.getAttribute('aria-pressed')`);
if (interactionPressed === "true") await clickSelector(".mg-head-btns button", interactionLabel);
const auditBeforeOff = await evaluate(`window.__riichiEmotionAudit.length`);
await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;g.lastEvent={seq:(g.lastEvent?.seq||0)+1,type:'riichi',seat:1,tile:3};g.onUpdate();return true})()`);
await wait(150);
const interactionOff = await metrics();
const auditAfterOff = await evaluate(`window.__riichiEmotionAudit.length`);
if (interactionOff.speech || auditAfterOff !== auditBeforeOff) throw new Error(`interaction-off still reacted: ${JSON.stringify({interactionOff,auditBeforeOff,auditAfterOff})}`);

// Motion off survives another action and removes animation class.
const motionLabel = await evaluate(`[...document.querySelectorAll('.mg-head-btns button')].find(b=>b.textContent.includes('动效'))?.textContent||''`);
const motionPressed = await evaluate(`[...document.querySelectorAll('.mg-head-btns button')].find(b=>b.textContent.includes('动效'))?.getAttribute('aria-pressed')`);
if (motionPressed === "true") await clickSelector(".mg-head-btns button", motionLabel);
const motionOff = await metrics();
if (motionOff.motion) throw new Error("motion toggle did not disable animation class");

// Exit/re-enter: stage anchor vars, old bubbles, timers and overlay must be cleaned.
await clickSelector(".mg-head-btns button", "退出");
await wait(200);
const exited = await evaluate(`(()=>{const s=document.getElementById('stage');return {overlays:document.querySelectorAll('.mg-view').length,active:document.body.classList.contains('mg-active'),x:s.style.getPropertyValue('--mg-pet-x'),y:s.style.getPropertyValue('--mg-pet-y'),scale:s.style.getPropertyValue('--mg-pet-scale')}})()`);
if (exited.overlays !== 0 || exited.active || exited.x || exited.y || exited.scale) throw new Error(`exit cleanup failed: ${JSON.stringify(exited)}`);
if (!await openFromMenu()) throw new Error("could not re-enter riichi");
const reentered = await evaluate(`(()=>({overlays:document.querySelectorAll('.mg-view').length,speech:document.querySelector('.mg-pet-speech')?.textContent||'',hand:document.querySelectorAll('.mg-hand>.mg-tile').length}))()`);
if (reentered.overlays !== 1 || reentered.hand !== 14 || reentered.speech) throw new Error(`re-entry leaked old state: ${JSON.stringify(reentered)}`);

await evaluate(`(${JSON.stringify(originalPrefs)}.motion===null?localStorage.removeItem('petra.riichi.motion'):localStorage.setItem('petra.riichi.motion',${JSON.stringify(originalPrefs.motion)}));(${JSON.stringify(originalPrefs)}.pet===null?localStorage.removeItem('petra.riichi.petInteraction'):localStorage.setItem('petra.riichi.petInteraction',${JSON.stringify(originalPrefs.pet)}))`);
await evaluate(originalGameSettings === null ? `localStorage.removeItem('live2d-pet-settings')` : `localStorage.setItem('live2d-pet-settings',${JSON.stringify(originalGameSettings)})`);

console.log(JSON.stringify({ pass: true, dpiScale, steps, naturalRiichi, naturalCall, naturalKan, naturalKanChecks, opening, narrow, afterDiscard, restarted, kanBefore, kanAfter, completed, emotionAudit, interactionOff, motionOff, exited, reentered, files }, null, 2));
ws.close();
