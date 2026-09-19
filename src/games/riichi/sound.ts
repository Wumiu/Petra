import { loadSettings } from "../../utils/settings";
import type { GameEvent } from "./engine";

const BASE = "/mahjong/audio/";
export const RIICHI_SOUND_SETTINGS_EVENT = "petra:riichi-sound-settings";

type EffectName = "draw" | "discard-1" | "discard-2" | "discard-3" | "pon" | "kan" | "riichi" | "button";
type MusicName = "bgm" | "result-victory" | "result-defeat" | "result-draw";
type AudioName = EffectName | MusicName;

interface EffectSpec { file: string; gain: number; priority: number; }
interface MusicSpec { file: string; gain: number; loop: boolean; }

const EFFECTS: Record<EffectName, EffectSpec> = {
  draw: { file: "draw.ogg", gain: .52, priority: 1 },
  "discard-1": { file: "discard-1.wav", gain: .64, priority: 1 },
  "discard-2": { file: "discard-2.wav", gain: .64, priority: 1 },
  "discard-3": { file: "discard-3.wav", gain: .64, priority: 1 },
  pon: { file: "pon.wav", gain: .68, priority: 2 },
  kan: { file: "kan.wav", gain: .62, priority: 2 },
  riichi: { file: "riichi.ogg", gain: .58, priority: 3 },
  button: { file: "button.ogg", gain: .4, priority: 0 },
};

const MUSIC: Record<MusicName, MusicSpec> = {
  bgm: { file: "bgm.ogg", gain: .72, loop: true },
  "result-victory": { file: "result-victory.ogg", gain: .82, loop: false },
  "result-defeat": { file: "result-defeat.ogg", gain: .76, loop: false },
  "result-draw": { file: "result-draw.ogg", gain: .68, loop: false },
};

export function soundNameForEvent(event: GameEvent, discardVariant = 0): EffectName | null {
  if (event.type === "draw") return "draw";
  if (event.type === "discard") return `discard-${discardVariant % 3 + 1}` as EffectName;
  if (event.type === "riichi") return "riichi";
  if (event.type === "call") return event.call === "kan" ? "kan" : "pon";
  if (event.type === "kan") return "kan";
  return null;
}

export function musicNameForEvent(event: GameEvent): MusicName | null {
  if (event.type === "hand-start") return "bgm";
  if (event.type === "win") return event.seat === 0 ? "result-victory" : "result-defeat";
  if (event.type === "draw-end") return "result-draw";
  return null;
}

export class RiichiSoundController {
  private readonly effects = new Map<EffectName, HTMLAudioElement>();
  private readonly music = new Map<MusicName, HTMLAudioElement>();
  private readonly activeEffects = new Map<HTMLAudioElement, number>();
  private readonly failed = new Set<AudioName>();
  private readonly fadeTimers = new Map<HTMLAudioElement, number>();
  private effectsEnabled = true;
  private effectsVolume = .3;
  private musicEnabled = true;
  private musicVolume = .18;
  private ducked = false;
  private foreground = !document.hidden && document.hasFocus();
  private lastEventSeq = 0;
  private discardVariant = 0;
  private currentMusic: MusicName | null = null;
  private desiredMusic: MusicName | null = null;
  private inHand = false;
  private pausedForBackground = false;
  private musicEpoch = 0;
  private disposed = false;

