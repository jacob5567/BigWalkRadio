// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../src/core/catalog';
import { setKV } from '../src/core/db';
import { Radio } from '../src/core/radio';
import { DEFAULT_TUNE } from '../src/core/tuning';
import { RadioUI } from '../src/app/ui';
import { installBrowserStubs, resetStorage } from './browser-stubs';

/** Long enough for the static to clear and a channel to settle in. */
const SETTLED_MS = DEFAULT_TUNE.staticMs + DEFAULT_TUNE.fadeMs + 10;
const START = Date.parse('2026-03-04T10:00:00Z');

describe('the switch', () => {
  let radio: Radio;

  beforeEach(async () => {
    installBrowserStubs();
    await resetStorage();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    radio = new Radio();
    await radio.init();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Move past the static so the channel is fully up. */
  const settle = () => {
    vi.setSystemTime(Date.now() + SETTLED_MS);
    radio.tick();
  };

  it('has one position per channel, and seven of them', () => {
    expect(radio.channelCount).toBe(7);
    expect(radio.getStations().map((s) => s.channel)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('starts off and silent', () => {
    const state = radio.snapshot();
    expect(state.position).toBe(0);
    expect(state.onAir).toBeNull();
    expect(state.tune).toEqual({ stationGain: 0, staticGain: 0, settling: false });
  });

  it('clicks up through every channel and back to off', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 9; i++) {
      await radio.advance();
      seen.push(radio.snapshot().position);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 0, 1]);
  });

  it('selects the station that sits at each position', async () => {
    await radio.setPosition(5);
    settle();
    const state = radio.snapshot();
    expect(state.onAir!.station.channel).toBe(5);
    expect(state.onAir!.station.name).toBe(radio.getStations()[4]!.name);
  });

  it('starts the audio on the press that turns it on', async () => {
    expect(radio.engine.isRunning).toBe(false);
    await radio.advance();
    expect(radio.engine.isRunning).toBe(true);
  });

  it('covers the change with static before the channel comes up', async () => {
    await radio.setPosition(3);
    const during = radio.snapshot();
    expect(during.tune.staticGain).toBe(1);
    expect(during.tune.stationGain).toBe(0);
    expect(during.tune.settling).toBe(true);

    settle();
    const after = radio.snapshot();
    expect(after.tune.staticGain).toBe(0);
    expect(after.tune.stationGain).toBe(1);
    expect(after.tune.settling).toBe(false);
  });

  it('puts static over every change, not just the first', async () => {
    await radio.setPosition(2);
    settle();
    expect(radio.snapshot().tune.settling).toBe(false);

    await radio.advance();
    expect(radio.snapshot().tune.staticGain).toBe(1);
  });

  it('holds the channel silent while the static is still up', async () => {
    const update = vi.spyOn(radio.engine, 'update');
    const setStatic = vi.spyOn(radio.engine, 'setStaticGain');
    await radio.setPosition(5);

    expect(setStatic).toHaveBeenLastCalledWith(1);
    for (const target of update.mock.lastCall![0]) expect(target.gain).toBe(0);
  });

  it('hands the engine the settled channel at full gain', async () => {
    await radio.setPosition(5);
    const update = vi.spyOn(radio.engine, 'update');
    settle();

    const targets = update.mock.lastCall![0];
    expect(targets).toHaveLength(1);
    expect(targets[0]!.gain).toBeCloseTo(1, 6);
    expect(radio.catalog.get(targets[0]!.trackId)!.name).toBe('Leitmotif');
  });

  it('feeds both sides of a daypart handover to the engine at once', async () => {
    // Turn on early enough that the static has cleared by four seconds into
    // the 07:12 handover, halfway through an 8s blend.
    vi.setSystemTime(Date.parse('2026-03-04T07:12:04Z') - SETTLED_MS);
    await radio.setPosition(5);
    const update = vi.spyOn(radio.engine, 'update');
    settle();

    const targets = update.mock.lastCall![0];
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => radio.catalog.get(t.trackId)!.name).sort()).toEqual(['Leitmotif', 'Motif']);
    for (const target of targets) expect(target.gain).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('lets the audio hardware sleep once the static from switching off dies away', async () => {
    await radio.setPosition(1);
    settle();
    expect(radio.engine.isRunning).toBe(true);

    await radio.setPosition(0);
    expect(radio.engine.isRunning).toBe(true); // still voicing the static
    settle();
    expect(radio.engine.isRunning).toBe(false);
  });
});

describe('what the radio remembers', () => {
  beforeEach(async () => {
    installBrowserStubs();
    await resetStorage();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps volume and clock settings, but always comes back off', async () => {
    const radio = new Radio();
    await radio.init();
    await radio.setPosition(4);
    radio.setVolume(0.42);
    radio.setMode('game');
    radio.setGameDayMinutes(12);
    await new Promise((resolve) => setTimeout(resolve, 400)); // debounced save

    const reopened = new Radio();
    await reopened.init();
    expect(reopened.getSettings().volume).toBeCloseTo(0.42, 6);
    expect(reopened.getSettings().mode).toBe('game');
    expect(reopened.getSettings().gameDayMinutes).toBe(12);
    // Audio can't start without a press, so a saved position would only lie.
    expect(reopened.snapshot().position).toBe(0);
  });

  it('takes the dial from the server, ignoring any it stored before', async () => {
    await setKV('stations', [
      { id: 'stale', name: 'Stale', channel: 1, programs: [{ id: 'p', name: 'P', startHour: 0, trackIds: [] }] },
    ]);
    const radio = new Radio();
    await radio.init();
    expect(radio.getStations()).toHaveLength(7);
    expect(radio.getStations().some((s) => s.name === 'Stale')).toBe(false);
  });

  it('runs the schedule faster in game mode', async () => {
    const radio = new Radio();
    await radio.init();
    radio.setMode('game');
    radio.setGameDayMinutes(24);
    expect(radio.snapshot().reading.timelineRate).toBeCloseTo(60, 6);
  });
});

describe('the catalog behind it', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('points at files under the site root, escaped for the URL', () => {
    const catalog = new Catalog([
      { id: 'a', name: 'A', duration: 10, src: 'music/Some Album (Live)/01 -7-12am- A.mp3' },
    ]);
    expect(catalog.urlFor('a')).toBe('/music/Some%20Album%20(Live)/01%20-7-12am-%20A.mp3');
    expect(catalog.urlFor('nope')).toBeNull();
  });

  it('reports which files the host is missing', async () => {
    const catalog = new Catalog([
      { id: 'a', name: 'A', duration: 10, src: 'music/a.mp3' },
      { id: 'b', name: 'B', duration: 10, src: 'music/b.mp3' },
    ]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: !url.endsWith('b.mp3') })));

    await catalog.checkAvailability();
    expect(catalog.statusOf('a')).toBe('present');
    expect(catalog.statusOf('b')).toBe('missing');
    expect(catalog.missingCount).toBe(1);
  });

  it('has every daypart on every channel pointing at a real file', async () => {
    installBrowserStubs();
    await resetStorage();
    const radio = new Radio();
    await radio.init();

    for (const station of radio.getStations()) {
      for (const program of station.programs) {
        expect(program.trackIds.length, `${station.name}/${program.name}`).toBeGreaterThan(0);
        for (const id of program.trackIds) {
          const track = radio.catalog.get(id);
          expect(track, `${station.name}/${program.name}`).toBeDefined();
          expect(track!.duration).toBeGreaterThan(0);
          expect(track!.src.startsWith('music/')).toBe(true);
        }
      }
    }
  });
});

