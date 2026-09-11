// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimPlaybackSession, hasAudioSession } from '../src/core/audio-session';
import { DEFAULT_TUNE } from '../src/core/tuning';
import { Radio } from '../src/core/radio';
import { FakeAudioContext, installBrowserStubs, resetStorage } from './browser-stubs';

const SETTLED_MS = DEFAULT_TUNE.holdMs + DEFAULT_TUNE.fadeMs + 10;
const START = Date.parse('2026-03-04T10:00:00Z');

/** The context the engine actually built, so tests can interrupt it. */
function contextOf(radio: Radio): FakeAudioContext {
  return (radio.engine as unknown as { ctx: FakeAudioContext }).ctx;
}

/** Stands in for the home button: iOS interrupts, then the page is hidden. */
function sendToBackground(radio: Radio, state: 'interrupted' | 'suspended' = 'interrupted'): void {
  contextOf(radio).state = state;
  setVisibility('hidden');
}

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: value === 'hidden' });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('the audio session', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'audioSession');
  });

  it('declares the radio a playback app where iOS offers the choice', () => {
    const session = { type: 'auto' };
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: session });

    expect(hasAudioSession()).toBe(true);
    expect(claimPlaybackSession()).toBe(true);
    // 'auto' is treated as ambient sound: muted by the ring switch, and cut off
    // the moment the app is backgrounded.
    expect(session.type).toBe('playback');
  });

  it('shrugs where the browser has no such notion', () => {
    expect(hasAudioSession()).toBe(false);
    expect(claimPlaybackSession()).toBe(false);
  });

  it('shrugs where the session refuses to be set', () => {
    Object.defineProperty(navigator, 'audioSession', {
      configurable: true,
      value: Object.freeze({ type: 'auto' }),
    });
    expect(claimPlaybackSession()).toBe(false);
  });
});

describe('going to the home screen', () => {
  let radio: Radio;
  let session: { type: string };

  beforeEach(async () => {
    installBrowserStubs();
    await resetStorage();
    session = { type: 'auto' };
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: session });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    radio = new Radio();
    await radio.init();
    setVisibility('visible');
  });

  afterEach(() => {
    radio.dispose();
    setVisibility('visible');
    Reflect.deleteProperty(navigator, 'audioSession');
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const settle = () => {
    vi.setSystemTime(Date.now() + SETTLED_MS);
    radio.tick();
  };

  it('claims the playback session as soon as the radio is switched on', async () => {
    expect(session.type).toBe('auto');
    await radio.setPower(true);
    expect(session.type).toBe('playback');
  });

  it('brings an interrupted context back when the app returns', async () => {
    await radio.setPower(true);
    settle();
    const ctx = contextOf(radio);
    ctx.resume.mockClear();

    sendToBackground(radio);
    expect(ctx.state).toBe('interrupted');

    setVisibility('visible');
    await vi.waitFor(() => expect(ctx.state).toBe('running'));
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('brings a plainly suspended context back too', async () => {
    await radio.setPower(true);
    settle();
    const ctx = contextOf(radio);

    sendToBackground(radio, 'suspended');
    setVisibility('visible');

    await vi.waitFor(() => expect(ctx.state).toBe('running'));
  });

  it('leaves the context alone when the radio was switched off anyway', async () => {
    await radio.setPower(true);
    settle();
    await radio.setPower(false);
    settle();

    const ctx = contextOf(radio);
    ctx.resume.mockClear();
    setVisibility('hidden');
    setVisibility('visible');

    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it('puts the streams back on schedule once the context is running again', async () => {
    await radio.setPower(true);
    settle();
    const ctx = contextOf(radio);
    const update = vi.spyOn(radio.engine, 'update');

    sendToBackground(radio);
    // Four minutes pass on the home screen, with every timer frozen.
    vi.setSystemTime(Date.now() + 4 * 60_000);
    setVisibility('visible');
    await vi.waitFor(() => expect(update).toHaveBeenCalled());

    // The catch-up tick must not run against a context that is still down.
    expect(ctx.state).toBe('running');
    expect(radio.snapshot().onAir?.playing).toBeTruthy();
  });

  it('survives a resume the browser refuses', async () => {
    await radio.setPower(true);
    settle();
    const ctx = contextOf(radio);
    ctx.resume.mockRejectedValueOnce(new Error('not allowed'));

    sendToBackground(radio);
    setVisibility('visible');

    await expect(radio.engine.resume()).resolves.toBe(true);
  });
});
