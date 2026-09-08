// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoundBank, toStereo } from '../src/core/sounds';
import { FakeAudioContext, installBrowserStubs } from './browser-stubs';

const SOURCES = {
  channelChange: ['audio/change_01.wav', 'audio/change_02.wav', 'audio/change_03.wav'],
  on: ['audio/on_01.wav'],
  off: ['audio/off_01.wav', 'audio/off_02.wav'],
};

/** Cycles the injected random through fixed values, so picks are predictable. */
function sequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

async function bank(random = Math.random) {
  const ctx = new FakeAudioContext() as unknown as AudioContext;
  const destination = ctx.createGain();
  const sounds = new SoundBank({ sources: SOURCES, random });
  await sounds.load(ctx, destination);
  return { sounds, ctx, destination };
}

describe('SoundBank', () => {
  beforeEach(() => installBrowserStubs());
  afterEach(() => vi.unstubAllGlobals());

  it('fetches every take once', async () => {
    const { sounds } = await bank();
    expect(sounds.ready).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
  });

  it('does not fetch again on a second load', async () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const sounds = new SoundBank({ sources: SOURCES });
    await sounds.load(ctx, ctx.createGain());
    await sounds.load(ctx, ctx.createGain());
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
  });

  it('picks a take belonging to the action asked for', async () => {
    const { sounds } = await bank();
    for (let i = 0; i < 20; i++) {
      expect(SOURCES.channelChange).toContain(sounds.pick('channelChange'));
      expect(sounds.pick('off')).toMatch(/^audio\/off_/);
    }
  });

  it('never plays the same take twice running', async () => {
    // Always reaching for the first choice would repeat, if it were allowed to.
    const { sounds } = await bank(sequence([0]));
    const picks = Array.from({ length: 8 }, () => sounds.pick('channelChange'));
    for (let i = 1; i < picks.length; i++) {
      expect(picks[i], `pick ${i}`).not.toBe(picks[i - 1]);
    }
  });

  it('reaches every take across many picks', async () => {
    const { sounds } = await bank();
    const heard = new Set(Array.from({ length: 200 }, () => sounds.pick('channelChange')));
    expect([...heard].sort()).toEqual([...SOURCES.channelChange].sort());
  });

  it('has nothing to vary when an action has a single take', async () => {
    const { sounds } = await bank();
    expect(sounds.pick('on')).toBe('audio/on_01.wav');
    expect(sounds.pick('on')).toBe('audio/on_01.wav');
  });

  it('plays a take and says how long it runs', async () => {
    const { sounds, destination } = await bank();
    const connect = vi.mocked((destination as unknown as { connect: ReturnType<typeof vi.fn> }).connect);
    connect.mockClear();

    const seconds = sounds.play('channelChange');
    expect(seconds).toBeCloseTo(0.2, 3);
  });

  it('is silent, not broken, when the host serves no sounds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const sounds = new SoundBank({ sources: SOURCES });
    await sounds.load(ctx, ctx.createGain());

    expect(sounds.ready).toBe(false);
    expect(sounds.missing.size).toBe(6);
    expect(sounds.pick('on')).toBeNull();
    expect(sounds.play('on')).toBe(0);
  });

  it('plays nothing for an action it has no takes for', async () => {
    const { sounds } = await bank();
    expect(sounds.pick('nonsense' as 'on')).toBeNull();
    expect(sounds.play('nonsense' as 'on')).toBe(0);
  });

  it('plays nothing before it has been loaded', () => {
    expect(new SoundBank({ sources: SOURCES }).play('on')).toBe(0);
  });
});

describe('toStereo', () => {
  beforeEach(() => installBrowserStubs());
  afterEach(() => vi.unstubAllGlobals());

  it('spreads a mono take across both speakers', () => {
    // The files are mono with no declared layout, which otherwise lands them
    // in the left speaker alone.
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const mono = ctx.createBuffer(1, 4, 44100);
    mono.getChannelData(0).set([0.1, -0.2, 0.3, -0.4]);

    const stereo = toStereo(ctx, mono);
    expect(stereo.numberOfChannels).toBe(2);
    expect([...stereo.getChannelData(0)]).toEqual([0.1, -0.2, 0.3, -0.4].map(Math.fround));
    expect([...stereo.getChannelData(1)]).toEqual([...stereo.getChannelData(0)]);
  });

  it('leaves a stereo take alone', () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const stereo = ctx.createBuffer(2, 4, 44100);
    expect(toStereo(ctx, stereo)).toBe(stereo);
  });
});
