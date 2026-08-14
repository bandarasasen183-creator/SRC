/**
 * Make the flat background of public/img/logo.png transparent.
 *
 *   node scripts/remove-bg.mjs [path] [--tolerance N] [--dry]
 *
 * Why a flood fill and not "delete every white pixel": the SRC badge has
 * white lettering and white dots INSIDE the circle. Deleting all white would
 * punch holes straight through them. Instead this floods inward from the
 * image border and only clears background that is actually connected to the
 * edge, so anything enclosed by the badge is untouched.
 *
 * Pure JS (pngjs) — no native modules, no ImageMagick, works anywhere Node
 * runs. The original is kept as logo-original.png before anything is written.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const tolIdx = args.indexOf('--tolerance');
const TOL = tolIdx !== -1 ? Number(args[tolIdx + 1]) : 32;
const file = args.find((a) => !a.startsWith('--') && a !== String(TOL))
  || 'public/img/logo.png';

if (!existsSync(file)) {
  console.error(`Not found: ${file}`);
  console.error('Copy your artwork to public/img/logo.png first.');
  process.exit(1);
}

const png = PNG.sync.read(readFileSync(file));
const { width: W, height: H, data } = png;
const at = (x, y) => (W * y + x) << 2;

// ---- is it already transparent? --------------------------------------------
const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
if (corners.every(([x, y]) => data[at(x, y) + 3] < 16)) {
  console.log('Background is already transparent — nothing to do.');
  process.exit(0);
}

// ---- what colour is the background? ----------------------------------------
// Sample the corners rather than assuming white, so an off-white or coloured
// backdrop works too.
const tally = new Map();
for (const [x, y] of corners) {
  const i = at(x, y);
  const k = `${data[i]},${data[i + 1]},${data[i + 2]}`;
  tally.set(k, (tally.get(k) || 0) + 1);
}
const [bgKey] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
const BG = bgKey.split(',').map(Number);
console.log(`Image ${W}x${H}, background rgb(${BG.join(', ')}), tolerance ${TOL}`);

const dist = (i) => Math.max(
  Math.abs(data[i] - BG[0]),
  Math.abs(data[i + 1] - BG[1]),
  Math.abs(data[i + 2] - BG[2]),
);

// ---- flood fill inward from every border pixel ------------------------------
const bg = new Uint8Array(W * H);
const stack = [];
const push = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const p = W * y + x;
  if (bg[p]) return;
  if (dist(p << 2) > TOL) return;
  bg[p] = 1;
  stack.push(p);
};
for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }

while (stack.length) {
  const p = stack.pop();
  const x = p % W, y = (p / W) | 0;
  push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
}

// ---- feather the boundary ---------------------------------------------------
// Pixels next to the cleared area that are still close to the background are
// anti-aliasing fringe. Fading them proportionally avoids a hard white halo
// around the circle.
const alpha = new Uint8Array(W * H).fill(255);
for (let p = 0; p < W * H; p++) if (bg[p]) alpha[p] = 0;

let feathered = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = W * y + x;
    if (bg[p]) continue;
    const touchesBg =
      (x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) ||
      (y > 0 && bg[p - W]) || (y < H - 1 && bg[p + W]);
    if (!touchesBg) continue;
    const d = dist(p << 2);
    if (d < TOL * 2) {
      alpha[p] = Math.round((d / (TOL * 2)) * 255);
      feathered++;
    }
  }
}

const cleared = bg.reduce((n, v) => n + v, 0);
const pct = ((cleared / (W * H)) * 100).toFixed(1);
console.log(`Cleared ${cleared} px (${pct}%), feathered ${feathered} edge px`);

if (cleared === 0) {
  console.log('Nothing matched the background colour. Try a larger --tolerance.');
  process.exit(0);
}
if (pct > 95) {
  console.error(`Refusing to write: ${pct}% of the image would vanish.`);
  console.error('The logo probably has no flat background. Try --tolerance 12.');
  process.exit(1);
}

for (let p = 0; p < W * H; p++) data[(p << 2) + 3] = alpha[p];

if (dry) {
  console.log('--dry: no files written.');
  process.exit(0);
}

const backup = file.replace(/\.png$/i, '-original.png');
if (!existsSync(backup)) {
  copyFileSync(file, backup);
  console.log(`Original saved as ${backup}`);
}
writeFileSync(file, PNG.sync.write(png));
console.log(`Wrote ${file} with a transparent background.`);
