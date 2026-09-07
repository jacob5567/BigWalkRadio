import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNE, OFF, nextPosition, readTuning } from '../src/core/tuning';

const { staticMs, fadeMs } = DEFAULT_TUNE;

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
  it('covers the change with static before the channel arrives', () => {
    const early = readTuning(0, true);
    expect(early.staticGain).toBe(1);
    expect(early.stationGain).toBe(0);
    expect(early.settling).toBe(true);

    const late = readTuning(staticMs - 1, true);
    expect(late.staticGain).toBe(1);
    expect(late.stationGain).toBe(0);
  });

  it('trades the static for the channel at equal power', () => {
    const mid = readTuning(staticMs + fadeMs / 2, true);
    expect(mid.stationGain).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.staticGain).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.stationGain ** 2 + mid.staticGain ** 2).toBeCloseTo(1, 6);
    expect(mid.settling).toBe(true);
  });

  it('settles into a clean channel', () => {
    const done = readTuning(staticMs + fadeMs, true);
    expect(done).toEqual({ stationGain: 1, staticGain: 0, settling: false });
    expect(readTuning(60_000, true)).toEqual(done);
  });

  it('fades the static into silence when switched off', () => {
    expect(readTuning(0, false).staticGain).toBe(1);
    expect(readTuning(staticMs + fadeMs / 2, false).stationGain).toBe(0);
    expect(readTuning(staticMs + fadeMs / 2, false).staticGain).toBeCloseTo(Math.SQRT1_2, 6);
    expect(readTuning(staticMs + fadeMs, false)).toEqual({
      stationGain: 0, staticGain: 0, settling: false,
    });
  });

  it('is quiet and settled before the switch has ever been touched', () => {
    const untouched = readTuning(Number.POSITIVE_INFINITY, false);
    expect(untouched).toEqual({ stationGain: 0, staticGain: 0, settling: false });
  });

  it('never leaves a silent gap between the static and the channel', () => {
    for (let t = 0; t <= staticMs + fadeMs; t += 5) {
      const { stationGain, staticGain } = readTuning(t, true);
      expect(Math.max(stationGain, staticGain), `at ${t}ms`).toBeGreaterThan(0.65);
    }
  });
});
