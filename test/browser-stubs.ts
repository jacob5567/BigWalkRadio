import { vi } from 'vitest';
import { closeDb } from '../src/core/db';

/** One piece of automation, kept so tests can read back the whole schedule. */
export interface ParamEvent {
  type: 'set' | 'ramp' | 'target';
  value: number;
  time: number;
  /** Time constant, for 'target' only. */
  tc?: number;
}

/** Records what the engine asked the browser to do, without any real audio. */
export interface FakeParam {
  value: number;
  /** Every automation call since the parameter was made, in order. */
  events: ParamEvent[];
  setValueAtTime: (value: number, at: number) => FakeParam;
  linearRampToValueAtTime: (value: number, at: number) => FakeParam;
  setTargetAtTime: (value: number, at: number, tc: number) => FakeParam;
  cancelScheduledValues: (at: number) => FakeParam;
  /** What the schedule reaches at `time`, without anything else being called. */
  at: (time: number) => number;
}

const param = (value = 0): FakeParam => {
  const p: FakeParam = {
    value,
    events: [],
    setValueAtTime: (next, at) => {
      p.events.push({ type: 'set', value: next, time: at });
      p.value = next;
      return p;
    },
    linearRampToValueAtTime: (next, at) => {
      p.events.push({ type: 'ramp', value: next, time: at });
      return p;
    },
    setTargetAtTime: (next, at, tc) => {
      p.events.push({ type: 'target', value: next, time: at, tc });
      p.value = next;
      return p;
    },
    cancelScheduledValues: (at) => {
      p.events = p.events.filter((e) => e.time < at);
      return p;
    },
    // Enough of the automation model to check a scheduled envelope: exact for
    // steps and linear ramps, and settled for the exponential approach.
    at: (time) => {
      let held = value;
      let heldAt = Number.NEGATIVE_INFINITY;
      for (const event of [...p.events].sort((a, b) => a.time - b.time)) {
        if (event.time > time) {
          if (event.type !== 'ramp') return held;
          const span = event.time - heldAt;
          return span <= 0 ? event.value : held + (event.value - held) * ((time - heldAt) / span);
        }
        held = event.value;
        heldAt = event.time;
      }
      return held;
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
  /** 'interrupted' is Safari's own, and what iOS does on the way to the home screen. */
  state: 'running' | 'suspended' | 'interrupted' | 'closed' = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  createGain = () => new FakeGain();
  createBiquadFilter = () => new FakeFilter();
  createBufferSource = () => new FakeBufferSource();
  createMediaElementSource = () => new FakeNode();
  /** Real backing arrays, so tests can see what was written into a buffer. */
  createBuffer = (channels: number, length: number, sampleRate = this.sampleRate) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (index: number) => data[index]!,
    } as unknown as AudioBuffer;
  };

  /** Stands in for a decoder: one mono buffer, long enough to be measurable. */
  decodeAudioData = vi.fn(async () => this.createBuffer(1, 8820, 44100));
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

/**
 * What the engine asked of each element, in order: `open <url>`, `seek <n>`,
 * `play`, `pause`. This is the closest thing to a latency measurement that
 * runs without a network -- each `open` is a file the browser has to go and
 * find, and a `play` before a `seek` means it will have to find it twice.
 */
const mediaOps = new WeakMap<HTMLMediaElement, string[]>();

export function opsOf(element: HTMLMediaElement): readonly string[] {
  return mediaOps.get(element) ?? [];
}

/** Every op across every element, for counting cold opens over a whole change. */
export function allOps(): string[] {
  return createdAudio.flatMap((element) => [...opsOf(element)]);
}

function record(element: HTMLMediaElement, op: string): void {
  const list = mediaOps.get(element);
  if (list) list.push(op);
  else mediaOps.set(element, [op]);
}

/**
 * Whether new elements come up cold, the way one does over a network: no
 * metadata until `deliverMetadata`, and no seek landing until `completeSeek`.
 * Off by default, so tests that don't care about loading stay simple.
 */
let coldMedia = false;
const readyStates = new WeakMap<HTMLMediaElement, number>();
const seekings = new WeakMap<HTMLMediaElement, boolean>();

export function useColdMedia(): void {
  coldMedia = true;
}

/** The element has its headers: it now knows its duration and can be seeked. */
export function deliverMetadata(element: HTMLMediaElement): void {
  readyStates.set(element, 1);
  element.dispatchEvent(new Event('loadedmetadata'));
}

/** The seek the engine asked for has landed. */
export function completeSeek(element: HTMLMediaElement): void {
  seekings.set(element, false);
  element.dispatchEvent(new Event('seeked'));
}

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
  coldMedia = false;
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

  // Sound effects are fetched on load; serve them something decodable.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  })));

  mediaSessionHandlers.clear();
  mediaSession.metadata = null;
  mediaSession.playbackState = 'none';
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: mediaSession });

  const proto = window.HTMLMediaElement.prototype;
  proto.play = vi.fn(async function (this: HTMLMediaElement) {
    record(this, 'play');
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
  });
  proto.pause = vi.fn(function (this: HTMLMediaElement) {
    record(this, 'pause');
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
  });
  proto.load = vi.fn();
  Object.defineProperty(proto, 'readyState', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return readyStates.get(this) ?? (coldMedia ? 0 : 4);
    },
  });
  Object.defineProperty(proto, 'duration', { value: 300, configurable: true });
  Object.defineProperty(proto, 'seeking', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return seekings.get(this) ?? false;
    },
  });

  // Per element, so two copies of one track can sit at different points.
  const positions = new WeakMap<HTMLMediaElement, number>();
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return positions.get(this) ?? 0;
    },
    set(this: HTMLMediaElement, value: number) {
      record(this, `seek ${value}`);
      positions.set(this, value);
      if (coldMedia) seekings.set(this, true);
    },
  });

  // Setting src is the expensive one: it sends the browser off to find a file.
  patchSrc(proto);

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

/** Wrapped once for the run: redefining it per install would nest the wrappers. */
let srcPatched = false;
function patchSrc(proto: HTMLMediaElement): void {
  if (srcPatched) return;
  srcPatched = true;
  const original = Object.getOwnPropertyDescriptor(proto, 'src')!;
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return original.get!.call(this);
    },
    set(this: HTMLMediaElement, value: string) {
      record(this, `open ${value}`);
      original.set!.call(this, value);
    },
  });
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
