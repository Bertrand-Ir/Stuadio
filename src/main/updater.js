'use strict';
/**
 * In-app updates from GitHub Releases (electron-updater).
 *
 * - The app is fully usable offline; checks that fail (no network, GitHub down) are silent.
 * - Checks: shortly after launch, every 4 hours, and whenever the renderer reports the
 *   connection came back online.
 * - Nothing downloads without the user's consent: the renderer shows a dialog, the user
 *   chooses "Download & install", then "Restart to update".
 */
const { app, ipcMain } = require('electron');

const RECHECK_MS = 4 * 3600 * 1000;
const MIN_GAP_MS = 10 * 60 * 1000;

/** GitHub release notes arrive as HTML; reduce them to plain lines (bullets become "- "). */
function plainNotes(notes) {
  if (!notes) return '';
  if (Array.isArray(notes)) notes = notes.map((n) => n.note || '').join('\n');
  return String(notes)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|h\d|li|ul|ol|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .slice(0, 4000);
}

module.exports = function setupUpdater(send) {
  ipcMain.handle('app:version', () => app.getVersion());

  if (!app.isPackaged) {
    // Development builds don't self-update.
    ipcMain.handle('update:check', () => ({ skipped: 'development build' }));
    ipcMain.handle('update:download', () => ({ error: 'Updates are only available in the installed app.' }));
    ipcMain.handle('update:install', () => false);
    ipcMain.on('update:online', () => {});
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  let checking = false, lastOk = 0, downloading = false, downloaded = null, available = null;

  async function check(force) {
    if (checking || downloading || downloaded) return;
    if (!force && lastOk && Date.now() - lastOk < MIN_GAP_MS) return;
    checking = true;
    try {
      await autoUpdater.checkForUpdates();
      lastOk = Date.now();
    } catch { /* offline or unreachable — try again later */ } finally { checking = false; }
  }

  autoUpdater.on('update-available', (info) => {
    available = info.version;
    send('update', { type: 'available', version: info.version, current: app.getVersion(), notes: plainNotes(info.releaseNotes), date: info.releaseDate });
  });
  autoUpdater.on('download-progress', (p) => send('update', { type: 'progress', percent: p.percent || 0 }));
  autoUpdater.on('update-downloaded', (info) => { downloading = false; downloaded = info.version; send('update', { type: 'downloaded', version: info.version }); });
  autoUpdater.on('error', () => {
    if (!downloading) return; // background check failures stay silent
    downloading = false;
    send('update', { type: 'error', message: 'The update could not be downloaded. Check your connection and try again.' });
  });

  ipcMain.handle('update:check', () => check(true));
  ipcMain.handle('update:download', async () => {
    if (downloaded) return { ok: true };
    if (!available) return { error: 'No update available.' };
    downloading = true;
    try { await autoUpdater.downloadUpdate(); return { ok: true }; } catch (e) { downloading = false; return { error: 'The update could not be downloaded. Check your connection and try again.' }; }
  });
  ipcMain.handle('update:install', () => { if (downloaded) setImmediate(() => autoUpdater.quitAndInstall(false, true)); return !!downloaded; });
  ipcMain.on('update:online', () => check(false));

  setTimeout(() => check(true), 5000);
  setInterval(() => check(false), RECHECK_MS);
};
