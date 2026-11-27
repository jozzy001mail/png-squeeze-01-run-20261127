// png-squeeze-01: lossless PNG re-encoder.
// Strategy (from scratch): decode the stored RGBA PNG, analyse the image
// (opaque / grey / <=256 colours / single transparent key), try several
// lossless forms (palette by count, by luminance, by greedy nearest-neighbour
// order; grey / grey+alpha / RGB / RGBA, with a tRNS key where possible),
// try fixed + min-sum + fewest-pairs per-row filters for each form, screen
// every candidate with zlib level 6, then re-encode the best two with
// zlib level 9 (default + filtered strategies) and keep the smallest.
// Deterministic: fixed work per image, no clock, no environment reads.
import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crcIn = new Uint8Array(4 + data.length);
  crcIn.set(out.subarray(4, 8), 0); crcIn.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcIn));
  return out;
}
function ihdr(ct: number): Uint8Array {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  d[8] = 8; d[9] = ct; d[10] = 0; d[11] = 0; d[12] = 0;
  return d;
}
const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
function pngOf(ct: number, plte: Uint8Array | null, trns: Uint8Array | null, idat: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [PNG_SIG, chunk('IHDR', ihdr(ct))];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- PNG decode (stored RGBA input; generic unfilter) ----
function paeth(l: number, u: number, ul: number): number {
  const p = l + u - ul;
  const pl = Math.abs(p - l), pu = Math.abs(p - u), pul = Math.abs(p - ul);
  if (pl <= pu && pl <= pul) return l;
  if (pu <= pul) return u;
  return ul;
}
function decodePng(bytes: Uint8Array): Uint8Array {
  let pos = 8;
  let ct = 6; let idat: Uint8Array[] = []; let idatLen = 0;
  while (pos + 8 <= bytes.length) {
    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ct = data[9];
    else if (type === 'IDAT') { idat.push(data); idatLen += len; }
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const comp = new Uint8Array(idatLen);
  let o = 0; for (const d of idat) { comp.set(d, o); o += d.length; }
  const raw = inflateSync(comp);
  const ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
  const stride = W * ch;
  const out = new Uint8Array(W * H * 4);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) v = (v + paeth(a, b, c)) & 0xff;
      cur[x] = v;
    }
    prev.set(cur);
    // expand to RGBA
    const dst = y * W * 4;
    if (ct === 6) out.set(cur, dst);
    else if (ct === 2) { for (let x = 0; x < W; x++) { out[dst + x * 4] = cur[x * 3]; out[dst + x * 4 + 1] = cur[x * 3 + 1]; out[dst + x * 4 + 2] = cur[x * 3 + 2]; out[dst + x * 4 + 3] = 255; } }
    else if (ct === 0) { for (let x = 0; x < W; x++) { const g = cur[x]; out[dst + x * 4] = g; out[dst + x * 4 + 1] = g; out[dst + x * 4 + 2] = g; out[dst + x * 4 + 3] = 255; } }
    else if (ct === 4) { for (let x = 0; x < W; x++) { const g = cur[x * 2]; out[dst + x * 4] = g; out[dst + x * 4 + 1] = g; out[dst + x * 4 + 2] = g; out[dst + x * 4 + 3] = cur[x * 2 + 1]; } }
  }
  return out;
}

// ---- analysis ----
interface Colour { r: number; g: number; b: number; a: number; word: number; count: number }
function analyse(rgba: Uint8Array) {
  const n = rgba.length >>> 2;
  let opaque = true; let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const word = (rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24)) >>> 0;
      const k = counts.get(word);
      if (k === undefined) {
        if (counts.size === 256) many = true; else counts.set(word, 1);
      } else counts.set(word, k + 1);
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      r: word & 0xff, g: (word >>> 8) & 0xff, b: (word >>> 16) & 0xff, a: (word >>> 24) & 0xff, word, count,
    }));
  }
  return { opaque, grey, colours };
}
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v; else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0; i < n; i++) {
    const d = i * 4, s = i * ch;
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// ---- palette forms ----
function orderPalette(colours: Colour[], order: string): Colour[] {
  const lum = (c: Colour) => 299 * c.r + 587 * c.g + 114 * c.b;
  const transparent = colours.filter((c) => c.a !== 255).sort((x, y) => x.a - y.a || y.count - x.count || x.word - y.word);
  const opaqueCols = colours.filter((c) => c.a === 255);
  let rest: Colour[];
  if (order === 'luminance') rest = [...opaqueCols].sort((x, y) => lum(x) - lum(y) || x.word - y.word);
  else if (order === 'greedy') {
    rest = [];
    const pool = [...opaqueCols].sort((x, y) => y.count - x.count || x.word - y.word);
    if (pool.length > 0) {
      let cur = pool.shift()!;
      rest.push(cur);
      while (pool.length > 0) {
        let bi = 0; let bd = Infinity;
        for (let i = 0; i < pool.length; i++) {
          const p = pool[i];
          const dr = p.r - cur.r, dg = p.g - cur.g, db = p.b - cur.b;
          const dist = 299 * dr * dr + 587 * dg * dg + 114 * db * db - p.count * 0.001;
          if (dist < bd) { bd = dist; bi = i; }
        }
        cur = pool.splice(bi, 1)[0];
        rest.push(cur);
      }
    }
  } else rest = [...opaqueCols].sort((x, y) => y.count - x.count || x.word - y.word);
  return [...transparent, ...rest];
}
function paletteForm(rgba: Uint8Array, colours: Colour[], order: string) {
  const entries = orderPalette(colours, order);
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i] as [number, number]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    const word = (rgba[d] | (rgba[d + 1] << 8) | (rgba[d + 2] << 16) | (rgba[d + 3] << 24)) >>> 0;
    indices[i] = index.get(word)!;
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

interface Form { colourType: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null }
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'greedy']) forms.push(paletteForm(rgba, colours, order));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number; let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

