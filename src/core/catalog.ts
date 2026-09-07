import { TRACK_CATALOG } from './presets';
import type { Track } from './types';

export type Availability = 'unknown' | 'checking' | 'present' | 'missing';

/**
 * The audio the host has put in place. Nothing is uploaded and nothing is
 * stored by the app: every track is a file served from ./music alongside it,
 * in the layout the soundtrack ships with.
 */
export class Catalog {
  private readonly tracks = new Map<string, Track>();
  private readonly availability = new Map<string, Availability>();

  constructor(tracks: readonly Track[] = TRACK_CATALOG) {
    for (const track of tracks) this.tracks.set(track.id, { ...track });
  }

  get map(): ReadonlyMap<string, Track> {
    return this.tracks;
  }

  list(): Track[] {
    return [...this.tracks.values()];
  }

  get(id: string): Track | undefined {
    return this.tracks.get(id);
  }

  statusOf(id: string): Availability {
    return this.availability.get(id) ?? 'unknown';
  }

  /**
   * Where the browser should fetch a track. Paths are relative to the site
   * root so the app works when it is hosted under a subdirectory.
   */
  urlFor(id: string): string | null {
    const track = this.tracks.get(id);
    if (!track) return null;
    const base = import.meta.env.BASE_URL ?? '/';
    return `${base.endsWith('/') ? base : `${base}/`}${encodeURI(track.src)}`;
  }

  /**
   * Fill in any duration the build couldn't bake, by reading the file header.
   * Without a duration the scheduler can't place a track in its daypart.
   */
  async probeMissingDurations(): Promise<void> {
    const pending = this.list().filter((t) => !(t.duration > 0));
    await Promise.all(pending.map(async (track) => {
      const url = this.urlFor(track.id);
      if (!url) return;
      try {
        const duration = await probeDuration(url);
        this.tracks.set(track.id, { ...track, duration });
        this.availability.set(track.id, 'present');
      } catch {
        this.availability.set(track.id, 'missing');
      }
    }));
  }

  /** Ask the server whether each file is actually there, for the Sources view. */
  async checkAvailability(onProgress?: () => void): Promise<void> {
    await Promise.all(this.list().map(async (track) => {
      const url = this.urlFor(track.id);
      if (!url) return;
      this.availability.set(track.id, 'checking');
      try {
        const response = await fetch(url, { method: 'HEAD' });
        this.availability.set(track.id, response.ok ? 'present' : 'missing');
      } catch {
        this.availability.set(track.id, 'missing');
      }
      onProgress?.();
    }));
  }

  get missingCount(): number {
    return this.list().filter((t) => this.statusOf(t.id) === 'missing').length;
  }
}

/**
 * Read a duration out of a served file. Some containers report Infinity until
 * you seek to the end, hence the nudge.
 */
export function probeDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(new Error('timed out reading duration'))), 20_000);

    const settle = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const duration = audio.duration;
        finish(() => resolve(duration));
      }
    };
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) settle();
      else audio.currentTime = 1e101;
    });
    audio.addEventListener('durationchange', settle);
    audio.addEventListener('error', () => finish(() => reject(new Error(`could not load ${url}`))));

    audio.src = url;
  });
}
