// Derives the maskable icon from the favicon's own artwork.
//
// A maskable icon is cropped by the launcher to whatever shape it likes, so
// the background has to reach the edges and everything that matters has to sit
// inside the central circle of 80% diameter. The favicon can't do that job: it
// is a rounded card, and cropping a rounded card to a circle shaves its
// corners. So the card goes, the green behind it fills the frame, and the
// radio itself is scaled to fit the safe circle.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'public/icons/favicon.svg');
const OUT = resolve(ROOT, 'public/icons/icon-maskable-512.png');
const TEMP = resolve(ROOT, 'public/icons/.maskable.svg');

/** The card the artwork sits on, which the maskable does without. */
const CARD = /<rect x="6" y="6"[^>]*><\/rect>/;
/** Bounding box of everything else: the display, the speaker and its bolts. */
const CONTENT = { minX: 74, minY: 72, maxX: 438, maxY: 475 };
const SIZE = 512;
/** Maskable safe zone: a circle of 80% the icon's width, centred. */
const SAFE_RADIUS = SIZE * 0.4;

const svg = readFileSync(SOURCE, 'utf8');
const body = svg.slice(svg.indexOf('</metadata>') + '</metadata>'.length, svg.lastIndexOf('</svg>'));
if (!CARD.test(body)) throw new Error('the artwork no longer starts with the card this strips');

const cx = (CONTENT.minX + CONTENT.maxX) / 2;
const cy = (CONTENT.minY + CONTENT.maxY) / 2;
const reach = Math.hypot(CONTENT.maxX - cx, CONTENT.maxY - cy);
// Round down, so rounding can only ever leave the artwork further inside.
const scale = Math.floor((SAFE_RADIUS / reach) * 100) / 100;

writeFileSync(TEMP, [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}"`,
  ` width="${SIZE}" height="${SIZE}" role="img"`,
  ' aria-label="Big Walk Radio app icon, maskable">',
  `<rect width="${SIZE}" height="${SIZE}" fill="#2e7d62"></rect>`,
  `<g transform="translate(${SIZE / 2} ${SIZE / 2}) scale(${scale}) translate(${-cx} ${-cy})">`,
  body.replace(CARD, ''),
  '</g></svg>',
].join(''));

execFileSync('magick', ['-background', 'none', TEMP, '-resize', `${SIZE}x${SIZE}`, OUT]);
unlinkSync(TEMP);
console.log(`wrote icon-maskable-512.png — artwork at ${Math.round(scale * 100)}%, reach ${reach.toFixed(1)}px`);
