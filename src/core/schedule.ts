import type { ClockReading } from './clock';
import type { Program, Station, Track } from './types';

/** A concrete airing of a program: which one is on, and its real-time window. */
export interface ProgramInstance {
  program: Program;
  index: number;
  /** Real epoch ms at which this airing started. */
  startMs: number;
  /** Real epoch ms at which it hands over to the next program. */
  endMs: number;
}

export interface PlaybackPoint {
  station: Station;
  instance: ProgramInstance;
  track: Track;
  trackIndex: number;
  /** Seconds into the track that should be audible right now. */
  offsetSec: number;
  /** Real epoch ms at which this track gives way to the next one. */
  trackEndsAtMs: number;
  /** Total playlist length in broadcast seconds. */
  cycleSec: number;
  /** True when the program is a single track on repeat, so it can loop seamlessly. */
  loops: boolean;
}

/** One audible stream from a station. Two overlap while programs hand over. */
export interface AudioLayer extends PlaybackPoint {
  role: 'current' | 'outgoing';
  /** Equal-power crossfade gain, 0..1. */
  blend: number;
}

/** Returns a copy with programs sorted by start hour and hours clamped to [0,24). */
export function normalizeStation(station: Station): Station {
  const programs = station.programs
    .map((p) => ({ ...p, startHour: ((p.startHour % 24) + 24) % 24 }))
    .sort((a, b) => a.startHour - b.startHour);
  return { ...station, programs };
}

const fractionOf = (p: Program) => p.startHour / 24;

/** How much of the broadcast day a program occupies, as a fraction. */
export function programWindow(station: Station, index: number): number {
  const n = station.programs.length;
  if (n === 0) return 0;
  const here = fractionOf(station.programs[index % n]!);
  const next = fractionOf(station.programs[(index + 1) % n]!);
  const width = next - here;
  return width > 0 ? width : width + 1;
}

/**
 * Which program is on air, and when its airing started and ends.
 *
 * Programs partition the broadcast day, so the one on air is the last whose
 * start hour has passed. Before the first program's start hour, the last
 * program of the previous day is still running.
 */
export function resolveProgram(station: Station, reading: ClockReading): ProgramInstance | null {
  const programs = station.programs;
  if (programs.length === 0) return null;

  const first = programs[0]!;
  const prevDayLength = reading.dayStartMs - reading.prevDayStartMs;
  const nextDayLength = reading.nextDayStartMs - reading.dayStartMs;

  if (reading.dayFraction < fractionOf(first)) {
    const index = programs.length - 1;
    const program = programs[index]!;
    return {
      program,
      index,
      startMs: reading.prevDayStartMs + fractionOf(program) * prevDayLength,
      endMs: reading.dayStartMs + fractionOf(first) * reading.dayLengthMs,
    };
  }

  let index = 0;
  for (let i = 0; i < programs.length; i++) {
    if (fractionOf(programs[i]!) <= reading.dayFraction) index = i;
    else break;
  }
  const program = programs[index]!;
  const next = programs[index + 1];
  return {
    program,
    index,
    startMs: reading.dayStartMs + fractionOf(program) * reading.dayLengthMs,
    endMs: next
      ? reading.dayStartMs + fractionOf(next) * reading.dayLengthMs
      : reading.nextDayStartMs + fractionOf(first) * nextDayLength,
  };
}

/** The airing that just ended, i.e. the one still bleeding through the handover. */
export function previousProgram(
  station: Station,
  reading: ClockReading,
  current: ProgramInstance,
): ProgramInstance | null {
  const n = station.programs.length;
  if (n < 2) return null;
  const index = (current.index - 1 + n) % n;
  const length = programWindow(station, index) * reading.dayLengthMs;
  return {
    program: station.programs[index]!,
    index,
    startMs: current.startMs - length,
    endMs: current.startMs,
  };
}

/** Playable tracks of a program, in order, skipping missing or zero-length ones. */
export function programTracks(program: Program, tracks: ReadonlyMap<string, Track>): Track[] {
  const out: Track[] = [];
  for (const id of program.trackIds) {
    const t = tracks.get(id);
    if (t && t.duration > 0) out.push(t);
  }
  return out;
}

