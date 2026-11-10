'use strict';
/**
 * Turns analysis + user settings into concrete processing.
 *
 * Studio voice chain (in order):
 *   declip -> gain staging -> rumble HPF -> hum notches -> neural denoise (+ spectral cleanup)
 *   -> room-tail expander -> adaptive tone match (linear-phase FIR) -> de-esser
 *   -> voice leveler -> compressor
 * then (in mastering pass): pause edit -> loudness gain -> true-peak limiter.
 */
const { THIRD_OCTAVES } = require('./dsp');

const LOUDNESS_TARGETS = {
  podcast: { lufs: -16, ceiling: -1.0, label: 'Podcast' },
  youtube: { lufs: -14, ceiling: -1.0, label: 'YouTube & social' },
  audiobook: { lufs: -19, ceiling: -3.0, label: 'Audiobook' },
  broadcast: { lufs: -23, ceiling: -1.0, label: 'Broadcast' },
};

/** Long-term average speech spectrum (1/3-octave, dB, after Byrne et al. 1994) – our "studio voice" reference. */
const LTASS = [30.0, 38.6, 43.5, 54.4, 57.7, 56.8, 60.2, 60.3, 59.0, 62.1, 62.1, 60.5, 56.8, 53.7, 53.0, 52.0, 48.7, 48.1, 46.8, 45.6, 44.5, 44.3, 43.7, 43.4, 41.3, 40.7];

/** Character tilts on top of LTASS, keyed by third-octave centre. */
function characterTilt(character, f) {
  const presence = f >= 2000 && f <= 5000 ? 1 : 0;
  const air = f >= 8000 ? 1 : 0;
  const mud = f >= 200 && f <= 400 ? 1 : 0;
  const body = f >= 100 && f <= 200 ? 1 : 0;
  switch (character) {
    case 'warm': return body * 1.5 - mud * 0.5 + presence * 0.5 + air * 0.5;
    case 'bright': return -mud * 1.5 + presence * 2.5 + air * 3.0;
    default: return -mud * 1.0 + presence * 1.5 + air * 1.5; // natural studio
  }
}

/**
 * Computes a corrective EQ curve that moves the measured (noise-compensated) voice spectrum
 * toward a studio reference. Conservative: partial correction, limited boosts, never boosts
 * bands where the recording has no real signal (e.g. phone-bandwidth audio).
 */
function toneMatch(spectrum, character = 'natural') {
  if (!spectrum || !spectrum.speechBlocks) return null;
  const n = THIRD_OCTAVES.length;
  const toP = (d) => Math.pow(10, d / 10);
  const measured = new Array(n), canBoost = new Array(n);
  const maxSpeech = Math.max(...spectrum.speech);
  for (let i = 0; i < n; i++) {
    const s = toP(spectrum.speech[i]), nz = toP(spectrum.noise[i]);
    const clean = Math.max(s - nz, s * 0.05);
    measured[i] = 10 * Math.log10(clean);
    const bandSnr = spectrum.speech[i] - spectrum.noise[i];
    canBoost[i] = bandSnr > 6 && spectrum.speech[i] > maxSpeech - 48;
  }
  const target = THIRD_OCTAVES.map((f, i) => LTASS[i] + characterTilt(character, f));
  // Align overall level on the core speech region (250 Hz – 4 kHz).
  let off = 0, cnt = 0;
  THIRD_OCTAVES.forEach((f, i) => { if (f >= 250 && f <= 4000) { off += target[i] - measured[i]; cnt++; } });
  off /= cnt;
  let gains = THIRD_OCTAVES.map((f, i) => (target[i] - measured[i] - off) * 0.65);
  // Smooth across neighbouring bands (broad, musical moves only).
  gains = gains.map((g, i) => {
    const a = gains[Math.max(0, i - 1)], c = gains[Math.min(n - 1, i + 1)];
    return 0.25 * a + 0.5 * g + 0.25 * c;
  });
  gains = gains.map((g, i) => {
    const f = THIRD_OCTAVES[i];
    let lo = -6, hi = 4.5;
    if (f < 160) hi = 1.5;           // never pump up boom
    if (f < 90) { hi = 0; lo = -3; } // HPF handles the extreme lows
    if (!canBoost[i]) hi = 0;
    return Math.max(lo, Math.min(hi, g));
  });
  return THIRD_OCTAVES.map((f, i) => ({ f, g: Math.round(gains[i] * 10) / 10 }));
}

function firEqualizer(curve) {
  const entries = [`entry(20,${curve[0].g})`, ...curve.map((p) => `entry(${p.f},${p.g})`), `entry(22000,${curve[curve.length - 1].g})`];
  return `firequalizer=gain_entry='${entries.join(';')}':scale=loglog:delay=0.04:zero_phase=on`;
}