describe('RadioUI', () => {
  beforeEach(async () => {
    installBrowserStubs();
    await resetStorage();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
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
    const knob = root.querySelector<HTMLButtonElement>('.knob')!;
    return { root, radio, knob };
  }

  it('opens showing the switch at off', async () => {
    const { root, knob } = await mount();
    expect(root.querySelector('.position-number')!.textContent).toBe('0');
    expect(root.querySelector('.position-label')!.textContent).toBe('off');
    expect(knob.classList.contains('off')).toBe(true);
  });

  it('is the only control on the page', async () => {
    const { root } = await mount();
    expect(root.querySelectorAll('.knob')).toHaveLength(1);
    expect(root.querySelectorAll('input[type=range]')).toHaveLength(1); // volume
  });

  it('advances a channel per press and says what is on', async () => {
    const { root, radio, knob } = await mount();
    knob.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(1));

    expect(root.querySelector('.position-number')!.textContent).toBe('1');
    expect(root.querySelector('.position-label')!.textContent).toBe(radio.getStations()[0]!.name);
    // Still inside the static, so it must not claim a track yet.
    expect(root.querySelector('.daypart')!.textContent).toBe('tuning…');

    vi.setSystemTime(Date.now() + SETTLED_MS);
    radio.tick();
    expect(root.querySelector('.track')!.textContent).toBeTruthy();
    expect(root.querySelector('.elapsed')!.textContent).toContain('/');
  });

  it('wraps back to off after the last channel', async () => {
    const { root, radio, knob } = await mount();
    for (let i = 0; i < radio.channelCount + 1; i++) {
      knob.click();
      await vi.waitFor(() => {});
    }
    expect(root.querySelector('.position-number')!.textContent).toBe('0');
    expect(root.querySelector('.position-label')!.textContent).toBe('off');
  });
});
