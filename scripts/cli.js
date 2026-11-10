#!/usr/bin/env node
'use strict';
/**
 * Stuadio engine CLI – handy for testing and batch use.
 *   node scripts/cli.js <input> [output.wav] [--no-pauses] [--target=podcast|youtube|audiobook|broadcast] [--json]
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Session } = require('../src/engine/session');

(async () => {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const output = args.filter((a) => !a.startsWith('--'))[1];
  if (!input) { console.error('usage: cli.js <input> [output]'); process.exit(1); }
  const session = new Session(path.join(os.tmpdir(), 'stuadio-cli-' + process.pid));
  const t0 = Date.now();
  const loaded = await session.load(path.resolve(input));
  const { analysis, recommended, info } = loaded;
  console.log('INFO', JSON.stringify(info));
  console.log('ANALYSIS', JSON.stringify({ ...analysis, waveform: undefined, spectrum: undefined }));
  console.log('RECOMMENDED', JSON.stringify(recommended));
  const settings = JSON.parse(JSON.stringify(recommended));
  for (const a of args) {
    if (a === '--no-pauses') settings.pauses.on = false;
    if (a === '--pauses') settings.pauses.on = true;
    if (a.startsWith('--target=')) settings.loudness.target = a.slice(9);
    if (a.startsWith('--noise=')) { settings.noise.on = true; settings.noise.strength = a.slice(8); }
    if (a === '--off') for (const k of Object.keys(settings)) settings[k].on = false;
    if (a.startsWith('--only=')) { for (const k of Object.keys(settings)) settings[k].on = false; for (const k of a.slice(7).split(',')) settings[k].on = true; }
  }
  const t1 = Date.now();
  let last = '';
  const result = await session.enhance(settings, ({ phase, value }) => {
    const s = `${phase} ${(value * 100).toFixed(0)}%`;
    if (s !== last && process.stdout.isTTY) process.stdout.write('\r' + s + '      ');
    last = s;
  });
  const { waveform, segments, ...rest } = result;
  console.log('\nRESULT', JSON.stringify({ ...rest, segments: segments.length }));
  console.log(`TIME analyse ${(t1 - t0) / 1000}s, enhance ${(Date.now() - t1) / 1000}s for ${info.duration.toFixed(1)}s audio`);
  if (output) fs.copyFileSync(result.preview, path.resolve(output));
  session.dispose();
})().catch((e) => { console.error(e); process.exit(1); });
