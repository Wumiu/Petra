const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

class FakeAudio extends EventTarget {
  static instances = [];
  constructor(src) {
    super();
    this.src = src;
    this.currentTime = 0;
    this.volume = 1;
    this.paused = true;
    this.loop = false;
    this.playCount = 0;
    FakeAudio.instances.push(this);
  }
  load() {}
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
  async play() { this.paused = false; this.playCount++; }
}

global.Audio = FakeAudio;
global.crypto = webcrypto;
global.localStorage = {
  value: JSON.stringify({ gameSound: true, gameSoundVolume: .3, gameMusic: true, gameMusicVolume: .18 }),
  getItem() { return this.value; },
  setItem(_key, value) { this.value = value; },
};
const doc = new EventTarget();
doc.hidden = false;
doc.hasFocus = () => true;
global.document = doc;
global.window = new EventTarget();
global.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 5);
global.cancelAnimationFrame = clearTimeout;

const { RiichiSoundController, soundNameForEvent, musicNameForEvent } = require("./build/games/riichi/sound.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(soundNameForEvent({ seq: 1, type: "draw" }), "draw");
assert.equal(soundNameForEvent({ seq: 1, type: "discard" }, 2), "discard-3");
assert.equal(soundNameForEvent({ seq: 1, type: "call", call: "pon" }), "pon");
assert.equal(soundNameForEvent({ seq: 1, type: "call", call: "kan" }), "kan");
assert.equal(soundNameForEvent({ seq: 1, type: "riichi" }), "riichi");
assert.equal(soundNameForEvent({ seq: 1, type: "win", seat: 0 }), null);
assert.equal(musicNameForEvent({ seq: 1, type: "hand-start" }), "bgm");
assert.equal(musicNameForEvent({ seq: 1, type: "win", seat: 0 }), "result-victory");
assert.equal(musicNameForEvent({ seq: 1, type: "win", seat: 1 }), "result-defeat");
assert.equal(musicNameForEvent({ seq: 1, type: "draw-end" }), "result-draw");

(async () => {
  const controller = new RiichiSoundController();
  const byFile = (suffix) => FakeAudio.instances.find((audio) => audio.src.endsWith(suffix));

  controller.handleEvent({ seq: 1, type: "hand-start" });
  controller.handleEvent({ seq: 1, type: "hand-start" });
  await wait(450);
  assert.equal(byFile("bgm.ogg").playCount, 1, "same event seq must not restart BGM");
  assert.equal(byFile("bgm.ogg").loop, true);
  controller.setMusicEnabled(true);
  assert.equal(byFile("bgm.ogg").playCount, 1, "saving unrelated settings must not restart active music");

  controller.handleEvent({ seq: 2, type: "draw", seat: 0 });
  controller.handleEvent({ seq: 2, type: "draw", seat: 0 });
  await Promise.resolve();
  assert.equal(byFile("draw.ogg").playCount, 1, "same event seq must not replay effect");

  controller.handleEvent({ seq: 3, type: "win", seat: 0 });
  await wait(700);
  assert.equal(byFile("result-victory.ogg").playCount, 1, "player win selects victory music");
  assert.equal(byFile("bgm.ogg").paused, true, "result retires table BGM");

  controller.setMusicEnabled(false);
  assert.equal(byFile("result-victory.ogg").paused, true, "music switch stops result music immediately");
  controller.setMusicEnabled(true);
  await Promise.resolve();
  assert.equal(byFile("result-victory.ogg").playCount, 2, "re-enabling music on results resumes the applicable result cue");

  controller.handleEvent({ seq: 4, type: "hand-start" });
  await wait(700);
  assert.equal(byFile("bgm.ogg").playCount, 2, "next hand restores table BGM");

  controller.setEnabled(false);
  controller.handleEvent({ seq: 5, type: "discard", seat: 0 });
  await Promise.resolve();
  assert.equal(FakeAudio.instances.filter((audio) => /discard-\d\.wav$/.test(audio.src)).reduce((n, audio) => n + audio.playCount, 0), 0, "effect switch is independent");
  assert.equal(byFile("bgm.ogg").paused, false, "disabling effects does not stop music");

  controller.setMusicEnabled(false);
  assert.equal(byFile("bgm.ogg").paused, true);
  controller.setEnabled(true);
  controller.handleEvent({ seq: 6, type: "draw", seat: 0 });
  await Promise.resolve();
  assert.equal(byFile("draw.ogg").playCount, 2, "disabling music does not stop effects");

  controller.setMusicEnabled(true);
  await Promise.resolve();
  window.dispatchEvent(new Event("blur"));
  const beforeBlur = byFile("draw.ogg").playCount;
  controller.handleEvent({ seq: 7, type: "draw", seat: 1 });
  await Promise.resolve();
  assert.equal(byFile("draw.ogg").playCount, beforeBlur, "blur suppresses automatic effects");
  window.dispatchEvent(new Event("focus"));
  assert.equal(byFile("bgm.ogg").paused, false, "focus resumes the current BGM without a new instance");

  controller.setVolume(.4);
  controller.preview();
  await Promise.resolve();
  assert.ok(Math.abs(byFile("discard-1.wav").volume - .256) < .0001, "effect volume uses per-asset gain");

  const bgm = byFile("bgm.ogg");
  controller.dispose();
  assert.equal(bgm.src, "", "dispose releases music and effect sources");
  console.log("riichi sound and music tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
