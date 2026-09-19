/** Targeted Tauri/WebView acceptance for local riichi effects, music and settings. */
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
if (page.url === "about:blank") {
  await send("Page.navigate", { url: "http://127.0.0.1:1420/" });
  await wait(2_000);
}
await send("Page.reload", { ignoreCache: true });
await wait(4_500);
await send("Page.bringToFront");
await evaluate(`window.focus()`);
const originalSettings = await evaluate(`localStorage.getItem('live2d-pet-settings')`);
await evaluate(`(()=>{
  const key='live2d-pet-settings';const settings=JSON.parse(localStorage.getItem(key)||'{}');
  settings.gameSound=true;settings.gameSoundVolume=.3;settings.gameMusic=true;settings.gameMusicVolume=.18;
  localStorage.setItem(key,JSON.stringify(settings));
  window.__audioCalls=[];window.__audioPauses=[];
  const originalPlay=HTMLMediaElement.prototype.play;const originalPause=HTMLMediaElement.prototype.pause;
  window.__audioRestore=()=>{HTMLMediaElement.prototype.play=originalPlay;HTMLMediaElement.prototype.pause=originalPause};
  HTMLMediaElement.prototype.play=function(){window.__audioCalls.push({node:this,src:this.currentSrc||this.src,volume:this.volume,loop:this.loop,time:performance.now()});return Promise.resolve()};
  HTMLMediaElement.prototype.pause=function(){if((this.currentSrc||this.src).includes('/mahjong/audio/'))window.__audioPauses.push(this.currentSrc||this.src);return originalPause.call(this)};
})()`);
await evaluate(`import('/src/games/host.ts').then(module=>module.openMiniGame('riichi'))`);
await wait(900);

const audioFiles = ["draw.ogg", "discard-1.wav", "discard-2.wav", "discard-3.wav", "pon.wav", "kan.wav", "riichi.ogg", "button.ogg", "bgm.ogg", "result-victory.ogg", "result-defeat.ogg", "result-draw.ogg"];
const resources = await evaluate(`Promise.all(${JSON.stringify(audioFiles)}.map(async file=>{
  const response=await fetch('/mahjong/audio/'+file);const bytes=new Uint8Array(await response.arrayBuffer());
  return {file,status:response.status,size:bytes.length,magic:String.fromCharCode(...bytes.slice(0,4))}
}))`);
if (resources.some((entry) => entry.status !== 200 || !["RIFF", "OggS"].includes(entry.magic) || entry.size < 1000)) throw new Error(`local assets failed: ${JSON.stringify(resources)}`);
const loaded = await evaluate(`(()=>({calls:window.__audioCalls.map(x=>({file:x.src.split('/').pop(),loop:x.loop,volume:x.volume})),sources:[...performance.getEntriesByType('resource')].map(x=>x.name).filter(x=>x.includes('/mahjong/audio/')).length,gameOpen:!!document.querySelector('.mg-riichi')}))()`);
if (!loaded.gameOpen || loaded.sources < 12 || !loaded.calls.some((entry) => entry.file === "bgm.ogg" && entry.loop)) throw new Error(`preload/BGM start failed: ${JSON.stringify(loaded)}`);

// Production view receives monotonically sequenced events. Re-running onUpdate must not replay them.
const effects = await evaluate(`(()=>{
  window.__audioCalls.length=0;const game=document.querySelector('.mg-riichi').__riichiGame;
  const emit=(type,call)=>{game.note(type,0,0,call);game.onUpdate()};
  emit('draw');emit('discard');emit('discard');emit('discard');emit('call','pon');emit('call','kan');emit('kan','ankan');emit('riichi');
  const beforeRepeat=window.__audioCalls.length;game.onUpdate();
  return {beforeRepeat,calls:window.__audioCalls.map(x=>({file:x.src.split('/').pop(),volume:x.volume}))};
})()`);
const effectFiles = effects.calls.map((entry) => entry.file);
for (const required of ["draw.ogg", "discard-1.wav", "discard-2.wav", "discard-3.wav", "pon.wav", "kan.wav", "riichi.ogg"]) if (!effectFiles.includes(required)) throw new Error(`missing event sound ${required}: ${JSON.stringify(effects)}`);
if (effects.calls.length !== effects.beforeRepeat || effects.calls.length !== 8) throw new Error(`effect replay mismatch: ${JSON.stringify(effects)}`);

