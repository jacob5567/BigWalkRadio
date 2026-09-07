import type { ClockMode } from './types';

/**
 * A reading of the broadcast clock: where "now" falls inside a broadcast day.
 * All *Ms fields are real wall-clock epoch milliseconds.
 */
export interface ClockReading {
  mode: ClockMode;
  nowMs: number;
  /** Integer index of the current broadcast day. Stable across reloads. */
  dayIndex: number;
  dayStartMs: number;
  dayLengthMs: number;
  prevDayStartMs: number;
  nextDayStartMs: number;
  /** 0..1 through the current broadcast day. */
  dayFraction: number;
  /** 0..24 broadcast hours. Not real hours in game mode. */
  dayHour: number;
  /** Broadcast seconds per real second. 1 in real mode, >1 in game mode. */
  timelineRate: number;
}

export interface BroadcastClock {
  readonly mode: ClockMode;
  read(nowMs: number): ClockReading;
}

const DAY_MS = 86_400_000;

/** Fixed anchor for game time so every device agrees on where the day is. */
export const GAME_EPOCH_MS = Date.UTC(2020, 0, 1, 0, 0, 0, 0);

function localMidnight(atMs: number): number {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localDayIndex(atMs: number): number {
  const d = new Date(atMs);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/**
 * One broadcast day == one real local day, anchored to local midnight.
 * Day lengths are measured rather than assumed, so DST transitions stay sane.
 */
export class RealTimeClock implements BroadcastClock {
  readonly mode = 'real' as const;

  read(nowMs: number): ClockReading {
    const dayStartMs = localMidnight(nowMs);
    const nextDayStartMs = localMidnight(dayStartMs + DAY_MS + DAY_MS / 2);
    const prevDayStartMs = localMidnight(dayStartMs - DAY_MS / 2);
    const dayLengthMs = nextDayStartMs - dayStartMs;
    const dayFraction = (nowMs - dayStartMs) / dayLengthMs;
    return {
      mode: 'real',
      nowMs,
      dayIndex: localDayIndex(nowMs),
      dayStartMs,
      dayLengthMs,
      prevDayStartMs,
      nextDayStartMs,
      dayFraction,
      dayHour: dayFraction * 24,
      timelineRate: 1,
    };
  }
}

/** One broadcast day compressed into `dayLengthMs` of real time. */
export class CompressedClock implements BroadcastClock {
  readonly mode = 'game' as const;

  constructor(
    public dayLengthMs: number,
    private readonly epochMs: number = GAME_EPOCH_MS,
  ) {}

  read(nowMs: number): ClockReading {
    const len = this.dayLengthMs;
    const dayIndex = Math.floor((nowMs - this.epochMs) / len);
    const dayStartMs = this.epochMs + dayIndex * len;
    const dayFraction = (nowMs - dayStartMs) / len;
    return {
      mode: 'game',
      nowMs,
      dayIndex,
      dayStartMs,
      dayLengthMs: len,
      prevDayStartMs: dayStartMs - len,
      nextDayStartMs: dayStartMs + len,
      dayFraction,
      dayHour: dayFraction * 24,
      timelineRate: DAY_MS / len,
    };
  }
}

export function makeClock(mode: ClockMode, gameDayMinutes: number): BroadcastClock {
  return mode === 'real'
    ? new RealTimeClock()
    : new CompressedClock(Math.max(1, gameDayMinutes) * 60_000);
}

/** "14:32" for a broadcast-day hour. */
export function formatDayHour(dayHour: number): string {
  const total = Math.floor(((dayHour % 24) + 24) % 24 * 3600);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
