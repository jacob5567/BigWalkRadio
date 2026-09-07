import { AudioEngine, type SyncMode, type VoiceTarget } from './audio';
import { makeClock, type BroadcastClock, type ClockReading } from './clock';
import { getKV, setKV } from './db';
import { DEFAULT_SETTINGS, makeDefaultStations } from './defaults';
import { Library } from './library';
import { albumKey } from './naming';
import { normalizeStation, resolveStationLayers, type AudioLayer } from './schedule';
import { AUDIBLE_THRESHOLD, DEFAULT_DIAL, readDial, type DialState, type StationSignal } from './tuner';
import type { ClockMode, DialConfig, Program, Settings, Station, Track } from './types';

const KEY_SETTINGS = 'settings';
const KEY_STATIONS = 'stations';
/** How many streams may sound at once. Mobile browsers throttle beyond a handful. */
const MAX_VOICES = 4;
const TICK_MS = 250;

export interface StationState {
  station: Station;
  signal: StationSignal;
  /** Current daypart first, then the outgoing one if a handover is in progress. */
  layers: AudioLayer[];
  /** The daypart considered "on air" for display purposes. */
  playing: AudioLayer | null;
}

export interface RadioState {
  ready: boolean;
  settings: Settings;
  reading: ClockReading;
  dial: DialState;
  stations: StationState[];
  /** The station currently being received, if any. */
  tuned: StationState | null;
}

type Listener = (state: RadioState) => void;

export interface PlacedTrack {
  track: Track;
  station: Station;
  program: Program;
}

export interface ImportSummary {
  placed: PlacedTrack[];
  unplaced: Track[];
  failed: { name: string; reason: string }[];
}

/** Minutes of slack allowed when matching a filename's time to a daypart. */
const SLOT_TOLERANCE_MIN = 1;

function findSlot(
  stations: Station[],
  album: string,
  minutes: number,
): { station: Station; program: Program } | null {
  const key = albumKey(album);
  const station = stations.find((s) => (s.albumKey ?? albumKey(s.name)) === key);
  if (!station) return null;
  const program = station.programs.find(
    (p) => Math.abs(p.startHour * 60 - minutes) <= SLOT_TOLERANCE_MIN,
  );
  return program ? { station, program } : null;
}

export class Radio {
  readonly library = new Library();
  readonly engine: AudioEngine;
  readonly dialConfig: DialConfig = DEFAULT_DIAL;

  private settings: Settings = { ...DEFAULT_SETTINGS };
  private stations: Station[] = makeDefaultStations();
  private clock: BroadcastClock = makeClock(DEFAULT_SETTINGS.mode, DEFAULT_SETTINGS.gameDayMinutes);
  private listeners = new Set<Listener>();
  private timer: number | null = null;
  private ready = false;
  private saveTimer: number | null = null;
  private lastMediaKey = '';

  constructor() {
    this.engine = new AudioEngine((trackId) => this.library.urlFor(trackId));
    this.engine.onNeedsUpdate = () => this.tick();
  }