/** Default settings, adapted to what the analysis found. */
function recommend(analysis, info) {
  const snr = analysis.snrDb;
  const noisy = snr < 52 || analysis.noiseFloorDb > -70;
  const strength = snr < 24 ? 'strong' : snr < 38 ? 'balanced' : 'gentle';
  return {
    noise: { on: noisy, strength },
    hum: { on: analysis.hum.detected, freq: analysis.hum.freq },
    rumble: { on: true },
    echo: { on: true, amount: snr < 30 ? 'medium' : 'light' },
    declip: { on: analysis.clipping.events > 0 },
    tone: { on: true, character: 'natural' },
    deess: { on: true, amount: 'medium' },
    level: { on: true, amount: 'medium' },
    pauses: { on: !info.hasVideo && (analysis.longPauses || 0) > 0, style: 'natural' },
    loudness: { on: true, target: info.hasVideo ? 'youtube' : 'podcast' },
  };
}

const lin = (dB) => Math.pow(10, dB / 20);
const f3 = (v) => Number(v.toFixed(5));

// Measured processing latency (samples @ 48 kHz) of filters that delay the signal.
const LATENCY = { arnndn: 480, afftdn: 1200, firequalizer: 1920 };
const NEURAL_MODEL = 'cb.rnnn';

/**
 * Builds the processing graph as two ffmpeg stages:
 *   A: repair + gain staging + filters + neural denoise   (verified, see session.js)
 *   B: spectral cleanup + room + tone + de-ess + dynamics
 * Each stage reports its latency so output can be trimmed sample-accurately.
 */
function buildChain(settings, analysis) {
  const steps = [];
  const a = [], b = [];
  let latA = 0, latB = 0;

  if (settings.declip.on) { a.push('adeclip'); steps.push('declip'); }

  // Gain staging: put active speech around -20 dBFS so every stage sees a consistent level.
  const preGainDb = Math.max(-12, Math.min(36, -20 - analysis.speechLevelDb));
  a.push(`volume=${preGainDb.toFixed(2)}dB`);
  const noiseAfterGain = analysis.noiseFloorDb + preGainDb;

  if (settings.rumble.on) { a.push('highpass=f=75:poles=2', 'highpass=f=75:poles=2'); steps.push('rumble'); }

  if (settings.hum.on) {
    const f0 = settings.hum.freq === 50 ? 50 : 60;
    for (let k = 1; k * f0 <= 500; k++) {
      a.push(`equalizer=f=${k * f0}:t=q:w=${k <= 2 ? 16 : 24}:g=${k <= 3 ? -30 : -18}`);
    }
    steps.push('hum');
  }

  let neural = false;
  if (settings.noise.on) {
    const s = settings.noise.strength;
    a.push(`arnndn=m=${NEURAL_MODEL}`); latA += LATENCY.arnndn; neural = true;
    if (s !== 'gentle') {
      // Spectral cleanup of the stationary hiss the neural pass leaves behind.
      const nf = Math.max(-80, Math.min(-30, noiseAfterGain - 20));
      b.push(`afftdn=nr=${s === 'strong' ? 16 : 8}:nf=${nf.toFixed(1)}:tn=1`); latB += LATENCY.afftdn;
    }
    steps.push('noise');
  }

  const f = b;
  if (settings.echo.on) {
    const medium = settings.echo.amount === 'medium';
    // Downward expander: pulls room tails and residue down between words without chopping them.
    f.push(`agate=threshold=${f3(lin(-44))}:ratio=${medium ? 2.5 : 1.8}:range=${f3(lin(medium ? -14 : -8))}:attack=4:release=${medium ? 160 : 220}:knee=4:detection=rms`);
    steps.push('echo');
  }

  if (settings.tone.on) {
    const curve = toneMatch(analysis.spectrum, settings.tone.character);
    if (curve) { f.push(firEqualizer(curve)); latB += LATENCY.firequalizer; steps.push('tone'); }
  }

  if (settings.deess.on) {
    const i = { light: 0.3, medium: 0.45, strong: 0.65 }[settings.deess.amount] || 0.45;
    f.push(`deesser=i=${i}:m=0.5:f=0.5:s=o`);
    steps.push('deess');
  }

  if (settings.level.on) {
    const a = settings.level.amount;
    const p = { light: { m: 3, g: 31, ratio: 2, att: 12, rel: 160 }, medium: { m: 5, g: 21, ratio: 3, att: 8, rel: 120 }, heavy: { m: 8, g: 13, ratio: 4.5, att: 5, rel: 90 } }[a] || {};
    // Leveler: rides the fader phrase by phrase; ignores pauses (threshold) so it never lifts the floor.
    f.push(`dynaudnorm=f=200:g=${p.g}:p=0.9:m=${p.m}:r=0.1:t=${f3(lin(-52))}`);
    // Compressor: glues the voice together and controls peaks.
    f.push(`acompressor=threshold=${f3(lin(-24))}:ratio=${p.ratio}:attack=${p.att}:release=${p.rel}:knee=3:detection=rms:makeup=1`);
    steps.push('level');
  }

  const head = 'aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=mono';
  const stage = (list, lat) => ({ filter: [head, lat ? `apad=pad_len=${lat}` : null, ...list].filter(Boolean).join(','), latency: lat });
  return { stageA: { ...stage(a, latA), neural }, stageB: stage(b, latB), preGainDb, steps };
}

module.exports = { LOUDNESS_TARGETS, recommend, buildChain, toneMatch };
