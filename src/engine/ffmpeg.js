'use strict';
/**
 * Thin, dependency-free wrapper around the bundled ffmpeg binary.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function resolveFfmpeg() {
  let p = require('ffmpeg-static');
  // When packaged, binaries live outside the asar archive.
  if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

function resolveModelsDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'models'));
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'models'));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'cb.rnnn'))) return c;
  }
  throw new Error('Noise models not found');
}

const FFMPEG = resolveFfmpeg();

class CancelledError extends Error {
  constructor() { super('Cancelled'); this.cancelled = true; }
}

/** Parse "HH:MM:SS.xx" into seconds. */
function parseTime(str) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(str);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

/**
 * Run ffmpeg.
 * opts.onStdout(buffer)   – receive raw stdout (e.g. f32le audio)
 * opts.onProgress(secs)   – processed media time
 * opts.stdin              – function(writable) to feed stdin
 * opts.cwd, opts.signal ({cancelled:boolean, procs:Set})
 */
function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const base = opts.stdin ? ['-hide_banner'] : ['-hide_banner', '-nostdin'];
    const proc = spawn(FFMPEG, [...base, ...args], {
      cwd: opts.cwd || undefined,
      windowsHide: true,
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const signal = opts.signal;
    if (opts.onSpawn) opts.onSpawn(proc);
    if (signal) {
      if (signal.cancelled) { proc.kill('SIGKILL'); return reject(new CancelledError()); }
      signal.procs.add(proc);
    }
    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      if (opts.onProgress) {
        const idx = d.lastIndexOf('time=');
        if (idx >= 0) {
          const t = parseTime(d.slice(idx + 5, idx + 20));
          if (t != null) opts.onProgress(t);
        }
      }
    });
    if (opts.onStdout) {
      // Handlers are synchronous (analysis + fs.writeSync), so no backpressure needed.
      proc.stdout.on('data', (chunk) => {
        try { opts.onStdout(chunk); } catch (e) { proc.kill('SIGKILL'); reject(e); }
      });
    } else {
      proc.stdout.resume();
    }
    if (opts.stdin) {
      proc.stdin.on('error', () => {}); // EPIPE if ffmpeg dies; surfaced via exit code
      Promise.resolve(opts.stdin(proc.stdin)).catch((e) => { proc.kill('SIGKILL'); reject(e); });
    }
    proc.on('error', (e) => { if (signal) signal.procs.delete(proc); reject(e); });
    proc.on('close', (code) => {
      if (signal) signal.procs.delete(proc);
      if (signal && signal.cancelled) return reject(new CancelledError());
      if (code !== 0 && !opts.allowFail) {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
        const err = new Error(`Audio engine failed (code ${code}).\n${tail}`);
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ code, stderr });
    });
  });
}

/** Inspect a media file: duration, audio/video streams. */
async function probe(file) {
  const { stderr } = await run(['-i', file], { allowFail: true });
  const dur = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(stderr);
  const streams = [...stderr.matchAll(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: (Audio|Video): ([^\n]*)/g)];
  const audio = streams.find((s) => s[1] === 'Audio');
  const video = streams.find((s) => s[1] === 'Video' && !/attached pic|mjpeg|png/i.test(s[2]));
  if (!audio) {
    if (/Invalid data found|No such file|could not find codec/i.test(stderr) || !streams.length) {
      throw new Error('This file could not be read. Try a common audio or video format.');
    }
    throw new Error('This file has no audio track.');
  }
  const a = audio[2];
  const codec = (/^(\w+)/.exec(a) || [])[1] || '';
  const rate = +((/(\d+) Hz/.exec(a) || [])[1] || 0);
  let channels = 1;
  if (/stereo/.test(a)) channels = 2;
  else if (/mono/.test(a)) channels = 1;
  else if (/5\.1|6 channels/.test(a)) channels = 6;
  else if (/7\.1|8 channels/.test(a)) channels = 8;
  else {
    const c = /(\d+) channels/.exec(a);
    if (c) channels = +c[1];
  }
  const vcodec = video ? ((/^(\w+)/.exec(video[2]) || [])[1] || '') : null;
  return {
    duration: dur ? parseTime(dur[1]) : 0,
    codec,
    sampleRate: rate,
    channels,
    hasVideo: !!video,
    videoCodec: vcodec,
  };
}

module.exports = { run, probe, FFMPEG, resolveModelsDir, CancelledError, parseTime };
