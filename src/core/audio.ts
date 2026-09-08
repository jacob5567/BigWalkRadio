import { SoundBank, type SfxAction } from './sounds';

export type SyncMode = 'lock' | 'free';

export interface VoiceTarget {
  /** Stable identity for this stream. One station can have two during a handover. */
  key: string;
  stationId: string;
  trackId: string;
  /** Where the schedule says this track should be, in seconds. */
  offsetSec: number;
  gain: number;
  /**
   * False for a stream that is only being got ready: it is loaded and cued at
   * `offsetSec`, but held paused until its moment comes.
   */
  playing: boolean;
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
  gain: GainNode;
  trackId: string | null;
  /** Generation counter so a slow async src load can't clobber a newer one. */
  epoch: number;
  releasing: boolean;
  started: boolean;
}

/** Seconds of drift tolerated before we hard-seek back onto the schedule. */
const DRIFT_TOLERANCE = 0.4;
const RAMP = 0.08;
const RELEASE_MS = 400;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly sounds = new SoundBank();
  private readonly voices = new Map<string, Voice>();
  private volume = 0.8;
  private running = false;
  private readonly failed = new Set<string>();

  /** Fired when a track ends, so the scheduler can hand us the next one at once. */
  onNeedsUpdate: (() => void) | null = null;

  constructor(private readonly resolveUrl: (trackId: string) => string | null) {}

  get isRunning(): boolean {
    return this.running;
  }

  get contextState(): AudioContextState | 'closed' {
    return this.ctx?.state ?? 'closed';
  }

  /** Tracks whose file could not be loaded from the server. */
  get failedTrackIds(): ReadonlySet<string> {
    return this.failed;
  }

  /** Must be called from a user gesture (iOS requires it). */
  async start(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    // Resume first, while still inside the gesture that asked for it.
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.running = true;
    // The switch and channel noises share the master gain, so the volume wheel
    // works them along with everything else. Already fetched, so this is quick.
    await this.sounds.load(this.ctx, this.master!);
  }

  /** Collects the sound effects ahead of the first press. */
  prefetchSounds(): Promise<void> {
    return this.sounds.prefetch();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const id of [...this.voices.keys()]) this.release(id);
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  /** Plays one take of an action's sound. Returns how long it runs, in seconds. */
  playSound(action: SfxAction): number {
    return this.ctx ? this.sounds.play(action) : 0;
  }

  /** Sound effect files the host isn't serving. */
  get missingSounds(): ReadonlySet<string> {
    return this.sounds.missing;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, RAMP);
    }
  }

  /** Apply the current set of audible stations. Called on every scheduler tick. */
  update(targets: readonly VoiceTarget[]): void {
    if (!this.ctx || !this.running) return;
    const wanted = new Set(targets.map((t) => t.key));
    for (const id of [...this.voices.keys()]) {
      if (!wanted.has(id)) this.release(id);
    }
    for (const target of targets) this.applyTarget(target);
  }

  private applyTarget(target: VoiceTarget): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const voice = this.ensureVoice(target.key);
    voice.releasing = false;

    voice.gain.gain.setTargetAtTime(target.gain, ctx.currentTime, RAMP);

    if (voice.trackId !== target.trackId) {
      voice.epoch++;
      voice.trackId = target.trackId;
      voice.started = false;
      const url = this.resolveUrl(target.trackId);
      if (!url) return;
      voice.el.src = url;
      voice.el.load();
      this.failed.delete(target.trackId);
      this.seek(voice, target.offsetSec);
    }

    if (!target.playing) {
      // Cued and waiting: loaded, sitting at the right spot, making no sound.
      if (!voice.el.paused) voice.el.pause();
      if (!voice.started) this.seek(voice, target.offsetSec);
      return;
    }

    if (!voice.started || voice.el.paused) {
      // Starting for real, so put it exactly where the schedule wants it.
      if (!voice.started) this.seek(voice, target.offsetSec);
      voice.started = true;
      if (this.running) void voice.el.play().catch(() => {});
      return;
    }

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
    el.addEventListener('error', () => {
      const voice = this.voices.get(key);
      if (voice?.trackId) this.failed.add(voice.trackId);
    });

    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(gain);
    gain.connect(this.master!);

    const voice: Voice = { el, source, gain, trackId: null, epoch: 0, releasing: false, started: false };
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
      voice.gain.disconnect();
      this.voices.delete(key);
    }, RELEASE_MS);
  }

  dispose(): void {
    for (const id of [...this.voices.keys()]) this.release(id);
    void this.ctx?.close();
    this.ctx = null;
    this.running = false;
  }
}