  async init(): Promise<void> {
    await this.library.load();
    const savedSettings = await getKV<Partial<Settings>>(KEY_SETTINGS);
    const savedStations = await getKV<Station[]>(KEY_STATIONS);
    if (savedSettings) this.settings = { ...DEFAULT_SETTINGS, ...savedSettings, powered: false };
    if (savedStations?.length) this.stations = savedStations.map(normalizeStation);
    this.clock = makeClock(this.settings.mode, this.settings.gameDayMinutes);
    this.ready = true;
    this.startTicking();
    this.emit();
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

  // --- controls -------------------------------------------------------------

  async setPower(on: boolean): Promise<void> {
    this.settings.powered = on;
    if (on) await this.engine.start();
    else await this.engine.stop();
    this.save();
    this.tick();
  }

  setFrequency(freq: number): void {
    const { min, max } = this.dialConfig;
    this.settings.frequency = Math.min(max, Math.max(min, freq));
    this.save();
    this.tick();
  }

  /** Snap to the nearest station at or beyond the current dial position. */
  seekStation(direction: 1 | -1): void {
    const sorted = [...this.stations].sort((a, b) => a.frequency - b.frequency);
    if (sorted.length === 0) return;
    const here = this.settings.frequency;
    const candidates = direction > 0
      ? sorted.filter((s) => s.frequency > here + 0.05)
      : sorted.filter((s) => s.frequency < here - 0.05).reverse();
    const next = candidates[0] ?? (direction > 0 ? sorted[0]! : sorted[sorted.length - 1]!);
    this.setFrequency(next.frequency);
  }

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

  // --- importing ------------------------------------------------------------

  /**
   * Import audio and file it into the schedule. Tracks whose names carry an
   * album and a time of day land straight in the matching daypart; anything
   * else is left in the library for the listener to place by hand.
   */
  async importFiles(files: readonly File[]): Promise<ImportSummary> {
    const imported = await this.library.import(files);
    const placed: PlacedTrack[] = [];
    const unplaced: Track[] = [];
    const stations = this.getStations();

    for (const track of imported.added) {
      const slot = track.album && track.timeOfDayMinutes != null
        ? findSlot(stations, track.album, track.timeOfDayMinutes)
        : null;
      if (slot) {
        // Each daypart is a single track on repeat, so a match replaces it.
        slot.program.trackIds = [track.id];
        placed.push({ track, station: slot.station, program: slot.program });
      } else {
        unplaced.push(track);
      }
    }

    if (placed.length > 0) this.updateStations(stations);
    else this.tick();
    return { placed, unplaced, failed: imported.failed };
  }

  async removeTrack(id: string): Promise<void> {
    await this.library.remove(id);
    this.updateStations(
      this.getStations().map((s) => ({
        ...s,
        programs: s.programs.map((p) => ({ ...p, trackIds: p.trackIds.filter((t) => t !== id) })),
      })),
    );
  }

  // --- station editing ------------------------------------------------------

  updateStations(next: Station[]): void {
    this.stations = next.map(normalizeStation);
    this.save();
    this.tick();
  }

  mutateStation(id: string, fn: (station: Station) => Station): void {
    this.updateStations(this.stations.map((s) => (s.id === id ? fn({ ...s, programs: s.programs.map((p) => ({ ...p })) }) : s)));
  }

  // --- scheduling -----------------------------------------------------------

  private timelineScale(reading: ClockReading): number {
    return this.settings.mode === 'game' && this.settings.compressTrackTimeline ? reading.timelineRate : 1;
  }

  snapshot(nowMs = Date.now()): RadioState {
    const reading = this.clock.read(nowMs);
    const dial = readDial(this.stations, this.settings.frequency, this.dialConfig);
    const scale = this.timelineScale(reading);
    const stations: StationState[] = dial.signals.map((signal) => {
      const layers = resolveStationLayers(signal.station, reading, this.library.map, {
        timelineScale: scale,
        blendSeconds: this.settings.blendSeconds,
      });
      return {
        station: signal.station,
        signal,
        layers,
        playing: layers.find((l) => l.role === 'current') ?? layers[0] ?? null,
      };
    });
    const tuned = dial.locked ? stations.find((s) => s.station.id === dial.locked!.station.id) ?? null : null;
    return { ready: this.ready, settings: { ...this.settings }, reading, dial, stations, tuned };
  }

  /** Recompute the broadcast and push it to the audio engine and the UI. */
  tick(): void {
    const state = this.snapshot();
    if (this.settings.powered && this.engine.isRunning) {
      const sync: SyncMode = this.timelineScale(state.reading) === 1 ? 'lock' : 'free';
      const targets: VoiceTarget[] = state.stations
        .filter((s) => s.signal.gain > AUDIBLE_THRESHOLD)
        .flatMap((s) =>
          s.layers.map((layer) => ({
            key: `${s.station.id}::${layer.instance.program.id}`,
            stationId: s.station.id,
            trackId: layer.track.id,
            offsetSec: layer.offsetSec,
            gain: s.signal.gain * layer.blend,
            loop: layer.loops,
            sync,
          })),
        )
        .sort((a, b) => b.gain - a.gain)
        .slice(0, MAX_VOICES);
      this.engine.update(targets);
      this.engine.setStaticGain(state.dial.staticGain);
      this.updateMediaSession(state);
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
    const tuned = state.tuned;
    const key = tuned?.playing ? `${tuned.station.id}:${tuned.playing.track.id}` : 'static';
    if (key === this.lastMediaKey) return;
    this.lastMediaKey = key;
    navigator.mediaSession.playbackState = 'playing';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: tuned?.playing ? tuned.playing.track.name : 'Static',
      artist: tuned ? `${tuned.station.name} · ${tuned.station.frequency.toFixed(1)} FM` : 'Between stations',
      album: tuned?.playing?.instance.program.name ?? '',
    });
  }

  private save(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void setKV(KEY_SETTINGS, this.settings);
      void setKV(KEY_STATIONS, this.stations);
    }, 300);
  }

  private emit(state: RadioState = this.snapshot()): void {
    for (const fn of this.listeners) fn(state);
  }
}
