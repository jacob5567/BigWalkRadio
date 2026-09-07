import { describe, expect, it } from 'vitest';
import { CompressedClock, GAME_EPOCH_MS, RealTimeClock, formatDayHour } from '../src/core/clock';

// Tests run with TZ=UTC (see package.json) so local midnight is predictable.
const at = (iso: string) => Date.parse(iso);

describe('RealTimeClock', () => {
  it('anchors the broadcast day to local midnight', () => {
    const r = new RealTimeClock().read(at('2026-03-04T14:30:00Z'));
    expect(new Date(r.dayStartMs).toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(r.dayHour).toBeCloseTo(14.5, 6);
    expect(r.timelineRate).toBe(1);
  });

  it('brackets the day with the neighbouring midnights', () => {
    const r = new RealTimeClock().read(at('2026-03-04T14:30:00Z'));
    expect(new Date(r.prevDayStartMs).toISOString()).toBe('2026-03-03T00:00:00.000Z');
    expect(new Date(r.nextDayStartMs).toISOString()).toBe('2026-03-05T00:00:00.000Z');
    expect(r.dayLengthMs).toBe(86_400_000);
  });
});

describe('CompressedClock', () => {
  const clock = new CompressedClock(24 * 60_000); // 24 real minutes per day

  it('runs a full broadcast day per configured span', () => {
    const r = clock.read(GAME_EPOCH_MS + 12 * 60_000);
    expect(r.dayIndex).toBe(0);
    expect(r.dayHour).toBeCloseTo(12, 6);
    expect(r.timelineRate).toBeCloseTo(60, 6);
  });

  it('rolls over into the next day', () => {
    const r = clock.read(GAME_EPOCH_MS + 24 * 60_000 + 6 * 60_000);
    expect(r.dayIndex).toBe(1);
    expect(r.dayHour).toBeCloseTo(6, 6);
  });

  it('is a pure function of wall-clock time', () => {
    const t = GAME_EPOCH_MS + 987_654_321;
    expect(clock.read(t)).toEqual(clock.read(t));
  });
});

describe('formatDayHour', () => {
  it('formats and wraps', () => {
    expect(formatDayHour(0)).toBe('00:00');
    expect(formatDayHour(14.5)).toBe('14:30');
    expect(formatDayHour(25)).toBe('01:00');
  });
});
