// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, type VoiceTarget } from '../src/core/audio';
import { Radio } from '../src/core/radio';
import { DEFAULT_TUNE } from '../src/core/tuning';
import {
  allOps,
  completeSeek,
  createdAudio,
  deliverMetadata,
  installBrowserStubs,
  opsOf,
  resetStorage,
  useColdMedia,
  type FakeParam,
} from './browser-stubs';

/**
 * How long it takes a channel to be heard is set by two things: how many times
 * the browser has to go and find a file, and how long the gain takes to open.
 * Neither needs a network or a speaker to measure -- the first is a count of
 * what the engine asked of the media elements, the second is the automation it
 * wrote onto the gain. Both are exact, so these tests measure rather than time.
 */

const START = Date.parse('2026-03-04T10:00:00Z');

const target = (over: Partial<VoiceTarget> = {}): VoiceTarget => ({
  key: 'st::p::0::0',
  stationId: 'st',
  trackId: 'music/one.ogg',
  offsetSec: 137,
  gain: 1,
  playing: true,
  sync: 'lock',
  ...over,
});

/** Files the browser was sent off to find, in order. */
const opens = () => allOps().filter((op) => op.startsWith('open '));

/** Where a stream was put, in order. Each one is a range request on a cold file. */
const seeks = (element: HTMLMediaElement) =>
  opsOf(element).filter((op) => op.startsWith('seek ')).map((op) => Number(op.slice(5)));

describe('opening a channel', () => {
  let engine: AudioEngine;

  beforeEach(async () => {
    installBrowserStubs();
    engine = new AudioEngine((id) => `/${id}`);
    await engine.start();
  });

  afterEach(() => {
    engine.dispose();
    vi.unstubAllGlobals();
  });

  it('opens the file once, not once per seek', () => {
    engine.update([target()]);
    expect(opens()).toEqual(['open /music/one.ogg']);
  });

  it('seeks to where the schedule wants it before it plays a note', () => {
    engine.update([target({ offsetSec: 137 })]);
    const ops = opsOf(createdAudio.at(-1)!);
    expect(ops).toEqual(['open /music/one.ogg', 'seek 137', 'play']);
  });

  it('waits for a cold file to report its length before seeking', () => {
    useColdMedia();
    engine.update([target({ offsetSec: 137 })]);
    const element = createdAudio.at(-1)!;
    // Nothing but the request itself: seeking now would be seeking blind.
    expect(opsOf(element)).toEqual(['open /music/one.ogg']);

    deliverMetadata(element);
    expect(opsOf(element)).toEqual(['open /music/one.ogg', 'seek 137']);
  });

  it('holds off playing until the seek has actually landed', () => {
    useColdMedia();
    engine.update([target({ offsetSec: 137 })]);
    const element = createdAudio.at(-1)!;
    deliverMetadata(element);
    // Playing here would sound the top of the file and then jump, which costs
    // a second trip over the network for the same channel.
    expect(opsOf(element)).not.toContain('play');

    completeSeek(element);
    expect(opsOf(element)).toEqual(['open /music/one.ogg', 'seek 137', 'play']);
  });

  it('does not re-open the file when the schedule ticks again', () => {
    engine.update([target({ offsetSec: 137 })]);
    engine.update([target({ offsetSec: 137.25 })]);
    engine.update([target({ offsetSec: 137.5 })]);
    expect(opens()).toHaveLength(1);
  });
});

describe('the switch envelope', () => {
  let engine: AudioEngine;

  beforeEach(async () => {
    installBrowserStubs();
    engine = new AudioEngine((id) => `/${id}`);
    await engine.start();
  });

  afterEach(() => {
    engine.dispose();
    vi.unstubAllGlobals();
  });

  /** The gain every station passes through, between the voices and the master. */
  const tuning = (): FakeParam =>
    (engine as unknown as { tuning: { gain: FakeParam } }).tuning.gain;

  it('writes the whole rise at the moment of the switch', () => {
    const gain = tuning();
    const before = gain.events.length;
    engine.tune(true, DEFAULT_TUNE);
    // One schedule, not one point per scheduler tick.
    expect(gain.events.length).toBeGreaterThan(before + 8);
  });

  it('is silent under the click and full by the end of the fade', () => {
    const gain = tuning();
    engine.tune(true, DEFAULT_TUNE);
    const hold = DEFAULT_TUNE.holdMs / 1000;
    const fade = DEFAULT_TUNE.fadeMs / 1000;

    expect(gain.at(hold)).toBeCloseTo(0, 6);
    expect(gain.at(hold + fade / 2)).toBeGreaterThan(0.5);
    expect(gain.at(hold + fade)).toBeCloseTo(1, 6);
  });

  it('is up on time whether or not the scheduler ticks again', () => {
    const gain = tuning();
    engine.tune(true, DEFAULT_TUNE);
    const settled = (DEFAULT_TUNE.holdMs + DEFAULT_TUNE.fadeMs) / 1000;
    const alone = gain.at(settled);

    // The old shape sampled the curve on the tick, so a channel could still be
    // climbing a quarter of a second after it should have arrived.
    for (let i = 0; i < 4; i++) engine.update([target()]);
    expect(gain.at(settled)).toBeCloseTo(alone, 6);
    expect(alone).toBeCloseTo(1, 6);
  });

  it('takes the station down under the click when switched off', () => {
    const gain = tuning();
    engine.tune(true, DEFAULT_TUNE);
    engine.tune(false, DEFAULT_TUNE);
    expect(gain.at(DEFAULT_TUNE.holdMs / 1000)).toBeCloseTo(0, 6);
    expect(gain.at(1)).toBeCloseTo(0, 6);
  });

  it('never lets the tuning gain go above full', () => {
    const gain = tuning();
    engine.tune(true, DEFAULT_TUNE);
    for (let t = 0; t <= 1; t += 0.01) {
      expect(gain.at(t)).toBeLessThanOrEqual(1 + 1e-9);
      expect(gain.at(t)).toBeGreaterThanOrEqual(-1e-9);
    }
  });
});

