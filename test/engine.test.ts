// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, type VoiceTarget } from '../src/core/audio';
import { createdAudio, installBrowserStubs } from './browser-stubs';

const target = (over: Partial<VoiceTarget> = {}): VoiceTarget => ({
  key: 'st::p::0::0',
  stationId: 'st',
  trackId: 'music/one.mp3',
  offsetSec: 0,
  gain: 1,
  playing: true,
  sync: 'lock',
  ...over,
});

describe('AudioEngine', () => {
  let engine: AudioEngine;
  let urls: string[];

  beforeEach(async () => {
    installBrowserStubs();
    urls = [];
    engine = new AudioEngine((id) => {
      urls.push(id);
      return `/${id}`;
    });
    await engine.start();
  });

  afterEach(() => {
    engine.dispose();
    vi.unstubAllGlobals();
  });

  const played = () => (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mock.calls.length;

  it('starts a stream that is meant to be sounding', () => {
    engine.update([target({ offsetSec: 12 })]);
    expect(urls).toEqual(['music/one.mp3']);
    expect(played()).toBeGreaterThan(0);
  });

  it('loads and cues a stream without sounding it', () => {
    const before = played();
    engine.update([target({ playing: false, gain: 0, offsetSec: 0 })]);
    expect(urls).toEqual(['music/one.mp3']); // fetched, so it is ready in time
    expect(played()).toBe(before); // but never started
  });

  it('starts a cued stream from the top when its moment comes', () => {
    engine.update([target({ playing: false, gain: 0 })]);
    const before = played();

    engine.update([target({ playing: true, gain: 1 })]);
    expect(played()).toBe(before + 1);
  });

  it('does not re-fetch a stream it has already cued', () => {
    engine.update([target({ playing: false, gain: 0 })]);
    engine.update([target({ playing: false, gain: 0 })]);
    engine.update([target({ playing: true, gain: 1 })]);
    expect(urls).toEqual(['music/one.mp3']);
  });

  it('keeps two copies of one track on separate elements', () => {
    engine.update([
      target({ key: 'st::p::0::0', offsetSec: 280 }),
      target({ key: 'st::p::1::0', offsetSec: 0.07 }),
    ]);
    expect(urls).toEqual(['music/one.mp3', 'music/one.mp3']);

    const [first, second] = createdAudio.slice(-2);
    expect(first!.currentTime).not.toBe(second!.currentTime);
  });

  it('reports a file the host is not serving', () => {
    engine.update([target()]);
    const element = createdAudio.at(-1)!;
    element.dispatchEvent(new Event('error'));
    expect([...engine.failedTrackIds]).toEqual(['music/one.mp3']);
  });

  it('drops a stream that is no longer wanted', async () => {
    vi.useFakeTimers();
    engine.update([target()]);
    const pauses = (HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mock.calls.length;

    engine.update([]);
    await vi.advanceTimersByTimeAsync(600); // past the release fade
    expect((HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(pauses);
    vi.useRealTimers();
  });

  it('does nothing at all while switched off', async () => {
    await engine.stop();
    const before = urls.length;
    engine.update([target()]);
    expect(urls).toHaveLength(before);
  });
});
