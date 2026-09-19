import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SAMPLE_RATE = 22_050;
const OUTPUT = resolve("public/mahjong/sfx");

function seededNoise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

function envelope(time, duration, attack = .002, release = .018) {
  return Math.min(1, time / attack, (duration - time) / release);
}

function impact(time, start, strength, tone, decay, noise) {
  const t = time - start;
  if (t < 0) return 0;
  const body = Math.sin(2 * Math.PI * tone * t) * Math.exp(-t * decay);
  const click = noise() * Math.exp(-t * decay * 2.8);
  return strength * (body * .62 + click * .38);
}

async function render(name, duration, seed, synth) {
  const count = Math.ceil(duration * SAMPLE_RATE);
  const samples = new Float32Array(count);
  const noise = seededNoise(seed);
  let peak = .0001;
  for (let i = 0; i < count; i++) {
    const time = i / SAMPLE_RATE;
    const value = synth(time, noise) * Math.max(0, envelope(time, duration));
    samples[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }
  const gain = .68 / peak;
  const pcmBytes = count * 2;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBytes, 40);
  for (let i = 0; i < count; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] * gain));
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  await mkdir(dirname(resolve(OUTPUT, name)), { recursive: true });
  await writeFile(resolve(OUTPUT, name), wav);
}

const jobs = [
  render("draw.wav", .12, 11, (t, n) => {
    const slide = n() * Math.exp(-t * 18) * .18;
    return slide + Math.sin(2 * Math.PI * 520 * t) * Math.exp(-t * 31) * .12;
  }),
  ...[
    ["discard-1.wav", 631, 780, 29],
    ["discard-2.wav", 947, 720, 27],
    ["discard-3.wav", 1291, 835, 31],
  ].map(([name, seed, tone, decay]) => render(name, .105, seed, (t, n) =>
    impact(t, 0, .78, tone, decay, n) + impact(t, .012, .22, tone * .62, decay * .8, n))),
  render("pon.wav", .18, 2027, (t, n) =>
    impact(t, 0, .66, 560, 22, n) + impact(t, .058, .58, 610, 24, n)),
  render("kan.wav", .235, 4093, (t, n) =>
    impact(t, 0, .58, 390, 18, n) + impact(t, .052, .55, 460, 20, n) + impact(t, .108, .62, 520, 22, n)),
  render("riichi.wav", .32, 6151, (t, n) => {
    const stick = impact(t, 0, .58, 760, 30, n);
    const chimeT = t - .055;
    const chime = chimeT < 0 ? 0 : (Math.sin(2 * Math.PI * 660 * chimeT) + .45 * Math.sin(2 * Math.PI * 990 * chimeT)) * Math.exp(-chimeT * 9) * .24;
    return stick + chime;
  }),
  render("win.wav", .56, 8191, (t) => {
    const notes = [[0, 523.25], [.105, 659.25], [.21, 783.99]];
    return notes.reduce((sum, [start, hz]) => {
      const nt = t - start;
      return sum + (nt < 0 ? 0 : Math.sin(2 * Math.PI * hz * nt) * Math.exp(-nt * 5.8) * .32);
    }, 0);
  }),
  render("draw-end.wav", .48, 12289, (t) => {
    const notes = [[0, 659.25], [.12, 523.25], [.24, 392]];
    return notes.reduce((sum, [start, hz]) => {
      const nt = t - start;
      return sum + (nt < 0 ? 0 : Math.sin(2 * Math.PI * hz * nt) * Math.exp(-nt * 7.2) * .25);
    }, 0);
  }),
  render("button.wav", .055, 16381, (t, n) =>
    impact(t, 0, .42, 980, 43, n) + Math.sin(2 * Math.PI * 1320 * t) * Math.exp(-t * 52) * .08),
];

await Promise.all(jobs);
console.log(`Generated ${jobs.length} local WAV files in ${OUTPUT}`);
