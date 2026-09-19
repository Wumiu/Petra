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
  value: JSON.stringify({ gameSound: true, gameSoundVolume: .3 }),
  getItem() { return this.value; },
  setItem(_key, value) { this.value = value; },
};
const doc = new EventTarget();
doc.hidden = false;
doc.hasFocus = () => true;
global.document = doc;
global.window = new EventTarget();

const { RiichiSoundController, soundNameForEvent } = require("./build/games/riichi/sound.js");

assert.equal(soundNameForEvent({ seq: 1, type: "draw" }), "draw");
assert.equal(soundNameForEvent({ seq: 1, type: "discard" }, 2), "discard-3");
assert.equal(soundNameForEvent({ seq: 1, type: "call", call: "pon" }), "pon");
assert.equal(soundNameForEvent({ seq: 1, type: "call", call: "kan" }), "kan");
assert.equal(soundNameForEvent({ seq: 1, type: "riichi" }), "riichi");
assert.equal(soundNameForEvent({ seq: 1, type: "win" }), "win");
assert.equal(soundNameForEvent({ seq: 1, type: "draw-end" }), "draw-end");
assert.equal(soundNameForEvent({ seq: 1, type: "turn" }), null);

(async () => {
  const controller = new RiichiSoundController();
  const byFile = (suffix) => FakeAudio.instances.find((audio) => audio.src.endsWith(suffix));
  controller.handleEvent({ seq: 1, type: "draw", seat: 0 });
  controller.handleEvent({ seq: 1, type: "draw", seat: 0 });
  await Promise.resolve();
  assert.equal(byFile("draw.wav").playCount, 1, "same event seq must not replay");

  controller.handleEvent({ seq: 2, type: "win", seat: 0 });
  await Promise.resolve();
  assert.equal(byFile("win.wav").playCount, 1);
  assert.equal(byFile("draw.wav").paused, true, "critical sound retires lower-priority sound");

  window.dispatchEvent(new Event("blur"));
  controller.handleEvent({ seq: 3, type: "draw", seat: 1 });
  await Promise.resolve();
  assert.equal(byFile("draw.wav").playCount, 1, "blurred game must suppress automatic sounds");

  window.dispatchEvent(new Event("focus"));
  controller.setEnabled(false);
  controller.handleEvent({ seq: 4, type: "draw-end" });
  await Promise.resolve();
  assert.equal(byFile("draw-end.wav").playCount, 0, "disabled sounds stay silent");

  controller.setEnabled(true);
  controller.setVolume(.4);
  controller.preview();
  await Promise.resolve();
  assert.equal(byFile("discard-1.wav").playCount, 1);
  assert.ok(Math.abs(byFile("discard-1.wav").volume - .288) < .0001, "user volume and relative gain combine");

  const discardOne = byFile("discard-1.wav");
  controller.dispose();
  assert.equal(discardOne.src, "", "dispose releases media sources");
  console.log("riichi sound tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
