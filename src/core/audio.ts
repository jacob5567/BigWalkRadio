import { SoundBank, type SfxAction } from './sounds';
import { riseAt, type TuneConfig } from './tuning';

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
  /**
   * True for a stream held open only so that tuning to it is quick. It is
   * loaded and parked, never sounded, and costs nothing while it waits.
   */
  warm?: boolean;
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
/** Steps in the scheduled rise: enough that the curve is smooth to the ear. */
const RISE_STEPS = 16;
/** How fast whatever was playing is taken down when the switch is turned. */
const DUCK_SECONDS = 0.02;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** The switch envelope, between the stations and the master. */
  private tuning: GainNode | null = null;
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
      // The stations pass through here; the switch sounds do not, so the click
      // is heard while the channel behind it is still silent.
      this.tuning = this.ctx.createGain();
      this.tuning.gain.value = 0;
      this.tuning.connect(this.master);
    }
    // Resume first, while still inside the gesture that asked for it.
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.running = true;
    // The switch and channel noises share the master gain, so the volume wheel
    // works them along with everything else. Already fetched, so this is quick.
    await this.sounds.load(this.ctx, this.master!);
  }

  /**
   * Works the switch. The whole envelope is scheduled here and then left alone:
   * sampling it on the scheduler's tick would quantise the rise to the tick
   * rate, which is far coarser than the fade.
   */
  tune(onStation: boolean, config: TuneConfig): void {
    const ctx = this.ctx;
    const gain = this.tuning?.gain;
    if (!ctx || !gain) return;

    const now = ctx.currentTime;
    const hold = Math.max(0, config.holdMs) / 1000;
    const fade = Math.max(0, config.fadeMs) / 1000;
    const duck = Math.min(DUCK_SECONDS, hold);

    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    if (duck > 0) gain.linearRampToValueAtTime(0, now + duck);
    else gain.setValueAtTime(0, now);
    if (!onStation) return;

    gain.setValueAtTime(0, now + hold);
    for (let i = 1; i <= RISE_STEPS; i++) {
      const x = i / RISE_STEPS;
      gain.linearRampToValueAtTime(riseAt(x), now + hold + fade * x);
    }
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
      // No seek here: whichever branch below owns this stream does it. Seeking
      // twice makes the browser fetch the head of the file for nothing.
    }

    if (!target.playing) {
      // Cued and waiting: loaded, sitting at the right spot, making no sound.
      if (!voice.el.paused) voice.el.pause();
      if (!voice.started) this.seek(voice, target.offsetSec);
      return;
    }

    if (!voice.started || voice.el.paused) {
      // Seek first, sound second. Playing from the top and then jumping makes
      // the browser open the file, throw the buffer away and open it again.
      voice.started = true;
      const epoch = voice.epoch;
      this.seek(voice, target.offsetSec, () => {
        if (voice.epoch !== epoch || voice.releasing || !this.running) return;
        void voice.el.play().catch(() => {});
      });
      return;
    }

    if (target.sync === 'lock' && voice.el.readyState >= 1 && !voice.el.seeking) {
      if (Math.abs(voice.el.currentTime - target.offsetSec) > DRIFT_TOLERANCE) {
        this.seek(voice, target.offsetSec);
      }
    }
  }

  /** Puts a stream where the schedule wants it, then calls `done` once it is there. */
  private seek(voice: Voice, offsetSec: number, done?: () => void): void {
    const apply = () => {
      const limit = Number.isFinite(voice.el.duration) ? voice.el.duration - 0.05 : Infinity;
      try {
        voice.el.currentTime = Math.max(0, Math.min(offsetSec, limit));
      } catch {
        /* element not seekable yet; the next tick will retry */
      }
      if (!done) return;
      if (voice.el.seeking) voice.el.addEventListener('seeked', done, { once: true });
      else done();
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
    gain.connect(this.tuning ?? this.master!);

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
    this.tuning = null;
    this.master = null;
    this.running = false;
  }
}
