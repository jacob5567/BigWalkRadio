import { vi } from 'vitest';
import { closeDb } from '../src/core/db';

/** Records what the engine asked the browser to do, without any real audio. */
export interface FakeParam {
  value: number;
  setTargetAtTime: (value: number, at: number, tc: number) => void;
}

const param = (value = 0): FakeParam => {
  const p: FakeParam = {
    value,
    setTargetAtTime: (next) => {
      p.value = next;
    },
  };
  return p;
};

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeGain extends FakeNode {
  gain = param(1);
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = param(20000);
  Q = param(1);
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  start = vi.fn();
  stop = vi.fn();
}

export class FakeAudioContext {
  state: 'running' | 'suspended' = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  createGain = () => new FakeGain();
  createBiquadFilter = () => new FakeFilter();
  createBufferSource = () => new FakeBufferSource();
  createMediaElementSource = () => new FakeNode();
  createBuffer = (channels: number, length: number) => ({
    getChannelData: () => new Float32Array(length),
    numberOfChannels: channels,
  });
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  close = vi.fn(async () => {});
}

/** Every media element built since the stubs were installed, in order. */
export const createdAudio: HTMLAudioElement[] = [];

/** Media key handlers the page has registered, by action name. */
export const mediaSessionHandlers = new Map<string, (() => void) | null>();

/** Actions the stubbed platform refuses, the way a real one refuses unknown ones. */
export const unsupportedMediaActions = new Set<string>();

/** The stubbed session itself, for checking metadata and playback state. */
export const mediaSession = {
  metadata: null as unknown,
  playbackState: 'none' as string,
  setActionHandler(action: string, handler: (() => void) | null) {
    if (unsupportedMediaActions.has(action)) throw new TypeError(`unsupported action: ${action}`);
    mediaSessionHandlers.set(action, handler);
  },
};

/**
 * jsdom has no audio pipeline, so stand in for the parts the engine touches.
 * Media elements get a settable currentTime and a readyState that reports ready.
 */
export function installBrowserStubs(): void {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  // The engine's elements are never put in the document, so keep a register of
  // them; tests have no other way to reach them.
  createdAudio.length = 0;
  vi.stubGlobal('Audio', function Audio(src?: string) {
    const element = document.createElement('audio');
    if (src) element.setAttribute('src', src);
    createdAudio.push(element);
    return element;
  } as unknown as typeof window.Audio);
  vi.stubGlobal('MediaMetadata', class { constructor(public init: unknown) {} });

  mediaSessionHandlers.clear();
  mediaSession.metadata = null;
  mediaSession.playbackState = 'none';
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: mediaSession });

  const proto = window.HTMLMediaElement.prototype;
  proto.play = vi.fn(async function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
  });
  proto.pause = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
  });
  proto.load = vi.fn();
  Object.defineProperty(proto, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(proto, 'duration', { value: 300, configurable: true });
  Object.defineProperty(proto, 'seeking', { value: false, configurable: true });

  // Per element, so two copies of one track can sit at different points.
  const positions = new WeakMap<HTMLMediaElement, number>();
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return positions.get(this) ?? 0;
    },
    set(this: HTMLMediaElement, value: number) {
      positions.set(this, value);
    },
  });

  // jsdom implements no pointer capture, which the volume wheel takes hold of.
  const element = window.Element.prototype as unknown as Record<string, unknown>;
  element.setPointerCapture ??= () => {};
  element.releasePointerCapture ??= () => {};
  element.hasPointerCapture ??= () => false;

  // jsdom has no blob URLs; the engine only ever hands these back to an element.
  if (typeof URL.createObjectURL !== 'function') {
    let n = 0;
    URL.createObjectURL = () => `blob:fake/${++n}`;
    URL.revokeObjectURL = () => {};
  }

  if (!('storage' in navigator)) {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist: async () => true, persisted: async () => true, estimate: async () => ({ usage: 0, quota: 1 }) },
    });
  }
  if (!('randomUUID' in crypto)) {
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: () => `id-${Math.random().toString(16).slice(2)}`,
    });
  }
}

/** Wipe stored settings, stations and audio so each test starts on a fresh radio. */
export async function resetStorage(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('bigwalk-radio');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
