/**
 * Renders the Newsy glyph to PNG. Notification icons must be raster, so rather
 * than adding an SVG rasterizer dependency we plot the handful of shapes the
 * logo is made of and write the PNG by hand.
 *
 *   node scripts/gen-icon.ts
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BLUE: [number, number, number] = [0x2f, 0x6b, 0xff];
const WHITE: [number, number, number] = [0xff, 0xff, 0xff];

type Point = { x: number; y: number };

function roundedRect(p: Point, x: number, y: number, w: number, h: number, r: number): boolean {
  if (p.x < x || p.y < y || p.x > x + w || p.y > y + h) return false;
  const cx = Math.min(Math.max(p.x, x + r), x + w - r);
  const cy = Math.min(Math.max(p.y, y + r), y + h - r);
  return Math.hypot(p.x - cx, p.y - cy) <= r;
}

/** Distance from a point to a line segment — used for the round-capped bars. */
function capsule(p: Point, x1: number, y1: number, x2: number, y2: number, r: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / len2));
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy)) <= r;
}

function circle(p: Point, cx: number, cy: number, r: number): boolean {
  return Math.hypot(p.x - cx, p.y - cy) <= r;
}

/** Returns the colour at a point in the 24×24 design space, or null for transparent. */
function shade(p: Point): [number, number, number] | null {
  if (circle(p, 17.6, 16.4, 1.3)) return BLUE;
  if (circle(p, 17.6, 16.4, 2.9)) return WHITE;
  if (capsule(p, 6, 8, 16, 8, 0.95)) return WHITE;
  if (capsule(p, 6, 12, 16, 12, 0.95)) return WHITE;
  if (capsule(p, 6, 16, 12, 16, 0.95)) return WHITE;
  if (roundedRect(p, 1, 1, 22, 22, 6.5)) return BLUE;
  return null;
}

function render(size: number): Buffer {
  const scale = 24 / size;
  const samples = 3;
  const raw = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const point = {
            x: (x + (sx + 0.5) / samples) * scale,
            y: (y + (sy + 0.5) / samples) * scale,
          };
          const colour = shade(point);
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          hits++;
        }
      }

      const total = samples * samples;
      const alpha = Math.round((hits / total) * 255);
      const offset = rowStart + 1 + x * 4;
      raw[offset] = hits ? Math.round(r / hits) : 0;
      raw[offset + 1] = hits ? Math.round(g / hits) : 0;
      raw[offset + 2] = hits ? Math.round(b / hits) : 0;
      raw[offset + 3] = alpha;
    }
  }

  return png(size, raw);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Windows shortcuts need a .ico, which PNG files cannot stand in for. Since
 * Vista an ICO may hold PNG-compressed entries, so the same rendered images are
 * simply wrapped in an ICO container rather than re-encoded as BMP.
 */
function ico(sizes: number[]): Buffer {
  const images = sizes.map((size) => render(size));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((png, i) => {
    const at = i * 16;
    // 0 in the width/height byte means 256 — the largest an ICO can describe.
    directory[at] = sizes[i] >= 256 ? 0 : sizes[i];
    directory[at + 1] = sizes[i] >= 256 ? 0 : sizes[i];
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images]);
}

for (const size of [192, 512]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}

const icoFile = path.join(OUT_DIR, 'newsy.ico');
writeFileSync(icoFile, ico([16, 32, 48, 64, 128, 256]));
console.log(`wrote ${icoFile}`);
