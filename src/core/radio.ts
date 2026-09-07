import { AudioEngine, type SyncMode, type VoiceTarget } from './audio';
import { makeClock, type BroadcastClock, type ClockReading } from './clock';
import { Catalog } from './catalog';
import { getKV, setKV } from './db';
import { DEFAULT_SETTINGS, makeDefaultStations } from './defaults';
import { normalizeStation, resolveStationLayers, type AudioLayer } from './schedule';
import { DEFAULT_TUNE, OFF, nextPosition, readTuning, type TuneConfig, type TuneState } from './tuning';
import type { ClockMode, Settings, Station } from './types';

const KEY_SETTINGS = 'settings';
/** Two at most: a daypart and the one it is taking over from. */
const MAX_VOICES = 2;
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
  /** How many channels the switch has, not counting off. */
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
  private saveTimer: number | null = null;
  private lastMediaKey = '';

  /** The radio always starts off: audio can't begin without a press anyway. */
  private position = OFF;
  private switchedAtMs = Number.NEGATIVE_INFINITY;

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

  // --- the switch -----------------------------------------------------------

  /** The one control: click on to the next position, wrapping through off. */
  async advance(): Promise<void> {
    await this.setPosition(nextPosition(this.position, this.stations.length));
  }

  async setPosition(position: number): Promise<void> {
    const next = Math.max(OFF, Math.min(this.stations.length, Math.round(position)));
    this.position = next;
    this.switchedAtMs = Date.now();
    // Starting the audio has to happen inside the press that turned it on.
    if (next !== OFF) await this.engine.start();
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
      });
      onAir = { station, layers, playing: layers.find((l) => l.role === 'current') ?? layers[0] ?? null };
    }

    return {
      ready: this.ready,
      settings: { ...this.settings },
      position: this.position,
      channels: this.stations.length,
      reading,
      tune,
      onAir,
    };
  }

  /** Recompute the broadcast and push it to the audio engine and the UI. */
  tick(): void {
    const state = this.snapshot();

    if (this.engine.isRunning) {
      const sync: SyncMode = this.timelineScale(state.reading) === 1 ? 'lock' : 'free';
      const targets: VoiceTarget[] = (state.onAir?.layers ?? [])
        .map((layer) => ({
          key: `${state.onAir!.station.id}::${layer.instance.program.id}`,
          stationId: state.onAir!.station.id,
          trackId: layer.track.id,
          offsetSec: layer.offsetSec,
          gain: state.tune.stationGain * layer.blend,
          loop: layer.loops,
          sync,
        }))
        .sort((a, b) => b.gain - a.gain)
        .slice(0, MAX_VOICES);

      this.engine.update(targets);
      this.engine.setStaticGain(state.tune.staticGain);
      this.updateMediaSession(state);

      // Once the static from switching off has died away, let the audio
      // hardware go back to sleep.
      if (state.position === OFF && !state.tune.settling) void this.engine.stop();
    }

    this.emit(state);
  }

  private startTicking(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.tick();
    });
  }

  private updateMediaSession(state: RadioState): void {
    if (!('mediaSession' in navigator)) return;
    const playing = state.onAir?.playing ?? null;
    const key = playing ? `${state.onAir!.station.id}:${playing.track.id}` : `off:${state.position}`;
    if (key === this.lastMediaKey) return;
    this.lastMediaKey = key;
    navigator.mediaSession.playbackState = state.position === OFF ? 'paused' : 'playing';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: playing ? playing.track.name : 'Off',
      artist: state.onAir ? `${state.onAir.station.name} · Channel ${state.position}` : 'Radio',
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
