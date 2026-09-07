import type { Track } from './types';

const DB_NAME = 'bigwalk-radio';
const DB_VERSION = 1;
const TRACKS = 'tracks';
const BLOBS = 'blobs';
const KV = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(TRACKS)) db.createObjectStore(TRACKS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function putTrack(track: Track, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([TRACKS, BLOBS], 'readwrite');
  tx.objectStore(TRACKS).put(track);
  tx.objectStore(BLOBS).put(blob, track.id);
  await done(tx);
}

export async function getAllTracks(): Promise<Track[]> {
  const db = await openDb();
  const tx = db.transaction(TRACKS, 'readonly');
  const all = await request(tx.objectStore(TRACKS).getAll() as IDBRequest<Track[]>);
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export async function getTrackBlob(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  const tx = db.transaction(BLOBS, 'readonly');
  return request(tx.objectStore(BLOBS).get(id) as IDBRequest<Blob | undefined>);
}

export async function deleteTrack(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([TRACKS, BLOBS], 'readwrite');
  tx.objectStore(TRACKS).delete(id);
  tx.objectStore(BLOBS).delete(id);
  await done(tx);
}

export async function getKV<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const tx = db.transaction(KV, 'readonly');
  return request(tx.objectStore(KV).get(key) as IDBRequest<T | undefined>);
}

export async function setKV(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(KV, 'readwrite');
  tx.objectStore(KV).put(value, key);
  await done(tx);
}

/** Release the connection. Used when tearing down, and between tests. */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  dbPromise = null;
  db?.close();
}

/** Ask the browser not to evict the user's imported audio under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
