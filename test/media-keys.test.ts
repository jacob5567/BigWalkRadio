// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindMediaKeys } from '../src/core/media-keys';
import { installBrowserStubs, mediaSessionHandlers, unsupportedMediaActions } from './browser-stubs';

const actions = () => ({
  play: vi.fn(), pause: vi.fn(), previous: vi.fn(), next: vi.fn(),
});

const press = (action: string) => mediaSessionHandlers.get(action)?.();

describe('bindMediaKeys', () => {
  beforeEach(() => {
    unsupportedMediaActions.clear();
    installBrowserStubs();
  });

  afterEach(() => {
    unsupportedMediaActions.clear();
    vi.unstubAllGlobals();
  });

  it('maps play and pause onto the on/off switch', () => {
    const handlers = actions();
    bindMediaKeys(handlers);

    press('play');
    expect(handlers.play).toHaveBeenCalledOnce();
    press('pause');
    expect(handlers.pause).toHaveBeenCalledOnce();
  });

  it('maps the track buttons onto the channels', () => {
    const handlers = actions();
    bindMediaKeys(handlers);

    press('nexttrack');
    expect(handlers.next).toHaveBeenCalledOnce();
    press('previoustrack');
    expect(handlers.previous).toHaveBeenCalledOnce();
  });

  it('treats stop as switching off', () => {
    const handlers = actions();
    bindMediaKeys(handlers);
    press('stop');
    expect(handlers.pause).toHaveBeenCalledOnce();
  });

  it('takes the handlers back off when unbound', () => {
    const handlers = actions();
    const unbind = bindMediaKeys(handlers);
    unbind();

    expect([...mediaSessionHandlers.values()].every((h) => h === null)).toBe(true);
    press('play');
    expect(handlers.play).not.toHaveBeenCalled();
  });

  it('binds what it can when the platform refuses an action', () => {
    unsupportedMediaActions.add('stop');
    const handlers = actions();
    expect(() => bindMediaKeys(handlers)).not.toThrow();

    press('play');
    press('nexttrack');
    expect(handlers.play).toHaveBeenCalledOnce();
    expect(handlers.next).toHaveBeenCalledOnce();
    expect(mediaSessionHandlers.has('stop')).toBe(false);
  });

  it('does nothing where there is no media session at all', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaSession');
    // @ts-expect-error -- removing the property is the point of the test.
    delete navigator.mediaSession;
    expect(() => bindMediaKeys(actions())()).not.toThrow();
    if (original) Object.defineProperty(navigator, 'mediaSession', original);
  });
});
