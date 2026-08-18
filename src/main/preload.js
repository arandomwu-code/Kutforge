'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// A sandboxed preload's polyfilled require() only exposes the `electron`
// module (contextBridge, ipcRenderer, webUtils, etc.) - raw Node built-ins
// like `url` or `path` aren't available. This is a small hand-rolled
// equivalent of Node's url.pathToFileURL() so preload never needs anything
// beyond `electron`, which keeps the renderer fully sandboxable.
function pathToFileUrl(p) {
  let pathName = String(p).replace(/\\/g, '/');
  if (!pathName.startsWith('/')) pathName = '/' + pathName; // e.g. Windows "C:/..." -> "/C:/..."
  const encoded = pathName
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')) // keep literal ':' after a Windows drive letter
    .join('/');
  return 'file://' + encoded;
}

let progressListener = null;
ipcRenderer.on('export:progress', (_evt, payload) => {
  if (progressListener) progressListener(payload);
});

let menuListener = null;
ipcRenderer.on('menu:action', (_evt, action) => {
  if (menuListener) menuListener(action);
});

let maximizedChangeListener = null;
ipcRenderer.on('window:maximizedChange', (_evt, isMaximized) => {
  if (maximizedChangeListener) maximizedChangeListener(isMaximized);
});

contextBridge.exposeInMainWorld('kutforgeAPI', {
  // ---- local file paths ----
  // Resolves the real filesystem path for a File object obtained from a
  // native <input type="file"> pick or an OS drag-and-drop, so media can be
  // referenced directly on disk instead of copied into a blob store.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return null; }
  },
  pathToFileUrl,

  // ---- media import ----
  openMediaDialog: () => ipcRenderer.invoke('dialog:openMediaFiles'),
  // Reads a file's duration/dimensions/stream info via the bundled ffprobe,
  // independent of whether Chromium's own <video>/<audio> element can
  // actually decode it - see main.js's media:probeFile handler.
  probeMediaFile: (filePath) => ipcRenderer.invoke('media:probeFile', filePath),

  // ---- project persistence ----
  loadAutosavedProject: () => ipcRenderer.invoke('project:loadAutosave'),
  saveAutosavedProject: (data) => ipcRenderer.invoke('project:saveAutosave', data),
  openProjectDialog: () => ipcRenderer.invoke('project:openDialog'),
  saveProjectAsDialog: (data) => ipcRenderer.invoke('project:saveAsDialog', data),

  // ---- app-wide settings (default theme, etc.) ----
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  // ---- export ----
  chooseExportPath: (suggestedName, format) => ipcRenderer.invoke('export:choosePath', suggestedName, format),
  startExport: (edl, outPath) => ipcRenderer.invoke('export:start', edl, outPath),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => { progressListener = cb; },

  // ---- misc ----
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItemInFolder', p),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onMenuAction: (cb) => { menuListener = cb; },

  // ---- custom title bar (Windows/Linux - see main.js's IS_CUSTOM_TITLEBAR_PLATFORM) ----
  isCustomTitlebar: () => ipcRenderer.invoke('window:isCustomTitlebar'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizedChange: (cb) => { maximizedChangeListener = cb; },
  popupMenu: (label) => ipcRenderer.invoke('menu:popup', label),
});
