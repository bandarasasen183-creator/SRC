/**
 * Regenerate the favicon and app icons from public/img/logo.png.
 *
 *   node scripts/build-icons.mjs
 *
 * Pure JS (pngjs) so it runs the same on macOS, Linux and CI — no sips, no
 * ImageMagick, no native modules.
 *
 * Pipeline:
 *   1. strip the flat background (scripts/remove-bg.mjs, run separately or
 *      via build-icons.sh)
 *   2. box-filter downscale to each required size
 *   3. cap the display logo so phones aren't served a multi-megabyte file
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const SRC = 'public/img/logo.png';
const DISPLAY_MAX = 512;

if (!existsSync(SRC)) {
  console.error(`Not found: ${SRC}`);
  process.exit(1);
}

/**
 * Box-filter downscale. Alpha is premultiplied before averaging and
 * unpremultiplied after — without that, the RGB of fully transparent pixels
 * (usually white) bleeds into the edges and haloes the artwork.
 */
function resize(src, w, h) {
  const out = new PNG({ width: w, height: h });
  const sx = src.width / w;
  const sy = src.height / h;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (src.width * yy + xx) << 2;
          const al = src.data[i + 3] / 255;
          r += src.data[i] * al;
          g += src.data[i + 1] * al;
          b += src.data[i + 2] * al;
          a += src.data[i + 3];
          n++;
        }
      }
      const o = (w * y + x) << 2;
      const avgA = a / n;
      const unmul = avgA > 0 ? 255 / avgA : 0;
      out.data[o] = Math.min(255, Math.round((r / n) * unmul));
      out.data[o + 1] = Math.min(255, Math.round((g / n) * unmul));
      out.data[o + 2] = Math.min(255, Math.round((b / n) * unmul));
      out.data[o + 3] = Math.round(avgA);
    }
  }
  return out;
}

/** Flatten onto a solid colour — iOS renders alpha as black, which looks broken. */
function onBackground(img, [br, bg, bb]) {
  const out = new PNG({ width: img.width, height: img.height });
  for (let p = 0; p < img.width * img.height; p++) {
    const i = p << 2;
    const a = img.data[i + 3] / 255;
    out.data[i] = Math.round(img.data[i] * a + br * (1 - a));
    out.data[i + 1] = Math.round(img.data[i + 1] * a + bg * (1 - a));
    out.data[i + 2] = Math.round(img.data[i + 2] * a + bb * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

/** Fit within size×size, centred, preserving aspect ratio. */
function square(img, size, pad = 1) {
  const inner = Math.round(size * pad);
  const scale = Math.min(inner / img.width, inner / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const small = resize(img, w, h);

  const out = new PNG({ width: size, height: size, fill: true });
  out.data.fill(0);
  const ox = ((size - w) / 2) | 0;
  const oy = ((size - h) / 2) | 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (w * y + x) << 2;
      const d = (size * (y + oy) + (x + ox)) << 2;
      out.data[d] = small.data[s];
      out.data[d + 1] = small.data[s + 1];
      out.data[d + 2] = small.data[s + 2];
      out.data[d + 3] = small.data[s + 3];
    }
  }
  return out;
}

const kb = (n) => `${Math.round(n / 1024)}KB`;
const write = (path, img) => {
  const buf = PNG.sync.write(img);
  writeFileSync(path, buf);
  console.log(`  wrote ${path} (${img.width}px, ${kb(buf.length)})`);
};

const source = PNG.sync.read(readFileSync(SRC));
console.log(`Source: ${SRC} (${source.width}x${source.height}, ${kb(readFileSync(SRC).length)})`);
console.log('Generating…');

write('public/img/icon-512.png', square(source, 512));
write('public/img/icon-192.png', square(source, 192));
write('public/img/favicon.png', square(source, 64));
// iOS fills transparency with black, so flatten onto white with a little inset.
write('public/img/apple-touch-icon.png',
  onBackground(square(source, 180, 0.9), [255, 255, 255]));

// Cap the copy the browser actually loads on every page.
if (source.width > DISPLAY_MAX || source.height > DISPLAY_MAX) {
  if (!existsSync('public/img/logo-original.png')) {
    copyFileSync(SRC, 'public/img/logo-original.png');
    console.log('  kept full-resolution master as public/img/logo-original.png');
  }
  const before = readFileSync(SRC).length;
  const scale = DISPLAY_MAX / Math.max(source.width, source.height);
  write(SRC, resize(source, Math.round(source.width * scale), Math.round(source.height * scale)));
  console.log(`  display logo ${kb(before)} -> ${kb(readFileSync(SRC).length)}`);
}

console.log('\nDone.');
