'use strict';
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { run, probe, resolveModelsDir, CancelledError } = require('./ffmpeg');
const { F32Reader, SR, percentile, fromDb } = require('./dsp');
const { Analyzer, smoothDb, FRAME } = require('./analyze');
const { recommend, buildChain, LOUDNESS_TARGETS } = require('./chain');

const XFADE = Math.round(0.03 * SR); // 30 ms equal-power crossfade at every edit

/** Stream f32 output, dropping `skip` leading samples (filter latency) and capping at `total`. */
function trimmedSink(skip, total, onSamples) {
  let seen = 0, emitted = 0;
  return new F32Reader((x) => {
    const start = seen < skip ? Math.min(x.length, skip - seen) : 0;
    seen += x.length;
    let y = start ? x.subarray(start) : x;
    if (emitted + y.length > total) y = y.subarray(0, Math.max(0, total - emitted));
    if (y.length) { emitted += y.length; onSamples(y); }
  });
}

/** Incremental 32-bit FNV-1a over float sample bytes. */
class Fnv {
  constructor() { this.h = 0x811c9dc5; }
  update(f32) {
    const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let h = this.h;
    for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); }
    this.h = h;
  }
  digest() { return this.h >>> 0; }
}
const fnv = (f32) => { const h = new Fnv(); h.update(f32); return h.digest(); };

/** Speech-to-gap ratio (dB) – how well noise between words is suppressed relative to the voice. */
function gapRatio(x) {
  const db = [];
  for (let i = 0; i + FRAME <= x.length; i += FRAME) {
    let s = 0; for (let k = i; k < i + FRAME; k++) s += x[k] * x[k];
    db.push(10 * Math.log10(s / FRAME + 1e-20));
  }
  return percentile(db, 0.9) - percentile(db, 0.15);
}

function firstActiveSecond(frameDb) {
  const thr = percentile(frameDb, 0.92) - 15;
  for (let i = 0; i < frameDb.length; i++) if (frameDb[i] > thr) return i / 100;
  return 0;
}

/** Pause editing plan from 10 ms frame levels of the *processed* voice. */
function planPauses(frameDb, style) {
  const n = frameDb.length;
  const cfg = style === 'tight' ? { min: 0.55, keep: 0.32 } : { min: 0.9, keep: 0.55 };
  const speech = percentile(frameDb, 0.92);
  const noise = percentile(smoothDb(frameDb, 5), 0.08);
  const thr = Math.max(noise + 10, speech - 32);

  const active = new Uint8Array(n);
  for (let i = 0; i < n; i++) active[i] = frameDb[i] > thr ? 1 : 0;
  // Drop isolated blips (< 60 ms) – clicks, not words.
  for (let i = 0; i < n;) {
    if (!active[i]) { i++; continue; }
    let j = i; while (j < n && active[j]) j++;
    if (j - i < 6) active.fill(0, i, j);
    i = j;
  }
  // Protect word onsets (60 ms) and soft endings (150 ms).
  const prot = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (active[i]) { prot.fill(1, Math.max(0, i - 6), Math.min(n, i + 16)); }

  const cuts = []; // [startFrame, endFrame)
  for (let i = 0; i < n;) {
    if (prot[i]) { i++; continue; }
    let j = i; while (j < n && !prot[j]) j++;
    const d = (j - i) / 100;
    if (i === 0 && j === n) { i = j; continue; } // no speech at all
    if (i === 0) { if (d > 0.3) cuts.push([0, j - 25]); }
    else if (j === n) { if (d > 0.6) cuts.push([i + 50, n]); }
    else if (d > cfg.min) {
      const keep = Math.min(cfg.keep + (d - cfg.keep) * 0.12, cfg.keep + 0.3);
      const half = Math.round(keep * 50); // frames per side
      cuts.push([i + half, j - half]);
    }
    i = j;
  }
  return { cuts: cuts.filter(([a, b]) => b - a > 3), threshold: thr };
}

/** Convert cut list (frames) into kept segments (samples) with output timeline positions. */
function keepSegments(cuts, totalSamples) {
  const segs = [];
  let pos = 0;
  for (const [a, b] of cuts) {
    const s = a * FRAME, e = Math.min(totalSamples, b * FRAME);
    if (s > pos) segs.push([pos, s]);
    pos = e;
  }
  if (pos < totalSamples) segs.push([pos, totalSamples]);
  let dst = 0;
  return segs.map(([s, e], i) => {
    const seg = { src: s, end: e, dst };
    dst += (e - s) - (i < segs.length - 1 ? XFADE : 0);
    return seg;
  });
}

class Session {
  constructor(workDir) {
    this.workDir = workDir;
    fs.mkdirSync(workDir, { recursive: true });
    this.signal = { cancelled: false, procs: new Set() };
    this.source = null;
  }

