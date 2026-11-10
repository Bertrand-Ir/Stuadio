'use strict';
/**
 * Dev-only UI walkthrough: drives the app through every state and saves screenshots.
 *   STUADIO_AUTOTEST=<outDir> STUADIO_AUTOTEST_FILE=<audio file> electron .
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

module.exports = async function autotest(win, outDir, file) {
  const wc = win.webContents;
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => wc.executeJavaScript(code, true);
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name + '.png'), (await wc.capturePage()).toPNG());
  const until = async (code, timeout = 180000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await js(code)) return; await wait(100); }
    throw new Error('Timed out waiting for: ' + code);
  };
  try {
    await wait(1800); await shot('01-empty');
    if (process.env.STUADIO_AUTOTEST_ONLY_EMPTY) { await wait(+process.env.STUADIO_AUTOTEST_ONLY_EMPTY); app.quit(); return; }
    js(`window.__stuadio.openPath(${JSON.stringify(file)})`);
    await wait(250); await shot('02-loading');
    await until(`document.body.dataset.state === 'ready'`); await wait(900); await shot('03-ready');
    js('window.__stuadio.enhance()');
    await until(`document.body.dataset.state === 'processing' && parseInt(document.querySelector('#busyPct').textContent) >= 45`); await shot('04-processing');
    await until(`document.body.dataset.state === 'done'`); await wait(1400); await shot('05-done');
    await js(`window.__stuadio.setView('original')`); await wait(800); await shot('06-original-trims');
    await js(`document.querySelector('.row[data-key="tone"] .seg-btn[data-value="warm"]').click()`); await wait(400); await shot('07-dirty');
    await js('window.__stuadio.openExport()'); await wait(600); await shot('08-export');
    await js(`document.querySelector('#btnSheetCancel').click()`); await wait(300);
    wc.send('update', { type: 'available', version: '1.1.0', current: '1.0.0', notes: ['What is new', '- Faster noise removal on long recordings', '- New Warm tone character', '- Fixed export of MKV files'].join('\n') });
    await wait(900); await shot('09-update');
    const errs = await js('window.__errors || []');
    fs.writeFileSync(path.join(outDir, 'errors.json'), JSON.stringify(errs, null, 2));
  } catch (e) {
    fs.writeFileSync(path.join(outDir, 'failure.txt'), String(e.stack || e));
    try { await shot('99-failure'); } catch {}
  }
  app.quit();
};
