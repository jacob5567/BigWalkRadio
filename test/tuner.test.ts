import { describe, expect, it } from 'vitest';
import { DEFAULT_DIAL, lowpassHz, readDial } from '../src/core/tuner';
import type { Station } from '../src/core/types';

const station = (id: string, channel: number): Station => ({
  id, name: id, channel, programs: [{ id: `${id}-p`, name: 'p', startHour: 0, trackIds: [] }],
});

const stations = [station('a', 3), station('b', 4), station('c', 7)];

describe('readDial', () => {
  it('locks cleanly when tuned exactly', () => {
    const d = readDial(stations, 3);
    expect(d.locked?.station.id).toBe('a');
    expect(d.lock).toBeCloseTo(1, 6);
    expect(d.staticGain).toBeCloseTo(0, 6);
    expect(d.signals.find((s) => s.station.id === 'a')!.gain).toBeCloseTo(1, 6);
  });

  it('is all static in a gap between stations', () => {
    const d = readDial(stations, 5.5);
    expect(d.locked).toBeNull();
    expect(d.staticGain).toBeGreaterThan(0.95);
  });

  it('suppresses the neighbour via the capture effect', () => {
    const d = readDial(stations, 3.1);
    const a = d.signals.find((s) => s.station.id === 'a')!;
    const b = d.signals.find((s) => s.station.id === 'b')!;
    expect(a.gain).toBeGreaterThan(b.gain * 5);
  });

  it('falls to half strength at the configured half-width', () => {
    const d = readDial([station('a', 3)], 3 + DEFAULT_DIAL.halfWidth);
    expect(d.signals[0]!.raw).toBeCloseTo(0.5, 6);
  });

  it('handles an empty dial', () => {
    const d = readDial([], 3);
    expect(d.locked).toBeNull();
    expect(d.staticGain).toBe(1);
  });
});

describe('lowpassHz', () => {
  it('opens up as the signal strengthens', () => {
    expect(lowpassHz(0)).toBeCloseTo(600, 6);
    expect(lowpassHz(1)).toBeCloseTo(20000, 6);
    expect(lowpassHz(0.5)).toBeGreaterThan(600);
    expect(lowpassHz(0.5)).toBeLessThan(20000);
  });
});
