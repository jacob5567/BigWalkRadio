const DB_NAME = 'bigwalk-radio';
const DB_VERSION = 2;
const KV = 'kv';
/** Audio used to be imported and stored here; it is served from disk now. */
const RETIRED = ['tracks', 'blobs'];

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

/** Holds nothing but preferences: the dial position, volume, clock mode. */
export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        for (const name of RETIRED) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
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
