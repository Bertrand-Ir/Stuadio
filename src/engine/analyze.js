'use strict';
/**
 * Streaming analysis of a recording (48 kHz mono float).
 * Produces: loudness, noise floor, speech level, hum, clipping, spectrum (speech + noise),
 * per-10 ms frame levels (for pause detection) and waveform peaks for the UI.
 */
const { SR, db, dbAmp, LoudnessMeter, FFT, goertzel, THIRD_OCTAVES, percentile } = require('./dsp');

const FRAME = 480;          // 10 ms
const FFT_N = 4096;
const HUM_DECIM = 32;       // 48k -> 1.5k for hum analysis
const HUM_RATE = SR / HUM_DECIM;
const HUM_LEN = 600;        // 0.4 s @ 1.5 kHz
const HUM_FREQS = [50, 100, 150, 200, 60, 120, 180, 240];

class Analyzer {
  constructor({ spectrum = true, hum = true, clipping = true } = {}) {
    this.opts = { spectrum, hum, clipping };
    this.meter = new LoudnessMeter();
    this.frameDb = [];
    this.framePeak = [];
    this.fAcc = 0; this.fPeak = 0; this.fN = 0;
    this.total = 0;
    this.peak = 0;
    // clipping
    this.clipRun = 0; this.clipEvents = 0;
    // spectrum
    if (spectrum) {
      this.fft = new FFT(FFT_N);
      this.fftBuf = new Float32Array(FFT_N); this.fftN = 0;
      this.pow = new Float64Array(FFT_N / 2 + 1);
      this.bandEdges = THIRD_OCTAVES.map((c) => [Math.max(1, Math.floor(c * Math.pow(2, -1 / 6) / (SR / FFT_N))), Math.ceil(c * Math.pow(2, 1 / 6) / (SR / FFT_N))]);
      this.blocks = []; // {rms, bands: Float32Array}
    }
    if (hum) {
      this.humAcc = 0; this.humAccN = 0;
      this.humBuf = new Float32Array(HUM_LEN); this.humN = 0;
      this.humRmsAcc = 0;
      this.humWin = new Float64Array(HUM_LEN);
      for (let i = 0; i < HUM_LEN; i++) this.humWin[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (HUM_LEN - 1));
      this.humBlocks = []; // {rms, p: Float64Array(24)}
    }
  }

  push(x) {
    this.meter.push(x);
    this.total += x.length;
    const o = this.opts;
    for (let i = 0; i < x.length; i++) {
      const v = x[i], a = v < 0 ? -v : v;
      // frames
      this.fAcc += v * v; if (a > this.fPeak) this.fPeak = a;
      if (++this.fN === FRAME) {
        this.frameDb.push(db(this.fAcc / FRAME));
        this.framePeak.push(this.fPeak);
        if (this.fPeak > this.peak) this.peak = this.fPeak;
        this.fAcc = 0; this.fPeak = 0; this.fN = 0;
      }
      // clipping: runs of >= 3 samples at full scale
      if (o.clipping) {
        if (a >= 0.998) { if (++this.clipRun === 3) this.clipEvents++; } else this.clipRun = 0;
      }
      if (o.spectrum) {
        this.fftBuf[this.fftN++] = v;
        if (this.fftN === FFT_N) { this._spectrumBlock(); this.fftN = 0; }
      }
      if (o.hum) {
        this.humAcc += v; this.humRmsAcc += v * v;
        if (++this.humAccN === HUM_DECIM) {
          this.humBuf[this.humN++] = this.humAcc / HUM_DECIM;
          this.humAcc = 0; this.humAccN = 0;
          if (this.humN === HUM_LEN) { this._humBlock(); this.humN = 0; this.humRmsAcc = 0; }
        }
      }
    }
  }

  _spectrumBlock() {
    let ss = 0;
    for (let i = 0; i < FFT_N; i++) ss += this.fftBuf[i] * this.fftBuf[i];
    const rms = db(ss / FFT_N);
    if (rms < -100) return;
    const p = this.fft.power(this.fftBuf, this.pow);
    const bands = new Float32Array(this.bandEdges.length);
    for (let b = 0; b < this.bandEdges.length; b++) {
      const [lo, hi] = this.bandEdges[b];
      let s = 0;
      for (let k = lo; k <= hi && k < p.length; k++) s += p[k];
      bands[b] = s;
    }
    this.blocks.push({ rms, bands });
  }

  _humBlock() {
    const rms = db(this.humRmsAcc / (HUM_LEN * HUM_DECIM));
    if (rms < -100) return;
    const p = new Float64Array(HUM_FREQS.length * 3);
    HUM_FREQS.forEach((f, j) => {
      p[j * 3] = goertzel(this.humBuf, HUM_LEN, f, HUM_RATE, this.humWin);
      p[j * 3 + 1] = goertzel(this.humBuf, HUM_LEN, f - 15, HUM_RATE, this.humWin);
      p[j * 3 + 2] = goertzel(this.humBuf, HUM_LEN, f + 15, HUM_RATE, this.humWin);
    });
    this.humBlocks.push({ rms, p });
  }

