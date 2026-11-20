#!/usr/bin/env node
/*
 * The link-preview card of the docs site, docs/brand/og.png (1200x630), and the social preview of the GitHub repository, docs/brand/social-preview.png
 * (1280x640, GitHub's size; the Director uploads it by hand in the repository's Settings): the logo and the tagline on the Instrument livery, the same design
 * in both, with the content well inside the edges, which GitHub and the chat apps crop.
 * Written pixel by pixel with node alone (no browser, no font, no dependency), so it is the same bytes on every machine:
 * test/og.test.ts runs it again and compares with the committed file. The logo is read from docs/brand/lockup.svg (its circles and rounded
 * rectangles); the tagline is drawn in the same dot matrix as the logo's word, on a 5x7 grid of the a slightly larger pitch and dot.
 *
 * node scripts/og-image.mjs [--out <file>]   --out writes only the docs card (the test compares it with the committed one)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CARDS = [
  ['og.png', 1200, 630],
  ['social-preview.png', 1280, 640],
];
const BODY = [0xe4, 0xe2, 0xdc]; // --body of the Instrument livery
const INK = [0x26, 0x27, 0x2b]; // --text
const SAMPLES = 4; // 4 x 4 samples per pixel
const LINES = ['MISSION CONTROL FOR', 'AI CODING AGENTS'];

const GLYPHS = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};

const hex = (value) => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));

/** The shapes of an SVG made of nested <g> (translate, scale, fill), <rect> and <circle>, in the order they are painted. */
function shapesOf(svg) {
  const shapes = [];
  const stack = [{ tx: 0, ty: 0, s: 1, fill: '#000000' }];
  for (const tag of svg.matchAll(/<(\/?)(g|rect|circle)\b([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrs, selfClosing] = tag;
    const attr = (key) => new RegExp(`\\s${key}="([^"]*)"`).exec(` ${attrs}`)?.[1];
    const top = stack[stack.length - 1];
    if (name === 'g') {
      if (closing) {
        stack.pop();
        continue;
      }
      const next = { ...top };
      const transform = attr('transform');
      if (transform !== undefined) {
        const move = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(transform);
        const scale = /scale\(\s*([-\d.]+)\s*\)/.exec(transform);
        // translate then scale: a point p goes to translate + scale * p
        if (scale) next.s = top.s * Number(scale[1]);
        if (move) {
          next.tx = top.tx + top.s * Number(move[1]);
          next.ty = top.ty + top.s * Number(move[2]);
        }
      }
      if (attr('fill') !== undefined) next.fill = attr('fill');
      if (!selfClosing) stack.push(next);
      continue;
    }
    if (closing) continue;
    const n = (key, fallback = 0) => Number(attr(key) ?? fallback);
    const fill = hex(attr('fill') ?? top.fill);
    if (name === 'circle') shapes.push({ kind: 'circle', cx: top.tx + top.s * n('cx'), cy: top.ty + top.s * n('cy'), r: top.s * n('r'), fill });
    else shapes.push({ kind: 'rect', x: top.tx + top.s * n('x'), y: top.ty + top.s * n('y'), w: top.s * n('width'), h: top.s * n('height'), r: top.s * n('rx'), fill });
  }
  return shapes;
}

/** One card of w x h pixels as PNG bytes. */
function render(W, H) {
const pixels = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i += 1) pixels.set(BODY, i * 3);

/** Paints a shape with 4x4 samples per pixel, over what is there. `inside(x, y)` is the shape's own test. */
function paint(box, inside, fill) {
  const x0 = Math.max(0, Math.floor(box.x0));
  const x1 = Math.min(W - 1, Math.ceil(box.x1));
  const y0 = Math.max(0, Math.floor(box.y0));
  const y1 = Math.min(H - 1, Math.ceil(box.y1));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      let hit = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) for (let sx = 0; sx < SAMPLES; sx += 1) if (inside(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES)) hit += 1;
      if (hit === 0) continue;
      const a = hit / (SAMPLES * SAMPLES);
      const at = (y * W + x) * 3;
      for (let c = 0; c < 3; c += 1) pixels[at + c] = Math.round(pixels[at + c] * (1 - a) + fill[c] * a);
    }
  }
}

function draw(shape, dx, dy, scale) {
  if (shape.kind === 'circle') {
    const cx = dx + scale * shape.cx;
    const cy = dy + scale * shape.cy;
    const r = scale * shape.r;
    paint({ x0: cx - r, x1: cx + r, y0: cy - r, y1: cy + r }, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r, shape.fill);
    return;
  }
  const x = dx + scale * shape.x;
  const y = dy + scale * shape.y;
  const w = scale * shape.w;
  const h = scale * shape.h;
  const r = scale * shape.r;
  paint(
    { x0: x, x1: x + w, y0: y, y1: y + h },
    (px, py) => {
      if (px < x || px > x + w || py < y || py > y + h) return false;
      // a corner is a quarter circle of radius r
      const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
      const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
      return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
    },
    shape.fill,
  );
}

// the logo and the tagline are 1085 px wide on either card: 57 px from the edge of the narrower one, and the content is centred
const lockup = readFileSync(new URL('../docs/brand/lockup.svg', import.meta.url), 'utf8');
const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(lockup);
const lockupW = Number(box[1]);
const lockupH = Number(box[2]);

// the tagline's width sets the logo's: the dots are the logo word's own, a little larger (pitch 9.6, radius 4.3)
const PITCH = 9.6;
const DOT = 4.3;
const COLS = Math.max(...LINES.map((line) => line.length * 6 - 1));
const textW = COLS * PITCH;
const scale = textW / lockupW;
const logoH = lockupH * scale;
const textH = (7 + 2 + 7) * PITCH;
const GAP = 70;
const left = (W - textW) / 2;
const top = (H - (logoH + GAP + textH)) / 2;

for (const shape of shapesOf(lockup)) draw(shape, left, top, scale);

LINES.forEach((line, row) => {
  const baseY = top + logoH + GAP + row * 9 * PITCH;
  [...line].forEach((letter, index) => {
    const glyph = GLYPHS[letter];
    if (glyph === undefined) throw new Error(`no glyph for "${letter}"`);
    glyph.forEach((bits, gy) => {
      [...bits].forEach((bit, gx) => {
        if (bit === '1') draw({ kind: 'circle', cx: PITCH / 2 + (index * 6 + gx) * PITCH, cy: PITCH / 2 + gy * PITCH, r: DOT, fill: INK }, left, baseY, 1);
      });
    });
  });
});

/** A PNG: 8-bit RGB, no filter, one deflate stream. */
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(W, 0);
  header.writeUInt32BE(H, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y += 1) {
    raw[y * (W * 3 + 1)] = 0;
    raw.set(pixels.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

return png();
}

if (process.argv.includes('--out')) writeFileSync(process.argv[process.argv.indexOf('--out') + 1], render(CARDS[0][1], CARDS[0][2]));
else for (const [file, w, h] of CARDS) writeFileSync(new URL(`../docs/brand/${file}`, import.meta.url).pathname, render(w, h));