export interface ResolveOptions {
  /**
   * Broadcast seconds per real second for the *track* timeline.
   * 1 keeps audio at natural speed (the schedule may still be compressed);
   * pass `reading.timelineRate` to compress the music along with the day.
   */
  timelineScale?: number;
  /** Real seconds of overlap when one program hands over to the next. */
  blendSeconds?: number;
}

/** Where a specific airing has got to at `reading.nowMs`. */
export function playbackForInstance(
  station: Station,
  instance: ProgramInstance,
  reading: ClockReading,
  tracks: ReadonlyMap<string, Track>,
  timelineScale = 1,
): PlaybackPoint | null {
  const list = programTracks(instance.program, tracks);
  if (list.length === 0) return null;

  const cycleSec = list.reduce((sum, t) => sum + t.duration, 0);
  if (cycleSec <= 0) return null;

  const elapsedSec = ((reading.nowMs - instance.startMs) / 1000) * timelineScale;
  let pos = elapsedSec % cycleSec;
  if (pos < 0) pos += cycleSec;

  let trackIndex = 0;
  for (const track of list) {
    if (pos < track.duration) break;
    pos -= track.duration;
    trackIndex++;
  }
  // Guard against float drift landing exactly on the cycle boundary.
  if (trackIndex >= list.length) {
    trackIndex = list.length - 1;
    pos = list[trackIndex]!.duration;
  }

  const track = list[trackIndex]!;
  const remainingRealMs = ((track.duration - pos) / timelineScale) * 1000;
  return {
    station,
    instance,
    track,
    trackIndex,
    offsetSec: pos,
    trackEndsAtMs: reading.nowMs + remainingRealMs,
    cycleSec,
    loops: list.length === 1,
  };
}

/**
 * What a station is playing at `reading.nowMs`, as a pure function of the clock.
 * Returns null for dead air (no program, or no playable tracks in it).
 */
export function resolvePlayback(
  station: Station,
  reading: ClockReading,
  tracks: ReadonlyMap<string, Track>,
  options: ResolveOptions = {},
): PlaybackPoint | null {
  const instance = resolveProgram(station, reading);
  if (!instance) return null;
  return playbackForInstance(station, instance, reading, tracks, options.timelineScale ?? 1);
}

export const DEFAULT_BLEND_SECONDS = 8;

/**
 * Everything a station has on air right now: the current program, plus the
 * outgoing one still fading out if we're inside a handover. Each program's
 * track loops from its own start time until the next program takes over, and
 * the two overlap on an equal-power crossfade rather than cutting.
 */
export function resolveStationLayers(
  station: Station,
  reading: ClockReading,
  tracks: ReadonlyMap<string, Track>,
  options: ResolveOptions = {},
): AudioLayer[] {
  const scale = options.timelineScale ?? 1;
  const instance = resolveProgram(station, reading);
  if (!instance) return [];

  const current = playbackForInstance(station, instance, reading, tracks, scale);
  const previous = previousProgram(station, reading, instance);

  const windowSec = (instance.endMs - instance.startMs) / 1000;
  // Never spend more than a quarter of a short program on the handover, which
  // matters in game mode where a daypart can be under a minute of real time.
  const blendSec = Math.max(0, Math.min(options.blendSeconds ?? DEFAULT_BLEND_SECONDS, windowSec / 4));
  const sinceHandover = (reading.nowMs - instance.startMs) / 1000;

  if (!current) {
    // Dead air on the incoming program still lets the outgoing one fade away.
    if (!previous || blendSec <= 0 || sinceHandover >= blendSec) return [];
    const tail = playbackForInstance(station, previous, reading, tracks, scale);
    if (!tail) return [];
    return [{ ...tail, role: 'outgoing', blend: Math.cos((sinceHandover / blendSec) * (Math.PI / 2)) }];
  }

  if (!previous || blendSec <= 0 || sinceHandover >= blendSec) {
    return [{ ...current, role: 'current', blend: 1 }];
  }

  const x = Math.min(1, Math.max(0, sinceHandover / blendSec));
  const layers: AudioLayer[] = [
    { ...current, role: 'current', blend: Math.sin(x * (Math.PI / 2)) },
  ];
  const tail = playbackForInstance(station, previous, reading, tracks, scale);
  if (tail) layers.push({ ...tail, role: 'outgoing', blend: Math.cos(x * (Math.PI / 2)) });
  return layers;
}
