const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const server = require('./server');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const PORT = Number(process.env.PORT) || 3000;
const CONFIG_DIR = path.join(app.getPath('userData'));
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    let raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip UTF-8 BOM
    return JSON.parse(raw);
  } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.warn('saveConfig failed:', e.message); }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

function defaultMediaDir() {
  return path.join(app.getPath('pictures'), 'Ez Phone Share');
}

async function pickFolder(initial) {
  const result = await dialog.showOpenDialog({
    title: 'Choose where uploads should be saved',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: initial || defaultMediaDir(),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

async function ensureMediaDir() {
  const cfg = loadConfig();
  if (cfg.mediaDir && fs.existsSync(cfg.mediaDir)) return cfg.mediaDir;

  const picked = await pickFolder(defaultMediaDir());
  if (picked) {
    saveConfig({ ...cfg, mediaDir: picked });
    return picked;
  }
  const fallback = defaultMediaDir();
  fs.mkdirSync(fallback, { recursive: true });
  saveConfig({ ...cfg, mediaDir: fallback });
  return fallback;
}

function createTray() {
  // Use the app's own icon for the tray (Electron supplies a default if none set)
  let image;
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) image = nativeImage.createFromPath(iconPath);
  else image = nativeImage.createEmpty();
  tray = new Tray(image.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_ICON) : image);
  tray.setToolTip('Ez Phone Share');
  const refreshMenu = () => {
    const cfg = loadConfig();
    const menu = Menu.buildFromTemplate([
      { label: 'Show window', click: () => showWindow() },
      { label: 'Open uploads folder', click: () => shell.openPath(server.getMediaDir()) },
      { label: 'Change folder…', click: async () => {
        const picked = await pickFolder(server.getMediaDir());
        if (picked) {
          server.setMediaDir(picked);
          saveConfig({ ...loadConfig(), mediaDir: picked });
          server.broadcast('folder-changed', { folder: picked });
          refreshMenu();
        }
      } },
      { type: 'separator' },
      { label: `Saving to: ${truncMid(server.getMediaDir(), 48)}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };
  refreshMenu();
  server.events.on('media-dir-changed', refreshMenu);
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function truncMid(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  const keep = Math.floor((max - 3) / 2);
  return s.slice(0, keep) + '…' + s.slice(-keep);
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#f5f5f7',
    title: 'Ez Phone Share',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWindow.loadURL(`http://localhost:${server.getPort()}/dashboard`);
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.once('did-finish-load', () => {
    // Send current version to renderer
    sendToWindow('app-meta', { version: app.getVersion(), name: app.getName() });
    // Kick off update check (no-op in dev)
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch(() => { /* swallow */ });
      setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
    }
  });
}

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    try { mainWindow.webContents.send(channel, data); } catch { /* noop */ }
  }
}

// ---------- Auto-updater wiring ----------
autoUpdater.on('checking-for-update', () => sendToWindow('update-status', { state: 'checking' }));
autoUpdater.on('update-not-available', () => sendToWindow('update-status', { state: 'idle' }));
autoUpdater.on('update-available', (info) => sendToWindow('update-status', { state: 'available', version: info.version }));
autoUpdater.on('download-progress', (p) => sendToWindow('update-status', { state: 'downloading', percent: Math.round(p.percent), version: p.version }));
autoUpdater.on('update-downloaded', (info) => sendToWindow('update-status', { state: 'ready', version: info.version }));
autoUpdater.on('error', (e) => sendToWindow('update-status', { state: 'error', message: e.message }));

ipcMain.handle('update-check', async () => {
  if (!app.isPackaged) return { ok: false, error: 'dev mode' };
  try { const r = await autoUpdater.checkForUpdates(); return { ok: true, version: r?.updateInfo?.version }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update-install', () => { isQuitting = true; autoUpdater.quitAndInstall(); });

// Single instance: focus the existing window if a second launch happens
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  const LOG_FILE = path.join(app.getPath('userData'), 'startup.log');
  function log(msg) { try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {} }

  app.whenReady().then(async () => {
    try {
      fs.writeFileSync(LOG_FILE, ''); // truncate
      log('app ready');
      const mediaDir = await ensureMediaDir();
      log('ensured mediaDir: ' + mediaDir);
      server.setMediaDir(mediaDir);
      log('set media dir');
      try {
        await server.start(PORT);
        log('server started on port ' + PORT);
      } catch (e) {
        log('server.start failed: ' + e.message);
        dialog.showErrorBox('Ez Phone Share', `Could not start server on port ${PORT}.\n\n${e.message}\n\nAnother copy may already be running.`);
        app.quit();
        return;
      }
      createTray();
      log('tray created');
      createWindow();
      log('window created');
    } catch (e) {
      log('startup exception: ' + (e.stack || e.message));
      dialog.showErrorBox('Ez Phone Share', 'Startup failed: ' + e.message);
      app.quit();
    }
  });

  app.on('window-all-closed', (e) => {
    // Keep alive in tray on Windows/Linux
    if (process.platform !== 'darwin') {
      // Suppress default quit
    }
  });

  app.on('before-quit', () => { isQuitting = true; });
}

// ---------- IPC: native dialogs + shell ----------
ipcMain.handle('pick-folder', async (_e, initial) => {
  const picked = await pickFolder(initial || server.getMediaDir());
  if (!picked) return { ok: false };
  server.setMediaDir(picked);
  saveConfig({ ...loadConfig(), mediaDir: picked });
  server.broadcast('folder-changed', { folder: picked });
  return { ok: true, folder: picked };
});

ipcMain.handle('open-folder', async (_e, p) => {
  await shell.openPath(p || server.getMediaDir());
  return { ok: true };
});

ipcMain.handle('show-in-folder', async (_e, p) => {
  if (!p) return { ok: false };
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle('open-file', async (_e, p) => {
  if (!p) return { ok: false };
  const err = await shell.openPath(p);
  return { ok: !err, error: err || undefined };
});

// 16x16 transparent placeholder used if no asset/icon.png is shipped.
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAVklEQVR42mNkYGD4z0AEYBxVSF+FjP///2cYBoYBKqVfQy+rwTAwLgQyAEEh1QqUKxbBKkBQwcDIyMjAyMjA4ALSC0gxIChJKkAhUBSAFRcAAACjAOe0kVZWAAAAAElFTkSuQmCC';