// ---- filters ----
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  for (let x = 0; x < n; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    let p = 0;
    if (type === 1) p = a;
    else if (type === 2) p = b;
    else if (type === 3) p = (a + b) >> 1;
    else p = paeth(a, b, c);
    out[x] = (cur[x] - p) & 0xff;
  }
}
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}
const PAIRS_SEEN = new Uint32Array(65536);
let pairsStamp = 0;
function pairsOf(row: Uint8Array): number {
  const stamp = ++pairsStamp;
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (PAIRS_SEEN[pair] !== stamp) { PAIRS_SEEN[pair] = stamp; n++; }
  }
  return n;
}
const ENT_TABLE = (() => {
  const t = new Float64Array(8192);
  for (let c = 2; c < t.length; c++) t[c] = c * Math.log2(c);
  return t;
})();
const ENT_COUNT = new Uint16Array(256);
const ENT_TOUCHED = new Uint16Array(256);
function entropyCost(row: Uint8Array): number {
  let nt = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (ENT_COUNT[v] === 0) ENT_TOUCHED[nt++] = v;
    ENT_COUNT[v]++;
  }
  let s = 0;
  for (let i = 0; i < nt; i++) { const v = ENT_TOUCHED[i]; s += ENT_TABLE[ENT_COUNT[v]]; ENT_COUNT[v] = 0; }
  return s;
}
type Choice = number | 'minsum' | 'pairs' | 'entropy';
// Brute-force filter choice: per row, try all five filters and keep the one
// whose deflate (level 4, with the previous 32 KiB of filtered output as
// dictionary) is smallest — the reference compressor's approach, and the
// main edge over the min-sum heuristic on photo-like rows.
function filteredBrute(samples: Uint8Array, bpp: number): Uint8Array {
  const stride = W * bpp;
  const raw = new Uint8Array(H * (stride + 1));
  const trial = new Uint8Array(stride + 1);
  const out = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0; let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[0] = t;
      filterRow(t, cur, prev, bpp, trial.subarray(1));
      const cost = before.length === 0
        ? deflateSync(trial, { level: 4, memLevel: 9 }).length
        : deflateSync(trial, { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw[at] = type;
    filterRow(type, cur, prev, bpp, out);
    raw.set(out, at + 1);
  }
  return raw;
}
function filtered(samples: Uint8Array, bpp: number, choice: Choice): Uint8Array {
  const stride = W * bpp;
  const raw = new Uint8Array(H * (stride + 1));
  const trial = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0; let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial);
      const cost = choice === 'minsum' ? signedSum(trial) : choice === 'pairs' ? pairsOf(trial) : entropyCost(trial);
      if (cost < best) { best = cost; type = t; }
    }
    raw[at] = type;
    filterRow(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

// ---- encode one image ----
function encodeImage(rgba: Uint8Array): Uint8Array {
  const forms = formsOf(rgba);
  const screened: { form: Form; data: Uint8Array; bytes: number }[] = [];
  for (const form of forms) {
    // Fixed filters can beat the per-row heuristics on palette indices
    // (a single Sub run compresses long flat runs better than mixed rows).
    const choices: Choice[] = [0, 1, 2, 3, 4, 'minsum', 'pairs', 'entropy'];
    for (const choice of choices) {
      const data = filtered(form.samples, form.bpp, choice);
      const z = deflateSync(data, { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
      const overhead = (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
      screened.push({ form, data, bytes: z.length + overhead });
    }
  }
  screened.sort((a, b) => a.bytes - b.bytes);
  // Brute-force filters for the single best-screened form only (bounded work).
  {
    const form = screened[0].form;
    const data = filteredBrute(form.samples, form.bpp);
    const z = deflateSync(data, { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
    const overhead = (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
    screened.push({ form, data, bytes: z.length + overhead });
    screened.sort((a, b) => a.bytes - b.bytes);
  }
  // Re-encode the best three screened candidates at level 9 (two strategies) and keep smallest.
  let best: Uint8Array | null = null;
  let bestLen = Infinity;
  const top = screened.slice(0, 3);
  for (const cand of top) {
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      const z = deflateSync(cand.data, { level: 9, memLevel: 9, strategy });
      const png = pngOf(cand.form.colourType, cand.form.plte, cand.form.trns, new Uint8Array(z));
      if (png.length < bestLen) { bestLen = png.length; best = png; }
    }
  }
  return best!;
}

// ---- main ----
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const rgba = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encodeImage(rgba));
}