const resultTransitions = [];
for (const fixture of [{ type:"win", seat:0, file:"result-victory.ogg" }, { type:"win", seat:1, file:"result-defeat.ogg" }, { type:"draw-end", seat:0, file:"result-draw.ogg" }]) {
  await evaluate(`(()=>{window.__audioCalls.length=0;const g=document.querySelector('.mg-riichi').__riichiGame;g.note('hand-start',0,0);g.onUpdate()})()`);
  await wait(550);
  await evaluate(`(()=>{const g=document.querySelector('.mg-riichi').__riichiGame;g.note(${JSON.stringify(fixture.type)},${fixture.seat},0);g.onUpdate()})()`);
  await wait(750);
  const transition = await evaluate(`window.__audioCalls.map(x=>({file:x.src.split('/').pop(),loop:x.loop,volume:x.volume}))`);
  if (!transition.some((entry) => entry.file === fixture.file)) throw new Error(`wrong result transition ${fixture.file}: ${JSON.stringify(transition)}`);
  resultTransitions.push({ fixture, transition });
}

// Rendered settings have independent persistent effect/music controls.
await evaluate(`(()=>{window.__audioCalls.length=0;const b=[...document.querySelectorAll('.mg-head-btns button')].find(x=>x.textContent.includes('音效'));b.click()})()`);
const panel = await evaluate(`(()=>{const p=document.querySelector('.mg-sound-panel');return {open:!!p,checks:[...p.querySelectorAll('input[type=checkbox]')].map(x=>x.checked),ranges:[...p.querySelectorAll('input[type=range]')].map(x=>x.value),help:p?.textContent}})()`);
if (!panel.open || panel.checks.join() !== "true,true" || panel.ranges.join() !== "30,18" || !panel.help.includes("对局与结算音乐")) throw new Error(`audio settings panel mismatch: ${JSON.stringify(panel)}`);
await evaluate(`(()=>{window.dispatchEvent(new Event('focus'));const [effects,music]=document.querySelectorAll('.mg-sound-panel input[type=range]');effects.value='45';effects.dispatchEvent(new Event('input',{bubbles:true}));effects.dispatchEvent(new Event('change',{bubbles:true}));music.value='12';music.dispatchEvent(new Event('input',{bubbles:true}));music.dispatchEvent(new Event('change',{bubbles:true}))})()`);
const persisted = await evaluate(`(()=>{const s=JSON.parse(localStorage.getItem('live2d-pet-settings'));return {effects:s.gameSoundVolume,music:s.gameMusicVolume,calls:window.__audioCalls.map(x=>x.src.split('/').pop())}})()`);
if (persisted.effects !== .45 || persisted.music !== .12) throw new Error(`persistence mismatch: ${JSON.stringify(persisted)}`);
const shot = await send("Page.captureScreenshot", { format:"png", fromSurface:true });
const screenshot = join(process.env.TEMP ?? process.cwd(), "petra-riichi-audio-settings.png");
await writeFile(screenshot, Buffer.from(shot.data, "base64"));
await send("Page.bringToFront");
await evaluate(`window.focus();window.dispatchEvent(new Event('focus'))`);

// Switches are independent: disabled effects do not stop music, disabled music does not stop effects.
await evaluate(`document.querySelectorAll('.mg-sound-panel input[type=checkbox]')[0].click()`);
const noEffect = await evaluate(`(()=>{window.dispatchEvent(new Event('focus'));window.__audioCalls.length=0;const g=document.querySelector('.mg-riichi').__riichiGame;g.note('draw',0,1);g.onUpdate();return window.__audioCalls.map(x=>x.src.split('/').pop())})()`);
await evaluate(`document.querySelectorAll('.mg-sound-panel input[type=checkbox]')[0].click()`);
await evaluate(`document.querySelectorAll('.mg-sound-panel input[type=checkbox]')[1].click()`);
const effectsWithoutMusic = await evaluate(`(()=>{window.dispatchEvent(new Event('focus'));window.__audioCalls.length=0;const g=document.querySelector('.mg-riichi').__riichiGame;g.note('draw',0,2);g.onUpdate();g.note('hand-start',0,0);g.onUpdate();return window.__audioCalls.map(x=>x.src.split('/').pop())})()`);
const independence = { noEffect, effectsWithoutMusic };
if (independence.noEffect.includes("draw.ogg") || !independence.effectsWithoutMusic.includes("draw.ogg") || independence.effectsWithoutMusic.includes("bgm.ogg")) throw new Error(`independent controls failed: ${JSON.stringify(independence)}`);

