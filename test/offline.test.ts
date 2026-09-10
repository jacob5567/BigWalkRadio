// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_CACHE, OfflineStore, type OfflineStatus } from '../src/core/offline';
import { OfflineSection } from '../src/app/offline-section';
import { absoluteAssetUrl, assetUrl } from '../src/core/paths';
import { TRACK_CATALOG } from '../src/core/presets';
import { SOUND_EFFECTS } from '../src/core/sfx';
import type { Track } from '../src/core/types';

/** Two tracks and one sound effect, so the sums are checkable by hand. */
const TRACKS: Track[] = [
  { id: 'music/a.ogg', name: 'A', duration: 60, bytes: 3000, src: 'music/a.ogg' },
  { id: 'music/b.ogg', name: 'B', duration: 60, bytes: 7000, src: 'music/b.ogg' },
];
const SOUNDS = { on: ['audio/on.wav'] };
const SOUND_BYTES = { 'audio/on.wav': 500 };
const TOTAL = 3000 + 7000 + 500;

function options() {
  return { tracks: TRACKS, sounds: SOUNDS, soundBytes: SOUND_BYTES };
}

/** Enough of the Cache API for the store: match, put, delete. */
class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(request: RequestInfo): Promise<Response | undefined> {
    const hit = this.entries.get(keyOf(request));
    return hit?.clone();
  }

  async put(request: RequestInfo, response: Response): Promise<void> {
    this.entries.set(keyOf(request), response);
  }
}

class FakeCacheStorage {
  readonly opened = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.opened.get(name);
    if (!cache) this.opened.set(name, (cache = new FakeCache()));
    return cache;
  }

  async delete(name: string): Promise<boolean> {
    return this.opened.delete(name);
  }
}

function keyOf(request: RequestInfo): string {
  return typeof request === 'string' ? request : request.url;
}

