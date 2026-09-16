/** Visual review for the real Tauri WebView (requires `npm run tauri dev`). */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

const port = process.argv[2] ?? "9222";
const outDir = join(process.env.TEMP ?? process.cwd(), "petra-riichi-visual-review");
await mkdir(outDir, { recursive: true });
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = pages.find((entry) => entry.type === "page") ?? pages[0];
if (!page?.webSocketDebuggerUrl) throw new Error("Petra WebView CDP page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id;
  const receive = (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id !== callId) return;
    ws.off("message", receive);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  };
  ws.on("message", receive);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const output = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (output.exceptionDetails) throw new Error(output.exceptionDetails.exception?.description ?? output.exceptionDetails.text);
  return output.result?.value;
};
const screenshot = async (name) => {
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const path = join(outDir, name);
  await writeFile(path, Buffer.from(shot.data, "base64"));
  return path;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await wait(4500);
await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:700*devicePixelRatio,height:700*devicePixelRatio})`);
await wait(400);

// Complete 34-kind source preview, clearly marked as a test preview.
await evaluate(`(()=>{
  const names=[...Array(9)].map((_,i)=>'Man'+(i+1)).concat([...Array(9)].map((_,i)=>'Pin'+(i+1)),[...Array(9)].map((_,i)=>'Sou'+(i+1)),['Ton','Nan','Shaa','Pei','Haku','Hatsu','Chun']);
  const labels=['一萬','二萬','三萬','四萬','五萬','六萬','七萬','八萬','九萬','一筒','二筒','三筒','四筒','五筒','六筒','七筒','八筒','九筒','一索','二索','三索','四索','五索','六索','七索','八索','九索','東','南','西','北','白','發','中'];
  const panel=document.createElement('div');panel.id='tile-review';panel.style.cssText='position:fixed;inset:0;z-index:99999;background:#173f35;color:#fff;padding:18px 24px;box-sizing:border-box;font:13px sans-serif';
  panel.innerHTML='<h2 style="margin:0 0 12px;text-align:center">测试预览 · 传统日式立直麻将牌面（34种）</h2>';
  const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(9,1fr);gap:9px 6px;max-width:650px;margin:auto';
  names.forEach((name,index)=>{const cell=document.createElement('div');cell.style.cssText='text-align:center;color:#e9f3ee';const face=document.createElement('div');face.style.cssText='width:46px;height:62px;margin:auto;border-radius:5px;background:linear-gradient(#fffdf7,#f1ede3);box-shadow:0 2px 0 #aaa089,0 4px 6px #0007';const img=document.createElement('img');img.src='/mahjong/tiles/'+name+'.svg';img.style.cssText='display:block;width:100%;height:100%;object-fit:contain';img.alt=labels[index];face.appendChild(img);const label=document.createElement('div');label.textContent=labels[index];label.style.fontSize='10px';cell.append(face,label);grid.appendChild(cell)});
  panel.appendChild(grid);document.body.appendChild(panel);return Promise.all([...panel.querySelectorAll('img')].map(img=>img.decode().catch(()=>{})));
})()`);
const files = { preview: await screenshot("01-tile-preview.png") };
await evaluate(`document.getElementById('tile-review')?.remove()`);

async function openGame() {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 350, y: 350, button: "right", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 350, y: 350, button: "right", clickCount: 1 });
  await wait(120);
  if (!await evaluate(`!![...document.querySelectorAll('#menu .mi')].find(x=>x.textContent.includes('立直麻将'))`)) {
    await evaluate(`document.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:350,clientY:350,button:2}))`);
    await wait(120);
  }
  await evaluate(`(()=>{const parent=[...document.querySelectorAll('#menu>.mi')].find(x=>x.textContent.includes('小游戏'));parent?.click();const game=[...document.querySelectorAll('#menu .mi')].find(x=>x.textContent.includes('立直麻将'));game?.click();return !!game})()`);
  await wait(500);
  return evaluate(`!!document.querySelector('.mg-riichi')`);
}
if (!await openGame()) throw new Error("Could not open riichi through the context menu");
files.opening = await screenshot("02-opening-700.png");

await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:560*devicePixelRatio,height:560*devicePixelRatio})`);
await wait(450);
files.narrow = await screenshot("03-opening-560.png");
await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:700*devicePixelRatio,height:700*devicePixelRatio})`);
await wait(450);

// Explicit test fixture: multi-line rivers, riichi/called slots and several melds.
await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;g.runId++;g.phase='playing';g.pending=null;g.handResult=null;g.players[0].hand=[0,1,2,3,4,9,10,18];g.players[1].hand=new Array(8).fill(0);const tiles=[0,9,18,27,1,10,19,28,2,11,20,29,3,12,21,30,4,13];g.players[0].river=tiles.map((tile,i)=>({tile,riichi:i===8,called:i===4}));g.players[1].river=tiles.map((tile,i)=>({tile:(tile+5)%34,riichi:i===10,called:i===14}));g.players[0].melds=[{kind:'triplet',tiles:[8,8,8],open:true,from:1},{kind:'kan',tiles:[31,31,31,31],open:false,from:null}];g.players[1].melds=[{kind:'kan',tiles:[27,27,27,27],open:true,from:0}];g.lastDraw=null;g.lastDrawSeat=null;g.log=['测试局面：三行牌河、立直牌、被鸣牌与多个副露'];g.lastEvent={seq:(g.lastEvent?.seq||0)+1,type:'call',seat:0,tile:8,call:'pon'};g.onUpdate();return true})()`);
await wait(500);
files.fixture = await screenshot("04-test-fixture-multiline-rivers.png");

