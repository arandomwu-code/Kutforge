'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

const projectStore = require('./projectStore');
const settingsStore = require('./settingsStore');
const ffmpegExport = require('./ffmpegExport');

let mainWindow = null;
let currentExportJob = null;

// A one-time token: export:start is only allowed to write to a path that
// export:choosePath just handed back from a real native save dialog, never
// to an arbitrary path supplied directly over IPC. Consumed on first use.
let approvedExportPath = null;

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'];
const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]);

const RENDERER_ENTRY = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_ENTRY_URL = require('url').pathToFileURL(RENDERER_ENTRY).href;

function sendMenuAction(action) {
  if (mainWindow) mainWindow.webContents.send('menu:action', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-project') },
        { label: 'Open Project\u2026', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('open-project') },
        { label: 'Save Project As\u2026', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('save-project-as') },
        { type: 'separator' },
        { label: 'Import Media\u2026', accelerator: 'CmdOrCtrl+I', click: () => sendMenuAction('import-media') },
        { label: 'Export\u2026', accelerator: 'CmdOrCtrl+E', click: () => sendMenuAction('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenuAction('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenuAction('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        // DevTools stay available in `npm start` for your own debugging, but
        // are left out of packaged builds - no reason to ship an easy console
        // into a shipped app.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => sendMenuAction('help') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#f6efe2',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(RENDERER_ENTRY);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- lockdown: no remote content, no popups, no permission grants ----------
// This app never loads remote pages, but these guards are cheap, standard
// defense-in-depth: even if a future change (or a bug) tried to navigate
// somewhere else or open a window, it's blocked at the platform level
// rather than relying on the renderer behaving itself.
app.on('web-contents-created', (_evt, contents) => {
  contents.on('will-navigate', (navEvt, targetUrl) => {
    if (targetUrl !== RENDERER_ENTRY_URL) navEvt.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (attachEvt) => attachEvt.preventDefault());

  if (app.isPackaged) {
    // Belt-and-suspenders alongside dropping the menu item above: the
    // DevTools keyboard shortcuts exist independently of the menu.
    contents.on('before-input-event', (inputEvt, input) => {
      const isDevToolsKey = input.key === 'F12'
        || (input.control && input.shift && (input.key === 'I' || input.key === 'i'))
        || (input.meta && input.alt && (input.key === 'I' || input.key === 'i'));
      if (isDevToolsKey) inputEvt.preventDefault();
    });
    contents.on('devtools-opened', () => contents.closeDevTools());
  }
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- media import ----------
ipcMain.handle('dialog:openMediaFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT] },
      { name: 'Video', extensions: VIDEO_EXT },
      { name: 'Audio', extensions: AUDIO_EXT },
      { name: 'Image', extensions: IMAGE_EXT },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled) return [];
  // Dialog already restricted by extension filters, but re-check server-side
  // too - filters are a UI convenience, not a security boundary on their own.
  return res.filePaths.filter((p) => MEDIA_EXT.has(path.extname(p).slice(1).toLowerCase()));
});

// ---------- project persistence ----------
ipcMain.handle('project:loadAutosave', () => projectStore.loadAutosave());
ipcMain.handle('project:saveAutosave', (_evt, data) => projectStore.saveAutosave(data));
ipcMain.handle('project:openDialog', () => projectStore.openProjectDialog(mainWindow));
ipcMain.handle('project:saveAsDialog', (_evt, data) => projectStore.saveProjectAsDialog(mainWindow, data));

// ---------- app-wide settings (separate from any one project) ----------
ipcMain.handle('settings:load', () => settingsStore.loadSettings());
ipcMain.handle('settings:save', (_evt, partial) => {
  // Only ever persist the specific keys we know about, regardless of what
  // shape the renderer sends - keeps this file from becoming a dumping
  // ground for arbitrary data.
  if (!partial || typeof partial !== 'object') return settingsStore.loadSettings();
  const allowed = {};
  if (typeof partial.defaultTheme === 'string') allowed.defaultTheme = partial.defaultTheme;
  if (typeof partial.trackColorTint === 'boolean') allowed.trackColorTint = partial.trackColorTint;
  return settingsStore.saveSettings(allowed);
});

// ---------- export ----------
ipcMain.handle('export:choosePath', async (_evt, suggestedName, format) => {
  const ext = format === 'mp4' ? 'mp4' : 'webm';
  const cleanName = (String(suggestedName || 'video')).replace(/[^a-z0-9-_ ]/gi, '').trim() || 'video';
  let defaultDir;
  try { defaultDir = app.getPath('videos'); } catch (e) { defaultDir = app.getPath('downloads'); }
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export video',
    defaultPath: path.join(defaultDir, cleanName + '.' + ext),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  approvedExportPath = res.filePath;
  return res.filePath;
});

ipcMain.handle('export:start', async (_evt, edl, outPath) => {
  if (currentExportJob) throw new Error('An export is already running.');
  if (typeof outPath !== 'string' || outPath !== approvedExportPath) {
    throw new Error('Export destination was not chosen through the save dialog.');
  }
  approvedExportPath = null; // single use
  if (!path.isAbsolute(outPath)) throw new Error('Invalid export path.');

  try {
    ffmpegExport.validateEdl(edl);
  } catch (e) {
    throw new Error('Invalid export request: ' + e.message);
  }

  const job = ffmpegExport.runExport(edl, outPath, (progress) => {
    if (mainWindow) mainWindow.webContents.send('export:progress', progress);
  });
  currentExportJob = job;
  try {
    const result = await job.promise;
    return result;
  } catch (e) {
    // Clean up a partial file left behind by a failed or cancelled run.
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e2) { /* ignore */ }
    throw e;
  } finally {
    currentExportJob = null;
  }
});

ipcMain.handle('export:cancel', () => {
  if (currentExportJob) currentExportJob.cancel();
  return true;
});

// ---------- misc ----------
ipcMain.handle('shell:showItemInFolder', (_evt, p) => {
  if (typeof p !== 'string' || !p) return;
  shell.showItemInFolder(p);
});
ipcMain.handle('app:getVersion', () => app.getVersion());
