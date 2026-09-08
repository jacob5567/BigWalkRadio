import { AudioEngine, type SyncMode, type VoiceTarget } from './audio';
import { makeClock, type BroadcastClock, type ClockReading } from './clock';
import { Catalog } from './catalog';
import { getKV, setKV } from './db';
import { DEFAULT_SETTINGS, makeDefaultStations } from './defaults';
import { bindMediaKeys } from './media-keys';
import { normalizeStation, resolveStationLayers, type AudioLayer } from './schedule';
import type { SfxAction } from './sounds';
import { DEFAULT_TUNE, OFF, nextPosition, readTuning, type TuneConfig, type TuneState } from './tuning';
import type { ClockMode, Settings, Station } from './types';

const KEY_SETTINGS = 'settings';
/**
 * At most four: the track that's up, the one it's overlapping at a seam, the
 * one cued for the next seam, and an outgoing daypart still fading away.
 */
const MAX_VOICES = 4;
const TICK_MS = 250;

export interface OnAir {
  station: Station;
  /** Current daypart first, then the outgoing one if a handover is in progress. */
  layers: AudioLayer[];
  /** The daypart considered "on air" for display purposes. */
  playing: AudioLayer | null;
}

export interface RadioState {
  ready: boolean;
  settings: Settings;
  /** 0 is off; 1..channels select a station. */
  position: number;
  /** Whether the radio is on at all, i.e. the position isn't 0. */
  power: boolean;
  /** How many channels there are, not counting off. */
  channels: number;
  reading: ClockReading;
  /** Where the change of position has got to. */
  tune: TuneState;
  /** What the selected channel is playing, or null at position 0. */
  onAir: OnAir | null;
}

type Listener = (state: RadioState) => void;

/**
 * The radio: a switch with an off position and one position per channel, and
 * the schedule running behind it whether or not anyone is listening.
 */
export class Radio {
  readonly catalog = new Catalog();
  readonly engine: AudioEngine;
  readonly tuneConfig: TuneConfig = DEFAULT_TUNE;

  private settings: Settings = { ...DEFAULT_SETTINGS };
  private readonly stations: Station[] = makeDefaultStations().map(normalizeStation);
  private clock: BroadcastClock = makeClock(DEFAULT_SETTINGS.mode, DEFAULT_SETTINGS.gameDayMinutes);
  private listeners = new Set<Listener>();
  private timer: number | null = null;
  private ready = false;
  private disposed = false;
  private saveTimer: number | null = null;
  private lastMediaKey = '';
  private unbindMediaKeys: (() => void) | null = null;

  /** The radio always starts off: audio can't begin without a press anyway. */
  private position = OFF;
  private switchedAtMs = Number.NEGATIVE_INFINITY;
  /** When the click covering the last change finishes. */
  private soundUntilMs = 0;

  constructor() {
    this.engine = new AudioEngine((trackId) => this.catalog.urlFor(trackId));
    this.engine.onNeedsUpdate = () => this.tick();
  }

