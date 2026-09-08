// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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
    radio.dispose();
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

  it('turns on with the switch, to the channel last listened to', async () => {
    await radio.setPosition(4);
    settle();
    await radio.setPower(false);
    settle();
    expect(radio.snapshot().power).toBe(false);

    await radio.setPower(true);
    expect(radio.snapshot().position).toBe(4);
  });

  it('steps forward and back through the channels, wrapping both ways', async () => {
    await radio.setPosition(1);
    await radio.stepChannel(-1);
    expect(radio.snapshot().position).toBe(7);
    await radio.stepChannel(1);
    expect(radio.snapshot().position).toBe(1);
    await radio.stepChannel(1);
    expect(radio.snapshot().position).toBe(2);
  });

  it('never steps past off, since the switch owns that', async () => {
    await radio.stepChannel(1);
    expect(radio.snapshot().position).toBe(0);
    await radio.stepChannel(-1);
    expect(radio.snapshot().position).toBe(0);
  });

  it('puts static over a change made with any of the controls', async () => {
    await radio.setPower(true);
    expect(radio.snapshot().tune.staticGain).toBe(1);
    settle();

    await radio.stepChannel(1);
    expect(radio.snapshot().tune.staticGain).toBe(1);
    settle();

    await radio.advance();
    expect(radio.snapshot().tune.staticGain).toBe(1);
    settle();

    await radio.setPower(false);
    expect(radio.snapshot().tune.staticGain).toBe(1);
  });

  it('ignores a control that asks for the position it is already on', async () => {
    await radio.setPosition(3);
    settle();
    await radio.setPower(true); // already on
    expect(radio.snapshot().tune.settling).toBe(false);
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

  it('gives overlapping copies of one track separate voices', async () => {
    // Channel 5's 07:12 daypart is a single track on repeat. Arrive halfway
    // through the seam where one pass gives way to the next.
    const seam = radio.getSettings().seamSeconds;
    const leitmotif = radio.catalog.list().find((t) => t.name === 'Leitmotif')!;
    const stride = leitmotif.duration - seam;
    const seamMid = Date.parse('2026-03-04T07:12:00Z') + (stride + seam / 2) * 1000;

    vi.setSystemTime(seamMid - SETTLED_MS);
    await radio.setPosition(5);
    const update = vi.spyOn(radio.engine, 'update');
    settle();

    const sounding = update.mock.lastCall![0].filter((t) => t.playing);
    expect(sounding).toHaveLength(2);
    // The same file, twice over, at two different points in it.
    expect(new Set(sounding.map((t) => t.trackId)).size).toBe(1);
    expect(new Set(sounding.map((t) => t.key)).size).toBe(2);
    for (const target of sounding) expect(target.gain).toBeCloseTo(Math.SQRT1_2, 2);
    expect(Math.abs(sounding[0]!.offsetSec - sounding[1]!.offsetSec)).toBeCloseTo(stride, 1);
  });

  it('cues the next pass silently before the seam arrives', async () => {
    const seam = radio.getSettings().seamSeconds;
    const leitmotif = radio.catalog.list().find((t) => t.name === 'Leitmotif')!;
    const stride = leitmotif.duration - seam;
    const justBefore = Date.parse('2026-03-04T07:12:00Z') + (stride - 4) * 1000;

    vi.setSystemTime(justBefore - SETTLED_MS);
    await radio.setPosition(5);
    const update = vi.spyOn(radio.engine, 'update');
    settle();

    const targets = update.mock.lastCall![0];
    const cued = targets.filter((t) => !t.playing);
    expect(cued).toHaveLength(1);
    expect(cued[0]!.gain).toBe(0);
    expect(cued[0]!.offsetSec).toBe(0);
    expect(targets.filter((t) => t.playing)).toHaveLength(1);
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
  const built: Radio[] = [];
  const open = async () => {
    const radio = new Radio();
    built.push(radio);
    await radio.init();
    return radio;
  };

  beforeEach(async () => {
    installBrowserStubs();
    await resetStorage();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    for (const radio of built.splice(0)) radio.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('comes back on to the channel it was last left on', async () => {
    const radio = await open();
    await radio.setPosition(6);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const reopened = await open();
    expect(reopened.snapshot().position).toBe(0);
    await reopened.setPower(true);
    expect(reopened.snapshot().position).toBe(6);
  });

  it('keeps volume and clock settings, but always comes back off', async () => {
    const radio = await open();
    await radio.setPosition(4);
    radio.setVolume(0.42);
    radio.setMode('game');
    radio.setGameDayMinutes(12);
    await new Promise((resolve) => setTimeout(resolve, 400)); // debounced save

    const reopened = await open();
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
    const radio = await open();
    expect(radio.getStations()).toHaveLength(7);
    expect(radio.getStations().some((s) => s.name === 'Stale')).toBe(false);
  });

  it('runs the schedule faster in game mode', async () => {
    const radio = await open();
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
    onTestFinished(() => radio.dispose());

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
    onTestFinished(() => radio.dispose());
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

  it('offers a wheel, a switch, two steppers and the cycle button', async () => {
    const { root } = await mount();
    expect(root.querySelectorAll('.wheel')).toHaveLength(1);
    expect(root.querySelectorAll('.power')).toHaveLength(1);
    expect(root.querySelectorAll('.step')).toHaveLength(2);
    expect(root.querySelectorAll('.knob')).toHaveLength(1);
  });

  it('turns on and off with the switch', async () => {
    const { root, radio } = await mount();
    const power = root.querySelector<HTMLButtonElement>('.power')!;
    expect(power.getAttribute('aria-checked')).toBe('false');

    power.click();
    await vi.waitFor(() => expect(radio.snapshot().power).toBe(true));
    expect(power.getAttribute('aria-checked')).toBe('true');

    power.click();
    await vi.waitFor(() => expect(radio.snapshot().power).toBe(false));
  });

  it('greys out the steppers until there is something to step between', async () => {
    const { root, radio } = await mount();
    const [back, forward] = [...root.querySelectorAll<HTMLButtonElement>('.step')];
    expect(back!.disabled).toBe(true);

    root.querySelector<HTMLButtonElement>('.power')!.click();
    await vi.waitFor(() => expect(radio.snapshot().power).toBe(true));
    expect(back!.disabled).toBe(false);

    forward!.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(2));
    back!.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(1));
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
