/** Targeted Tauri/WebView acceptance for local riichi sound event wiring and settings. */
import WebSocket from "ws";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = process.argv[2] ?? "9222";
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

await send("Runtime.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await wait(4_500);
const originalSettings = await evaluate(`localStorage.getItem('live2d-pet-settings')`);
await evaluate(`(()=>{
  const key='live2d-pet-settings';const settings=JSON.parse(localStorage.getItem(key)||'{}');
  settings.gameSound=true;settings.gameSoundVolume=.3;localStorage.setItem(key,JSON.stringify(settings));
  window.__sfxCalls=[];window.__sfxPauses=[];
  const originalPlay=HTMLMediaElement.prototype.play;const originalPause=HTMLMediaElement.prototype.pause;
  window.__sfxRestore=()=>{HTMLMediaElement.prototype.play=originalPlay;HTMLMediaElement.prototype.pause=originalPause};
  HTMLMediaElement.prototype.play=function(){window.__sfxCalls.push({src:this.currentSrc||this.src,volume:this.volume,time:performance.now()});return Promise.resolve()};
  HTMLMediaElement.prototype.pause=function(){if((this.currentSrc||this.src).includes('/mahjong/sfx/'))window.__sfxPauses.push(this.currentSrc||this.src);return originalPause.call(this)};
})()`);
await evaluate(`import('/src/games/host.ts').then(module=>module.openMiniGame('riichi'))`);
await wait(500);

const resources = await evaluate(`Promise.all([
  'draw.wav','discard-1.wav','discard-2.wav','discard-3.wav','pon.wav','kan.wav','riichi.wav','win.wav','draw-end.wav','button.wav'
].map(async file=>{const response=await fetch('/mahjong/sfx/'+file);const bytes=new Uint8Array(await response.arrayBuffer());return {file,status:response.status,size:bytes.length,riff:String.fromCharCode(...bytes.slice(0,4))}}))`);
if (resources.some((entry) => entry.status !== 200 || entry.riff !== "RIFF" || entry.size < 1000)) throw new Error(`local assets failed: ${JSON.stringify(resources)}`);

const loaded = await evaluate(`(()=>({
  audioCount:[...window.__sfxCalls].length,
  sources:[...performance.getEntriesByType('resource')].map(x=>x.name).filter(x=>x.includes('/mahjong/sfx/')).length,
  gameOpen:!!document.querySelector('.mg-riichi')
}))()`);
if (!loaded.gameOpen || loaded.sources < 10) throw new Error(`preload failed: ${JSON.stringify(loaded)}`);

// Explicit event fixture: production view receives genuine monotonically sequenced game events.
const events = await evaluate(`(()=>{
  window.__sfxCalls.length=0;
  const game=document.querySelector('.mg-riichi').__riichiGame;
  const emit=(type,call)=>{game.note(type,0,0,call);game.onUpdate()};
  emit('draw');emit('discard');emit('discard');emit('discard');emit('call','pon');emit('call','kan');emit('kan','ankan');emit('riichi');emit('win');emit('draw-end');
  const beforeRepeat=window.__sfxCalls.length;game.onUpdate();
  return {beforeRepeat,calls:window.__sfxCalls.map(x=>({file:x.src.split('/').pop(),volume:x.volume}))};
})()`);
const files = events.calls.map((entry) => entry.file);
for (const required of ["draw.wav", "discard-1.wav", "discard-2.wav", "discard-3.wav", "pon.wav", "kan.wav", "riichi.wav", "win.wav", "draw-end.wav"]) {
  if (!files.includes(required)) throw new Error(`missing event sound ${required}: ${JSON.stringify(events)}`);
}
if (events.calls.length !== events.beforeRepeat || events.calls.length !== 10) throw new Error(`event replay/stack mismatch: ${JSON.stringify(events)}`);

// Real rendered toolbar settings: toggle, persistent volume and one preview on committed change.
await evaluate(`(()=>{window.__sfxCalls.length=0;const b=[...document.querySelectorAll('.mg-head-btns button')].find(x=>x.textContent.includes('音效'));b.click()})()`);
const panel = await evaluate(`(()=>{const panel=document.querySelector('.mg-sound-panel');return {open:!!panel,checked:panel?.querySelector('input[type=checkbox]')?.checked,value:panel?.querySelector('input[type=range]')?.value,help:panel?.textContent}})()`);
if (!panel.open || !panel.checked || panel.value !== "30" || !panel.help.includes("松开滑块试听")) throw new Error(`sound settings panel mismatch: ${JSON.stringify(panel)}`);
await evaluate(`(()=>{const range=document.querySelector('.mg-sound-panel input[type=range]');range.value='45';range.dispatchEvent(new Event('input',{bubbles:true}));range.dispatchEvent(new Event('change',{bubbles:true}))})()`);
const volume = await evaluate(`(()=>{const saved=JSON.parse(localStorage.getItem('live2d-pet-settings'));return {saved:saved.gameSoundVolume,calls:window.__sfxCalls.map(x=>({file:x.src.split('/').pop(),volume:x.volume}))}})()`);
if (volume.saved !== .45 || volume.calls.filter((entry) => entry.file === "discard-1.wav").length !== 1) throw new Error(`volume preview mismatch: ${JSON.stringify(volume)}`);
const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
const screenshot = join(process.env.TEMP ?? process.cwd(), "petra-riichi-sfx-settings.png");
await writeFile(screenshot, Buffer.from(shot.data, "base64"));

// Disable stops current sounds; blur suppresses events and focus does not replay a backlog.
await evaluate(`(()=>{const box=document.querySelector('.mg-sound-panel input[type=checkbox]');box.click();window.__sfxCalls.length=0;const g=document.querySelector('.mg-riichi').__riichiGame;g.note('draw',0,1);g.onUpdate()})()`);
const disabledCalls = await evaluate(`window.__sfxCalls.length`);
if (disabledCalls !== 0) throw new Error("disabled game sound still played");
await evaluate(`(()=>{const box=document.querySelector('.mg-sound-panel input[type=checkbox]');box.click();window.__sfxCalls.length=0;window.dispatchEvent(new Event('blur'));const g=document.querySelector('.mg-riichi').__riichiGame;g.note('discard',0,2);g.onUpdate();window.dispatchEvent(new Event('focus'));return true})()`);
const blurredCalls = await evaluate(`window.__sfxCalls.length`);
if (blurredCalls !== 0) throw new Error("blurred game emitted or replayed a sound");

await evaluate(`(()=>{window.__sfxCalls.length=0;const close=[...document.querySelectorAll('.mg-head-btns button')].find(x=>x.textContent.includes('退出'));close.click()})()`);
const cleanup = await evaluate(`({closed:!document.querySelector('.mg-riichi'),pauses:window.__sfxPauses.length,calls:window.__sfxCalls.length})`);
if (!cleanup.closed || cleanup.pauses < 10) throw new Error(`unmount cleanup failed: ${JSON.stringify(cleanup)}`);

await evaluate(`window.__sfxRestore()`);
const actualPlayback = await evaluate(`new Promise((resolve)=>{
  const audio=new Audio('/mahjong/sfx/button.wav');audio.volume=.3;
  const timer=setTimeout(()=>resolve({ok:false,reason:'ended timeout',readyState:audio.readyState}),1500);
  audio.addEventListener('ended',()=>{clearTimeout(timer);resolve({ok:true,duration:audio.duration,readyState:audio.readyState})},{once:true});
  audio.play().catch(error=>{clearTimeout(timer);resolve({ok:false,reason:error.name+': '+error.message,readyState:audio.readyState})});
})`);
if (!actualPlayback.ok) throw new Error(`real WebView audio playback failed: ${JSON.stringify(actualPlayback)}`);
await evaluate(originalSettings === null ? `localStorage.removeItem('live2d-pet-settings')` : `localStorage.setItem('live2d-pet-settings',${JSON.stringify(originalSettings)})`);
console.log(JSON.stringify({ pass: true, resources, loaded, events, panel, volume, disabledCalls, blurredCalls, cleanup, actualPlayback, screenshot }, null, 2));
ws.close();
