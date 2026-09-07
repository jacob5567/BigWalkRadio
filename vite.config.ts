import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';

const MUSIC_DIR = resolve(process.cwd(), 'music');

const CONTENT_TYPES: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  // Cover art sits alongside the audio in the album folders.
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Serves ./music during dev and preview, the way the host is expected to serve
 * it in production. Range requests are honoured so the player can seek, which
 * it does constantly to stay on the broadcast schedule.
 */
function serveMusic(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/music/')) return next();

    const relative = decodeURIComponent(url.split('?')[0]!.slice('/music/'.length));
    const path = resolve(join(MUSIC_DIR, relative));
    if (path !== MUSIC_DIR && !path.startsWith(MUSIC_DIR + sep)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }

    let size: number;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) throw new Error('not a file');
      size = stats.size;
    } catch {
      res.statusCode = 404;
      return res.end('not found');
    }

    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', size);
      res.statusCode = 200;
      return res.end();
    }

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || end < start) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      return void createReadStream(path, { start, end }).pipe(res);
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', size);
    return void createReadStream(path).pipe(res);
  };

  return {
    name: 'serve-music',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

export default defineConfig({
  plugins: [serveMusic()],
  server: { host: true },
  preview: { host: true },
  build: { target: 'es2022' },
});
