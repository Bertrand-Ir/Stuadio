#!/usr/bin/env node
'use strict';
/**
 * Engine self-test: generates fixtures with ffmpeg, runs the whole pipeline on each and
 * checks loudness, peaks, timing, error handling and every export format.
 *   npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, probe } = require('../src/engine/ffmpeg');
const { Session } = require('../src/engine/session');
const { LOUDNESS_TARGETS } = require('../src/engine/chain');

const dir = path.join(os.tmpdir(), 'stuadio-selftest');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const F = (n) => path.join(dir, n);

// Voiced, formant-shaped "syllables" with natural pauses, plus room noise.
const VOICE = "0.08*gt(sin(2*PI*0.23*t)+0.35,0)*(0.5-0.5*cos(2*PI*3.5*t))*(sin(2*PI*130*t)+0.9*sin(2*PI*260*t)+sin(2*PI*390*t)+0.8*sin(2*PI*520*t)+1.1*sin(2*PI*650*t)+0.9*sin(2*PI*780*t)+0.5*sin(2*PI*1040*t)+0.4*sin(2*PI*1300*t)+0.25*sin(2*PI*2600*t)+0.15*sin(2*PI*3900*t))";
const speech = (d, extra = '') => ['-f', 'lavfi', '-i', `aevalsrc='${VOICE}':s=48000:d=${d}`, '-f', 'lavfi', '-i', `anoisesrc=r=48000:color=pink:amplitude=0.01:d=${d}:seed=4`,
  '-filter_complex', `[0][1]amix=inputs=2:normalize=0${extra}`];

const FIXTURES = [
  { name: 'speech-stereo-44k.wav', args: [...speech(24, ',aformat=channel_layouts=stereo,aresample=44100'), '-c:a', 'pcm_s16le'] },
  { name: 'short.mp3', args: [...speech(1.2), '-c:a', 'libmp3lame', '-b:a', '128k'] },
  { name: 'silent.wav', args: ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '5', '-c:a', 'pcm_s16le'] },
  { name: 'clipped.flac', args: [...speech(12, ',volume=24dB,alimiter=limit=1:level=0,volume=3dB'), '-c:a', 'flac'] },
  { name: 'surround.m4a', args: [...speech(8, ',aformat=channel_layouts=5.1'), '-c:a', 'aac', '-b:a', '192k'] },
  { name: 'video.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=10', ...speech(10).map((a) => a === '[0][1]amix=inputs=2:normalize=0' ? '[1][2]amix=inputs=2:normalize=0' : a), '-map', '0:v', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] },
  { name: 'video-no-audio.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] },
];

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

(async () => {
  for (const fx of FIXTURES) {
    const args = [...fx.args];
    // the video fixture maps audio from the filter graph output
    if (fx.name === 'video.mp4') args.splice(args.indexOf('-map'), 2, '-map', '0:v');
    await run([...args, '-y', F(fx.name)]);
  }
  console.log(`fixtures in ${dir}\n`);

  for (const fx of FIXTURES) {
    console.log(fx.name);
    const s = new Session(path.join(dir, 'work-' + fx.name));
    try {
      let loaded;
      try { loaded = await s.load(F(fx.name)); } catch (e) {
        check(fx.name === 'video-no-audio.mp4' && /no audio/i.test(e.message), `load error is friendly: "${e.message}"`);
        continue;
      }
      check(fx.name !== 'video-no-audio.mp4', 'loaded');
      const a = loaded.analysis, rec = loaded.recommended;
      if (fx.name === 'clipped.flac') check(a.clipping.events > 0 && rec.declip.on, `clipping detected (${a.clipping.events}) → repair on`);
      if (fx.name === 'video.mp4') check(loaded.info.hasVideo && !rec.pauses.on && rec.loudness.target === 'youtube', 'video: pauses off, YouTube target');
      const r = await s.enhance(rec);
      const target = LOUDNESS_TARGETS[rec.loudness.target];
      if (fx.name === 'silent.wav') {
        check(isFinite(r.duration) && r.duration > 0, `silent file survives (lufs ${r.lufs})`);
      } else {
        check(Math.abs(r.lufs - target.lufs) <= 1.0, `loudness ${r.lufs} LUFS (target ${target.lufs})`);
        check(r.truePeak <= target.ceiling + 0.3, `true peak ${r.truePeak} dBTP (ceiling ${target.ceiling})`);
      }
      if (!rec.pauses.on) check(Math.abs(r.duration - a.duration) < 0.02, `duration preserved ${a.duration.toFixed(3)} → ${r.duration.toFixed(3)}`);
      else check(r.duration <= a.duration, `duration ${a.duration.toFixed(2)} → ${r.duration.toFixed(2)} (−${r.removedSeconds}s)`);

      const formats = fx.name === 'video.mp4' ? ['video', 'mp3'] : fx.name === 'speech-stereo-44k.wav' ? ['wav', 'flac', 'mp3', 'm4a'] : ['wav'];
      for (const fmt of formats) {
        const ext = fmt === 'video' ? 'mp4' : fmt;
        const out = F(`out-${fx.name}.${ext}`);
        await s.exportTo(out, { format: fmt, channels: fmt === 'flac' ? 'stereo' : 'mono' });
        const info = await probe(out);
        const ok = fs.existsSync(out) && Math.abs(info.duration - r.duration) < 0.1 && (fmt !== 'video' || info.hasVideo);
        check(ok, `export ${fmt}: ${info.codec}, ${info.channels}ch, ${info.duration.toFixed(2)}s${info.hasVideo ? ', video ' + info.videoCodec : ''}`);
      }
    } catch (e) {
      check(false, 'threw: ' + e.message);
    } finally { s.dispose(); }
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
