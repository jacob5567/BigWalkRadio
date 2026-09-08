import { describe, expect, it } from 'vitest';
import { RealTimeClock } from '../src/core/clock';
import { DEFAULT_SEAM_SECONDS, resolveStationLayers } from '../src/core/schedule';
import type { Station, Track } from '../src/core/types';

const clock = new RealTimeClock();
const track = (id: string, duration: number): Track => ({
  id, name: id, duration, src: `music/${id}.mp3`,
});

const tracks = new Map<string, Track>([
  ['motif', track('motif', 270)],
  ['leitmotif', track('leitmotif', 281)],
  ['a', track('a', 100)],
  ['b', track('b', 200)],
]);

const SEAM = 0.15;
/** The Leitmotif daypart starts here; one track, repeating until 2:41pm. */
const DAYPART_START = Date.parse('2026-03-04T07:12:00Z');
const STRIDE = 281 - SEAM;

const lobby: Station = {
  id: 'lobby',
  name: 'Lobby',
  channel: 5,
  programs: [
    { id: 'motif', name: 'Motif', startHour: 0, trackIds: ['motif'] },
    { id: 'leitmotif', name: 'Leitmotif', startHour: 7.2, trackIds: ['leitmotif'] },
    { id: 'refrain', name: 'Refrain', startHour: 14 + 41 / 60, trackIds: ['motif'] },
  ],
};

/** Layers `sec` into the Leitmotif daypart, with the programme handover out of the way. */
const at = (sec: number, seamSeconds = SEAM) =>
  resolveStationLayers(lobby, clock.read(DAYPART_START + sec * 1000), tracks, {
    seamSeconds,
    blendSeconds: 0,
  });

const audible = (layers: ReturnType<typeof at>) => layers.filter((l) => l.playing);

describe('a track giving way to itself', () => {
  it('plays one copy in the body of a pass', () => {
    const layers = audible(at(120));
    expect(layers).toHaveLength(1);
    expect(layers[0]!.track.id).toBe('leitmotif');
    expect(layers[0]!.blend).toBe(1);
    expect(layers[0]!.pass).toBe(0);
  });

  it('overlaps the end of one pass with the start of the next', () => {
    const layers = audible(at(STRIDE + SEAM / 2));
    expect(layers).toHaveLength(2);

    const [incoming, outgoing] = [
      layers.find((l) => l.pass === 1)!,
      layers.find((l) => l.pass === 0)!,
    ];
    expect(incoming.track.id).toBe('leitmotif');
    expect(outgoing.track.id).toBe('leitmotif');
    // The new pass is just starting; the old one is in its last moments.
    expect(incoming.offsetSec).toBeCloseTo(SEAM / 2, 6);
    expect(outgoing.offsetSec).toBeCloseTo(STRIDE + SEAM / 2, 6);
    expect(outgoing.offsetSec).toBeLessThan(281);
  });

  it('trades them at equal power, so the seam never dips', () => {
    // This is the fix: sampled right across the loop point, something is
    // always at full power, where before there was a silent gap.
    for (let t = STRIDE - 0.5; t < STRIDE + SEAM + 0.5; t += 0.005) {
      const power = audible(at(t)).reduce((sum, l) => sum + l.blend ** 2, 0);
      expect(power, `${t.toFixed(3)}s in`).toBeCloseTo(1, 6);
    }
  });

  it('shortens the pass by the overlap, so the schedule stays exact', () => {
    expect(at(10)[0]!.cycleSec).toBeCloseTo(STRIDE, 6);
    // A whole stride on, the next pass is up and at the same point in itself.
    const first = audible(at(40));
    const second = audible(at(40 + STRIDE));
    expect(second[0]!.pass).toBe(first[0]!.pass + 1);
    expect(second[0]!.offsetSec).toBeCloseTo(first[0]!.offsetSec, 6);
  });

  it('cues the next pass before it is needed', () => {
    const layers = at(STRIDE - 4);
    const cued = layers.find((l) => !l.playing)!;
    expect(cued).toBeDefined();
    expect(cued.pass).toBe(1);
    expect(cued.offsetSec).toBe(0);
    expect(cued.blend).toBe(0);
    // The one already sounding is untouched by the cueing.
    expect(audible(layers)).toHaveLength(1);
    expect(audible(layers)[0]!.blend).toBe(1);
  });

  it('does not cue anything in the middle of a long track', () => {
    expect(at(120).every((l) => l.playing)).toBe(true);
  });

  it('leaves no overlap at the very start, where the daypart handover covers it', () => {
    const layers = audible(at(0.05));
    expect(layers).toHaveLength(1);
    expect(layers[0]!.pass).toBe(0);
    expect(layers[0]!.blend).toBe(1);
  });

  it('goes back to a hard change when the seam is turned off', () => {
    const layers = audible(at(281 - 0.01, 0));
    expect(layers).toHaveLength(1);
    expect(layers[0]!.cycleSec).toBe(281);
  });
});

describe('one track giving way to another', () => {
  const mixed: Station = {
    id: 'mixed',
    name: 'Mixed',
    channel: 1,
    programs: [{ id: 'p', name: 'P', startHour: 0, trackIds: ['a', 'b'] }],
  };
  const layersAt = (sec: number, seamSeconds = SEAM) =>
    resolveStationLayers(mixed, clock.read(Date.parse('2026-03-04T00:00:00Z') + sec * 1000), tracks, {
      seamSeconds,
      blendSeconds: 0,
    }).filter((l) => l.playing);

  it('overlaps the two tracks across the join', () => {
    // 'a' strides for 100 - 0.15, then 'b' comes in over its tail.
    const layers = layersAt(100 - SEAM + SEAM / 2);
    expect(layers.map((l) => l.track.id).sort()).toEqual(['a', 'b']);
    for (const layer of layers) expect(layer.blend).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('keeps a constant power across that join too', () => {
    for (let t = 99; t < 101; t += 0.01) {
      const power = layersAt(t).reduce((sum, l) => sum + l.blend ** 2, 0);
      expect(power, `${t.toFixed(2)}s in`).toBeCloseTo(1, 6);
    }
  });
});

describe('the seam length', () => {
  it('is never more than half the shortest track', () => {
    const brief: Station = {
      id: 'brief', name: 'Brief', channel: 1,
      programs: [{ id: 'p', name: 'P', startHour: 0, trackIds: ['a'] }],
    };
    const layers = resolveStationLayers(brief, clock.read(Date.parse('2026-03-04T00:00:30Z')), tracks, {
      seamSeconds: 500, // absurd, against a 100s track
      blendSeconds: 0,
    });
    // Clamped to 50s, so the pass is 50s long rather than collapsing.
    expect(layers[0]!.cycleSec).toBeCloseTo(50, 6);
  });

  it('defaults to something short enough to be inaudible', () => {
    expect(DEFAULT_SEAM_SECONDS).toBeGreaterThan(0);
    expect(DEFAULT_SEAM_SECONDS).toBeLessThan(0.5);
  });
});
