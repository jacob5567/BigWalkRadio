// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putTrack } from '../src/core/db';
import { Radio } from '../src/core/radio';
import { RadioUI } from '../src/app/ui';
import type { Track } from '../src/core/types';
import { installBrowserStubs, resetStorage } from './browser-stubs';

const track = (id: string, name: string, duration: number): Track => ({
  id, name, duration, mime: 'audio/flac', size: 1024, addedAt: Date.now(),
});

/** Put audio in the library without decoding anything. */
async function seed(radio: Radio, tracks: Track[]): Promise<void> {
  for (const t of tracks) await putTrack(t, new Blob(['x'], { type: t.mime }));
  await radio.library.load();
}

describe('Radio end to end', () => {
  let radio: Radio;

  beforeEach(async () => {
    installBrowserStubs();
    await resetStorage();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-03-04T10:00:00Z'));
    radio = new Radio();
    await radio.init();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts on the preset dial with eight channels', () => {
    const stations = radio.getStations();
    expect(stations).toHaveLength(8);
    expect(stations.map((s) => s.channel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(stations.some((s) => s.name === 'Lobby')).toBe(true);
  });

  it('is silent until the listener supplies audio', () => {
    const state = radio.snapshot();
    expect(state.stations.every((s) => s.layers.length === 0)).toBe(true);
  });

  it('files imported names into the matching station and daypart', async () => {
    await seed(radio, [track('t1', 'Leitmotif', 281)]);
    const lobby = radio.getStations().find((s) => s.name === 'Lobby')!;
    const slot = lobby.programs.find((p) => p.name === 'Leitmotif')!;
    radio.mutateStation(lobby.id, (s) => ({
      ...s,
      programs: s.programs.map((p) => (p.id === slot.id ? { ...p, trackIds: ['t1'] } : p)),
    }));

    radio.setChannel(lobby.channel);
    const tuned = radio.snapshot().tuned!;
    expect(tuned.station.name).toBe('Lobby');
    expect(tuned.playing!.track.name).toBe('Leitmotif');
    // 10:00 is 2h48m into the 07:12 daypart, so the track has looped.
    expect(tuned.playing!.loops).toBe(true);
    expect(tuned.playing!.offsetSec).toBeGreaterThan(0);
  });

  it('hands the right streams to the audio engine once powered on', async () => {
    await seed(radio, [track('t1', 'Leitmotif', 281)]);
    const lobby = radio.getStations().find((s) => s.name === 'Lobby')!;
    const slot = lobby.programs.find((p) => p.name === 'Leitmotif')!;
    radio.mutateStation(lobby.id, (s) => ({
      ...s,
      programs: s.programs.map((p) => (p.id === slot.id ? { ...p, trackIds: ['t1'] } : p)),
    }));
    radio.setChannel(lobby.channel);

    const update = vi.spyOn(radio.engine, 'update');
    await radio.setPower(true);
    radio.tick();

    const targets = update.mock.lastCall![0];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ trackId: 't1', loop: true, sync: 'lock' });
    expect(targets[0]!.gain).toBeCloseTo(1, 6);
  });

  it('feeds both sides of a handover to the engine at once', async () => {
    await seed(radio, [track('t1', 'Motif', 270), track('t2', 'Leitmotif', 281)]);
    const lobby = radio.getStations().find((s) => s.name === 'Lobby')!;
    radio.mutateStation(lobby.id, (s) => ({
      ...s,
      programs: s.programs.map((p) =>
        p.name === 'Motif' ? { ...p, trackIds: ['t1'] }
        : p.name === 'Leitmotif' ? { ...p, trackIds: ['t2'] }
        : p),
    }));
    radio.setChannel(lobby.channel);
    await radio.setPower(true);

    // Four seconds into the 07:12 handover, halfway through an 8s blend.
    vi.setSystemTime(Date.parse('2026-03-04T07:12:04Z'));
    const update = vi.spyOn(radio.engine, 'update');
    radio.tick();

    const targets = update.mock.lastCall![0];
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.trackId).sort()).toEqual(['t1', 't2']);
    for (const target of targets) expect(target.gain).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('goes quiet between channels and loud on one', async () => {
    await seed(radio, [track('t1', 'Leitmotif', 281)]);
    const lobby = radio.getStations().find((s) => s.name === 'Lobby')!;
    radio.mutateStation(lobby.id, (s) => ({
      ...s,
      programs: s.programs.map((p) => (p.name === 'Leitmotif' ? { ...p, trackIds: ['t1'] } : p)),
    }));

    radio.setChannel(lobby.channel);
    expect(radio.snapshot().dial.staticGain).toBeCloseTo(0, 3);

    radio.setChannel(lobby.channel + 0.5);
    const between = radio.snapshot();
    expect(between.tuned).toBeNull();
    expect(between.dial.staticGain).toBeGreaterThan(0.9);
  });

  it('keeps its dial, volume and mode across a restart', async () => {
    radio.setChannel(6);
    radio.setVolume(0.42);
    radio.setMode('game');
    radio.setGameDayMinutes(12);
    await vi.waitFor(() => expect(radio.getSettings().channel).toBe(6));
    await new Promise((resolve) => setTimeout(resolve, 400)); // debounced save

    const reopened = new Radio();
    await reopened.init();
    const settings = reopened.getSettings();
    expect(settings.channel).toBe(6);
    expect(settings.volume).toBeCloseTo(0.42, 6);
    expect(settings.mode).toBe('game');
    expect(settings.gameDayMinutes).toBe(12);
    // The radio always comes back switched off; audio needs a fresh gesture.
    expect(settings.powered).toBe(false);
  });

  it('runs the schedule faster in game mode', () => {
    radio.setMode('game');
    radio.setGameDayMinutes(24);
    expect(radio.snapshot().reading.timelineRate).toBeCloseTo(60, 6);
    expect(radio.snapshot().reading.mode).toBe('game');
  });

  it('removing a track clears it from the schedule', async () => {
    await seed(radio, [track('t1', 'Leitmotif', 281)]);
    const lobby = radio.getStations().find((s) => s.name === 'Lobby')!;
    radio.mutateStation(lobby.id, (s) => ({
      ...s,
      programs: s.programs.map((p) => (p.name === 'Leitmotif' ? { ...p, trackIds: ['t1'] } : p)),
    }));
    await radio.removeTrack('t1');

    const after = radio.getStations().find((s) => s.name === 'Lobby')!;
    expect(after.programs.every((p) => p.trackIds.length === 0)).toBe(true);
    expect(radio.library.get('t1')).toBeUndefined();
  });
});

