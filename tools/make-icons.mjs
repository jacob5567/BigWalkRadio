// Generates the PWA icons as PNGs with no dependencies: signed-distance shapes
// rasterised into RGBA, then packed into a minimal PNG.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');

const BG = [0x14, 0x12, 0x10];
const FG = [0xe6, 0xa3, 0x3c];
const DIM = [0x6b, 0x5a, 0x45];

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour with alpha
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 1 inside the shape, fading to 0 across one pixel at the edge. */
const cover = (sd, px) => clamp01(0.5 - sd / px);

function sdRing(x, y, cx, cy, radius, width) {
  return Math.abs(Math.hypot(x - cx, y - cy) - radius) - width / 2;
}

function sdSegment(x, y, ax, ay, bx, by, width) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - width / 2;
}

function render(size, scale) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = size * 0.30 * scale;
  const ringW = size * 0.052 * scale;
  const px = 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x + 0.5;
      const sy = y + 0.5;
      let [rr, gg, bb] = BG;

      // Dial ticks around the outside of the ring.
      let tick = 0;
      for (let i = 0; i < 12; i++) {
        const a = (-Math.PI / 2) + (i / 12) * Math.PI * 2;
        const inner = r + ringW * 1.3;
        const outer = inner + size * 0.045 * scale;
        tick = Math.max(tick, cover(sdSegment(sx, sy,
          c + Math.cos(a) * inner, c + Math.sin(a) * inner,
          c + Math.cos(a) * outer, c + Math.sin(a) * outer,
          size * 0.018 * scale), px));
      }
      if (tick > 0) {
        rr = BG[0] + (DIM[0] - BG[0]) * tick;
        gg = BG[1] + (DIM[1] - BG[1]) * tick;
        bb = BG[2] + (DIM[2] - BG[2]) * tick;
      }

      // Ring, needle and hub in amber.
      const mark = Math.max(
        cover(sdRing(sx, sy, c, c, r, ringW), px),
        cover(sdSegment(sx, sy, c, c, c, c - r * 0.92, size * 0.036 * scale), px),
        cover(Math.hypot(sx - c, sy - c) - size * 0.055 * scale, px),
      );
      rr = rr + (FG[0] - rr) * mark;
      gg = gg + (FG[1] - gg) * mark;
      bb = bb + (FG[2] - bb) * mark;

      const o = (y * size + x) * 4;
      rgba[o] = Math.round(rr);
      rgba[o + 1] = Math.round(gg);
      rgba[o + 2] = Math.round(bb);
      rgba[o + 3] = 255;
    }
  }
  return png(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-180.png', 180, 1],
  // Maskable icons get cropped to a circle, so shrink the artwork into the safe zone.
  ['icon-maskable-512.png', 512, 0.72],
];
for (const [name, size, scale] of files) {
  writeFileSync(resolve(OUT, name), render(size, scale));
  console.log(`wrote ${name} (${size}x${size})`);
}