  constructor() {
    const settings = loadSettings();
    this.effectsEnabled = settings.gameSound;
    this.effectsVolume = settings.gameSoundVolume;
    this.musicEnabled = settings.gameMusic;
    this.musicVolume = settings.gameMusicVolume;
    const seed = new Uint32Array(1);
    crypto.getRandomValues(seed);
    this.discardVariant = seed[0] % 3;
    for (const [name, spec] of Object.entries(EFFECTS) as Array<[EffectName, EffectSpec]>) {
      const audio = this.createAudio(name, spec.file);
      audio.addEventListener("ended", () => this.activeEffects.delete(audio));
      this.effects.set(name, audio);
    }
    for (const [name, spec] of Object.entries(MUSIC) as Array<[MusicName, MusicSpec]>) {
      const audio = this.createAudio(name, spec.file);
      audio.loop = spec.loop;
      audio.addEventListener("ended", () => {
        if (this.currentMusic !== name || spec.loop) return;
        this.currentMusic = null;
        this.desiredMusic = null;
      });
      this.music.set(name, audio);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener(RIICHI_SOUND_SETTINGS_EVENT, this.onSettingsChange);
  }

  get settings(): Readonly<{ enabled: boolean; volume: number; musicEnabled: boolean; musicVolume: number }> {
    return { enabled: this.effectsEnabled, volume: this.effectsVolume, musicEnabled: this.musicEnabled, musicVolume: this.musicVolume };
  }

  setEnabled(enabled: boolean): void {
    this.effectsEnabled = enabled;
    if (!enabled) this.stopEffects();
  }

  setVolume(volume: number): void {
    this.effectsVolume = this.clampVolume(volume, .3);
    for (const [name, audio] of this.effects) audio.volume = this.effectVolume(name);
  }

  setMusicEnabled(enabled: boolean): void {
    if (this.musicEnabled === enabled) return;
    this.musicEnabled = enabled;
    if (!enabled) {
      const resumeTarget = this.desiredMusic ?? (this.inHand ? "bgm" : null);
      this.stopMusic(true);
      this.desiredMusic = resumeTarget;
    } else {
      const resumeTarget = this.desiredMusic ?? (this.inHand ? "bgm" : null);
      if (resumeTarget) this.startMusic(resumeTarget, 300);
    }
  }

  setMusicVolume(volume: number): void {
    this.musicVolume = this.clampVolume(volume, .18);
    if (this.currentMusic) {
      const audio = this.music.get(this.currentMusic);
      if (audio && !this.fadeTimers.has(audio)) audio.volume = this.musicTargetVolume(this.currentMusic);
    }
  }

  /** 供未来语音播放器压低麻将音频；当前项目尚无 TTS 播放通道。 */
  setDucked(ducked: boolean): void {
    this.ducked = ducked;
    for (const [name, audio] of this.effects) audio.volume = this.effectVolume(name);
    if (this.currentMusic) {
      const audio = this.music.get(this.currentMusic);
      if (audio && !this.fadeTimers.has(audio)) audio.volume = this.musicTargetVolume(this.currentMusic);
    }
  }

  handleEvent(event: GameEvent): void {
    if (event.seq <= this.lastEventSeq) return;
    this.lastEventSeq = event.seq;
    const musicName = musicNameForEvent(event);
    if (musicName === "bgm") {
      this.inHand = true;
      this.startMusic("bgm", 500);
    } else if (musicName) {
      this.inHand = false;
      this.stopEffects();
      this.startMusic(musicName, 260);
    } else {
      const effectName = soundNameForEvent(event, this.discardVariant);
      if (event.type === "discard") this.discardVariant = (this.discardVariant + 1) % 3;
      if (effectName) void this.playEffect(effectName);
    }
  }

  /** 用户手势到来时重试曾被 WebView 自动播放策略拦下的当前音乐。 */
  resumeForGesture(): void {
    if (!this.foreground || !this.musicEnabled || !this.desiredMusic) return;
    const audio = this.music.get(this.desiredMusic);
    if (!audio?.paused) return;
    this.currentMusic = this.desiredMusic;
    audio.volume = this.musicTargetVolume(this.desiredMusic);
    void audio.play().catch(() => undefined);
  }

  playButton(): void { void this.playEffect("button"); }
  preview(): void { void this.playEffect("discard-1"); }

  stopAll(): void {
    this.stopEffects();
    this.stopMusic(true);
    this.desiredMusic = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener(RIICHI_SOUND_SETTINGS_EVENT, this.onSettingsChange);
    for (const audio of [...this.effects.values(), ...this.music.values()]) {
      audio.removeAttribute("src");
      audio.load();
    }
    this.effects.clear();
    this.music.clear();
  }

  private createAudio(name: AudioName, file: string): HTMLAudioElement {
    const audio = new Audio(BASE + file);
    audio.preload = name === "bgm" ? "metadata" : "auto";
    audio.addEventListener("error", () => this.noteFailure(name), { once: true });
    audio.load();
    return audio;
  }

  private clampVolume(value: number, fallback: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : fallback));
  }

  private effectVolume(name: EffectName): number {
    return this.clampVolume(this.effectsVolume * EFFECTS[name].gain * (this.ducked ? .32 : 1), 0);
  }

  private musicTargetVolume(name: MusicName): number {
    return this.clampVolume(this.musicVolume * MUSIC[name].gain * (this.ducked ? .45 : 1), 0);
  }

  private async playEffect(name: EffectName): Promise<void> {
    if (this.disposed || !this.effectsEnabled || this.effectsVolume <= 0 || this.failed.has(name) || !this.foreground) return;
    const audio = this.effects.get(name);
    if (!audio) return;
    const priority = EFFECTS[name].priority;
    if (priority >= 2) {
      for (const [playing, activePriority] of this.activeEffects) {
        if (activePriority >= priority) continue;
        this.stopAudio(playing, true);
        this.activeEffects.delete(playing);
      }
    }
    if (this.activeEffects.size >= 4 && priority < 3) return;
    this.stopAudio(audio, true);
    audio.volume = this.effectVolume(name);
    this.activeEffects.set(audio, priority);
    try {
      await audio.play();
    } catch {
      this.activeEffects.delete(audio);
    }
  }

  private startMusic(name: MusicName, fadeOutMs: number): void {
    this.desiredMusic = name;
    if (!this.musicEnabled || this.musicVolume <= 0 || !this.foreground || this.failed.has(name)) return;
    if (this.currentMusic === name) {
      const current = this.music.get(name);
      if (current?.paused) void current.play().catch(() => undefined);
      return;
    }
    const epoch = ++this.musicEpoch;
    const previousName = this.currentMusic;
    const begin = () => {
      if (this.disposed || epoch !== this.musicEpoch || this.desiredMusic !== name || !this.musicEnabled || !this.foreground) return;
      const next = this.music.get(name);
      if (!next) return;
      this.currentMusic = name;
      this.pausedForBackground = false;
      next.loop = MUSIC[name].loop;
      try { next.currentTime = 0; } catch { /* metadata may not be ready yet */ }
      next.volume = 0;
      void next.play().then(() => this.fade(next, this.musicTargetVolume(name), 420)).catch(() => undefined);
    };
    if (!previousName) {
      begin();
      return;
    }
    const previous = this.music.get(previousName);
    if (!previous) {
      begin();
      return;
    }
    this.fade(previous, 0, fadeOutMs, () => {
      this.stopAudio(previous, true);
      if (this.currentMusic === previousName) this.currentMusic = null;
      begin();
    });
  }

  private fade(audio: HTMLAudioElement, target: number, durationMs: number, done?: () => void): void {
    this.cancelFade(audio);
    if (durationMs <= 0) {
      audio.volume = target;
      done?.();
      return;
    }
    const start = performance.now();
    const from = audio.volume;
    const tick = (now: number) => {
      if (this.disposed) return;
      const progress = Math.min(1, (now - start) / durationMs);
      audio.volume = from + (target - from) * progress;
      if (progress >= 1) {
        this.fadeTimers.delete(audio);
        done?.();
        return;
      }
      this.fadeTimers.set(audio, requestAnimationFrame(tick));
    };
    this.fadeTimers.set(audio, requestAnimationFrame(tick));
  }

  private cancelFade(audio: HTMLAudioElement): void {
    const timer = this.fadeTimers.get(audio);
    if (timer !== undefined) cancelAnimationFrame(timer);
    this.fadeTimers.delete(audio);
  }

  private stopEffects(): void {
    for (const audio of this.effects.values()) this.stopAudio(audio, true);
    this.activeEffects.clear();
  }

  private stopMusic(reset: boolean): void {
    this.musicEpoch++;
    for (const audio of this.music.values()) {
      this.cancelFade(audio);
      this.stopAudio(audio, reset);
    }
    this.currentMusic = null;
    this.pausedForBackground = false;
  }

  private stopAudio(audio: HTMLAudioElement, reset: boolean): void {
    audio.pause();
    if (!reset) return;
    try { audio.currentTime = 0; } catch { /* 尚未载入时无需处理 */ }
  }

  private noteFailure(name: AudioName): void {
    if (this.disposed || this.failed.has(name)) return;
    this.failed.add(name);
    const file = name in EFFECTS ? EFFECTS[name as EffectName].file : MUSIC[name as MusicName].file;
    console.warn(`[riichi-audio] disabled unavailable local audio: ${file}`);
  }

  private suspendForBackground(): void {
    this.foreground = false;
    this.stopEffects();
    if (!this.currentMusic) return;
    const audio = this.music.get(this.currentMusic);
    if (!audio || audio.paused) return;
    this.cancelFade(audio);
    audio.pause();
    this.pausedForBackground = true;
  }

  private readonly onVisibility = () => {
    this.foreground = !document.hidden && document.hasFocus();
    if (!this.foreground) this.suspendForBackground();
  };

  private readonly onBlur = () => this.suspendForBackground();

  private readonly onFocus = () => {
    this.foreground = !document.hidden;
    if (!this.foreground || !this.pausedForBackground || !this.currentMusic || !this.musicEnabled) return;
    const audio = this.music.get(this.currentMusic);
    if (!audio) return;
    this.pausedForBackground = false;
    audio.volume = this.musicTargetVolume(this.currentMusic);
    void audio.play().catch(() => undefined);
  };

  private readonly onSettingsChange = () => {
    const settings = loadSettings();
    this.setEnabled(settings.gameSound);
    this.setVolume(settings.gameSoundVolume);
    this.setMusicVolume(settings.gameMusicVolume);
    this.setMusicEnabled(settings.gameMusic);
  };
}
