'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { Session } = require('../engine/session');

app.setName('Stuadio');
if (process.platform === 'win32') app.setAppUserModelId('com.stuadio.app');
nativeTheme.themeSource = ['light', 'dark'].includes(process.env.STUADIO_THEME) ? process.env.STUADIO_THEME : 'system';

if (process.env.STUADIO_AUTOTEST) app.setPath('userData', path.join(app.getPath('temp'), 'stuadio-autotest-profile'));
else if (!app.requestSingleInstanceLock()) { app.quit(); }
// Automated screenshots need software compositing so capturePage sees every layer.
if (process.env.STUADIO_AUTOTEST) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// Window chrome follows the OS theme (matches the renderer's CSS tokens).
const chrome = () => (nativeTheme.shouldUseDarkColors
  ? { bg: '#111113', bar: '#161618', symbol: '#A5A5AE' }
  : { bg: '#F6F6F7', bar: '#FFFFFF', symbol: '#50505A' });
const AUDIO_EXT = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'caf', 'amr', 'webm'];
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'webm', 'wmv', 'mts', 'm2ts'];
const WORK_ROOT = path.join(app.getPath('temp'), 'stuadio');

let win = null;
let session = null;
const media = new Map(); // key -> file path (only files we created are ever served)

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: chrome().bg,
    title: 'Stuadio',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: chrome().bar, symbolColor: chrome().symbol, height: 47 },
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  nativeTheme.on('updated', () => {
    if (!win || win.isDestroyed()) return;
    const c = chrome();
    win.setBackgroundColor(c.bg);
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: c.bar, symbolColor: c.symbol });
  });
  win.once('ready-to-show', () => {
    win.show();
    if (process.env.STUADIO_AUTOTEST) require('./autotest')(win, process.env.STUADIO_AUTOTEST, process.env.STUADIO_AUTOTEST_FILE);
  });
  win.webContents.on('console-message', (e) => {
    if (process.env.STUADIO_AUTOTEST && e.level === 'error') console.error('[renderer]', e.message);
  });
  // Never navigate away or open windows from the renderer.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.STUADIO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

function mediaUrl(key, file) {
  media.set(key, file);
  return `media://audio/${key}?v=${Date.now()}`;
}

function registerMediaProtocol() {
  protocol.handle('media', async (req) => {
    const key = new URL(req.url).pathname.replace(/^\//, '');
    const file = media.get(key);
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const size = (await fs.promises.stat(file)).size;
    const range = req.headers.get('range');
    const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (!m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  });
}

function cleanStaleWork() {
  try {
    for (const d of fs.readdirSync(WORK_ROOT)) {
      const p = path.join(WORK_ROOT, d);
      const age = Date.now() - fs.statSync(p).mtimeMs;
      if (age > 6 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {}
}

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

function friendlyError(e) {
  if (e && e.cancelled) return { cancelled: true };
  const msg = (e && e.message) || String(e);
  return { error: msg.split('\n')[0] };
}

function registerIpc() {
  ipcMain.handle('pick-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a recording',
      properties: ['openFile'],
      filters: [
        { name: 'Audio & video', extensions: [...new Set([...AUDIO_EXT, ...VIDEO_EXT])] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('load', async (_e, file) => {
    try {
      if (session) session.dispose();
      session = new Session(path.join(WORK_ROOT, crypto.randomUUID()));
      const data = await session.load(file, (v) => send('progress', { task: 'load', phase: 'analyse', value: v }));
      data.previewUrl = mediaUrl('original', data.preview);
      delete data.preview;
      return { ok: true, data };
    } catch (e) { return friendlyError(e); }
  });

  ipcMain.handle('enhance', async (_e, settings) => {
    try {
      if (!session) throw new Error('Load a file first.');
      // Copy, never mutate: session.result.preview is the file that export reads.
      const { preview, ...data } = await session.enhance(settings, (p) => send('progress', { task: 'enhance', ...p }));
      data.previewUrl = mediaUrl('studio', preview);
      return { ok: true, data };
    } catch (e) { return friendlyError(e); }
  });

  ipcMain.handle('cancel', () => { if (session) session.cancel(); return true; });

  ipcMain.handle('export', async (_e, { format, channels }) => {
    try {
      if (!session || !session.result) throw new Error('Enhance the recording first.');
      const src = session.source.file;
      const base = path.basename(src, path.extname(src));
      const srcExt = path.extname(src).slice(1).toLowerCase();
      const ext = format === 'video' ? (['mov', 'mkv', 'webm', 'm4v'].includes(srcExt) ? srcExt : 'mp4') : format;
      const names = { wav: 'WAV audio', flac: 'FLAC audio', mp3: 'MP3 audio', m4a: 'AAC audio', mp4: 'MP4 video', mov: 'QuickTime video', mkv: 'Matroska video', webm: 'WebM video', m4v: 'MP4 video' };
      const auto = process.env.STUADIO_AUTOTEST && !app.isPackaged ? path.join(process.env.STUADIO_AUTOTEST, `export.${ext}`) : null;
      const r = auto ? { filePath: auto } : await dialog.showSaveDialog(win, {
        title: 'Export studio audio',
        defaultPath: path.join(path.dirname(src), `${base} (Studio).${ext}`),
        filters: [{ name: names[ext] || ext.toUpperCase(), extensions: [ext] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      let dest = r.filePath;
      if (path.extname(dest).toLowerCase() !== '.' + ext) dest += '.' + ext;
      if (path.resolve(dest) === path.resolve(src)) throw new Error('Choose a different name so your original stays untouched.');
      await session.exportTo(dest, { format, channels }, (v) => send('progress', { task: 'export', phase: 'export', value: v }));
      return { ok: true, data: { path: dest, name: path.basename(dest) } };
    } catch (e) { return friendlyError(e); }
  });

  ipcMain.handle('reveal', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); return true; });
}

app.whenReady().then(() => {
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  cleanStaleWork();
  registerMediaProtocol();
  registerIpc();
  require('./updater')(send);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (session) session.dispose(); });
