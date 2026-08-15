'use strict';
const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

function autosavePath() {
  return path.join(app.getPath('userData'), 'autosave.kutforgeproj.json');
}

function loadAutosave() {
  try {
    const raw = fs.readFileSync(autosavePath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Called every time the renderer's debounced autosave fires - roughly every
// 600ms of active editing (dragging a clip, adjusting a filter, etc.). This
// used to do fs.mkdirSync + fs.writeFileSync, both synchronous - which
// means every autosave blocked the *entire* main process event loop (window
// events, every other IPC handler, menu clicks) for however long the write
// took. On a fast local SSD that's normally sub-millisecond and invisible,
// but it's a real stall waiting to happen on a slower disk, a network-mounted
// home directory, antivirus intercepting the write, or just a large project
// with a lot of clips/media - and it happens repeatedly, every 600ms, for as
// long as someone is actively editing. Using the async fs API instead means
// a slow write no longer blocks anything else the app needs to do while it
// completes. mkdir is also now skipped once it's already known to exist,
// rather than re-checking on every single save.
let _autosaveDirEnsured = false;
async function saveAutosave(data) {
  try {
    if (!_autosaveDirEnsured) {
      await fs.promises.mkdir(path.dirname(autosavePath()), { recursive: true });
      _autosaveDirEnsured = true;
    }
    await fs.promises.writeFile(autosavePath(), JSON.stringify(data), 'utf8');
    return true;
  } catch (e) {
    // The directory could have been removed out from under us since the
    // last successful save (external tooling, the user cleaning up
    // userData, etc.) - re-check next time rather than assuming forever
    // that it still exists.
    _autosaveDirEnsured = false;
    return false;
  }
}

async function openProjectDialog(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open project',
    filters: [{ name: 'Kutforge project', extensions: ['kutforgeproj', 'json'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  try {
    const raw = fs.readFileSync(res.filePaths[0], 'utf8');
    return { data: JSON.parse(raw), filePath: res.filePaths[0] };
  } catch (e) {
    return { error: 'Could not read that project file.' };
  }
}

async function saveProjectAsDialog(win, data) {
  const suggested = (data && data.projectName ? data.projectName : 'My Video').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'video';
  const res = await dialog.showSaveDialog(win, {
    title: 'Save project as',
    defaultPath: suggested + '.kutforgeproj.json',
    filters: [{ name: 'Kutforge project', extensions: ['kutforgeproj.json', 'json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.promises.writeFile(res.filePath, JSON.stringify(data), 'utf8');
  return res.filePath;
}

module.exports = { autosavePath, loadAutosave, saveAutosave, openProjectDialog, saveProjectAsDialog };