await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;g.pending={kind:'turn',options:[]};g.onUpdate()})()`);
const hoverPoint = await evaluate(`(()=>{const r=document.querySelector('.mg-tile-click')?.getBoundingClientRect();return r?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`);
if (!hoverPoint) throw new Error("No clickable tile for hover review");
const hoverBaseline = await evaluate(`([...document.querySelectorAll('.mg-hand>.mg-tile')].map(x=>{const r=x.getBoundingClientRect();return [r.left,r.top,r.width,r.height]}))`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hoverPoint.x, y: hoverPoint.y, button: "none" });
await wait(180);
const hovered = await evaluate(`(()=>{const e=document.querySelector('.mg-tile-click');return {transform:getComputedStyle(e).transform,top:e.getBoundingClientRect().top}})()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 100, button: "none" });
await wait(180);
const hoverSettled = await evaluate(`([...document.querySelectorAll('.mg-hand>.mg-tile')].map(x=>{const r=x.getBoundingClientRect();return [r.left,r.top,r.width,r.height]}))`);
if (hovered.transform === "none" || JSON.stringify(hoverBaseline) !== JSON.stringify(hoverSettled)) throw new Error("Hover feedback changed hand layout or did not render");

const stability = await evaluate(`(()=>{const cards=[...document.querySelectorAll('.mg-hand>.mg-tile')];const gameAnimations=()=>document.getAnimations().filter(x=>x.playState==='running'&&x.effect?.target?.closest?.('.mg-riichi')).length;return {rects:cards.map(x=>{const r=x.getBoundingClientRect();return [r.left,r.top,r.width,r.height]}),animations:gameAnimations(),center:document.querySelector('.mg-center')?.getBoundingClientRect().toJSON(),rivers:[...document.querySelectorAll('.mg-river-zone')].map(x=>x.getBoundingClientRect().toJSON()),broken:[...document.images].filter(x=>!x.complete||!x.naturalWidth).map(x=>x.src),label:document.querySelector('.mg-dead-label')?.textContent}})()`);
await wait(1600);
const settled = await evaluate(`({animations:document.getAnimations().filter(x=>x.playState==='running'&&x.effect?.target?.closest?.('.mg-riichi')).length,rects:[...document.querySelectorAll('.mg-hand>.mg-tile')].map(x=>{const r=x.getBoundingClientRect();return [r.left,r.top,r.width,r.height]})})`);
if (stability.broken.length || stability.label !== "宝牌区" || settled.animations !== 0 || JSON.stringify(stability.rects) !== JSON.stringify(settled.rects)) throw new Error(`visual stability failed: ${JSON.stringify({stability,settled})}`);

await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;g.phase='handend';g.handResult='测试结算状态：流局\\n此画面仅用于布局验收';g.lastEvent={seq:(g.lastEvent?.seq||0)+1,type:'draw-end'};g.onUpdate()})()`);
await wait(500);
files.settlement = await screenshot("05-test-fixture-settlement.png");

console.log(JSON.stringify({ pass: true, files, hovered, stability, settled }, null, 2));
ws.close();