/** A body of `size` bytes, delivered in four chunks so progress has to add up. */
function fileOf(size: number): Response {
  const chunk = Math.ceil(size / 4);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < size; sent += chunk) {
        controller.enqueue(new Uint8Array(Math.min(chunk, size - sent)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/ogg' } });
}

describe('the offline download', () => {
  let store: OfflineStore;
  let cacheStorage: FakeCacheStorage;
  let served: string[];

  beforeEach(() => {
    cacheStorage = new FakeCacheStorage();
    vi.stubGlobal('caches', cacheStorage);
    // `supported` also wants a service worker, which jsdom hasn't got.
    if (!('serviceWorker' in navigator)) {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
    }

    served = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      served.push(new URL(url).pathname);
      const name = decodeURI(new URL(url).pathname);
      if (name.endsWith('/a.ogg')) return fileOf(3000);
      if (name.endsWith('/b.ogg')) return fileOf(7000);
      return fileOf(500);
    }));

    store = new OfflineStore(options());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prices the whole set from the sizes baked in at build time', () => {
    expect(store.totalBytes).toBe(TOTAL);
    expect(store.fileCount).toBe(3);
  });

  it('reports nothing stored before anything is downloaded', async () => {
    const status = await store.status();
    expect(status.state).toBe('absent');
    expect(status.done).toBe(0);
    expect(status.total).toBe(TOTAL);
  });

  it('fetches every file into the audio cache', async () => {
    const final = await store.download(() => {});

    expect(final.state).toBe('stored');
    expect(final.done).toBe(TOTAL);
    expect(final.files).toBe(3);
    expect(served).toHaveLength(3);

    const cache = cacheStorage.opened.get(AUDIO_CACHE)!;
    expect(cache.entries.size).toBe(3);
    for (const [, response] of cache.entries) expect(response.status).toBe(200);
  });

  it('reports progress that only ever climbs, and lands on the total', async () => {
    const seen: OfflineStatus[] = [];
    await store.download((status) => seen.push({ ...status }));

    expect(seen.length).toBeGreaterThan(3);
    expect(seen[0]!.state).toBe('downloading');
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.done).toBeGreaterThanOrEqual(seen[i - 1]!.done);
      expect(seen[i]!.done).toBeLessThanOrEqual(TOTAL);
    }
    expect(seen[seen.length - 1]!.done).toBe(TOTAL);
  });

  it('skips what is already held, so a second run costs no traffic', async () => {
    await store.download(() => {});
    served.length = 0;

    const again = await store.download(() => {});
    expect(served).toEqual([]);
    expect(again.state).toBe('stored');
    expect(again.done).toBe(TOTAL);
  });

  it('calls a half-finished download partial, and resumes it', async () => {
    const cache = await cacheStorage.open(AUDIO_CACHE);
    await cache.put(new URL('/music/a.ogg', location.href).href, new Response('x'));

    const before = await store.status();
    expect(before.state).toBe('partial');
    expect(before.done).toBe(3000);
    expect(before.files).toBe(1);

    await store.download(() => {});
    expect(served).toHaveLength(2);
    expect((await store.status()).state).toBe('stored');
  });

  it('stops when cancelled, keeping whatever already landed', async () => {
    const done = store.download((status) => {
      if (status.files === 1) store.cancel();
    });
    const status = await done;

    expect(status.state).toBe('partial');
    expect(status.files).toBeLessThan(3);
    expect(status.files).toBeGreaterThan(0);
    expect(store.isDownloading).toBe(false);
  });

  it('gives the space back when the download is removed', async () => {
    await store.download(() => {});
    const status = await store.remove();

    expect(status.state).toBe('absent');
    expect(status.done).toBe(0);
    expect(cacheStorage.opened.get(AUDIO_CACHE)?.entries.size ?? 0).toBe(0);
  });

  it('says what went wrong when the host does not serve a file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));

    const status = await store.download(() => {});
    expect(status.state).toBe('error');
    expect(status.message).toContain('404');
  });

  // If these two ever drift, everything still passes and nothing plays offline:
  // the worker looks up a URL the player never asks for.
  it('keys the cache on exactly the URL the player will ask for', () => {
    const paths = [
      ...TRACK_CATALOG.map((track) => track.src),
      ...Object.values(SOUND_EFFECTS).flat(),
    ];
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      const audio = document.createElement('audio');
      audio.src = assetUrl(path);
      expect(audio.src).toBe(absoluteAssetUrl(path));
    }
  });

  it('says so plainly where there is no cache storage to use', async () => {
    vi.stubGlobal('caches', undefined);
    expect(OfflineStore.supported).toBe(false);
    expect((await new OfflineStore(options()).status()).state).toBe('unsupported');
  });

  describe('as it appears in the sheet', () => {
    let section: OfflineSection;

    const text = () => section.el.textContent ?? '';
    const button = () => section.el.querySelector<HTMLButtonElement>('.off-action')!;
    const bar = () => section.el.querySelector<HTMLElement>('.off-progress')!;

    beforeEach(async () => {
      section = new OfflineSection(store);
      document.body.append(section.el);
      await section.refresh();
    });

    it('quotes the size and says to install it first', () => {
      expect(text()).toContain('Install it to the home screen first');
      expect(text()).toContain('11 KB');
      expect(button().textContent).toBe('Download 11 KB');
      expect(bar().hidden).toBe(true);
    });

    it('runs the bar up while it downloads, then reports it stored', async () => {
      const widths: string[] = [];
      const observed = new MutationObserver(() => widths.push(section.el.querySelector<HTMLElement>('.off-fill')!.style.width));
      observed.observe(section.el, { attributes: true, subtree: true, attributeFilter: ['style'] });

      await section.download();
      observed.disconnect();

      expect(widths.length).toBeGreaterThan(0);
      expect(widths[widths.length - 1]).toBe('100%');
      expect(bar().hidden).toBe(true);
      expect(button().hidden).toBe(true);
      expect(text()).toContain('on this device');
      expect(section.el.querySelector<HTMLButtonElement>('.off-remove')!.hidden).toBe(false);
    });

    it('offers to resume a download that was left half done', async () => {
      const cache = await cacheStorage.open(AUDIO_CACHE);
      await cache.put(new URL('/music/a.ogg', location.href).href, new Response('x'));
      await section.refresh();

      expect(button().textContent).toBe('Resume the download');
      expect(text()).toContain('is already here');
    });
  });
});
