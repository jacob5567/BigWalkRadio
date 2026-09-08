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
  /** Which time through the playlist this is. Repeats get their own number. */
  pass: number;
  /** Seconds into the track that should be audible right now. */
  offsetSec: number;
  /** Real epoch ms at which the next track starts. */
  trackEndsAtMs: number;
  /** Playlist length in broadcast seconds, counting the seam overlaps. */
  cycleSec: number;
  /** True when the program is a single track repeating. */
  loops: boolean;
}

/** One audible stream from a station. Several overlap across a seam. */
export interface AudioLayer extends PlaybackPoint {
  role: 'current' | 'outgoing';
  /** Final gain, 0..1: the daypart crossfade and the seam crossfade combined. */
  blend: number;
  /**
   * False while a stream is only being got ready. The next track is loaded and
   * cued a few seconds early so it can start on time over a slow connection.
   */
  playing: boolean;
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

/** FNV-1a, so a program id turns into a stable seed. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates against a seeded generator, so the same pass always deals the same order. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The playlist as it is dealt for one pass. A shuffled program gets a fresh
 * order every time through, derived from the pass number rather than stored,
 * so every listener hears the same sequence and reloading changes nothing.
 */
export function orderForPass(program: Program, tracks: readonly Track[], pass: number): Track[] {
  if (program.order !== 'shuffle' || tracks.length < 2) return [...tracks];
  const seed = hashString(program.id);
  const current = shuffled(tracks, seed ^ Math.imul(pass, 0x9e3779b1));
  const previous = shuffled(tracks, seed ^ Math.imul(pass - 1, 0x9e3779b1));
  // Don't let the pass boundary play the same track twice in a row.
  if (current[0] === previous[previous.length - 1]) {
    [current[0], current[1]] = [current[1]!, current[0]!];
  }
  return current;
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

/**
 * How long two tracks overlap where one gives way to the next, including where
 * a track gives way to itself. Repeating a track by restarting it leaves an
 * audible gap: media elements don't restart sample-accurately, and lossy
 * formats pad both ends of the file. Overlapping the seam hides both.
 *
 * Short enough to be inaudible against tracks written to loop, and to alter
 * the music as little as possible while still covering the join.
 */
export const DEFAULT_SEAM_SECONDS = 0.02;

/** How far ahead the next track is fetched and cued. */
const LEAD_SECONDS = 8;

export interface ResolveOptions {
  /**
   * Broadcast seconds per real second for the *track* timeline.
   * 1 keeps audio at natural speed (the schedule may still be compressed);
   * pass `reading.timelineRate` to compress the music along with the day.
   */
  timelineScale?: number;
  /** Real seconds of overlap when one program hands over to the next. */
  blendSeconds?: number;
  /** Broadcast seconds of overlap where one track gives way to the next. */
  seamSeconds?: number;
}

/**
 * A track's stride: how long from its start to the next track's start. One
 * seam shorter than the track itself, because the two overlap.
 */
function strideOf(track: Track, seamSec: number): number {
  return Math.max(0.05, track.duration - seamSec);
}

interface Placement {
  order: Track[];
  trackIndex: number;
  offsetSec: number;
  pass: number;
  cycleSec: number;
  strideSec: number;
}

/** Where an airing's playlist has got to, `elapsedSec` in. */
function placeInPlaylist(
  program: Program,
  list: readonly Track[],
  elapsedSec: number,
  seamSec: number,
): Placement | null {
  // Strides sum the same whatever the order, so the pass is stable even when
  // the playlist is shuffled into a different order each time through.
  const cycleSec = list.reduce((sum, t) => sum + strideOf(t, seamSec), 0);
  if (cycleSec <= 0) return null;

  const pass = Math.floor(elapsedSec / cycleSec);
  let pos = elapsedSec - pass * cycleSec;
  if (pos < 0) pos += cycleSec;

  const order = orderForPass(program, list, pass);
  let trackIndex = 0;
  let cumulative = 0;
  for (; trackIndex < order.length; trackIndex++) {
    const stride = strideOf(order[trackIndex]!, seamSec);
    if (pos < cumulative + stride) break;
    cumulative += stride;
  }
  // Guard against float drift landing exactly on the cycle boundary.
  if (trackIndex >= order.length) {
    trackIndex = order.length - 1;
    cumulative = cycleSec - strideOf(order[trackIndex]!, seamSec);
  }

  return {
    order,
    trackIndex,
    offsetSec: pos - cumulative,
    pass,
    cycleSec,
    strideSec: strideOf(order[trackIndex]!, seamSec),
  };
}

/** Where a specific airing has got to at `reading.nowMs`. */
export function playbackForInstance(
  station: Station,
  instance: ProgramInstance,
  reading: ClockReading,
  tracks: ReadonlyMap<string, Track>,
  timelineScale = 1,
  seamSeconds = 0,
): PlaybackPoint | null {
  const list = programTracks(instance.program, tracks);
  if (list.length === 0) return null;

  const seamSec = clampSeam(seamSeconds, list);
  const elapsedSec = ((reading.nowMs - instance.startMs) / 1000) * timelineScale;
  const placed = placeInPlaylist(instance.program, list, elapsedSec, seamSec);
  if (!placed) return null;

  return point(station, instance, placed, placed.trackIndex, placed.offsetSec, placed.pass, reading, timelineScale, list.length === 1);
}

/** A seam can never eat more than half of the shortest track in the playlist. */
function clampSeam(seamSeconds: number, list: readonly Track[]): number {
  const shortest = list.reduce((min, t) => Math.min(min, t.duration), Infinity);
  return Math.max(0, Math.min(seamSeconds, shortest / 2));
}

function point(
  station: Station,
  instance: ProgramInstance,
  placed: Placement,
  trackIndex: number,
  offsetSec: number,
  pass: number,
  reading: ClockReading,
  timelineScale: number,
  loops: boolean,
): PlaybackPoint {
  const track = placed.order[trackIndex]!;
  const remainingRealMs = ((placed.strideSec - placed.offsetSec) / timelineScale) * 1000;
  return {
    station,
    instance,
    track,
    trackIndex,
    pass,
    offsetSec,
    trackEndsAtMs: reading.nowMs + remainingRealMs,
    cycleSec: placed.cycleSec,
    loops,
  };
}

/**
 * What a station is playing at `reading.nowMs`, as a pure function of the
 * clock. Returns null for dead air (no programme, or nothing playable in it).
 */
export function resolvePlayback(
  station: Station,
  reading: ClockReading,
  tracks: ReadonlyMap<string, Track>,
  options: ResolveOptions = {},
): PlaybackPoint | null {
  const instance = resolveProgram(station, reading);
  if (!instance) return null;
  return playbackForInstance(
    station,
    instance,
    reading,
    tracks,
    options.timelineScale ?? 1,
    options.seamSeconds ?? DEFAULT_SEAM_SECONDS,
  );
}

export const DEFAULT_BLEND_SECONDS = 8;

/**
 * What one airing has on air: the track that is up, the one it is still
 * overlapping at a seam, and the one being cued ready for the next seam.
 */
function layersForInstance(
  station: Station,
  instance: ProgramInstance,
  reading: ClockReading,
  tracks: ReadonlyMap<string, Track>,
  options: ResolveOptions,
  role: 'current' | 'outgoing',
  dayBlend: number,
): AudioLayer[] {
  const list = programTracks(instance.program, tracks);
  if (list.length === 0) return [];

  const scale = options.timelineScale ?? 1;
  const seamSec = clampSeam(options.seamSeconds ?? DEFAULT_SEAM_SECONDS, list);
  const elapsedSec = ((reading.nowMs - instance.startMs) / 1000) * scale;
  const placed = placeInPlaylist(instance.program, list, elapsedSec, seamSec);
  if (!placed) return [];

  const loops = list.length === 1;
  const at = (index: number, offset: number, pass: number) =>
    point(station, instance, placed, index, offset, pass, reading, scale, loops);

  const primary = at(placed.trackIndex, placed.offsetSec, placed.pass);

  // At the very start of an airing there is nothing before it to overlap: the
  // programme handover covers that seam instead.
  const opening = placed.pass === 0 && placed.trackIndex === 0;
  const inSeam = seamSec > 0 && placed.offsetSec < seamSec && !opening;

  const layers: AudioLayer[] = [{
    ...primary,
    role,
    playing: true,
    blend: dayBlend * (inSeam ? Math.sin((placed.offsetSec / seamSec) * (Math.PI / 2)) : 1),
  }];

  // The outgoing airing is already fading out, so its own seams don't matter.
  if (role === 'outgoing') return layers;

  if (inSeam) {
    // The track before this one is still running, into its final seam.
    const previousIndex = placed.trackIndex - 1;
    const fromThisPass = previousIndex >= 0;
    const order = fromThisPass ? placed.order : orderForPass(instance.program, list, placed.pass - 1);
    const index = fromThisPass ? previousIndex : order.length - 1;
    const track = order[index];
    if (track) {
      const tail = at(index, strideOf(track, seamSec) + placed.offsetSec, fromThisPass ? placed.pass : placed.pass - 1);
      layers.push({
        ...tail,
        track,
        role,
        playing: true,
        blend: dayBlend * Math.cos((placed.offsetSec / seamSec) * (Math.PI / 2)),
      });
    }
  }

  // Cue the next track early so it can come in on time over a slow connection.
  const lead = Math.min(LEAD_SECONDS, placed.strideSec / 2);
  if (seamSec > 0 && placed.offsetSec > placed.strideSec - lead) {
    const nextIndex = placed.trackIndex + 1;
    const wraps = nextIndex >= placed.order.length;
    const order = wraps ? orderForPass(instance.program, list, placed.pass + 1) : placed.order;
    const index = wraps ? 0 : nextIndex;
    const track = order[index];
    if (track) {
      layers.push({
        ...at(index, 0, wraps ? placed.pass + 1 : placed.pass),
        track,
        role,
        playing: false,
        blend: 0,
      });
    }
  }

  return layers;
}

/**
 * Everything a station has on air right now: the current programme, the
 * outgoing one still fading out if a handover is in progress, and the overlaps
 * where one track gives way to the next.
 */
export function resolveStationLayers(
  station: Station,
  reading: ClockReading,
  tracks: ReadonlyMap<string, Track>,
  options: ResolveOptions = {},
): AudioLayer[] {
  const instance = resolveProgram(station, reading);
  if (!instance) return [];

  const previous = previousProgram(station, reading, instance);
  const windowSec = (instance.endMs - instance.startMs) / 1000;
  // Never spend more than a quarter of a short programme on the handover, which
  // matters in game mode where a daypart can be under a minute of real time.
  const blendSec = Math.max(0, Math.min(options.blendSeconds ?? DEFAULT_BLEND_SECONDS, windowSec / 4));
  const sinceHandover = (reading.nowMs - instance.startMs) / 1000;
  const handingOver = previous !== null && blendSec > 0 && sinceHandover < blendSec;

  const x = handingOver ? Math.min(1, Math.max(0, sinceHandover / blendSec)) : 1;
  const layers = layersForInstance(
    station, instance, reading, tracks, options, 'current',
    handingOver ? Math.sin(x * (Math.PI / 2)) : 1,
  );

  if (handingOver && previous) {
    layers.push(...layersForInstance(
      station, previous, reading, tracks, options, 'outgoing', Math.cos(x * (Math.PI / 2)),
    ));
  }

  return layers;
}
