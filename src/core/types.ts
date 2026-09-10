/**
 * One audio file the host serves. Nothing is uploaded or stored by the app:
 * `src` is a path under the site root, served from ./music next to the app.
 */
export interface Track {
  /** The relative path, which doubles as a stable id. */
  id: string;
  /** Display name, taken from the filename. */
  name: string;
  /** Seconds. Baked in at build time, re-probed in the browser if missing. */
  duration: number;
  /**
   * File size in bytes, baked in at build time. Only used to size the offline
   * download, so 0 (the file wasn't there to measure) is survivable.
   */
  bytes?: number;
  /** Path relative to the site root, unencoded. */
  src: string;
  /** Album parsed out of the filename, if it named one. */
  album?: string | null;
  /** Time of day parsed out of the filename, in minutes past midnight. */
  timeOfDayMinutes?: number | null;
}

/**
 * A daypart. Programs partition a station's broadcast day; a program runs from
 * its own `startHour` until the next program's `startHour` (wrapping past 24).
 */
export interface Program {
  id: string;
  name: string;
  /** 0 <= startHour < 24, in broadcast-day hours (not necessarily real hours). */
  startHour: number;
  /** The playlist, played through for as long as the program is on air. */
  trackIds: string[];
  /**
   * How the playlist is ordered each time through. 'shuffle' reorders it on
   * every pass, seeded by the pass number so the broadcast stays the same for
   * everyone listening. Defaults to 'sequence'.
   */
  order?: 'sequence' | 'shuffle';
}

export interface Station {
  id: string;
  name: string;
  /** Normalised album name, used to match imported files back to this station. */
  albumKey?: string;
  /** Slot on the dial, numbered from 1. */
  channel: number;
  /** At least one. Kept sorted by startHour by `normalizeStation`. */
  programs: Program[];
}

export type ClockMode = 'real' | 'game';

export interface Settings {
  mode: ClockMode;
  /** Real minutes per broadcast day when in game mode. */
  gameDayMinutes: number;
  /**
   * Game mode only. When true the track timeline is compressed along with the
   * schedule, so songs are chopped short. When false (default) audio always
   * plays at 1x and only the daypart schedule accelerates.
   */
  compressTrackTimeline: boolean;
  volume: number;
  /** The channel the on/off switch returns to. Not the current position. */
  lastChannel: number;
  /** Real seconds of overlap when one daypart hands over to the next. */
  blendSeconds: number;
  /** Seconds of overlap where a track gives way to the next, or to itself. */
  seamSeconds: number;
}
