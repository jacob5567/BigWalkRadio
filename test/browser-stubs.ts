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

/**
 * jsdom has no audio pipeline, so stand in for the parts the engine touches.
 * Media elements get a settable currentTime and a readyState that reports ready.
 */
export function installBrowserStubs(): void {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaMetadata', class { constructor(public init: unknown) {} });

  const proto = window.HTMLMediaElement.prototype;
  proto.play = vi.fn(async function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
  });
  proto.pause = vi.fn();
  proto.load = vi.fn();
  Object.defineProperty(proto, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(proto, 'duration', { value: 300, configurable: true });
  Object.defineProperty(proto, 'seeking', { value: false, configurable: true });

  let currentTime = 0;
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    },
  });

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