// Restore music, then blur suppresses effects and focus resumes without an effect backlog.
const focus = await evaluate(`(()=>{
  const musicBox=document.querySelectorAll('.mg-sound-panel input[type=checkbox]')[1];musicBox.click();window.__audioCalls.length=0;window.dispatchEvent(new Event('blur'));
  const g=document.querySelector('.mg-riichi').__riichiGame;g.note('discard',0,3);g.onUpdate();const whileBlurred=window.__audioCalls.map(x=>x.src.split('/').pop());window.dispatchEvent(new Event('focus'));
  return {whileBlurred,afterFocus:window.__audioCalls.map(x=>x.src.split('/').pop())};
})()`);
if (focus.whileBlurred.some((file) => file.startsWith("discard-"))) throw new Error(`blurred game played an effect: ${JSON.stringify(focus)}`);

await evaluate(`(()=>{window.__audioCalls.length=0;const close=[...document.querySelectorAll('.mg-head-btns button')].find(x=>x.textContent.includes('退出'));close.click()})()`);
const cleanup = await evaluate(`({closed:!document.querySelector('.mg-riichi'),pauses:window.__audioPauses.length,calls:window.__audioCalls.length})`);
if (!cleanup.closed || cleanup.pauses < 12) throw new Error(`unmount cleanup failed: ${JSON.stringify(cleanup)}`);

// Restore actual WebView media methods, then prove every file decodes, an effect ends, and BGM crosses a real loop boundary.
await evaluate(`window.__audioRestore()`);
const metadata = await evaluate(`Promise.all(${JSON.stringify(audioFiles)}.map(file=>new Promise(resolve=>{
  const a=new Audio('/mahjong/audio/'+file);const timer=setTimeout(()=>resolve({file,ok:false,reason:'metadata timeout'}),5000);
  a.addEventListener('loadedmetadata',()=>{clearTimeout(timer);resolve({file,ok:true,duration:a.duration})},{once:true});a.addEventListener('error',()=>{clearTimeout(timer);resolve({file,ok:false,reason:'decode error'})},{once:true});a.load();
})))`);
if (metadata.some((entry) => !entry.ok || !Number.isFinite(entry.duration) || entry.duration <= 0)) throw new Error(`WebView decode failed: ${JSON.stringify(metadata)}`);
const actualButton = await evaluate(`new Promise(resolve=>{const a=new Audio('/mahjong/audio/button.ogg');a.volume=.05;const timer=setTimeout(()=>resolve({ok:false,reason:'ended timeout'}),2500);a.addEventListener('ended',()=>{clearTimeout(timer);resolve({ok:true,duration:a.duration})},{once:true});a.play().catch(error=>{clearTimeout(timer);resolve({ok:false,reason:error.name+': '+error.message})})})`);
if (!actualButton.ok) throw new Error(`actual effect playback failed: ${JSON.stringify(actualButton)}`);
const actualLoop = await evaluate(`new Promise(resolve=>{
  const a=new Audio('/mahjong/audio/bgm.ogg');a.loop=true;a.volume=.01;let duration=0;const timer=setTimeout(()=>{a.pause();resolve({ok:false,reason:'loop timeout',duration,currentTime:a.currentTime})},3500);
  a.addEventListener('loadedmetadata',()=>{duration=a.duration;a.currentTime=Math.max(0,duration-.25);a.play().catch(error=>{clearTimeout(timer);resolve({ok:false,reason:error.name+': '+error.message,duration})})},{once:true});
  a.addEventListener('timeupdate',()=>{if(duration>0&&a.currentTime<.2){clearTimeout(timer);a.pause();resolve({ok:true,duration,currentTime:a.currentTime,crossed:true})}});a.load();
})`);
if (!actualLoop.ok || !actualLoop.crossed) throw new Error(`actual BGM loop failed: ${JSON.stringify(actualLoop)}`);

await evaluate(originalSettings === null ? `localStorage.removeItem('live2d-pet-settings')` : `localStorage.setItem('live2d-pet-settings',${JSON.stringify(originalSettings)})`);
console.log(JSON.stringify({ pass:true, resources, loaded, effects, resultTransitions, panel, persisted, independence, focus, cleanup, metadata, actualButton, actualLoop, screenshot }, null, 2));
ws.close();
