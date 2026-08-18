'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

const projectStore = require('./projectStore');
const settingsStore = require('./settingsStore');
const ffmpegExport = require('./ffmpegExport');

let mainWindow = null;
let currentExportJob = null;
// Kept so the custom title bar's File/Edit/View/Help buttons can pop the
// exact same menu items as a context menu (see menu:popupSubmenu below) -
// only needed on platforms that actually use the custom title bar (see
// IS_CUSTOM_TITLEBAR_PLATFORM); macOS keeps its native frame/menu bar
// entirely as-is, so this stays null there.
let appMenu = null;

// macOS gets a real menu bar "for free" as part of the OS itself (it's not
// even part of the window - it's the strip along the top of the screen),
// and a native traffic-light title bar most Mac users expect. Neither of
// those is true on Windows/Linux, where the frame this app used to use was
// plain OS chrome with no styling control at all (see the squished-icon
// conversation this came out of). Custom title bar is Windows/Linux only,
// on purpose - redoing the traffic-light equivalent correctly on macOS is
// a distinct, separate piece of work, not something to bolt on as a
// side-effect of fixing this.
const IS_CUSTOM_TITLEBAR_PLATFORM = process.platform !== 'darwin';

// A one-time token: export:start is only allowed to write to a path that
// export:choosePath just handed back from a real native save dialog, never
// to an arbitrary path supplied directly over IPC. Consumed on first use.
let approvedExportPath = null;

// File-dialog and drag-and-drop extension gates. This used to only cover 6
// video / 6 audio extensions - well short of what the bundled ffmpeg can
// actually decode, since export already runs everything through real
// ffmpeg regardless of what container it came in. That mismatch meant
// perfectly normal files (camcorder/phone .mts and .3gp footage, .wmv or
// .flv from older sources, DVD .vob, broadcast .mxf, etc.) would either not
// show up as selectable at all in "Import Media...", or - for drag-and-drop,
// which isn't gated by this list at all, only by editor.js's matching
// classifyMediaType - fail with a generic "unsupported type" error despite
// ffmpeg being fully capable of reading them. This list is intentionally
// still curated (not literally every extension ffmpeg has ever heard of),
// covering the containers someone editing video is actually likely to have.
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'f4v', 'mpg', 'mpeg', 'm2v', 'ts', 'mts', 'm2ts', '3gp', '3g2', 'ogv', 'vob', 'asf', 'mxf', 'divx'];
const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'wma', 'opus', 'aiff', 'aif', 'amr'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]);

const RENDERER_ENTRY = path.join(__dirname, '..', 'renderer', 'index.html');
const RENDERER_ENTRY_URL = require('url').pathToFileURL(RENDERER_ENTRY).href;

// The one deliberate, narrow exception to "no remote content ever loads in
// the window" below: the in-app disclaimer/license gate links out to the
// project's GitHub page. A click on that link is never allowed to navigate
// the app's own window to it - instead it's handed off to the OS's default
// browser via shell.openExternal, and only if the URL matches this exact
// prefix. Nothing else the renderer could ever construct or receive (from a
// project file, media metadata, etc.) is able to trigger an external-browser
// open - this allowlist is intentionally a single hardcoded string, not a
// pattern that could be tricked into matching something else.
const ALLOWED_EXTERNAL_URL_PREFIX = 'https://github.com/arandomwu-code/Kutforge';
function isAllowedExternalUrl(url) {
  return url === ALLOWED_EXTERNAL_URL_PREFIX || url.startsWith(ALLOWED_EXTERNAL_URL_PREFIX + '/')
    || url.startsWith(ALLOWED_EXTERNAL_URL_PREFIX + '#') || url.startsWith(ALLOWED_EXTERNAL_URL_PREFIX + '?');
}

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
  appMenu = Menu.buildFromTemplate(template);
  // Still set as the application menu even where the custom title bar hides
  // its visual bar (frame: false doesn't render one) - this is also what
  // keeps every accelerator above (CmdOrCtrl+Z, +N, +O, etc.) working as a
  // real keyboard shortcut, not just something a visible bar would trigger.
  Menu.setApplicationMenu(appMenu);
}

