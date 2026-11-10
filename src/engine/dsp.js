'use strict';
/**
 * Small DSP toolkit: loudness (ITU-R BS.1770-4), FFT, Goertzel, helpers.
 * Everything assumes 48 kHz mono float input.
 */

const SR = 48000;

const db = (p) => 10 * Math.log10(Math.max(p, 1e-20)); // power -> dB
const dbAmp = (a) => 20 * Math.log10(Math.max(Math.abs(a), 1e-10)); // amplitude -> dB
const fromDb = (d) => Math.pow(10, d / 20);

/** Converts a stream of Buffers (f32le) into Float32Array chunks, handling odd byte splits. */
class F32Reader {
  constructor(onSamples) { this.rest = null; this.onSamples = onSamples; }
  push(buf) {
    if (this.rest) { buf = Buffer.concat([this.rest, buf]); this.rest = null; }
    const usable = buf.length - (buf.length % 4);
    if (usable < buf.length) this.rest = Buffer.from(buf.subarray(usable));
    if (!usable) return;
    // Copy to guarantee 4-byte alignment.
    const ab = new ArrayBuffer(usable);
    new Uint8Array(ab).set(buf.subarray(0, usable));
    this.onSamples(new Float32Array(ab));
  }
}

/** Biquad in transposed direct form II. */
class Biquad {
  constructor(b, a) { this.b0 = b[0]; this.b1 = b[1]; this.b2 = b[2]; this.a1 = a[1]; this.a2 = a[2]; this.z1 = 0; this.z2 = 0; }
  step(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Integrated loudness meter (BS.1770-4 gating), mono, 48 kHz. */
class LoudnessMeter {
  constructor() {
    this.shelf = new Biquad([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]);
    this.hp = new Biquad([1.0, -2.0, 1.0], [1, -1.99004745483398, 0.99007225036621]);
    this.sub = []; // mean-square per 100 ms
    this.acc = 0; this.n = 0;
  }
  push(x) {
    const { shelf, hp } = this;
    let acc = this.acc, n = this.n;
    for (let i = 0; i < x.length; i++) {
      const y = hp.step(shelf.step(x[i]));
      acc += y * y;
      if (++n === 4800) { this.sub.push(acc / 4800); acc = 0; n = 0; }
    }
    this.acc = acc; this.n = n;
  }
  integrated() {
    const s = this.sub;
    const blocks = [];
    for (let i = 0; i + 4 <= s.length; i++) blocks.push((s[i] + s[i + 1] + s[i + 2] + s[i + 3]) / 4);
    if (!blocks.length) return -70;
    const L = (z) => -0.691 + db(z);
    let gated = blocks.filter((z) => L(z) > -70);
    if (!gated.length) return -70;
    const rel = L(gated.reduce((a, b) => a + b, 0) / gated.length) - 10;
    gated = gated.filter((z) => L(z) > rel);
    if (!gated.length) return -70;
    return L(gated.reduce((a, b) => a + b, 0) / gated.length);
  }
}

/** In-place radix-2 complex FFT. */
class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(-2 * Math.PI * i / n); this.sin[i] = Math.sin(-2 * Math.PI * i / n); }
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  }
  /** Returns power spectrum (n/2+1 bins) of a real block using a Hann window. */
  power(block, out) {
    const n = this.n, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[this.rev[i]] = block[i] * this.window[i];
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], s = this.sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    out = out || new Float64Array(n / 2 + 1);
    for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  }
}

/** Goertzel power of a single frequency with a precomputed window. */
function goertzel(x, len, freq, rate, win) {
  const w = 2 * Math.PI * freq / rate, coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = x[i] * win[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

const THIRD_OCTAVES = [50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000];

function percentile(arr, p) {
  if (!arr.length) return -100;
  const a = Float32Array.from(arr).sort();
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[i];
}

module.exports = { SR, db, dbAmp, fromDb, F32Reader, Biquad, LoudnessMeter, FFT, goertzel, THIRD_OCTAVES, percentile };