  _p(name) { return path.join(this.workDir, name); }

  cancel() {
    this.signal.cancelled = true;
    for (const p of this.signal.procs) { try { p.kill('SIGKILL'); } catch {} }
  }
  _fresh() { this.signal = { cancelled: false, procs: new Set() }; return this.signal; }

  dispose() {
    this.cancel();
    try { fs.rmSync(this.workDir, { recursive: true, force: true }); } catch {}
  }

  /** Decode, preview, and analyse the source. */
  async load(file, onProgress = () => {}) {
    const signal = this._fresh();
    const info = await probe(file);
    const analyzer = new Analyzer();
    const reader = new F32Reader((x) => analyzer.push(x));
    const previewCh = Math.min(2, info.channels || 1);
    await run([
      '-i', file,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1',
      '-map', '0:a:0', '-vn', '-ac', String(previewCh), '-ar', String(SR), '-c:a', 'pcm_s16le', '-y', this._p('original.wav'),
    ], {
      signal,
      onStdout: (b) => reader.push(b),
      onProgress: (t) => info.duration && onProgress(Math.min(0.99, t / info.duration)),
    });
    const a = analyzer.finish();
    // Rough pause estimate for the diagnosis panel (refined after cleanup).
    const est = planPauses(a.frameDb, 'natural');
    a.longPauses = est.cuts.filter(([s, e]) => s > 0 && e < a.frameDb.length).length;
    a.pauseSeconds = Math.round(est.cuts.reduce((t, [s, e]) => t + (e - s), 0)) / 100;
    if (!info.duration) info.duration = a.duration;

    this.source = { file, info, analysis: a };
    const { frameDb, ...publicAnalysis } = a;
    return {
      file,
      name: path.basename(file),
      info,
      analysis: publicAnalysis,
      recommended: recommend(a, info),
      preview: this._p('original.wav'),
    };
  }

  /**
   * Full enhancement. Progress is reported as { phase, value } with phases:
   * clean (0–0.7), edit (0.7–0.8), master (0.8–0.95), verify (0.95–1).
   */
  async enhance(settings, onProgress = () => {}) {
    if (!this.source) throw new Error('No file loaded');
    const signal = this._fresh();
    const { file, info, analysis } = this.source;
    const dur = info.duration || analysis.duration;
    const report = (phase, v) => onProgress({ phase, value: Math.max(0, Math.min(1, v)) });

    // ---- Pass 1: clean (stage A, verified) + shape (stage B) ---------------------
    const chain = buildChain(settings, analysis);
    const total = analysis.samples;
    const stageAPath = this._p('stageA.f32');
    const rawPath = this._p('stage1.f32');
    report('clean', 0);
    await this._neuralStage(file, chain.stageA, total, stageAPath, signal, (t) => report('clean', (t / dur) * 0.4));

    const post = new Analyzer({ spectrum: false, hum: false, clipping: false });
    let samples = 0;
    const fd = fs.openSync(rawPath, 'w');
    try {
      const sink = trimmedSink(chain.stageB.latency, total, (x) => {
        post.push(x);
        fs.writeSync(fd, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
        samples += x.length;
      });
      await run(['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', stageAPath, '-af', chain.stageB.filter, '-f', 'f32le', 'pipe:1'], {
        signal,
        onStdout: (b) => sink.push(b),
        onProgress: (t) => report('clean', 0.4 + (t / dur) * 0.3),
      });
    } finally { fs.closeSync(fd); }
    fs.rmSync(stageAPath, { force: true });
    const p1 = post.finish();

    // ---- Edit: pause plan -------------------------------------------------------
    report('edit', 0.72);
    let segments = [{ src: 0, end: samples, dst: 0 }];
    let removed = 0, pauseCount = 0;
    if (settings.pauses.on) {
      const plan = planPauses(p1.frameDb, settings.pauses.style);
      segments = keepSegments(plan.cuts, samples);
      pauseCount = plan.cuts.length;
      const outLen = segments.length ? segments[segments.length - 1].dst + (segments[segments.length - 1].end - segments[segments.length - 1].src) : 0;
      removed = (samples - outLen) / SR;
    }

    // ---- Pass 2: master -------------------------------------------------------
    const target = LOUDNESS_TARGETS[settings.loudness.target] || LOUDNESS_TARGETS.podcast;
    const targetLufs = settings.loudness.on ? target.lufs : Math.min(-10, analysis.integratedLufs);
    const ceiling = settings.loudness.on ? target.ceiling : -1.0;
    let gainDb = targetLufs - p1.integratedLufs;
    gainDb = Math.max(-30, Math.min(40, gainDb));
    const masterPath = this._p('studio.wav');
    let verify;
    // The limiter absorbs part of any gain increase, so search for the gain that lands on
    // target (secant method on measured loudness). Re-mastering is fast: no re-cleaning.
    const tried = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      await this._master(rawPath, segments, gainDb, ceiling, masterPath, signal, (v) => report('master', 0.8 + v * 0.15));
      report('verify', 0.95);
      verify = await this._measure(masterPath, signal);
      tried.push([gainDb, verify.lufs]);
      const miss = targetLufs - verify.lufs;
      if (Math.abs(miss) <= 0.2 || attempt === 4) break;
      let slope = 1;
      if (tried.length > 1) {
        const [g1, l1] = tried[tried.length - 2], [g2, l2] = tried[tried.length - 1];
        if (Math.abs(g2 - g1) > 0.01) slope = Math.max(0.15, Math.min(1, (l2 - l1) / (g2 - g1)));
      }
      gainDb = Math.min(gainDb + Math.max(-8, Math.min(8, miss / slope)), 48);
    }
    report('verify', 1);
    fs.rmSync(rawPath, { force: true });

    const result = {
      preview: masterPath,
      duration: verify.analysis.duration,
      lufs: verify.lufs,
      truePeak: verify.truePeak,
      noiseFloorDb: verify.analysis.noiseFloorDb,
      speechLevelDb: verify.analysis.speechLevelDb,
      waveform: verify.analysis.waveform,
      removedSeconds: Math.round(removed * 10) / 10,
      pauseCount,
      segments: segments.map((s) => [s.src / SR, s.end / SR, s.dst / SR]),
      target: { lufs: targetLufs, ceiling },
      steps: chain.steps,
    };
    this.result = result;
    return result;
  }

