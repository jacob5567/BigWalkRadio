// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../src/core/catalog';
import { Radio } from '../src/core/radio';
import { RadioUI } from '../src/app/ui';
import { installBrowserStubs, resetStorage } from './browser-stubs';

/** The station the tests tune to, and the daypart on air at 10:00. */
const STATION = 'Lobby';
const DAYPART = 'Leitmotif';

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
    expect(stations.some((s) => s.name === STATION)).toBe(true);
  });

  it('comes ready to play, with every album daypart already pointing at a file', () => {
    for (const station of radio.getStations()) {
      if (station.name === 'Open Channel') continue;
      for (const program of station.programs) {
        expect(program.trackIds).toHaveLength(1);
        const track = radio.catalog.get(program.trackIds[0]!);
        expect(track, `${station.name}/${program.name}`).toBeDefined();
        expect(track!.duration).toBeGreaterThan(0);
        expect(track!.src.startsWith('music/')).toBe(true);
      }
    }
  });

  it('plays the daypart whose time has come', () => {
    const lobby = radio.getStations().find((s) => s.name === STATION)!;
    radio.setChannel(lobby.channel);

    const tuned = radio.snapshot().tuned!;
    expect(tuned.station.name).toBe(STATION);
    expect(tuned.playing!.instance.program.name).toBe(DAYPART);
    // 10:00 is well into the 07:12 daypart, so the track has looped.
    expect(tuned.playing!.loops).toBe(true);
    expect(tuned.playing!.offsetSec).toBeGreaterThan(0);
  });

  it('hands the right stream to the audio engine once powered on', async () => {
    const lobby = radio.getStations().find((s) => s.name === STATION)!;
    radio.setChannel(lobby.channel);

    const update = vi.spyOn(radio.engine, 'update');
    await radio.setPower(true);
    radio.tick();

    const targets = update.mock.lastCall![0];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ loop: true, sync: 'lock' });
    expect(radio.catalog.get(targets[0]!.trackId)!.name).toBe(DAYPART);
    expect(targets[0]!.gain).toBeCloseTo(1, 6);
  });

  it('feeds both sides of a handover to the engine at once', async () => {
    const lobby = radio.getStations().find((s) => s.name === STATION)!;
    radio.setChannel(lobby.channel);
    await radio.setPower(true);

    // Four seconds into the 07:12 handover, halfway through an 8s blend.
    vi.setSystemTime(Date.parse('2026-03-04T07:12:04Z'));
    const update = vi.spyOn(radio.engine, 'update');
    radio.tick();

    const targets = update.mock.lastCall![0];
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => radio.catalog.get(t.trackId)!.name).sort()).toEqual(['Leitmotif', 'Motif']);
    for (const target of targets) expect(target.gain).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('goes quiet between channels and loud on one', () => {
    const lobby = radio.getStations().find((s) => s.name === STATION)!;

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
});

describe('Catalog', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('points at files under the site root, escaped for the URL', () => {
    const catalog = new Catalog([
      { id: 'a', name: 'A', duration: 10, src: 'music/Some Album (Live)/01 -7-12am- A.flac' },
    ]);
    expect(catalog.urlFor('a')).toBe('/music/Some%20Album%20(Live)/01%20-7-12am-%20A.flac');
    expect(catalog.urlFor('nope')).toBeNull();
  });

  it('reports which files the host is missing', async () => {
    const catalog = new Catalog([
      { id: 'a', name: 'A', duration: 10, src: 'music/a.flac' },
      { id: 'b', name: 'B', duration: 10, src: 'music/b.flac' },
    ]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: !url.endsWith('b.flac') })));

    await catalog.checkAvailability();
    expect(catalog.statusOf('a')).toBe('present');
    expect(catalog.statusOf('b')).toBe('missing');
    expect(catalog.missingCount).toBe(1);
  });

  it('ships a duration for every track so the schedule is right before anything loads', () => {
    expect(new Catalog().list().every((t) => t.duration > 0)).toBe(true);
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

  async function mount() {
    const root = document.createElement('div');
    document.body.append(root);
    const radio = new Radio();
    new RadioUI(radio, root).mount();
    await radio.init();
    return { root, radio };
  }

  it('mounts and shows what is on air', async () => {
    const { root, radio } = await mount();
    const lobby = radio.getStations().find((s) => s.name === STATION)!;
    radio.setChannel(lobby.channel);

    expect(root.querySelector('.channel-number')!.textContent).toBe(String(lobby.channel));
    expect(root.querySelector('.station-name')!.textContent).toBe(STATION);
    expect(root.querySelector('.track')!.textContent).toBe(DAYPART);
    expect(root.querySelector('.position')!.textContent).toContain('looping');
    expect(root.querySelectorAll('.tab')).toHaveLength(3);
  });

  it('lists every daypart on the schedule tab', async () => {
    const { root } = await mount();
    root.querySelectorAll<HTMLButtonElement>('.tab')[1]!.click();
    expect(root.querySelectorAll('.station')).toHaveLength(8);
    // 24 dayparts across the seven albums, plus the empty eighth channel.
    expect(root.querySelectorAll('.program')).toHaveLength(25);
  });

  it('lists the files the host has to provide', async () => {
    const { root } = await mount();
    root.querySelectorAll<HTMLButtonElement>('.tab')[2]!.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.track-row').length).toBe(24));
    expect(root.querySelector('.path')!.textContent).toMatch(/^music\//);
  });
});
