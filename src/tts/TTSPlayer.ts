/**
 * TTS 播放队列 - 调用豆包声音复刻 API
 * 断句 → 预加载 → 顺序播放
 */

import { invoke } from "@tauri-apps/api/core";

class TTSPlayer {
  private enabled = false;
  private apiKey = "";
  private speakerId = "";
  private language = "";
  private queue: { text: string; audio: HTMLAudioElement | null; ready: boolean; blobUrl: string | null }[] = [];
  private speaking = false;
  private buffer = "";
  private stopped = false;
  private idleCallbacks: (() => void)[] = [];

  onIdle(cb: () => void) { this.idleCallbacks.push(cb); }

  setConfig(enabled: boolean, apiKey: string, speakerId: string, language = "") {
    this.enabled = enabled;
    this.apiKey = apiKey;
    this.speakerId = speakerId;
    this.language = language;
    if (!enabled) this.stop();
  }

  pushDelta(delta: string) {
    if (!this.enabled || !this.apiKey || !this.speakerId) return;
    if (this.stopped) return;
    this.buffer += delta;
    // 检测到翻译分隔符，后面的内容不读
    if (this.buffer.includes("\n---")) {
      this.buffer = this.buffer.split("\n---")[0];
      this.stopped = true;
    }
    const sentence = this.extractSentence();
    if (sentence) this.enqueue(sentence);
  }

  flush() {
    if (!this.enabled) return;
    if (!this.stopped) {
      const rest = this.buffer.trim();
      if (rest) this.enqueue(rest);
    }
    this.buffer = "";
    this.stopped = false;
  }

  stop() {
    this.queue = [];
    this.buffer = "";
    this.speaking = false;
    this.stopped = false;
    const current = document.querySelector<HTMLAudioElement>("audio.tts-current");
    current?.pause();
  }

  private extractSentence(): string | null {
    this.buffer = this.buffer.replace(/^\n+/, "");
    const match = /^(.{2,}?[。！？!?；;…])/s.exec(this.buffer);
    if (!match) return null;
    const sentence = match[1];
    this.buffer = this.buffer.slice(sentence.length);
    return sentence;
  }

  private enqueue(text: string) {
    let clean = text
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[*_`#~|]/g, "")
      .replace(/\n---\n[\s\S]*$/, "")
      .trim();
    if (!clean || clean.length < 2) return;
    const item = { text: clean, audio: null as HTMLAudioElement | null, ready: false, blobUrl: null as string | null };
    this.queue.push(item);
    this.preload(item);
    this.pump();
  }

  private async preload(item: { text: string; audio: HTMLAudioElement | null; ready: boolean; blobUrl: string | null }) {
    try {
      const base64 = await invoke<string>("tts_synthesize", {
        apiKey: this.apiKey,
        speaker: this.speakerId,
        text: item.text,
        language: this.language || undefined,
      });
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/mp3" });
      item.blobUrl = URL.createObjectURL(blob);
      item.audio = new Audio(item.blobUrl);
      item.ready = true;
      if (!this.speaking) this.pump();
    } catch (e) {
      console.warn("[TTS] failed:", e);
      item.ready = true;
    }
  }

  private pump() {
    if (this.speaking || !this.enabled) return;
    const idx = this.queue.findIndex(i => i.ready);
    if (idx === -1) {
      if (this.queue.length === 0 && this.idleCallbacks.length > 0) {
        const cbs = this.idleCallbacks;
        this.idleCallbacks = [];
        cbs.forEach(cb => cb());
      }
      return;
    }
    const next = this.queue.splice(idx, 1)[0];
    if (!next.audio) { this.speaking = false; this.pump(); return; }
    this.speaking = true;
    next.audio.onended = () => { this.speaking = false; this.pump(); };
    next.audio.onerror = () => { this.speaking = false; this.pump(); };
    next.audio.play().catch(() => { this.speaking = false; this.pump(); });
  }
}

export const ttsPlayer = new TTSPlayer();
(window as any).ttsPlayer = ttsPlayer;
