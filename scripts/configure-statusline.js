#!/usr/bin/env node
// Points the user's statusLine setting at the plugin's staged statusline.js.
// Run by /statusline-for-claude-code:setup in two steps, so the user sees the
// change before anything is written:
//
//   node configure-statusline.js plan  <script> [settings.json]
//   node configure-statusline.js apply <script> [settings.json]
//
// `plan` writes nothing and prints JSON: settingsPath, current, proposed,
// isAlreadySet. `apply` backs settings.json up to settings.json.bak, then
// rewrites the statusLine key alone, keeping every other key, the file's
// indentation and its line endings. A settings file that isn't valid JSON
// is never touched. Exits 1 with a message on stderr on any failure.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_REFRESH_INTERVAL = 60;

function defaultSettingsPath() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(claudeDir, 'settings.json');
}

function readSettings(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { raw: null, settings: {} };
    throw err;
  }
  let settings;
  try {
    settings = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON (${err.message}); fix it by hand first`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${settingsPath} does not hold a JSON object`);
  }
  return { raw, settings };
}

function proposeStatusLine(current, script) {
  const proposed = { type: 'command', command: `node "${script}"` };
  const hasOwn = current && typeof current === 'object';
  proposed.refreshInterval = hasOwn && Number.isInteger(current.refreshInterval)
    ? current.refreshInterval
    : DEFAULT_REFRESH_INTERVAL;
  if (hasOwn && current.padding !== undefined) proposed.padding = current.padding;
  return proposed;
}

function plan(script, settingsPath) {
  const { settings } = readSettings(settingsPath);
  const current = settings.statusLine ?? null;
  const proposed = proposeStatusLine(current, script);
  return {
    settingsPath,
    current,
    proposed,
    isAlreadySet: JSON.stringify(current) === JSON.stringify(proposed)
  };
}

function apply(script, settingsPath) {
  const { raw, settings } = readSettings(settingsPath);
  const result = plan(script, settingsPath);
  if (result.isAlreadySet) return { settingsPath, backupPath: null, statusLine: result.proposed, isChanged: false };

  let backupPath = null;
  if (raw !== null) {
    backupPath = `${settingsPath}.bak`;
    fs.writeFileSync(backupPath, raw);
  }
  const indent = (raw && raw.match(/^([ \t]+)"/m)?.[1]) || '  ';
  const eol = raw && raw.includes('\r\n') ? '\r\n' : '\n';
  const text = JSON.stringify({ ...settings, statusLine: result.proposed }, null, indent);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, text.replace(/\n/g, eol) + eol);
  return { settingsPath, backupPath, statusLine: result.proposed, isChanged: true };
}

if (require.main === module) {
  try {
    const [mode, script, settingsArg] = process.argv.slice(2);
    if (!['plan', 'apply'].includes(mode) || !script) {
      throw new Error('usage: configure-statusline.js plan|apply <script> [settings.json]');
    }
    const settingsPath = settingsArg || defaultSettingsPath();
    const scriptPath = script.replace(/\\/g, '/');
    const out = mode === 'plan' ? plan(scriptPath, settingsPath) : apply(scriptPath, settingsPath);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`configure-statusline: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { plan, apply, proposeStatusLine };
