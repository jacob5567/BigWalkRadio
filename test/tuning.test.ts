import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNE, OFF, nextPosition, readTuning } from '../src/core/tuning';

const { holdMs, fadeMs } = DEFAULT_TUNE;

describe('nextPosition', () => {
  it('clicks up through the channels and back to off', () => {
    const walk: number[] = [];
    let p = OFF;
    for (let i = 0; i < 9; i++) {
      p = nextPosition(p, 7);
      walk.push(p);
    }
    expect(walk).toEqual([1, 2, 3, 4, 5, 6, 7, 0, 1]);
  });

  it('stays off when there are no channels to select', () => {
    expect(nextPosition(OFF, 0)).toBe(OFF);
  });
});

describe('readTuning', () => {
  it('holds the channel silent while the click covers the change', () => {
    const early = readTuning(0, true);
    expect(early.stationGain).toBe(0);
    expect(early.settling).toBe(true);
    expect(readTuning(holdMs - 1, true).stationGain).toBe(0);
  });

  it('brings the channel up on an equal-power curve', () => {
    const mid = readTuning(holdMs + fadeMs / 2, true);
    expect(mid.stationGain).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.settling).toBe(true);
  });

  it('settles into a clean channel', () => {
    const done = readTuning(holdMs + fadeMs, true);
    expect(done).toEqual({ stationGain: 1, settling: false });
    expect(readTuning(60_000, true)).toEqual(done);
  });

  it('brings nothing up when switched off', () => {
    expect(readTuning(0, false).stationGain).toBe(0);
    expect(readTuning(holdMs + fadeMs / 2, false).stationGain).toBe(0);
    expect(readTuning(holdMs + fadeMs, false)).toEqual({ stationGain: 0, settling: false });
  });

  it('is quiet and settled before the switch has ever been touched', () => {
    expect(readTuning(Number.POSITIVE_INFINITY, false))
      .toEqual({ stationGain: 0, settling: false });
  });

  it('rises without ever dipping backwards', () => {
    let previous = -1;
    for (let t = 0; t <= holdMs + fadeMs; t += 5) {
      const { stationGain } = readTuning(t, true);
      expect(stationGain, `at ${t}ms`).toBeGreaterThanOrEqual(previous);
      previous = stationGain;
    }
  });

  it("holds the channel back until the radio's own click has landed", () => {
    // The recorded clicks run about 190-270ms, so the silence sits inside the
    // shortest of them and the channel rises across the tail of the longest.
    expect(holdMs).toBeLessThanOrEqual(180);
    expect(holdMs + fadeMs).toBeLessThanOrEqual(400);
  });
});