  finish() {
    if (this.fN > 0) {
      this.frameDb.push(db(this.fAcc / this.fN));
      this.framePeak.push(this.fPeak);
      if (this.fPeak > this.peak) this.peak = this.fPeak;
    }
    const frameDb = Float32Array.from(this.frameDb);
    const duration = this.total / SR;

    // Levels: smooth over 50 ms to avoid inter-syllable dips counting as "noise".
    const smooth = smoothDb(frameDb, 5);
    const noiseFloor = percentile(smooth, 0.08);
    const speechLevel = percentile(frameDb, 0.92);
    const snr = speechLevel - noiseFloor;
    const result = {
      duration,
      samples: this.total,
      integratedLufs: round1(this.meter.integrated()),
      peakDb: round1(dbAmp(this.peak)),
      noiseFloorDb: round1(noiseFloor),
      speechLevelDb: round1(speechLevel),
      snrDb: round1(snr),
      frameDb,
    };

    // Speech vs. noise block classification for spectrum + hum.
    const speechThr = speechLevel - 12;
    const noiseThr = noiseFloor + Math.min(6, Math.max(2, snr * 0.2));

    if (this.opts.spectrum && this.blocks.length) {
      const nb = THIRD_OCTAVES.length;
      const sp = new Float64Array(nb), np = new Float64Array(nb);
      let sn = 0, nn = 0;
      for (const b of this.blocks) {
        if (b.rms >= speechThr) { for (let i = 0; i < nb; i++) sp[i] += b.bands[i]; sn++; }
        else if (b.rms <= noiseThr) { for (let i = 0; i < nb; i++) np[i] += b.bands[i]; nn++; }
      }
      // If there is no quiet section at all, estimate noise from the quietest 10% of blocks.
      if (nn < 3) {
        const sorted = [...this.blocks].sort((a, b) => a.rms - b.rms).slice(0, Math.max(1, Math.floor(this.blocks.length * 0.1)));
        np.fill(0); nn = sorted.length;
        for (const b of sorted) for (let i = 0; i < nb; i++) np[i] += b.bands[i];
      }
      result.spectrum = {
        centers: THIRD_OCTAVES,
        speech: Array.from(sp, (v) => db(v / Math.max(1, sn))),
        noise: Array.from(np, (v) => db(v / Math.max(1, nn))),
        speechBlocks: sn, noiseBlocks: nn,
      };
    }

    if (this.opts.hum && this.humBlocks.length) {
      let quiet = this.humBlocks.filter((b) => b.rms <= noiseThr + 3);
      if (quiet.length < 3) quiet = [...this.humBlocks].sort((a, b) => a.rms - b.rms).slice(0, Math.max(1, Math.floor(this.humBlocks.length * 0.15)));
      const avg = new Float64Array(HUM_FREQS.length * 3);
      for (const b of quiet) for (let i = 0; i < avg.length; i++) avg[i] += b.p[i];
      // Contrast of each harmonic against its ±15 Hz neighbourhood; score = mean of the two strongest.
      const score = (from, to) => {
        const c = [];
        for (let j = from; j < to; j++) c.push(db(avg[j * 3]) - db((avg[j * 3 + 1] + avg[j * 3 + 2]) / 2));
        c.sort((x, y) => y - x);
        return (c[0] + c[1]) / 2;
      };
      const s50 = score(0, 4), s60 = score(4, 8);
      const best = s60 >= s50 ? 60 : 50;
      const strength = Math.max(s50, s60);
      // Hum also has to be audible: it must stand above the floor *and* not be buried below -75 dBFS.
      result.hum = { detected: strength > 5 && noiseFloor > -85, freq: best, strengthDb: round1(strength) };
    } else {
      result.hum = { detected: false, freq: 60, strengthDb: 0 };
    }

    result.clipping = { events: this.clipEvents, perMinute: round1(this.clipEvents / Math.max(1 / 60, duration / 60)) };
    result.waveform = buildWaveform(this.framePeak, 2400);
    return result;
  }
}

function smoothDb(frameDb, radius) {
  const n = frameDb.length, out = new Float32Array(n);
  const pw = Float64Array.from(frameDb, (d) => Math.pow(10, d / 10));
  let acc = 0, cnt = 0;
  for (let i = 0; i < Math.min(n, radius); i++) { acc += pw[i]; cnt++; }
  for (let i = 0; i < n; i++) {
    if (i + radius < n) { acc += pw[i + radius]; cnt++; }
    if (i - radius - 1 >= 0) { acc -= pw[i - radius - 1]; cnt--; }
    out[i] = db(Math.max(acc, 0) / cnt);
  }
  return out;
}

function buildWaveform(peaks, buckets) {
  const n = peaks.length;
  if (!n) return [];
  const count = Math.min(buckets, n);
  const out = new Array(count);
  for (let b = 0; b < count; b++) {
    const s = Math.floor(b * n / count), e = Math.max(s + 1, Math.floor((b + 1) * n / count));
    let m = 0;
    for (let i = s; i < e; i++) if (peaks[i] > m) m = peaks[i];
    out[b] = Math.round(Math.min(1, m) * 1000) / 1000;
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;

module.exports = { Analyzer, smoothDb, buildWaveform, FRAME };
