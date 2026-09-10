import { absoluteAssetUrl } from './paths';
import { TRACK_CATALOG } from './presets';
import { SOUND_EFFECTS, SOUND_EFFECT_BYTES } from './sfx';
import type { Track } from './types';

/**
 * Kept apart from the app-shell cache on purpose. A new deploy bumps the shell
 * and clears the old one; a hundred and fifty megabytes of music shouldn't go
 * with it. The service worker reads from this name and never writes to it --
 * filling it is an explicit act, which is what the download button is.
 */
export const AUDIO_CACHE = 'bigwalk-audio-v1';

/** One file to keep, and what the build said it weighs. */
export interface OfflineItem {
  url: string;
  bytes: number;
}

export type OfflineState =
  | 'unsupported'
  | 'absent'
  | 'partial'
  | 'downloading'
  | 'stored'
  | 'error';

export interface OfflineStatus {
  state: OfflineState;
  /** Bytes on the device; during a download, bytes secured so far. */
  done: number;
  /** What the whole set comes to. */
  total: number;
  /** Files on the device, out of `fileCount`. */
  files: number;
  fileCount: number;
  /** Set when `state` is 'error'. */
  message?: string;
}

/** A sound effect the generator couldn't measure still has to count for something. */
const ASSUMED_SFX_BYTES = 22_000;

/** Don't repaint the bar for every chunk the network hands over. */
const REPORT_EVERY_BYTES = 96 * 1024;

/** Injectable throughout for tests; the generated set is what ships. */
export interface OfflineStoreOptions {
  tracks?: readonly Track[];
  sounds?: Record<string, string[]>;
  soundBytes?: Record<string, number>;
}

function itemsFor({ tracks, sounds, soundBytes }: OfflineStoreOptions): OfflineItem[] {
  const sizes = soundBytes ?? SOUND_EFFECT_BYTES;
  const music = (tracks ?? TRACK_CATALOG).map((track) => ({
    url: absoluteAssetUrl(track.src),
    bytes: track.bytes ?? 0,
  }));
  const sfx = Object.values(sounds ?? SOUND_EFFECTS).flat().map((path) => ({
    url: absoluteAssetUrl(path),
    bytes: sizes[path] ?? ASSUMED_SFX_BYTES,
  }));
  return [...music, ...sfx];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the audio on the device, so the radio plays with the aeroplane mode on.
 *
 * The files go into the Cache API rather than IndexedDB because the player
 * reaches them through `<audio src>`, and only the service worker can answer
 * that -- which it does out of this same cache, range requests and all.
 */
export class OfflineStore {
  private readonly all: OfflineItem[];
  private running: AbortController | null = null;

  constructor(options: OfflineStoreOptions = {}) {
    this.all = itemsFor(options);
  }

  /** Cache storage is missing in a private window on some browsers. */
  static get supported(): boolean {
    return typeof caches !== 'undefined' && 'serviceWorker' in navigator;
  }

  get fileCount(): number {
    return this.all.length;
  }

  /** What the download comes to, from the sizes baked in at build time. */
  get totalBytes(): number {
    return this.all.reduce((sum, item) => sum + item.bytes, 0);
  }

  get isDownloading(): boolean {
    return this.running !== null;
  }

  private idle(state: OfflineState, message?: string): OfflineStatus {
    return { state, done: 0, total: this.totalBytes, files: 0, fileCount: this.fileCount, message };
  }

  /** What is already on the device. Touches the cache, never the network. */
  async status(): Promise<OfflineStatus> {
    if (!OfflineStore.supported) return this.idle('unsupported');
    try {
      const cache = await caches.open(AUDIO_CACHE);
      let done = 0;
      let files = 0;
      for (const item of this.all) {
        if (await cache.match(item.url)) {
          done += item.bytes;
          files += 1;
        }
      }
      const state: OfflineState = files === 0
        ? 'absent'
        : files === this.all.length ? 'stored' : 'partial';
      return { state, done, total: this.totalBytes, files, fileCount: this.fileCount };
    } catch (error) {
      return this.idle('error', describe(error));
    }
  }

  /**
   * Fetches everything not already held and puts it in the cache, reporting as
   * it goes. A cancelled run costs nothing to resume: whatever landed stays,
   * and the next run skips it.
   */
  async download(onProgress: (status: OfflineStatus) => void): Promise<OfflineStatus> {
    if (!OfflineStore.supported) {
      const status = this.idle('unsupported');
      onProgress(status);
      return status;
    }
    if (this.running) throw new Error('a download is already running');

    const controller = new AbortController();
    this.running = controller;
    // Without this the browser may throw the lot away under storage pressure,
    // which for a download the listener asked for by name would be rude.
    await navigator.storage?.persist?.().catch(() => false);

    /** Bytes of files fully stored, counted at the size the build recorded. */
    let stored = 0;
    /** Bytes read of the file in hand, capped so it can't outrun its quote. */
    let inFlight = 0;
    let files = 0;

    const report = (state: OfflineState, message?: string) => onProgress({
      state,
      done: stored + inFlight,
      total: this.totalBytes,
      files,
      fileCount: this.fileCount,
      message,
    });

    try {
      const cache = await caches.open(AUDIO_CACHE);
      report('downloading');

      for (const item of this.all) {
        if (controller.signal.aborted) break;
        inFlight = 0;

        if (!(await cache.match(item.url))) {
          const response = await this.fetchWhileCounting(item, controller.signal, (read) => {
            inFlight = item.bytes > 0 ? Math.min(read, item.bytes) : read;
            report('downloading');
          });
          await cache.put(item.url, response);
        }

        inFlight = 0;
        stored += item.bytes;
        files += 1;
        report('downloading');
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const status: OfflineStatus = {
          state: 'error',
          done: stored,
          total: this.totalBytes,
          files,
          fileCount: this.fileCount,
          message: describe(error),
        };
        this.running = null;
        onProgress(status);
        return status;
      }
    } finally {
      this.running = null;
    }

    // Cancelled or finished, the truth is whatever is actually in the cache.
    const status = await this.status();
    onProgress(status);
    return status;
  }

  cancel(): void {
    this.running?.abort();
  }

  /** Gives the space back. The radio falls back to streaming from the host. */
  async remove(): Promise<OfflineStatus> {
    this.cancel();
    if (OfflineStore.supported) await caches.delete(AUDIO_CACHE).catch(() => false);
    return this.status();
  }

  /**
   * Reads the body as it arrives, so the bar moves within a file and not only
   * between them. A response that can't be streamed is taken in one piece.
   */
  private async fetchWhileCounting(
    item: OfflineItem,
    signal: AbortSignal,
    onRead: (bytes: number) => void,
  ): Promise<Response> {
    const response = await fetch(item.url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} on ${decodeURI(new URL(item.url).pathname)}`);

    const reader = response.body?.getReader?.();
    if (!reader) return response;

    const chunks: Uint8Array[] = [];
    let read = 0;
    let reported = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      read += value.byteLength;
      if (read - reported >= REPORT_EVERY_BYTES) {
        reported = read;
        onRead(read);
      }
    }
    onRead(read);

    // Rebuilt rather than passed through: the body has been read, and the cache
    // needs one it can still consume. Joined into a single array rather than a
    // Blob, which not every environment can turn back into a body.
    const body = new Uint8Array(read);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    return new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: response.headers,
    });
  }
}
