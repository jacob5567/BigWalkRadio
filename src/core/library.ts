import { deleteTrack, getAllTracks, getTrackBlob, putTrack } from './db';
import { parseTrackName } from './naming';
import type { Track } from './types';

export interface ImportResult {
  added: Track[];
  failed: { name: string; reason: string }[];
}

function newId(): string {
  return crypto.randomUUID();
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '');
}

/**
 * Files picked from a folder carry their directory in `webkitRelativePath`,
 * which often names the album even when the filename alone doesn't.
 */
function describe(file: File): Track {
  const fromFile = parseTrackName(file.name);
  const folder = file.webkitRelativePath?.split('/').at(-2);
  const album = fromFile.album ?? (folder ? parseTrackName(folder).album : null);
  return {
    id: newId(),
    name: fromFile.title || baseName(file.name),
    duration: 0,
    mime: file.type || 'audio/*',
    size: file.size,
    addedAt: Date.now(),
    album,
    timeOfDayMinutes: fromFile.timeOfDayMinutes,
  };
}

/**
 * Read a real duration out of the file. Some containers (notably webm/ogg from
 * a recorder) report Infinity until you seek to the end, hence the nudge.
 */
export function probeDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.preload = 'metadata';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(new Error('timed out reading duration'))), 20_000);

    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const d = audio.duration;
        finish(() => resolve(d));
      } else {
        audio.currentTime = 1e101;
      }
    });
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const d = audio.duration;
        finish(() => resolve(d));
      }
    });
    audio.addEventListener('error', () => {
      finish(() => reject(new Error('unsupported or corrupt audio file')));
    });

    audio.src = url;
  });
}

/** The user's imported audio, kept in IndexedDB so it survives reloads and works offline. */
export class Library {
  private readonly tracks = new Map<string, Track>();
  private readonly urls = new Map<string, string>();

  get map(): ReadonlyMap<string, Track> {
    return this.tracks;
  }

  list(): Track[] {
    return [...this.tracks.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  get(id: string): Track | undefined {
    return this.tracks.get(id);
  }

  async load(): Promise<void> {
    this.tracks.clear();
    for (const t of await getAllTracks()) this.tracks.set(t.id, t);
  }

  async import(files: readonly File[]): Promise<ImportResult> {
    const result: ImportResult = { added: [], failed: [] };
    for (const file of files) {
      try {
        const duration = await probeDuration(file);
        const track: Track = { ...describe(file), duration };
        await putTrack(track, file);
        this.tracks.set(track.id, track);
        result.added.push(track);
      } catch (err) {
        result.failed.push({ name: file.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  async rename(id: string, name: string): Promise<void> {
    const track = this.tracks.get(id);
    if (!track) return;
    const updated = { ...track, name };
    const blob = await getTrackBlob(id);
    if (!blob) return;
    await putTrack(updated, blob);
    this.tracks.set(id, updated);
  }

  async remove(id: string): Promise<void> {
    await deleteTrack(id);
    this.tracks.delete(id);
    const url = this.urls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(id);
    }
  }

  /** Object URL for a track, created once and reused for the session. */
  async urlFor(id: string): Promise<string | null> {
    const existing = this.urls.get(id);
    if (existing) return existing;
    const blob = await getTrackBlob(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(id, url);
    return url;
  }

  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
