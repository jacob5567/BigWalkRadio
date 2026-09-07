import { lowpassHz } from './tuner';

export type SyncMode = 'lock' | 'free';

export interface VoiceTarget {
  /** Stable identity for this stream. One station can have two during a handover. */
  key: string;
  stationId: string;
  trackId: string;
  /** Where the schedule says this track should be, in seconds. */
  offsetSec: number;
  gain: number;
  /** Single-track dayparts repeat seamlessly instead of being re-seeked. */
  loop: boolean;
  /**
   * 'lock' keeps the element pinned to the schedule (real time).
   * 'free' seeks only when the track changes, then lets it run at 1x — used
   * when the schedule is running faster than the audio.
   */
  sync: SyncMode;
}

interface Voice {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  trackId: string | null;
  /** Generation counter so a slow async src load can't clobber a newer one. */
  epoch: number;
  releasing: boolean;
}

/** Seconds of drift tolerated before we hard-seek back onto the schedule. */
const DRIFT_TOLERANCE = 0.4;
const RAMP = 0.08;
const RELEASE_MS = 400;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseGain: GainNode | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;
  private readonly voices = new Map<string, Voice>();
  private volume = 0.8;
  private running = false;

  /** Fired when a track ends, so the scheduler can hand us the next one at once. */
  onNeedsUpdate: (() => void) | null = null;

  constructor(private readonly resolveUrl: (trackId: string) => Promise<string | null>) {}

  get isRunning(): boolean {
    return this.running;
  }

  get contextState(): AudioContextState | 'closed' {
    return this.ctx?.state ?? 'closed';
  }

  /** Must be called from a user gesture (iOS requires it). */
  async start(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.buildNoise();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const id of [...this.voices.keys()]) this.release(id);
    this.setStaticGain(0);
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, RAMP);
    }
  }

  setStaticGain(level: number): void {
    if (!this.noiseGain || !this.ctx) return;
    const g = this.running ? Math.min(1, Math.max(0, level)) * 0.28 : 0;
    this.noiseGain.gain.setTargetAtTime(g, this.ctx.currentTime, RAMP);
  }

  /** Apply the current set of audible stations. Called on every scheduler tick. */
  update(targets: readonly VoiceTarget[]): void {
    if (!this.ctx || !this.running) return;
    const wanted = new Set(targets.map((t) => t.key));
    for (const id of [...this.voices.keys()]) {
      if (!wanted.has(id)) this.release(id);
    }
    for (const target of targets) void this.applyTarget(target);
  }

  private async applyTarget(target: VoiceTarget): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const voice = this.ensureVoice(target.key);
    voice.releasing = false;
    voice.el.loop = target.loop;

    voice.gain.gain.setTargetAtTime(target.gain, ctx.currentTime, RAMP);
    voice.filter.frequency.setTargetAtTime(lowpassHz(target.gain), ctx.currentTime, RAMP);

    if (voice.trackId !== target.trackId) {
      const epoch = ++voice.epoch;
      voice.trackId = target.trackId;
      const url = await this.resolveUrl(target.trackId);
      if (!url || voice.epoch !== epoch || !this.running) return;
      voice.el.src = url;
      voice.el.load();
      this.seek(voice, target.offsetSec);
      void voice.el.play().catch(() => {});
      return;
    }

    if (voice.el.paused && this.running) void voice.el.play().catch(() => {});
    if (target.sync === 'lock' && voice.el.readyState >= 1 && !voice.el.seeking) {
      if (Math.abs(voice.el.currentTime - target.offsetSec) > DRIFT_TOLERANCE) {
        this.seek(voice, target.offsetSec);
      }
    }
  }

  private seek(voice: Voice, offsetSec: number): void {
    const apply = () => {
      const limit = Number.isFinite(voice.el.duration) ? voice.el.duration - 0.05 : Infinity;
      try {
        voice.el.currentTime = Math.max(0, Math.min(offsetSec, limit));
      } catch {
        /* element not seekable yet; the next tick will retry */
      }
    };
    if (voice.el.readyState >= 1) apply();
    else voice.el.addEventListener('loadedmetadata', apply, { once: true });
  }

  private ensureVoice(key: string): Voice {
    const existing = this.voices.get(key);
    if (existing) return existing;
    const ctx = this.ctx!;

    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    // Keeps iOS from treating each station as a separate "now playing" item.
    el.setAttribute('playsinline', '');
    el.addEventListener('ended', () => this.onNeedsUpdate?.());

    const source = ctx.createMediaElementSource(el);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);

    const voice: Voice = { el, source, filter, gain, trackId: null, epoch: 0, releasing: false };
    this.voices.set(key, voice);
    return voice;
  }

  private release(key: string): void {
    const voice = this.voices.get(key);
    if (!voice || voice.releasing) return;
    voice.releasing = true;
    voice.epoch++;
    if (this.ctx) voice.gain.gain.setTargetAtTime(0, this.ctx.currentTime, RAMP);
    setTimeout(() => {
      if (!voice.releasing) return;
      voice.el.pause();
      voice.el.removeAttribute('src');
      voice.el.load();
      voice.source.disconnect();
      voice.filter.disconnect();
      voice.gain.disconnect();
      this.voices.delete(key);
    }, RELEASE_MS);
  }

  private buildNoise(): void {
    const ctx = this.ctx!;
    const seconds = 2;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Slightly filtered white noise reads as FM hiss rather than a hard buzz.
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = 0.7 * last + 0.3 * white;
      data[i] = last * 1.4;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400;
    band.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(band);
    band.connect(gain);
    gain.connect(this.master!);
    source.start();

    this.noiseSource = source;
    this.noiseGain = gain;
  }

  dispose(): void {
    for (const id of [...this.voices.keys()]) this.release(id);
    this.noiseSource?.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.running = false;
  }
}