  async init(): Promise<void> {
    const savedSettings = await getKV<Partial<Settings>>(KEY_SETTINGS);
    if (savedSettings) this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    this.clock = makeClock(this.settings.mode, this.settings.gameDayMinutes);
    this.ready = true;
    this.startTicking();
    // Collect the switch and channel sounds now, so the first press has them.
    void this.engine.prefetchSounds();
    this.unbindMediaKeys = bindMediaKeys({
      play: () => void this.setPower(true),
      pause: () => void this.setPower(false),
      previous: () => void this.stepChannel(-1),
      next: () => void this.stepChannel(1),
    });
    this.emit();
    // Anything the build couldn't measure gets read from the file header, in
    // the background, so a missing duration doesn't hold up the dial.
    void this.catalog.probeMissingDurations().then(() => this.tick());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  getStations(): Station[] {
    return this.stations.map((s) => ({ ...s, programs: s.programs.map((p) => ({ ...p })) }));
  }

  get channelCount(): number {
    return this.stations.length;
  }

  // --- the controls ---------------------------------------------------------
  //
  // Four ways in, one position underneath, so every one of them gets the same
  // click over the change.

  /** The on/off switch. Turning it on returns to the channel last listened to. */
  async setPower(on: boolean): Promise<void> {
    if (on === (this.position !== OFF)) return;
    await this.setPosition(on ? this.settings.lastChannel : OFF);
  }

  /** The forward and back buttons. They wrap, and do nothing while off. */
  async stepChannel(direction: 1 | -1): Promise<void> {
    const count = this.stations.length;
    if (this.position === OFF || count === 0) return;
    await this.setPosition(((this.position - 1 + direction + count) % count) + 1);
  }

  /** The single button: on through each channel in turn, then off again. */
  async advance(): Promise<void> {
    await this.setPosition(nextPosition(this.position, this.stations.length));
  }

  async setPosition(position: number): Promise<void> {
    const next = Math.max(OFF, Math.min(this.stations.length, Math.round(position)));
    if (next === this.position) return;
    const from = this.position;
    this.position = next;
    this.switchedAtMs = Date.now();
    if (next !== OFF) {
      this.settings.lastChannel = next;
      this.save();
      // Starting the audio has to happen inside the press that turned it on.
      await this.engine.start();
      // Which is long enough for the radio to have been shut down under us.
      if (this.disposed) return;
    }

    // The whole rise is handed to the audio clock now, in one go, rather than
    // being sampled on the tick -- the tick is coarser than the fade.
    this.engine.tune(next !== OFF, this.tuneConfig);

    const action: SfxAction = next === OFF ? 'off' : from === OFF ? 'on' : 'channelChange';
    this.soundUntilMs = Date.now() + this.engine.playSound(action) * 1000;
    this.tick();
  }

  stationAt(position: number): Station | null {
    return position === OFF ? null : this.stations[position - 1] ?? null;
  }

  // --- settings -------------------------------------------------------------

  setVolume(v: number): void {
    this.settings.volume = Math.min(1, Math.max(0, v));
    this.engine.setVolume(this.settings.volume);
    this.save();
    this.emit();
  }

  setMode(mode: ClockMode): void {
    this.settings.mode = mode;
    this.clock = makeClock(mode, this.settings.gameDayMinutes);
    this.save();
    this.tick();
  }

  setGameDayMinutes(minutes: number): void {
    this.settings.gameDayMinutes = Math.min(1440, Math.max(1, minutes));
    if (this.settings.mode === 'game') this.clock = makeClock('game', this.settings.gameDayMinutes);
    this.save();
    this.tick();
  }

  setSeamSeconds(seconds: number): void {
    this.settings.seamSeconds = Math.min(5, Math.max(0, seconds));
    this.save();
    this.tick();
  }

  setBlendSeconds(seconds: number): void {
    this.settings.blendSeconds = Math.min(120, Math.max(0, seconds));
    this.save();
    this.tick();
  }

  setCompressTrackTimeline(on: boolean): void {
    this.settings.compressTrackTimeline = on;
    this.save();
    this.tick();
  }

  // --- scheduling -----------------------------------------------------------

  private timelineScale(reading: ClockReading): number {
    return this.settings.mode === 'game' && this.settings.compressTrackTimeline ? reading.timelineRate : 1;
  }

  snapshot(nowMs = Date.now()): RadioState {
    const reading = this.clock.read(nowMs);
    const station = this.stationAt(this.position);
    const tune = readTuning(nowMs - this.switchedAtMs, station !== null, this.tuneConfig);

    let onAir: OnAir | null = null;
    if (station) {
      const layers = resolveStationLayers(station, reading, this.catalog.map, {
        timelineScale: this.timelineScale(reading),
        blendSeconds: this.settings.blendSeconds,
        seamSeconds: this.settings.seamSeconds,
      });
      onAir = { station, layers, playing: layers.find((l) => l.role === 'current') ?? layers[0] ?? null };
    }

    return {
      ready: this.ready,
      settings: { ...this.settings },
      position: this.position,
      power: this.position !== OFF,
      channels: this.stations.length,
      reading,
      tune,
      onAir,
    };
  }

  /** Recompute the broadcast and push it to the audio engine and the UI. */
  tick(): void {
    if (this.disposed) return;
    const state = this.snapshot();

    if (this.engine.isRunning) {
      const sync: SyncMode = this.timelineScale(state.reading) === 1 ? 'lock' : 'free';
      const targets: VoiceTarget[] = (state.onAir?.layers ?? [])
        .map((layer) => ({
          // Overlapping copies of one track need to be told apart, so the pass
          // and the place in the playlist are part of the identity.
          key: `${state.onAir!.station.id}::${layer.instance.program.id}::${layer.pass}::${layer.trackIndex}`,
          stationId: state.onAir!.station.id,
          trackId: layer.track.id,
          offsetSec: layer.offsetSec,
          // The switch envelope lives on the engine's own clock now; this
          // carries only the daypart blend.
          gain: layer.blend,
          playing: layer.playing,
          sync,
        }))
        // Anything cued but silent goes last, so it is dropped first if the
        // cap bites.
        .sort((a, b) => Number(b.playing) - Number(a.playing) || b.gain - a.gain)
        .slice(0, MAX_VOICES);

      this.engine.update([...targets, ...this.warmTargets(state, sync)]);
      this.updateMediaSession(state);

      // Once the click of switching off has finished, let the audio hardware
      // go back to sleep.
      const quiet = !state.tune.settling && state.reading.nowMs >= this.soundUntilMs;
      if (state.position === OFF && quiet) void this.engine.stop();
    }

    this.emit(state);
  }

  /**
   * The channels either side, opened and parked but never sounded. Tuning to
   * one of them then reuses a stream that is already on the file, instead of
   * opening it and hunting for the offset from cold -- which over a network,
   * in a format with no seek index, is most of what makes a change feel slow.
   */
  private warmTargets(state: RadioState, sync: SyncMode): VoiceTarget[] {
    const count = this.stations.length;
    if (state.position === OFF || count < 2) return [];

    const out: VoiceTarget[] = [];
    const seen = new Set<string>();
    for (const step of [1, -1]) {
      const position = ((state.position - 1 + step + count) % count) + 1;
      const station = this.stationAt(position);
      if (!station || position === state.position) continue;

      const layers = resolveStationLayers(station, state.reading, this.catalog.map, {
        timelineScale: this.timelineScale(state.reading),
        blendSeconds: this.settings.blendSeconds,
        seamSeconds: this.settings.seamSeconds,
      });
      const layer = layers.find((l) => l.role === 'current' && l.playing);
      if (!layer) continue;

      const key = `${station.id}::${layer.instance.program.id}::${layer.pass}::${layer.trackIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        stationId: station.id,
        trackId: layer.track.id,
        offsetSec: layer.offsetSec,
        gain: 0,
        playing: false,
        sync,
        warm: true,
      });
    }
    return out;
  }

  private startTicking(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private readonly onVisibilityChange = () => {
    if (!document.hidden) this.tick();
  };

  /** Stop ticking and release the audio hardware. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.unbindMediaKeys?.();
    this.unbindMediaKeys = null;
    this.listeners.clear();
    this.engine.dispose();
  }

  private updateMediaSession(state: RadioState): void {
    if (!('mediaSession' in navigator)) return;
    const playing = state.onAir?.playing ?? null;
    const key = playing ? `${state.onAir!.station.id}:${playing.track.id}` : `off:${state.position}`;
    if (key === this.lastMediaKey) return;
    this.lastMediaKey = key;
    navigator.mediaSession.playbackState = state.position === OFF ? 'paused' : 'playing';
    // Some platforms hand out the session without the metadata constructor.
    if (typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: playing ? playing.track.name : 'Off',
      artist: state.onAir ? `${state.onAir.station.name} · Channel ${state.position}` : 'Big Walk Radio',
      album: playing?.instance.program.name ?? '',
    });
  }

  private save(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void setKV(KEY_SETTINGS, this.settings);
    }, 300);
  }

  private emit(state: RadioState = this.snapshot()): void {
    for (const fn of this.listeners) fn(state);
  }
}
