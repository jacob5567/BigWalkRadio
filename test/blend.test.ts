import { describe, expect, it } from 'vitest';
import { RealTimeClock } from '../src/core/clock';
import { normalizeStation, resolveStationLayers } from '../src/core/schedule';
import type { Station, Track } from '../src/core/types';

const at = (iso: string) => Date.parse(iso);
const clock = new RealTimeClock();

const track = (id: string, duration: number): Track => ({
  id, name: id, duration, mime: 'audio/flac', size: 1, addedAt: 0,
});

const tracks = new Map<string, Track>([
  ['motif', track('motif', 270)],
  ['leitmotif', track('leitmotif', 281)],
  ['refrain', track('refrain', 358)],
]);

// Modelled on the Lobby station: one looping track per time of day.
const lobby: Station = normalizeStation({
  id: 'lobby',
  name: 'Lobby',
  channel: 5,
  programs: [
    { id: 'motif', name: 'Motif', startHour: 0, trackIds: ['motif'] },
    { id: 'leitmotif', name: 'Leitmotif', startHour: 7.2, trackIds: ['leitmotif'] },
    { id: 'refrain', name: 'Refrain', startHour: 14 + 41 / 60, trackIds: ['refrain'] },
  ],
});

describe('resolveStationLayers', () => {
  it('plays one looping daypart outside a handover', () => {
    const layers = resolveStationLayers(lobby, clock.read(at('2026-03-04T10:00:00Z')), tracks);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.track.id).toBe('leitmotif');
    expect(layers[0]!.blend).toBe(1);
    expect(layers[0]!.loops).toBe(true);
  });

  it('repeats the track for the whole daypart', () => {
    // 07:12 + 300s is past the 281s track, so it has wrapped to 19s in.
    const layers = resolveStationLayers(lobby, clock.read(at('2026-03-04T07:17:00Z')), tracks);
    expect(layers[0]!.track.id).toBe('leitmotif');
    expect(layers[0]!.offsetSec).toBeCloseTo(19, 3);
  });

  it('overlaps both dayparts across the handover', () => {
    // 4s into an 8s blend, at the 07:12 change from Motif to Leitmotif.
    const layers = resolveStationLayers(lobby, clock.read(at('2026-03-04T07:12:04Z')), tracks, {
      blendSeconds: 8,
    });
    expect(layers.map((l) => l.track.id)).toEqual(['leitmotif', 'motif']);
    expect(layers[0]!.blend).toBeCloseTo(Math.SQRT1_2, 6);
    expect(layers[1]!.blend).toBeCloseTo(Math.SQRT1_2, 6);
    // Equal-power: the pair holds a constant power sum through the fade.
    const power = layers.reduce((sum, l) => sum + l.blend ** 2, 0);
    expect(power).toBeCloseTo(1, 6);
  });

  it('starts the incoming daypart from the top of its track', () => {
    const layers = resolveStationLayers(lobby, clock.read(at('2026-03-04T07:12:00.000Z')), tracks);
    expect(layers[0]!.track.id).toBe('leitmotif');
    expect(layers[0]!.offsetSec).toBeCloseTo(0, 6);
    expect(layers[0]!.blend).toBeCloseTo(0, 6);
    expect(layers[1]!.blend).toBeCloseTo(1, 6);
  });

  it('lets the outgoing daypart keep its own position while it fades', () => {
    const layers = resolveStationLayers(lobby, clock.read(at('2026-03-04T07:12:04Z')), tracks);
    const outgoing = layers.find((l) => l.role === 'outgoing')!;
    // Motif ran from 00:00, so it is 4s past a whole number of 270s loops.
    const elapsed = 7 * 3600 + 12 * 60 + 4;
    expect(outgoing.offsetSec).toBeCloseTo(elapsed % 270, 3);
  });

  it('is finished blending once the window has passed', () => {
    const layers = resolveStationLayers(lobby, clock.read(at('2026-03-04T07:12:20Z')), tracks, {
      blendSeconds: 8,
    });
    expect(layers).toHaveLength(1);
    expect(layers[0]!.blend).toBe(1);
  });

  it('blends across midnight, from the last daypart into the first', () => {
    const layers = resolveStationLayers(lobby, clock.read(at('2026-03-04T00:00:03Z')), tracks);
    expect(layers.map((l) => l.track.id)).toEqual(['motif', 'refrain']);
  });

  it('caps the blend so a short daypart is not mostly crossfade', () => {
    const brief: Station = normalizeStation({
      id: 'b', name: 'B', channel: 2,
      programs: [
        { id: 'one', name: 'One', startHour: 0, trackIds: ['motif'] },
        // A 20-second daypart: the blend must not exceed a quarter of it.
        { id: 'two', name: 'Two', startHour: 20 / 3600, trackIds: ['leitmotif'] },
        { id: 'three', name: 'Three', startHour: 40 / 3600, trackIds: ['refrain'] },
      ],
    });
    const during = resolveStationLayers(brief, clock.read(at('2026-03-04T00:00:26Z')), tracks, {
      blendSeconds: 8,
    });
    expect(during).toHaveLength(1); // 6s into 'two', past its 5s cap
  });

  it('keeps the outgoing daypart audible when the incoming one is empty', () => {
    const patchy: Station = normalizeStation({
      id: 'p', name: 'P', channel: 2,
      programs: [
        { id: 'one', name: 'One', startHour: 0, trackIds: ['motif'] },
        { id: 'empty', name: 'Empty', startHour: 7, trackIds: [] },
      ],
    });
    const layers = resolveStationLayers(patchy, clock.read(at('2026-03-04T07:00:02Z')), tracks);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.role).toBe('outgoing');
    expect(layers[0]!.blend).toBeLessThan(1);
  });

  it('has nothing to blend on a single-daypart station', () => {
    const solo: Station = {
      id: 's', name: 'S', channel: 2,
      programs: [{ id: 'all', name: 'All', startHour: 0, trackIds: ['motif'] }],
    };
    const layers = resolveStationLayers(solo, clock.read(at('2026-03-04T00:00:02Z')), tracks);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.blend).toBe(1);
  });
});
