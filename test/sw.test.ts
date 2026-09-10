import { beforeEach, describe, expect, it } from 'vitest';
// The worker ships as a plain script, so it is read rather than imported and
// run against a fake `self`. That is the only way to reach the range slicing.
import source from '../public/sw.js?raw';

const ORIGIN = 'https://radio.test';
const TRACK = `${ORIGIN}/music/album/track.ogg`;
const AUDIO_CACHE = 'bigwalk-audio-v1';

/** The worker only reads these four things off a request. */
function fakeRequest(url: string, headers: Record<string, string> = {}, mode = 'no-cors') {
  return { url, method: 'GET', mode, headers: new Headers(headers) };
}

class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(request: unknown): Promise<Response | undefined> {
    const key = typeof request === 'string' ? request : (request as { url: string }).url;
    return this.entries.get(key)?.clone();
  }

  async put(request: unknown, response: Response): Promise<void> {
    const key = typeof request === 'string' ? request : (request as { url: string }).url;
    this.entries.set(key, response);
  }

  async addAll(): Promise<void> {}
}

class FakeCacheStorage {
  readonly opened = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.opened.get(name);
    if (!cache) this.opened.set(name, (cache = new FakeCache()));
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.opened.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.opened.delete(name);
  }

  async match(): Promise<Response | undefined> {
    return undefined;
  }
}

interface Worker {
  listeners: Map<string, (event: unknown) => void>;
  caches: FakeCacheStorage;
  network: string[];
}

/** Runs public/sw.js against a fake `self`, and hands back what it registered. */
function loadWorker(networkAnswer: () => Response): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStorage = new FakeCacheStorage();
  const network: string[] = [];

  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    location: new URL(`${ORIGIN}/sw.js`),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  const run = new Function('self', 'caches', 'fetch', source) as (
    self: unknown, caches: unknown, fetch: unknown,
  ) => void;
  run(self, cacheStorage, async (request: { url: string } | string) => {
    network.push(typeof request === 'string' ? request : request.url);
    return networkAnswer();
  });

  return { listeners, caches: cacheStorage, network };
}

/** Drives the worker's fetch handler and returns whatever it answered with. */
async function respond(worker: Worker, request: ReturnType<typeof fakeRequest>): Promise<Response | null> {
  let answer: Promise<Response> | null = null;
  worker.listeners.get('fetch')!({
    request,
    respondWith: (value: Promise<Response>) => { answer = value; },
  });
  return answer ? await answer : null;
}

describe('the service worker', () => {
  let worker: Worker;
  let stored: Uint8Array<ArrayBuffer>;

  beforeEach(async () => {
    worker = loadWorker(() => new Response('from the host', { status: 200 }));
    // A file whose every byte says where it is, so a slice is checkable.
    stored = new Uint8Array(256);
    for (let i = 0; i < stored.length; i++) stored[i] = i;
    const cache = await worker.caches.open(AUDIO_CACHE);
    await cache.put(TRACK, new Response(stored, {
      status: 200,
      headers: { 'Content-Type': 'audio/ogg' },
    }));
  });

  it('answers a whole-file request from the stored copy', async () => {
    const response = (await respond(worker, fakeRequest(TRACK)))!;

    expect(response.status).toBe(200);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(stored);
    expect(worker.network).toEqual([]);
  });

  it('slices a byte range out of the stored copy', async () => {
    const response = (await respond(worker, fakeRequest(TRACK, { range: 'bytes=10-19' })))!;

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 10-19/256');
    expect(response.headers.get('Content-Length')).toBe('10');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('reads an open-ended range to the end of the file', async () => {
    const response = (await respond(worker, fakeRequest(TRACK, { range: 'bytes=200-' })))!;

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 200-255/256');
    expect((await response.arrayBuffer()).byteLength).toBe(56);
  });

  it('reads a suffix range from the end backwards', async () => {
    const response = (await respond(worker, fakeRequest(TRACK, { range: 'bytes=-16' })))!;

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 240-255/256');
  });

  it('clamps a range that runs off the end rather than overreading', async () => {
    const response = (await respond(worker, fakeRequest(TRACK, { range: 'bytes=250-999' })))!;

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 250-255/256');
  });

  it('refuses a range that starts past the end', async () => {
    const response = (await respond(worker, fakeRequest(TRACK, { range: 'bytes=300-400' })))!;

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */256');
  });

  it('falls through to the host for audio it does not hold', async () => {
    const response = (await respond(worker, fakeRequest(`${ORIGIN}/music/album/other.ogg`)))!;

    expect(await response.text()).toBe('from the host');
    expect(worker.network).toHaveLength(1);
  });

  it('never collects music of its own accord', async () => {
    await respond(worker, fakeRequest(`${ORIGIN}/music/album/other.ogg`));
    const cache = await worker.caches.open(AUDIO_CACHE);

    expect([...cache.entries.keys()]).toEqual([TRACK]);
  });

  it('keeps the downloaded audio when a new version clears the old shell', async () => {
    await worker.caches.open('bigwalk-radio-v3');
    await worker.caches.open('bigwalk-radio-v4');

    let settled: Promise<unknown> | null = null;
    worker.listeners.get('activate')!({ waitUntil: (value: Promise<unknown>) => { settled = value; } });
    await settled;

    expect(await worker.caches.keys()).toEqual(['bigwalk-audio-v1', 'bigwalk-radio-v4']);
  });

  it('leaves requests to other origins alone', async () => {
    expect(await respond(worker, fakeRequest('https://fonts.googleapis.com/css2?family=Archivo'))).toBe(null);
  });
});