describe('RadioUI', () => {
  beforeEach(async () => {
    installBrowserStubs();
    await resetStorage();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-03-04T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('mounts and shows what is on air', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const radio = new Radio();
    new RadioUI(radio, root).mount();
    await radio.init();

    await seed(radio, [track('t1', 'Leitmotif', 281)]);
    const lobby = radio.getStations().find((s) => s.name === 'Lobby')!;
    radio.mutateStation(lobby.id, (s) => ({
      ...s,
      programs: s.programs.map((p) => (p.name === 'Leitmotif' ? { ...p, trackIds: ['t1'] } : p)),
    }));
    radio.setChannel(lobby.channel);

    expect(root.querySelector('.channel-number')!.textContent).toBe(String(lobby.channel));
    expect(root.querySelector('.station-name')!.textContent).toBe('Lobby');
    expect(root.querySelector('.track')!.textContent).toBe('Leitmotif');
    expect(root.querySelector('.position')!.textContent).toContain('looping');
    expect(root.querySelectorAll('.tab')).toHaveLength(3);
  });

  it('lists every daypart on the schedule tab', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const radio = new Radio();
    new RadioUI(radio, root).mount();
    await radio.init();

    root.querySelectorAll<HTMLButtonElement>('.tab')[1]!.click();
    expect(root.querySelectorAll('.station')).toHaveLength(8);
    // 24 dayparts across the seven albums, plus the empty eighth channel.
    expect(root.querySelectorAll('.program')).toHaveLength(25);
  });
});
