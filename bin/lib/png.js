/* bin/lib/png.js — decode a PNG to RGBA with node:zlib alone (the app ships the CLI without node_modules). Enough for the
   station's sprites and any ordinary image: 8-bit greyscale, grey+alpha, RGB, RGBA and palette (with tRNS), not interlaced.
   decode(buf) → { width, height, data: Uint8Array RGBA }; anything else throws, and the caller simply draws no picture. */
'use strict';

const zlib = require('node:zlib');
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString('latin1', off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height || width * height > 16e6) throw new Error('bad PNG size');
  if (depth !== 8 || !(type in CHANNELS) || interlace) throw new Error('unsupported PNG (depth ' + depth + ', type ' + type + (interlace ? ', interlaced' : '') + ')');
  const ch = CHANNELS[type], stride = width * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG');
  // undo the per-row filters (none, sub, up, average, paeth), one byte per channel
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i], a = i >= ch ? px[row + i - ch] : 0, b = y ? px[prev + i] : 0, c = (y && i >= ch) ? px[prev + i - ch] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error('bad PNG filter ' + f);
      px[row + i] = v & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const s = i * ch;
    if (type === 6) { data[j] = px[s]; data[j + 1] = px[s + 1]; data[j + 2] = px[s + 2]; data[j + 3] = px[s + 3]; }
    else if (type === 2) { data[j] = px[s]; data[j + 1] = px[s + 1]; data[j + 2] = px[s + 2]; data[j + 3] = 255; }
    else if (type === 0) { data[j] = data[j + 1] = data[j + 2] = px[s]; data[j + 3] = 255; }
    else if (type === 4) { data[j] = data[j + 1] = data[j + 2] = px[s]; data[j + 3] = px[s + 1]; }
    else { const k = px[s]; data[j] = palette ? palette[k * 3] : 0; data[j + 1] = palette ? palette[k * 3 + 1] : 0; data[j + 2] = palette ? palette[k * 3 + 2] : 0; data[j + 3] = trns && k < trns.length ? trns[k] : 255; }
  }
  return { width, height, data };
}

module.exports = { decode };
