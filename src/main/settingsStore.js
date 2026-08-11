'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Distinct from projectStore's autosave: this holds preferences that apply
// across every project (currently just the default theme), not the content
// of any one project.
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const DEFAULTS = {
  defaultTheme: 'cream',
  trackColorTint: true,
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings(partial) {
  try {
    const current = loadSettings();
    const next = { ...current, ...partial };
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next), 'utf8');
    return next;
  } catch (e) {
    return null;
  }
}

module.exports = { loadSettings, saveSettings };
