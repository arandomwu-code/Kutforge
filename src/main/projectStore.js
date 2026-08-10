'use strict';
const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

function autosavePath() {
  return path.join(app.getPath('userData'), 'autosave.reelproj.json');
}

function loadAutosave() {
  try {
    const raw = fs.readFileSync(autosavePath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveAutosave(data) {
  try {
    fs.mkdirSync(path.dirname(autosavePath()), { recursive: true });
    fs.writeFileSync(autosavePath(), JSON.stringify(data), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

async function openProjectDialog(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open project',
    filters: [{ name: 'Reel project', extensions: ['reelproj', 'json'] }],
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
    defaultPath: suggested + '.reelproj.json',
    filters: [{ name: 'Reel project', extensions: ['reelproj.json', 'json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, JSON.stringify(data), 'utf8');
  return res.filePath;
}

module.exports = { autosavePath, loadAutosave, saveAutosave, openProjectDialog, saveProjectAsDialog };
