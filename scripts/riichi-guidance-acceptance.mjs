/** Targeted Tauri/WebView acceptance for wait preview, in-table actions and AI request boundaries. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

const port = process.argv[2] ?? "9222";
const outDir = join(process.env.TEMP ?? process.cwd(), "petra-riichi-guidance");
await mkdir(outDir, { recursive: true });
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = pages.find((p) => p.type === "page") ?? pages[0];
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
const hover = async (selector) => {
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`);
  if (!point) throw new Error(`missing hover target: ${selector}`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await wait(120);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await wait(4_500);
const originalSettings = await evaluate(`localStorage.getItem('live2d-pet-settings')`);
const originalInteraction = await evaluate(`localStorage.getItem('petra.riichi.petInteraction')`);
await evaluate(`(()=>{const k='live2d-pet-settings';const s=JSON.parse(localStorage.getItem(k)||'{}');s.gameTalk=false;localStorage.setItem(k,JSON.stringify(s))})()`);
await evaluate(`localStorage.setItem('petra.riichi.petInteraction','1')`);
await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:700*devicePixelRatio,height:700*devicePixelRatio})`);
await evaluate(`import('/src/games/host.ts').then(m=>m.openMiniGame('riichi'))`);
await wait(500);

// Explicit fixture: discard North -> two-sided 3m/6m wait, with real engine calculation.
await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;g.runId++;g.phase='playing';g.players[0].hand=[0,1,2,3,4,9,10,11,18,19,20,27,27,30];g.players[0].melds=[];g.players[0].river=[];g.players[0].discards=[];g.players[1].river=[];g.players[1].discards=[];g.pending={kind:'turn',options:['discard','tsumo','riichi']};g.lastDraw=30;g.lastDrawSeat=0;g.handResult=null;g.onUpdate();return true})()`);
await hover(".mg-hand .mg-tile:last-child");
const waitPreview = await evaluate(`(()=>{const p=document.querySelector('.mg-wait-preview');const r=p?.getBoundingClientRect();const table=document.querySelector('.mg-table')?.getBoundingClientRect();return {title:p?.querySelector('.mg-wait-preview-title')?.textContent,images:p?.querySelectorAll('img').length,text:p?.textContent,bounds:r&&{left:r.left,right:r.right,top:r.top,bottom:r.bottom},table:table&&{left:table.left,right:table.right,top:table.top,bottom:table.bottom},actions:document.querySelector('.mg-actions')?.getBoundingClientRect().toJSON()}})()`);
if (waitPreview.title !== "打出后听牌" || waitPreview.images !== 2) throw new Error(`wait preview mismatch: ${JSON.stringify(waitPreview)}`);
if (waitPreview.bounds.left < waitPreview.table.left || waitPreview.bounds.right > waitPreview.table.right) throw new Error(`wait preview escaped table: ${JSON.stringify(waitPreview)}`);
if (waitPreview.bounds.bottom > waitPreview.actions.top) throw new Error(`wait preview overlaps actions: ${JSON.stringify(waitPreview)}`);
const files = { preview700: await screenshot("01-wait-preview-actions-700.png") };

// Fast target switch and a non-tenpai discard must not leave stale content.
await hover(".mg-hand .mg-tile:first-child");
const stale = await evaluate(`!!document.querySelector('.mg-wait-preview')`);
if (stale) throw new Error("non-tenpai hover retained stale preview");

await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:560*devicePixelRatio,height:560*devicePixelRatio})`);
await wait(350);
await hover(".mg-hand .mg-tile:last-child");
const narrowBounds = await evaluate(`(()=>{const p=document.querySelector('.mg-wait-preview')?.getBoundingClientRect();const t=document.querySelector('.mg-table')?.getBoundingClientRect();return {p:p&&{left:p.left,right:p.right,top:p.top,bottom:p.bottom},t:t&&{left:t.left,right:t.right,top:t.top,bottom:t.bottom}}})()`);
if (!narrowBounds.p || narrowBounds.p.left < narrowBounds.t.left || narrowBounds.p.right > narrowBounds.t.right) throw new Error(`560 preview bounds failed: ${JSON.stringify(narrowBounds)}`);
files.preview560 = await screenshot("02-wait-preview-actions-560.png");

await evaluate(`window.__TAURI_INTERNALS__.invoke('set_window_size',{width:700*devicePixelRatio,height:700*devicePixelRatio})`);
await wait(300);
await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;g.players[0].hand=[0,0,0,0,9,9,9,9,1,2,3,18,19,20];g.players[0].melds=[];g.pending={kind:'turn',options:['discard','ankan']};g.onUpdate();return true})()`);
const multiKanButtons = await evaluate(`[...document.querySelectorAll('.mg-actions button')].map(b=>b.textContent.trim()).filter(t=>t.startsWith('暗杠'))`);
if (multiKanButtons.length !== 2 || new Set(multiKanButtons).size !== 2) throw new Error(`multiple kan choices collapsed: ${JSON.stringify(multiKanButtons)}`);
// Explicit long-river/call fixture: in-table Ron/Pon/Kan/Pass area plus public melds.
await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;const river=[0,9,18,27,1,10,19,28,2,11,20,29,3,12,21,30,4,13].map((tile,i)=>({tile,riichi:i===8,called:i===4}));g.players[0].river=river;g.players[0].discards=river.filter(x=>!x.called).map(x=>x.tile);g.players[1].river=river.map((x,i)=>({...x,tile:(x.tile+5)%34,riichi:i===10,called:i===14}));g.players[1].discards=g.players[1].river.filter(x=>!x.called).map(x=>x.tile);g.players[0].melds=[{kind:'triplet',tiles:[8,8,8],open:true,from:1},{kind:'kan',tiles:[31,31,31,31],open:false,from:null}];g.pending={kind:'call',options:['ron','pon','kan','pass'],tile:8};g.lastDrawSeat=null;g.onUpdate();return true})()`);
const actionAudit = await evaluate(`(()=>{const a=document.querySelector('.mg-actions')?.getBoundingClientRect();const t=document.querySelector('.mg-table')?.getBoundingClientRect();const labels=[...document.querySelectorAll('.mg-actions button')].map(b=>b.textContent.trim());const rivers=[...document.querySelectorAll('.mg-river-zone')].map(e=>e.getBoundingClientRect().toJSON());return {labels,a:a&&a.toJSON(),t:t&&t.toJSON(),rivers}})()`);
if (JSON.stringify(actionAudit.labels) !== JSON.stringify(["荣和","碰","明杠","过"])) throw new Error(`action labels mismatch: ${JSON.stringify(actionAudit)}`);
if (actionAudit.a.left < actionAudit.t.left || actionAudit.a.right > actionAudit.t.right) throw new Error(`actions outside table: ${JSON.stringify(actionAudit)}`);
if (actionAudit.rivers.some((r) => !(actionAudit.a.right <= r.left || actionAudit.a.left >= r.right || actionAudit.a.bottom <= r.top || actionAudit.a.top >= r.bottom))) throw new Error(`actions overlap river: ${JSON.stringify(actionAudit)}`);
files.callActions = await screenshot("03-call-actions-long-rivers.png");
await evaluate(`document.querySelector('.mg-chat-toggle')?.click()`);
const chatAudit = await evaluate(`({input:!!document.querySelector('.mg-chat-input'),max:Number(document.querySelector('.mg-chat-input')?.maxLength),buttons:[...document.querySelectorAll('.mg-chat-form button')].map(b=>b.textContent)})`);
if (!chatAudit.input || chatAudit.max !== 240) throw new Error(`game chat UI mismatch: ${JSON.stringify(chatAudit)}`);
files.gameChat = await screenshot("04-compact-game-chat.png");

// Mock-only API audit: no paid request. Verify whitelist, budgets, cooldown, 429 pause and cancellation.
const aiAudit = await evaluate(`(async()=>{
  const settingsKey='live2d-pet-settings';const saved=localStorage.getItem(settingsKey);const settingsModule=await import('/src/utils/settings.ts');localStorage.removeItem(settingsKey);const defaultGameTalk=settingsModule.loadSettings().gameTalk;if(saved!==null)localStorage.setItem(settingsKey,saved);const s=JSON.parse(saved||'{}');s.gameTalk=true;s.assistant={...(s.assistant||{}),enabled:true,provider:'ollama',model:'mock-model',persona:'',customBaseUrl:''};localStorage.setItem(settingsKey,JSON.stringify(s));
  const talk=await import('/src/games/riichi/petTalk.ts?mock='+Date.now());const client=await import('/src/assistant/AssistantClient.ts');const g=document.querySelector('.mg-riichi').__riichiGame;
  const originalFetch=window.fetch;let calls=[];let mode='ok';let aborted=false;
  window.fetch=(url,opts={})=>{calls.push({url:String(url),body:JSON.parse(String(opts.body||'{}'))});if(mode==='429')return Promise.resolve(new Response('limited',{status:429}));if(mode==='delay')return new Promise((resolve,reject)=>{opts.signal?.addEventListener('abort',()=>{aborted=true;reject(new DOMException('aborted','AbortError'))},{once:true})});const body='data: '+JSON.stringify({choices:[{delta:{content:'月色正好，这一局我可不会让哦。'}}]})+'\\n\\ndata: '+JSON.stringify({choices:[{delta:{}}],usage:{total_tokens:120,prompt_tokens:100,completion_tokens:20}})+'\\n\\ndata: [DONE]\\n\\n';return Promise.resolve(new Response(body,{status:200,headers:{'Content-Type':'text/event-stream'}}))};
  talk.resetPetTalk();const line=await talk.requestPetTalk(g,'测试关键事件',false,()=>true);const first=calls[0];const ctx=JSON.parse(first.body.messages[1].content);const estimate=client.estimateTokens(JSON.stringify(first.body.messages));const afterFirst=calls.length;await talk.requestPetTalk(g,'紧邻事件',false,()=>true);const cooldownCalls=calls.length;
  const off=JSON.parse(localStorage.getItem(settingsKey));off.assistant.enabled=false;localStorage.setItem(settingsKey,JSON.stringify(off));talk.clearPetTalkKeyCache();const unavailable=await talk.requestManualPetTalk(g,'未配置测试',false,()=>true);off.assistant.enabled=true;off.assistant.provider='ollama';localStorage.setItem(settingsKey,JSON.stringify(off));talk.clearPetTalkKeyCache();
  talk.resetPetTalk();mode='429';await talk.requestPetTalk(g,'限流测试',false,()=>true);const limited=await talk.requestManualPetTalk(g,'还能说话吗',false,()=>true);const rateCalls=calls.length;
  talk.resetPetTalk();mode='delay';const timeoutStarted=Date.now();const timeoutResult=await talk.requestManualPetTalk(g,'请测试超时回退',false,()=>true);const timeoutElapsed=Date.now()-timeoutStarted;
  talk.resetPetTalk();mode='delay';const pending=talk.requestManualPetTalk(g,'取消这个低优先级请求',false,()=>true);setTimeout(()=>talk.cancelPetTalk(),20);const cancelled=await pending;
  window.fetch=originalFetch;if(saved===null)localStorage.removeItem(settingsKey);else localStorage.setItem(settingsKey,saved);
  return {defaultGameTalk,line,ctx,estimate,maxTokens:first.body.max_tokens,tools:first.body.tools,afterFirst,cooldownCalls,unavailable,rateCalls,limited,timeoutResult,timeoutElapsed,cancelled,aborted,limits:talk.PET_TALK_LIMITS};
})()`);
if (aiAudit.defaultGameTalk !== false || !aiAudit.line || aiAudit.maxTokens !== 160 || aiAudit.estimate > 1500 || aiAudit.tools !== undefined) throw new Error(`AI budget/default mismatch: ${JSON.stringify(aiAudit)}`);
if (!aiAudit.ctx.pet?.hand || Object.hasOwn(aiAudit.ctx.opponentPublic,'hand') || Object.hasOwn(aiAudit.ctx.opponentPublic,'waits')) throw new Error(`AI whitelist mismatch: ${JSON.stringify(aiAudit.ctx)}`);
if (aiAudit.cooldownCalls !== aiAudit.afterFirst || !aiAudit.unavailable.notice.includes('未开启') || aiAudit.rateCalls !== aiAudit.afterFirst + 1 || !aiAudit.limited.notice.includes('限流') || aiAudit.timeoutElapsed < 14500 || !aiAudit.timeoutResult.notice || !aiAudit.aborted) throw new Error(`AI stability mismatch: ${JSON.stringify(aiAudit)}`);

await evaluate(`document.querySelector('.mg-head-btns button:last-child')?.click()`);
const cleaned = await evaluate(`!document.querySelector('.mg-view') && !document.querySelector('.mg-wait-preview') && !document.querySelector('.mg-actions')`);
if (!cleaned) throw new Error("exit did not clean interaction UI");
await evaluate(originalSettings === null ? `localStorage.removeItem('live2d-pet-settings')` : `localStorage.setItem('live2d-pet-settings',${JSON.stringify(originalSettings)})`);
await evaluate(originalInteraction === null ? `localStorage.removeItem('petra.riichi.petInteraction')` : `localStorage.setItem('petra.riichi.petInteraction',${JSON.stringify(originalInteraction)})`);
console.log(JSON.stringify({ pass: true, waitPreview, narrowBounds, multiKanButtons, actionAudit, chatAudit, aiAudit, files }, null, 2));
ws.close();
