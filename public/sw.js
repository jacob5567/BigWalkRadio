// App-shell cache so the radio opens offline, plus an audio cache the listener
// fills on purpose. Nothing here ever puts music in that second cache: it is
// written only by the download button, and read back here so that `<audio>`
// finds the files with the network off.
const CACHE = 'bigwalk-radio-v4';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

/** Must match AUDIO_CACHE in src/core/offline.ts. */
const AUDIO_CACHE = 'bigwalk-audio-v1';
const AUDIO_PATHS = ['/music/', '/audio/'];

self.addEventListener('install', (event) => {
  // Straight from the network, not through the HTTP cache. The icon names
  // never change, so a stale entry there would quietly refill a brand new
  // cache with the old artwork -- and bumping the name above would look like
  // it had done nothing.
  const shell = SHELL.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(shell)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // The audio cache survives a deploy. It is far too expensive to refill
      // for the sake of a changed stylesheet, and its contents don't go stale.
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== AUDIO_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

/**
 * Media elements ask for byte ranges, and the Cache API only ever hands back
 * the whole file. Slicing it here is what makes a cached track seekable --
 * without it Safari won't play from the cache at all.
 */
async function partial(response, header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return response;

  const buffer = await response.arrayBuffer();
  const size = buffer.byteLength;
  const from = match[1] === '' ? NaN : Number(match[1]);
  const to = match[2] === '' ? NaN : Number(match[2]);

  let start;
  let end;
  if (Number.isNaN(from)) {
    // "bytes=-500" means the last 500 bytes, not the first.
    if (Number.isNaN(to)) return response;
    start = Math.max(0, size - to);
    end = size - 1;
  } else {
    start = from;
    end = Number.isNaN(to) ? size - 1 : Math.min(to, size - 1);
  }

  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(buffer.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

/** The stored copy if there is one, otherwise nothing and the network answers. */
async function fromAudioCache(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const hit = await cache.match(request.url);
  if (!hit) return null;

  const range = request.headers.get('range');
  if (range) return partial(hit, range);

  const headers = new Headers(hit.headers);
  headers.set('Accept-Ranges', 'bytes');
  return new Response(hit.body, { status: 200, statusText: 'OK', headers });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Audio: the stored copy first, the host second. Never cached on the way
  // past -- a hundred and fifty megabytes is not something to collect by
  // accident, and the HTTP cache is the right place for a casual listen.
  if (AUDIO_PATHS.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(
      fromAudioCache(request)
        .catch(() => null)
        .then((hit) => hit ?? fetch(request)),
    );
    return;
  }

  // Navigations come from the network first so a deploy is picked up promptly,
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    })),
  );
});