  /**
   * Stage A: repair + neural denoise, written to `outPath` as raw f32.
   *
   * The bundled ffmpeg's RNNoise filter has a memory bug: in roughly half of all processes it
   * runs with a corrupted network that removes ~10 dB less noise and dulls speech. Output is
   * otherwise deterministic, and only ever takes one of two forms. So we:
   *   1. probe the opening seconds in a few parallel processes and identify the correct output
   *      (the healthy network has a clearly higher speech-to-gap ratio), then
   *   2. run the full pass, hash its opening samples as they stream, and restart instantly
   *      if they don't match the healthy fingerprint.
   */
  async _neuralStage(file, stage, total, outPath, signal, progress) {
    const cwd = resolveModelsDir();
    const inArgs = ['-i', file, '-map', '0:a:0', '-vn', '-af', stage.filter, '-f', 'f32le', 'pipe:1'];
    let goodHash = null, K = 0;

    if (stage.neural) {
      const a = this.source.analysis;
      // Probe window: up to 10 s past the first speech, so the network has heard voice.
      const firstSpeech = firstActiveSecond(a.frameDb);
      const probeSec = Math.min(a.duration, Math.max(8, Math.min(40, firstSpeech + 10)));
      K = Math.min(total, Math.max(0, Math.round((probeSec - 0.5) * SR)));
      const probe = async () => {
        const buf = new Float32Array(K);
        let n = 0;
        const sink = trimmedSink(stage.latency, K, (x) => { buf.set(x, n); n += x.length; });
        await run(['-t', (probeSec + 1).toFixed(2), ...inArgs], { cwd, signal, onStdout: (b) => sink.push(b) });
        return { hash: fnv(buf.subarray(0, n)), score: gapRatio(buf.subarray(0, n)), n };
      };
      const groups = new Map();
      const add = (r) => { const g = groups.get(r.hash) || { ...r, count: 0 }; g.count++; groups.set(r.hash, g); };
      (await Promise.all([probe(), probe(), probe()])).forEach(add);
      if (groups.size === 1) (await Promise.all([probe(), probe(), probe()])).forEach(add);
      const best = [...groups.values()].sort((x, y) => y.score - x.score)[0];
      goodHash = best.hash; K = best.n;
    }

    for (let attempt = 0; attempt < 16; attempt++) {
      let proc = null, seen = 0, mismatch = false;
      const hasher = new Fnv();
      const fd = fs.openSync(outPath, 'w');
      try {
        const sink = trimmedSink(stage.latency, total, (x) => {
          if (goodHash != null && seen < K) {
            const part = x.subarray(0, Math.min(x.length, K - seen));
            hasher.update(part); seen += part.length;
            if (seen >= K && hasher.digest() !== goodHash) { mismatch = true; proc && proc.kill('SIGKILL'); return; }
          }
          if (!mismatch) fs.writeSync(fd, Buffer.from(x.buffer, x.byteOffset, x.byteLength));
        });
        await run(inArgs, { cwd, signal, onSpawn: (p) => { proc = p; }, onStdout: (b) => { if (!mismatch) sink.push(b); }, onProgress: progress });
      } catch (e) {
        if (!mismatch) throw e;
      } finally { fs.closeSync(fd); }
      if (!mismatch) return;
    }
    throw new Error('Noise removal could not be initialised. Please try again.');
  }

