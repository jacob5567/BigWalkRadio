import { describe, expect, it } from 'vitest';
import { RealTimeClock } from '../src/core/clock';
import { orderForPass, resolvePlayback } from '../src/core/schedule';
import type { Program, Station, Track } from '../src/core/types';

const at = (iso: string) => Date.parse(iso);
const clock = new RealTimeClock();

const track = (id: string, duration: number): Track => ({
  id, name: id, duration, src: `music/${id}.mp3`,
});

// Modelled on B-Sides: one long track and three short ones, all day, shuffled.
const tracks = new Map<string, Track>([
  ['gauntlet', track('gauntlet', 1521)],
  ['menu', track('menu', 243)],
  ['mic', track('mic', 189)],
  ['credits', track('credits', 180)],
]);
const ids = [...tracks.keys()];
const list = ids.map((id) => tracks.get(id)!);

const program: Program = {
  id: 'st-bsides-p1', name: 'B-Sides', startHour: 0, trackIds: ids, order: 'shuffle',
};
const bsides: Station = { id: 'st-bsides', name: 'B-Sides', channel: 8, programs: [program] };

describe('orderForPass', () => {
  it('deals the same order every time for a given pass', () => {
    expect(orderForPass(program, list, 7)).toEqual(orderForPass(program, list, 7));
  });

  it('deals a different order on a later pass', () => {
    const orders = new Set<string>();
    for (let pass = 0; pass < 12; pass++) {
      orders.add(orderForPass(program, list, pass).map((t) => t.id).join(','));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('always deals every track exactly once', () => {
    for (let pass = 0; pass < 30; pass++) {
      const order = orderForPass(program, list, pass);
      expect([...order].map((t) => t.id).sort()).toEqual([...ids].sort());
    }
  });

  it('never repeats a track across the pass boundary', () => {
    for (let pass = 1; pass < 60; pass++) {
      const previous = orderForPass(program, list, pass - 1);
      const current = orderForPass(program, list, pass);
      expect(current[0]!.id, `pass ${pass}`).not.toBe(previous[previous.length - 1]!.id);
    }
  });

  it('leaves an ordinary program in its listed order', () => {
    const sequence: Program = { ...program, order: 'sequence' };
    expect(orderForPass(sequence, list, 5)).toEqual(list);
    expect(orderForPass({ ...program, order: undefined }, list, 5)).toEqual(list);
  });

  it('has nothing to shuffle with a single track', () => {
    expect(orderForPass(program, list.slice(0, 1), 3)).toEqual(list.slice(0, 1));
  });
});

describe('a shuffled channel', () => {
  it('plays without looping a single track', () => {
    const point = resolvePlayback(bsides, clock.read(at('2026-03-04T10:00:00Z')), tracks)!;
    expect(point.loops).toBe(false);
    expect(point.cycleSec).toBe(1521 + 243 + 189 + 180);
  });

  it('stays on the same broadcast however often it is asked', () => {
    const now = clock.read(at('2026-03-04T13:37:11Z'));
    const a = resolvePlayback(bsides, now, tracks)!;
    const b = resolvePlayback(bsides, now, tracks)!;
    expect(b.track.id).toBe(a.track.id);
    expect(b.offsetSec).toBeCloseTo(a.offsetSec, 9);
  });

  it('advances in real time like any other channel', () => {
    const t = at('2026-03-04T13:37:11Z');
    const a = resolvePlayback(bsides, clock.read(t), tracks)!;
    const b = resolvePlayback(bsides, clock.read(t + 1000), tracks)!;
    if (b.track.id === a.track.id) expect(b.offsetSec - a.offsetSec).toBeCloseTo(1, 6);
  });

  it('works through the whole playlist over a day, in varying orders', () => {
    const heard = new Set<string>();
    const sequence: string[] = [];
    // The playlist runs about 35 minutes, so sample across a full day.
    for (let minute = 0; minute < 1440; minute += 3) {
      const point = resolvePlayback(bsides, clock.read(at('2026-03-04T00:00:00Z') + minute * 60_000), tracks)!;
      heard.add(point.track.id);
      if (sequence.at(-1) !== point.track.id) sequence.push(point.track.id);
    }
    expect([...heard].sort()).toEqual([...ids].sort());
    // A fixed rotation would repeat the same run over and over.
    const runs = sequence.slice(0, 8).join(',');
    expect(sequence.slice(8, 16).join(',')).not.toBe(runs);
  });
});