// Shows one of the four top-level menus (File/Edit/View/Help) as a popup at
// the cursor - what the custom title bar's menu buttons call, standing in
// for the visual menu bar that frame: false removes. Reuses the exact same
// Menu object/template as everywhere else, so there's no second copy of the
// menu structure to keep in sync.
function popupMenuByLabel(label) {
  if (!mainWindow || !appMenu) return;
  const item = appMenu.items.find((i) => i.label === label);
  if (item && item.submenu) item.submenu.popup({ window: mainWindow });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    // See IS_CUSTOM_TITLEBAR_PLATFORM above - macOS keeps its native frame
    // (traffic lights, system menu bar) untouched; Windows/Linux get a
    // frame-less window, with editor.js drawing its own title bar/window
    // controls entirely, and full control over that area's spacing as a
    // result (the actual point of dropping the native frame here).
    frame: !IS_CUSTOM_TITLEBAR_PLATFORM,
    show: false, // shown (already maximized) once ready - see below, avoids a flash of a small window first
    backgroundColor: '#f6efe2',
    // Windows renders the title-bar/taskbar icon by aggressively downscaling
    // whatever it's given (1024x1024 -> 16x16 is a 64:1 reduction), and a
    // raw PNG at that ratio comes out visibly squished/distorted. icon.ico
    // carries proper hand-sized renditions (16/24/32/48px) for exactly this
    // situation, so Windows uses those directly instead of downscaling on
    // the fly. macOS/Linux don't have the same tiny-title-bar-icon problem
    // and don't need an .ico, so they keep the plain PNG. Still relevant
    // with frame:false on Windows - this icon is what shows in the taskbar
    // and alt-tab, even though there's no title bar left to put it in.
    icon: path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
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
  // The custom title bar's maximize/restore button needs to know current
  // window state to show the right icon and to stay correct when the
  // window is maximized/restored some *other* way (double-clicking the
  // custom title bar - see editor.js - a Windows snap gesture, the View
  // menu, etc.), not just via that button itself.
  mainWindow.on('maximize', () => { if (mainWindow) mainWindow.webContents.send('window:maximizedChange', true); });
  mainWindow.on('unmaximize', () => { if (mainWindow) mainWindow.webContents.send('window:maximizedChange', false); });
  // Launch already maximized (same end state as clicking the window's own
  // maximize button) rather than the smaller fixed size above, which is
  // only the fallback/minimum if something prevents maximizing.
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    // Some window managers (this shows up mainly on Linux, occasionally on
    // Windows with certain multi-monitor/scaling setups) silently ignore
    // maximize() on a window that hasn't been mapped to the screen yet, so
    // the call above can no-op and leave the window at its smaller default
    // size - the person then has to maximize it by hand every launch. A
    // second call here, now that the window is actually visible, is what
    // takes effect in that case. It's a harmless no-op everywhere the first
    // call already worked.
    mainWindow.maximize();
  });
  mainWindow.loadFile(RENDERER_ENTRY);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- lockdown: no remote content, no popups, no permission grants ----------
// This app never loads remote pages, but these guards are cheap, standard
// defense-in-depth: even if a future change (or a bug) tried to navigate
// somewhere else or open a window, it's blocked at the platform level
// rather than relying on the renderer behaving itself. The single exception
// (see isAllowedExternalUrl above) still never lets the app's own window
// navigate anywhere - it only ever hands the one allowlisted URL off to the
// OS's browser instead.
app.on('web-contents-created', (_evt, contents) => {
  contents.on('will-navigate', (navEvt, targetUrl) => {
    if (targetUrl === RENDERER_ENTRY_URL) return;
    navEvt.preventDefault();
    if (isAllowedExternalUrl(targetUrl)) shell.openExternal(targetUrl).catch(() => {});
  });
  contents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) shell.openExternal(details.url).catch(() => {});
    return { action: 'deny' };
  });
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

// Reads duration/dimensions/stream-presence via the same bundled ffprobe
// export already uses, rather than making the renderer depend on Chromium's
// own (much narrower) <video>/<audio> decoding just to learn a file's
// metadata - see the comment on probeMediaInfo in ffmpegExport.js for why.
ipcMain.handle('media:probeFile', async (_evt, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('Invalid file path.');
  }
  return ffmpegExport.probeMediaInfo(filePath);
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
  if (typeof partial.resourceCapEnabled === 'boolean') allowed.resourceCapEnabled = partial.resourceCapEnabled;
  return settingsStore.saveSettings(allowed);
});

// ---------- export ----------
ipcMain.handle('export:choosePath', async (_evt, suggestedName, format) => {
  const ext = format === 'mp4' ? 'mp4' : 'webm';
  // Trimmed to a sane length regardless of what the renderer sends (its own
  // maxLength is just the first line of defense - a project file edited
  // outside the app, or one saved before that limit existed, could still
  // carry something absurd) - long enough for any real video title, short
  // enough to stay well clear of OS path-length limits once combined with a
  // real directory path and extension.
  const cleanName = (String(suggestedName || 'video')).replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 100) || 'video';
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
// Lets the renderer's disclaimer/license gate cleanly quit the app if the
// person declines, rather than leaving them stuck on a screen with no way
// out (the sandboxed renderer has no other way to close its own window).
ipcMain.handle('app:quit', () => { app.quit(); });

// ---------- custom title bar (Windows/Linux only - see IS_CUSTOM_TITLEBAR_PLATFORM) ----------
// Standing in for what a native title bar's own window controls would
// otherwise do - the renderer has no way to minimize/maximize/close its
// own window (nor should it be able to reach into anything OS-level like
// that without going through main, same as every other capability here).
ipcMain.handle('window:isCustomTitlebar', () => IS_CUSTOM_TITLEBAR_PLATFORM);
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window:isMaximized', () => (mainWindow ? mainWindow.isMaximized() : false));
// One handler for all four top-level menus - see popupMenuByLabel above.
ipcMain.handle('menu:popup', (_evt, label) => {
  if (typeof label !== 'string') return;
  popupMenuByLabel(label);
});