  async _master(rawPath, segments, gainDb, ceiling, outPath, signal, progress) {
    const limit = Math.max(0.0625, fromDb(ceiling - 0.6));
    const total = segments.reduce((t, s) => t + (s.end - s.src), 0) || 1;
    let written = 0;
    await run([
      '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0',
      '-af', `volume=${gainDb.toFixed(2)}dB,aresample=192000,alimiter=limit=${limit.toFixed(5)}:attack=1.5:release=60:level=0:latency=1:asc=1,aresample=48000`,
      '-c:a', 'pcm_s24le', '-y', outPath,
    ], {
      signal,
      stdin: async (stdin) => {
        const fd = fs.openSync(rawPath, 'r');
        try {
          const CH = 1 << 17;
          const buf = Buffer.alloc(CH * 4);
          let tail = null; // last XFADE samples of previous segment
          for (let si = 0; si < segments.length; si++) {
            const { src, end } = segments[si];
            const last = si === segments.length - 1;
            let pos = src;
            let head = tail; tail = null;
            const stopAt = last ? end : end - XFADE;
            while (pos < stopAt) {
              if (signal.cancelled) throw new CancelledError();
              const n = Math.min(CH, stopAt - pos);
              fs.readSync(fd, buf, 0, n * 4, pos * 4);
              const x = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4));
              if (head) {
                const m = Math.min(head.length, n);
                for (let i = 0; i < m; i++) {
                  const t = (i + 0.5) / head.length;
                  x[i] = x[i] * Math.sin(t * Math.PI / 2) + head[i] * Math.cos(t * Math.PI / 2);
                }
                head = null;
              }
              if (!stdin.write(Buffer.from(x.buffer))) await once(stdin, 'drain');
              pos += n; written += n;
              progress(written / total);
            }
            if (!last) {
              const len = Math.min(XFADE, end - stopAt);
              const tb = Buffer.alloc(len * 4);
              fs.readSync(fd, tb, 0, len * 4, stopAt * 4);
              tail = new Float32Array(tb.buffer, tb.byteOffset, len);
              written += len;
            }
          }
        } finally {
          fs.closeSync(fd);
          stdin.end();
        }
      },
    });
  }

  async _measure(file, signal) {
    const an = new Analyzer({ spectrum: false, hum: false, clipping: false });
    const reader = new F32Reader((x) => an.push(x));
    const { stderr } = await run(['-i', file, '-af', 'ebur128=peak=true', '-ac', '1', '-f', 'f32le', 'pipe:1'], { signal, onStdout: (b) => reader.push(b) });
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    const lufs = parseFloat((/I:\s*(-?[\d.]+|-inf) LUFS/.exec(summary) || [])[1]);
    const tp = parseFloat((/True peak:\s*Peak:\s*(-?[\d.]+|-inf)/.exec(summary) || [])[1]);
    const a = an.finish();
    delete a.frameDb;
    return { lufs: isFinite(lufs) ? lufs : -70, truePeak: isFinite(tp) ? tp : -70, analysis: a };
  }

  /**
   * Export the mastered audio (or the source video with the new soundtrack).
   * format: wav | flac | mp3 | m4a | video
   */
  async exportTo(dest, { format, channels = 'mono' }, onProgress = () => {}) {
    if (!this.result) throw new Error('Nothing to export yet');
    const signal = this._fresh();
    const src = this.result.preview;
    const ac = channels === 'stereo' ? '2' : '1';
    const dur = this.result.duration;
    const prog = (t) => onProgress(Math.min(0.99, t / dur));
    let args;
    switch (format) {
      case 'wav': args = ['-i', src, '-ac', ac, '-c:a', 'pcm_s24le']; break;
      case 'flac': args = ['-i', src, '-ac', ac, '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-compression_level', '8']; break;
      case 'mp3': args = ['-i', src, '-ac', ac, '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000']; break;
      case 'm4a': args = ['-i', src, '-ac', ac, '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart']; break;
      case 'video': {
        const ext = path.extname(dest).toLowerCase();
        const acodec = ext === '.webm' ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '256k'];
        args = ['-i', this.source.file, '-i', src, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...acodec, '-ac', '2',
          ...(ext === '.mp4' || ext === '.mov' || ext === '.m4v' ? ['-movflags', '+faststart'] : []), '-shortest'];
        break;
      }
      default: throw new Error('Unknown format');
    }
    // Write next to the destination first, then move into place – never leave a half-written file.
    const tmp = dest + '.part' + path.extname(dest);
    try {
      await run([...args, '-y', tmp], { signal, onProgress: prog });
      fs.renameSync(tmp, dest);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    onProgress(1);
    return dest;
  }
}

module.exports = { Session, planPauses, keepSegments, LOUDNESS_TARGETS };
