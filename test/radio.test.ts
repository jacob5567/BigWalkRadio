// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Catalog } from '../src/core/catalog';
import { setKV } from '../src/core/db';
import { Radio } from '../src/core/radio';
import { DEFAULT_TUNE } from '../src/core/tuning';
import { RadioUI } from '../src/app/ui';
import { installBrowserStubs, mediaSession, mediaSessionHandlers, resetStorage } from './browser-stubs';

/** Long enough for the click to pass and a channel to settle in. */
const SETTLED_MS = DEFAULT_TUNE.holdMs + DEFAULT_TUNE.fadeMs + 10;
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
    expect(state.tune).toEqual({ stationGain: 0, settling: false });
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

  it('holds the channel back while the click covers the change', async () => {
    await radio.setPosition(3);
    const during = radio.snapshot();
    expect(during.tune.stationGain).toBe(0);
    expect(during.tune.settling).toBe(true);

    settle();
    const after = radio.snapshot();
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

  it('sounds the right click for whichever control made the change', async () => {
    const play = vi.spyOn(radio.engine, 'playSound');

    await radio.setPower(true);
    expect(play).toHaveBeenLastCalledWith('on');
    settle();

    await radio.stepChannel(1);
    expect(play).toHaveBeenLastCalledWith('channelChange');
    settle();

    await radio.advance();
    expect(play).toHaveBeenLastCalledWith('channelChange');
    settle();

    await radio.setPower(false);
    expect(play).toHaveBeenLastCalledWith('off');
  });

  it('sounds the on click only when coming up from off', async () => {
    const play = vi.spyOn(radio.engine, 'playSound');
    await radio.advance(); // off -> 1
    settle();
    await radio.advance(); // 1 -> 2
    expect(play.mock.calls.map(([action]) => action)).toEqual(['on', 'channelChange']);
  });

  it('ignores a control that asks for the position it is already on', async () => {
    await radio.setPosition(3);
    settle();
    await radio.setPower(true); // already on
    expect(radio.snapshot().tune.settling).toBe(false);
  });

  it('covers every change, not just the first', async () => {
    await radio.setPosition(2);
    settle();
    expect(radio.snapshot().tune.settling).toBe(false);

    const play = vi.spyOn(radio.engine, 'playSound');
    await radio.advance();
    expect(radio.snapshot().tune.settling).toBe(true);
    expect(play).toHaveBeenCalledOnce();
  });

  it('holds the channel silent until the click has passed', async () => {
    const update = vi.spyOn(radio.engine, 'update');
    await radio.setPosition(5);
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

  it('lets the audio hardware sleep once the off click has finished', async () => {
    await radio.setPosition(1);
    settle();
    expect(radio.engine.isRunning).toBe(true);

    await radio.setPosition(0);
    expect(radio.engine.isRunning).toBe(true); // still voicing the static
    settle();
    expect(radio.engine.isRunning).toBe(false);
  });
});

describe('the media keys', () => {
  let radio: Radio;
  const press = async (action: string) => {
    mediaSessionHandlers.get(action)?.();
    await vi.waitFor(() => {});
  };

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

  it('turns the radio on and off with play and pause', async () => {
    await press('play');
    expect(radio.snapshot().power).toBe(true);
    await press('pause');
    expect(radio.snapshot().power).toBe(false);
  });

  it('steps channels with the track buttons', async () => {
    await press('play');
    expect(radio.snapshot().position).toBe(1);

    await press('nexttrack');
    expect(radio.snapshot().position).toBe(2);
    await press('previoustrack');
    expect(radio.snapshot().position).toBe(1);
    // Back one more wraps round the dial rather than switching off.
    await press('previoustrack');
    expect(radio.snapshot().position).toBe(7);
  });

  it('leaves the track buttons dead while the radio is off, as on screen', async () => {
    await press('nexttrack');
    expect(radio.snapshot().position).toBe(0);
  });

  it('tells the lock screen whether the radio is on', async () => {
    await press('play');
    await vi.waitFor(() => expect(mediaSession.playbackState).toBe('playing'));
    await press('pause');
    await vi.waitFor(() => expect(mediaSession.playbackState).toBe('paused'));
  });

  it('names the station and what it is playing', async () => {
    await radio.setPosition(5);
    vi.setSystemTime(Date.now() + SETTLED_MS);
    radio.tick();

    const metadata = mediaSession.metadata as { init: { title: string; artist: string } };
    expect(metadata.init.title).toBe('Leitmotif');
    expect(metadata.init.artist).toContain('Lobby');
    expect(metadata.init.artist).toContain('Channel 5');
  });

  it('lets go of the keys when the radio is shut down', async () => {
    radio.dispose();
    expect([...mediaSessionHandlers.values()].every((h) => h === null)).toBe(true);
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
  let teardown: (() => void)[] = [];

  beforeEach(async () => {
    installBrowserStubs();
    await resetStorage();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });

  // Shut the radio down before the stubs go, not after: afterEach runs ahead
  // of onTestFinished, so anything still in flight would land on a bare global.
  afterEach(() => {
    for (const stop of teardown.splice(0)) stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount() {
    const root = document.createElement('div');
    document.body.append(root);
    const radio = new Radio();
    const ui = new RadioUI(radio, root);
    teardown.push(() => {
      ui.dispose();
      radio.dispose();
    });
    ui.mount();
    await radio.init();
    const unit = root.querySelector<HTMLElement>('.unit')!;
    const power = root.querySelector<HTMLButtonElement>('.power')!;
    const speaker = root.querySelector<HTMLButtonElement>('.speaker-rim')!;
    return { root, radio, unit, power, speaker };
  }

  const marker = (root: HTMLElement) => root.querySelector<HTMLElement>('.marker')!.style.left;

  it('opens dark, with the switch off and the marker parked', async () => {
    const { root, unit, power } = await mount();
    expect(unit.classList.contains('on')).toBe(false);
    expect(power.getAttribute('aria-checked')).toBe('false');
    expect(marker(root)).toBe('2.9px');
  });

  it('draws a tick and a stem for every channel', async () => {
    const { root, radio } = await mount();
    expect(root.querySelectorAll('.tick')).toHaveLength(radio.channelCount);
    expect(root.querySelectorAll('.stem')).toHaveLength(radio.channelCount);
    expect(root.querySelector('.tick-num')!.textContent).toBe('01');
    expect(root.querySelector<HTMLElement>('.ticks')!.style.getPropertyValue('--channels'))
      .toBe(String(radio.channelCount));
  });

  it('offers a knob, a switch, a rocker, two seek buttons and the grille', async () => {
    const { root } = await mount();
    expect(root.querySelectorAll('.wheel')).toHaveLength(1);
    expect(root.querySelectorAll('.power')).toHaveLength(1);
    expect(root.querySelectorAll('.rocker')).toHaveLength(1);
    expect(root.querySelectorAll('.step')).toHaveLength(2);
    expect(root.querySelectorAll('button.speaker-rim')).toHaveLength(1);
  });

  it('cycles a channel per press of the speaker grille', async () => {
    const { radio, speaker } = await mount();
    speaker.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(1));
    speaker.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(2));
  });

  it('wraps the grille back round to off after the last channel', async () => {
    const { radio, unit, speaker } = await mount();
    for (let i = 1; i <= radio.channelCount; i++) {
      speaker.click();
      await vi.waitFor(() => expect(radio.snapshot().position).toBe(i));
    }
    speaker.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(0));
    expect(unit.classList.contains('on')).toBe(false);
  });

  it('says what the grille will do next, since nothing on it is labelled', async () => {
    const { radio, speaker } = await mount();
    expect(speaker.getAttribute('aria-label')).toBe(`Radio off. Press for channel 1 of ${radio.channelCount}.`);

    speaker.click();
    await vi.waitFor(() =>
      expect(speaker.getAttribute('aria-label')).toContain(radio.getStations()[0]!.name));
    expect(speaker.getAttribute('aria-label')).toContain('Press for the next.');
  });

  it('turns on and off with the switch, and lights the lamp with it', async () => {
    const { root, radio, unit, power } = await mount();
    const lamp = root.querySelector<HTMLElement>('.lamp-glow')!;
    expect(lamp.style.opacity).toBe('0');

    power.click();
    await vi.waitFor(() => expect(power.getAttribute('aria-checked')).toBe('true'));
    expect(unit.classList.contains('on')).toBe(true);
    expect(lamp.style.opacity).toBe('1');
    expect(marker(root)).not.toBe('2.9px');

    power.click();
    await vi.waitFor(() => expect(power.getAttribute('aria-checked')).toBe('false'));
    expect(radio.snapshot().power).toBe(false);
    expect(lamp.style.opacity).toBe('0');
  });

  it('extends the antenna when it comes on', async () => {
    const { root, power } = await mount();
    const mast = root.querySelector<HTMLElement>('.antenna-mast')!;
    expect(mast.style.transform).toBe('scaleY(0.3)');
    power.click();
    await vi.waitFor(() => expect(mast.style.transform).toBe('scaleY(1)'));
  });

  it('greys out the seek buttons until there is something to step between', async () => {
    const { root, radio, power } = await mount();
    const [back, forward] = [...root.querySelectorAll<HTMLButtonElement>('.step')];
    expect(back!.disabled).toBe(true);

    power.click();
    await vi.waitFor(() => expect(back!.disabled).toBe(false));

    forward!.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(2));
    back!.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(1));
  });

  it('moves the marker along the dial as the channel changes', async () => {
    const { root, radio, power } = await mount();
    power.click();
    await vi.waitFor(() => expect(radio.snapshot().position).toBe(1));
    const first = marker(root);

    root.querySelectorAll<HTMLButtonElement>('.step')[1]!.click();
    await vi.waitFor(() => expect(marker(root)).not.toBe(first));
  });

  it('hisses over a change and settles once the channel is up', async () => {
    const { root, radio, power } = await mount();
    const film = root.querySelector<HTMLElement>('.screen-static')!;
    power.click();
    await vi.waitFor(() => expect(Number(film.style.opacity)).toBeGreaterThan(0.2));

    vi.setSystemTime(Date.now() + SETTLED_MS);
    radio.tick();
    expect(Number(film.style.opacity)).toBeCloseTo(0.05, 3);
  });

  it('rocks the clock between real time and game time', async () => {
    const { root, radio } = await mount();
    const rocker = root.querySelector<HTMLButtonElement>('.rocker')!;
    expect(rocker.classList.contains('game')).toBe(false);
    expect(rocker.getAttribute('aria-checked')).toBe('false');

    rocker.click();
    expect(radio.getSettings().mode).toBe('game');
    expect(rocker.classList.contains('game')).toBe(true);
    expect(rocker.getAttribute('aria-checked')).toBe('true');

    rocker.click();
    expect(radio.getSettings().mode).toBe('real');
  });

  it('reads the volume off the knob and shows it in the tray', async () => {
    const { root, radio } = await mount();
    const wheel = root.querySelector<HTMLElement>('.wheel')!;
    wheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', cancelable: true }));

    expect(radio.getSettings().volume).toBe(1);
    expect(root.querySelector('.vol-num')!.textContent).toBe('100');
    expect(root.querySelector<HTMLElement>('.vol-fill')!.style.width).toBe('100%');
  });

  it('says what is on for anyone who cannot see the dial', async () => {
    const { root, radio, power } = await mount();
    const said = root.querySelector<HTMLElement>('.sr-only')!;
    expect(said.textContent).toBe('Radio off');

    power.click();
    await vi.waitFor(() => expect(said.textContent).toContain('tuning'));

    vi.setSystemTime(Date.now() + SETTLED_MS);
    radio.tick();
    expect(said.textContent).toContain(radio.getStations()[0]!.name);
  });
});
