import { describe, expect, it } from 'vitest';
import { CompressedClock, GAME_EPOCH_MS, RealTimeClock } from '../src/core/clock';
import { normalizeStation, resolvePlayback, resolveProgram } from '../src/core/schedule';
import type { Station, Track } from '../src/core/types';

const at = (iso: string) => Date.parse(iso);

/** These check how the playlist is sequenced, so the seam overlap is off. */
const NO_SEAM = { seamSeconds: 0 };

function track(id: string, duration: number): Track {
  return { id, name: id, duration, src: `music/${id}.flac` };
}

const tracks = new Map<string, Track>([
  ['a', track('a', 100)],
  ['b', track('b', 200)],
  ['c', track('c', 60)],
  ['zero', track('zero', 0)],
]);

const dayparted: Station = normalizeStation({
  id: 'st',
  name: 'Test',
  channel: 3,
  programs: [
    { id: 'night', name: 'Night', startHour: 22, trackIds: ['c'] },
    { id: 'morning', name: 'Morning', startHour: 6, trackIds: ['a', 'b'] },
    { id: 'evening', name: 'Evening', startHour: 18, trackIds: ['b'] },
  ],
});

const continuous: Station = {
  id: 'cont',
  name: 'Continuous',
  channel: 1,
  programs: [{ id: 'all', name: 'All Day', startHour: 0, trackIds: ['a', 'b'] }],
};

describe('normalizeStation', () => {
  it('sorts programs by start hour', () => {
    expect(dayparted.programs.map((p) => p.id)).toEqual(['morning', 'evening', 'night']);
  });
});

describe('resolveProgram', () => {
  const clock = new RealTimeClock();

  it('picks the program whose window contains now', () => {
    const inst = resolveProgram(dayparted, clock.read(at('2026-03-04T07:00:00Z')));
    expect(inst?.program.id).toBe('morning');
    expect(new Date(inst!.startMs).toISOString()).toBe('2026-03-04T06:00:00.000Z');
    expect(new Date(inst!.endMs).toISOString()).toBe('2026-03-04T18:00:00.000Z');
  });

  it('carries the last program over past midnight', () => {
    const inst = resolveProgram(dayparted, clock.read(at('2026-03-04T02:00:00Z')));
    expect(inst?.program.id).toBe('night');
    // Started at 22:00 the previous day and runs until the 06:00 handover.
    expect(new Date(inst!.startMs).toISOString()).toBe('2026-03-03T22:00:00.000Z');
    expect(new Date(inst!.endMs).toISOString()).toBe('2026-03-04T06:00:00.000Z');
  });

  it('gives a single program the whole day', () => {
    const inst = resolveProgram(continuous, clock.read(at('2026-03-04T13:00:00Z')));
    expect(inst?.program.id).toBe('all');
    expect(inst!.endMs - inst!.startMs).toBe(86_400_000);
  });

  it('returns null when a station has no programs', () => {
    const empty: Station = { id: 'x', name: 'x', channel: 2, programs: [] };
    expect(resolveProgram(empty, clock.read(at('2026-03-04T13:00:00Z')))).toBeNull();
  });
});

describe('resolvePlayback in real time', () => {
  const clock = new RealTimeClock();

  it('drops the listener mid-broadcast rather than starting at track one', () => {
    // 06:00 handover + 250s => 100s of 'a', then 150s into 'b'.
    const p = resolvePlayback(dayparted, clock.read(at('2026-03-04T06:04:10Z')), tracks, NO_SEAM);
    expect(p?.track.id).toBe('b');
    expect(p?.offsetSec).toBeCloseTo(150, 6);
    expect(p?.cycleSec).toBe(300);
  });

  it('loops the playlist for the length of the program', () => {
    const p = resolvePlayback(dayparted, clock.read(at('2026-03-04T06:05:10Z')), tracks, NO_SEAM);
    expect(p?.track.id).toBe('a'); // 310s in => wrapped past the 300s cycle
    expect(p?.offsetSec).toBeCloseTo(10, 6);
  });

  it('reports when the current track hands over', () => {
    const now = at('2026-03-04T06:00:30Z');
    const p = resolvePlayback(dayparted, clock.read(now), tracks, NO_SEAM);
    expect(p!.trackEndsAtMs - now).toBeCloseTo(70_000, 0);
  });

  it('is stable: two readings a second apart advance by exactly a second', () => {
    const t = at('2026-03-04T09:13:07Z');
    const a = resolvePlayback(dayparted, clock.read(t), tracks, NO_SEAM)!;
    const b = resolvePlayback(dayparted, clock.read(t + 1000), tracks, NO_SEAM)!;
    expect(b.offsetSec - a.offsetSec).toBeCloseTo(1, 6);
  });

  it('skips missing and zero-length tracks', () => {
    const patchy: Station = {
      id: 'p', name: 'P', channel: 2,
      programs: [{ id: 'x', name: 'X', startHour: 0, trackIds: ['missing', 'zero', 'c'] }],
    };
    const p = resolvePlayback(patchy, clock.read(at('2026-03-04T00:00:10Z')), tracks, NO_SEAM);
    expect(p?.track.id).toBe('c');
    expect(p?.cycleSec).toBe(60);
  });

  it('is dead air when nothing playable is scheduled', () => {
    const silent: Station = {
      id: 's', name: 'S', channel: 2,
      programs: [{ id: 'x', name: 'X', startHour: 0, trackIds: [] }],
    };
    expect(resolvePlayback(silent, clock.read(at('2026-03-04T00:00:10Z')), tracks, NO_SEAM)).toBeNull();
  });
});

describe('resolvePlayback in game time', () => {
  const clock = new CompressedClock(24 * 60_000); // 1 broadcast day = 24 real minutes

  it('runs the dayparts fast while the music stays at 1x', () => {
    // 6 real minutes in = 06:00 broadcast, the morning handover.
    const start = clock.read(GAME_EPOCH_MS + 6 * 60_000);
    expect(resolveProgram(dayparted, start)?.program.id).toBe('morning');

    // 30 real seconds later the music has advanced 30 real seconds, not 30 minutes.
    const later = clock.read(GAME_EPOCH_MS + 6 * 60_000 + 30_000);
    expect(resolvePlayback(dayparted, later, tracks, NO_SEAM)?.offsetSec).toBeCloseTo(30, 3);
  });

  it('compresses the music too when asked', () => {
    const later = clock.read(GAME_EPOCH_MS + 6 * 60_000 + 3_000);
    const p = resolvePlayback(dayparted, later, tracks, { ...NO_SEAM, timelineScale: later.timelineRate });
    // 3 real seconds x60 = 180 broadcast seconds: 100s of 'a' then 80s into 'b'.
    expect(p?.track.id).toBe('b');
    expect(p?.offsetSec).toBeCloseTo(80, 3);
  });

  it('changes program after a few real minutes', () => {
    const before = clock.read(GAME_EPOCH_MS + 17 * 60_000 + 59_000);
    const after = clock.read(GAME_EPOCH_MS + 18 * 60_000 + 1_000);
    expect(resolveProgram(dayparted, before)?.program.id).toBe('morning');
    expect(resolveProgram(dayparted, after)?.program.id).toBe('evening');
  });
});