/**
 * A stream that makes no sound still costs something to move: a paused element
 * stays where it is while the schedule walks on, and closing that gap is a
 * range request like any other. Counting opens says nothing about this, which
 * is how it went unnoticed that the channels held either side were being
 * chased four times a second. These count the seeks instead.
 */
describe('holding a stream ready', () => {
  let engine: AudioEngine;

  beforeEach(async () => {
    installBrowserStubs();
    engine = new AudioEngine((id) => `/${id}`);
    await engine.start();
  });

  afterEach(() => {
    engine.dispose();
    vi.unstubAllGlobals();
  });

  const parked = (over: Partial<VoiceTarget> = {}) =>
    target({ key: 'parked', gain: 0, playing: false, ...over });

  it('puts a warm stream in place once, not once a tick', () => {
    // Ten ticks of the scheduler, the schedule walking on 250 ms each time.
    for (let i = 0; i < 10; i++) {
      engine.update([parked({ warm: true, offsetSec: 100 + i * 0.25 })]);
    }
    expect(seeks(createdAudio.at(-1)!)).toEqual([100]);
  });

  it('moves a warm stream up once it has fallen far enough behind to matter', () => {
    engine.update([parked({ warm: true, offsetSec: 100 })]);
    const element = createdAudio.at(-1)!;

    // Ten seconds adrift is still inside what the browser will have read
    // ahead, so tuning to it would land in audio it already has.
    engine.update([parked({ warm: true, offsetSec: 110 })]);
    expect(seeks(element)).toEqual([100]);

    engine.update([parked({ warm: true, offsetSec: 130 })]);
    expect(seeks(element)).toEqual([100, 130]);
  });

  it('places a stream cued for a seam exactly, and then leaves it alone', () => {
    for (let i = 0; i < 10; i++) engine.update([parked({ offsetSec: 0 })]);
    expect(seeks(createdAudio.at(-1)!)).toEqual([0]);
  });

  it('will not let a cued stream sit adrift the way a warm one may', () => {
    engine.update([parked({ offsetSec: 0 })]);
    const element = createdAudio.at(-1)!;
    // It is about to be sounded from exactly where it sits, so four seconds
    // out is four seconds of the wrong music.
    engine.update([parked({ offsetSec: 4 })]);
    expect(seeks(element)).toEqual([0, 4]);
  });
});

describe('changing channel', () => {
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

  const openedFiles = () => new Set(opens());

  it('holds the channels either side open, cued and silent', async () => {
    await radio.setPosition(4);

    const warm = radio.snapshot();
    expect(warm.position).toBe(4);
    // Three files open: the one on air and the two next to it on the dial.
    expect(openedFiles().size).toBe(3);

    const sounding = createdAudio.filter((el) => !el.paused);
    expect(sounding).toHaveLength(1);
  });

  it('tunes to the next channel without opening its file again', async () => {
    await radio.setPosition(4);
    const openedBefore = opens();

    await radio.stepChannel(1);
    expect(radio.snapshot().position).toBe(5);
    const url = radio.catalog.urlFor(radio.snapshot().onAir!.playing!.track.id)!;

    // It was already open before the button was touched, and sounding it did
    // not send the browser back for it.
    expect(openedBefore).toContain(`open ${url}`);
    expect(opens().filter((op) => op === `open ${url}`)).toHaveLength(1);
  });

  it('reuses the very element it had cued, rather than a fresh one', async () => {
    await radio.setPosition(4);
    const cued = createdAudio.filter((el) => el.paused);
    const opened = cued.map((el) => opsOf(el)[0]);

    await radio.stepChannel(1);
    const nowPlaying = createdAudio.filter((el) => !el.paused);
    expect(nowPlaying).toHaveLength(1);
    // The element that is sounding is one of the two that were already cued.
    expect(opened).toContain(opsOf(nowPlaying[0]!)[0]);
  });

  it('costs one cold open when the channel is not one of the neighbours', async () => {
    await radio.setPosition(1);
    const before = openedFiles();

    await radio.setPosition(4);
    // Channel 4 itself, plus its own two neighbours: nothing was held ready.
    expect(openedFiles().size).toBe(before.size + 3);
  });

  it('leaves the channels either side alone while it plays', async () => {
    await radio.setPosition(4);
    const sought = () => createdAudio
      .filter((el) => !opsOf(el).includes('play'))
      .reduce((total, el) => total + seeks(el).length, 0);
    const before = sought();

    // A minute of the scheduler running, at the 250 ms tick it really uses.
    for (let i = 0; i < 240; i++) {
      vi.setSystemTime(Date.now() + 250);
      radio.tick();
    }

    // Chasing the schedule would be 240 apiece, and 480 between them.
    expect(sought() - before).toBeLessThan(10);
  });

  it('opens nothing at all while the radio is off', async () => {
    expect(opens()).toHaveLength(0);
    await radio.setPosition(3);
    const on = opens().length;

    await radio.setPosition(0);
    expect(opens()).toHaveLength(on);
  });
});
