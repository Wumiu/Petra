import { loadSettings } from "../../utils/settings";
import type { GameEvent } from "./engine";

const BASE = "/mahjong/sfx/";
export const RIICHI_SOUND_SETTINGS_EVENT = "petra:riichi-sound-settings";

type SoundName = "draw" | "discard-1" | "discard-2" | "discard-3" | "pon" | "kan" | "riichi" | "win" | "draw-end" | "button";

interface SoundSpec {
  file: string;
  gain: number;
  priority: number;
}

const SPECS: Record<SoundName, SoundSpec> = {
  draw: { file: "draw.wav", gain: .52, priority: 1 },
  "discard-1": { file: "discard-1.wav", gain: .72, priority: 1 },
  "discard-2": { file: "discard-2.wav", gain: .72, priority: 1 },
  "discard-3": { file: "discard-3.wav", gain: .72, priority: 1 },
  pon: { file: "pon.wav", gain: .8, priority: 2 },
  kan: { file: "kan.wav", gain: .84, priority: 2 },
  riichi: { file: "riichi.wav", gain: .82, priority: 3 },
  win: { file: "win.wav", gain: .9, priority: 4 },
  "draw-end": { file: "draw-end.wav", gain: .72, priority: 3 },
  button: { file: "button.wav", gain: .42, priority: 0 },
};

export function soundNameForEvent(event: GameEvent, discardVariant = 0): SoundName | null {
  if (event.type === "draw") return "draw";
  if (event.type === "discard") return `discard-${discardVariant % 3 + 1}` as SoundName;
  if (event.type === "riichi") return "riichi";
  if (event.type === "call") return event.call === "kan" ? "kan" : "pon";
  if (event.type === "kan") return "kan";
  if (event.type === "win") return "win";
  if (event.type === "draw-end") return "draw-end";
  return null;
}

export class RiichiSoundController {
  private readonly players = new Map<SoundName, HTMLAudioElement>();
  private readonly active = new Map<HTMLAudioElement, number>();
  private readonly failed = new Set<SoundName>();
  private enabled = true;
  private volume = .3;
  private ducked = false;
  private foreground = !document.hidden && document.hasFocus();
  private lastEventSeq = 0;
  private discardVariant = 0;
  private disposed = false;

  constructor() {
    const settings = loadSettings();
    this.enabled = settings.gameSound;
    this.volume = settings.gameSoundVolume;
    const seed = new Uint32Array(1);
    crypto.getRandomValues(seed);
    this.discardVariant = seed[0] % 3;
    for (const [name, spec] of Object.entries(SPECS) as Array<[SoundName, SoundSpec]>) {
      const audio = new Audio(BASE + spec.file);
      audio.preload = "auto";
      audio.addEventListener("ended", () => this.active.delete(audio));
      audio.addEventListener("error", () => this.noteFailure(name), { once: true });
      audio.load();
      this.players.set(name, audio);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener(RIICHI_SOUND_SETTINGS_EVENT, this.onSettingsChange);
  }

  get settings(): Readonly<{ enabled: boolean; volume: number }> {
    return { enabled: this.enabled, volume: this.volume };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stopAll();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : .3));
    for (const [name, audio] of this.players) audio.volume = this.effectiveVolume(name);
  }

  /** 供未来语音播放器在说话期间压低游戏声；当前项目尚无 TTS 播放通道。 */
  setDucked(ducked: boolean): void {
    this.ducked = ducked;
    for (const [name, audio] of this.players) audio.volume = this.effectiveVolume(name);
  }

  handleEvent(event: GameEvent): void {
    if (event.seq <= this.lastEventSeq) return;
    this.lastEventSeq = event.seq;
    const name = soundNameForEvent(event, this.discardVariant);
    if (event.type === "discard") this.discardVariant = (this.discardVariant + 1) % 3;
    if (name) void this.play(name);
  }

  playButton(): void {
    void this.play("button");
  }

  preview(): void {
    void this.play("discard-1");
  }

  stopAll(): void {
    for (const audio of this.players.values()) {
      audio.pause();
      try { audio.currentTime = 0; } catch { /* 尚未载入时无须处理 */ }
    }
    this.active.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener(RIICHI_SOUND_SETTINGS_EVENT, this.onSettingsChange);
    for (const audio of this.players.values()) {
      audio.removeAttribute("src");
      audio.load();
    }
    this.players.clear();
  }

  private effectiveVolume(name: SoundName): number {
    return Math.max(0, Math.min(1, this.volume * SPECS[name].gain * (this.ducked ? .32 : 1)));
  }

  private async play(name: SoundName): Promise<void> {
    if (this.disposed || !this.enabled || this.volume <= 0 || this.failed.has(name)) return;
    if (!this.foreground) return;
    const audio = this.players.get(name);
    if (!audio) return;
    const priority = SPECS[name].priority;
    if (priority >= 2) {
      for (const [playing, activePriority] of this.active) {
        if (activePriority >= priority) continue;
        playing.pause();
        try { playing.currentTime = 0; } catch { /* ignore */ }
        this.active.delete(playing);
      }
    }
    if (this.active.size >= 4 && priority < 3) return;
    audio.pause();
    try { audio.currentTime = 0; } catch { /* ignore */ }
    audio.volume = this.effectiveVolume(name);
    this.active.set(audio, priority);
    try {
      await audio.play();
    } catch {
      this.active.delete(audio);
      // WebView 可能在首次用户手势前拒绝播放；不永久禁用素材，后续手势仍可重试。
    }
  }

  private noteFailure(name: SoundName): void {
    if (this.disposed || this.failed.has(name)) return;
    this.failed.add(name);
    console.warn(`[riichi-sfx] disabled unavailable local sound: ${SPECS[name].file}`);
  }

  private readonly onVisibility = () => {
    this.foreground = !document.hidden && document.hasFocus();
    if (!this.foreground) this.stopAll();
  };

  private readonly onBlur = () => {
    this.foreground = false;
    this.stopAll();
  };

  private readonly onFocus = () => {
    this.foreground = !document.hidden;
  };

  private readonly onSettingsChange = () => {
    const settings = loadSettings();
    this.setEnabled(settings.gameSound);
    this.setVolume(settings.gameSoundVolume);
  };
}
