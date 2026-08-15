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
  // Off by default: exporting as fast as possible is the expected behavior
  // unless the person explicitly opts into holding some capacity back.
  // Whichever way they leave it is remembered as the default for next time
  // (see resourceCapEnabled below).
  resourceCapEnabled: false,
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
