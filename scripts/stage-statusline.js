#!/usr/bin/env node
// Plugin SessionStart hook: copies this plugin version's statusline.js into
// CLAUDE_PLUGIN_DATA. The plugin root is versioned and moves on every
// update; the data dir stays put, so settings.json points at the copy and
// picks up new releases without re-running setup. Never blocks; exits 0 on
// any error.
//
// In hook mode its only output is a one-time setup hint, sent as JSON
// systemMessage: Claude Code shows that to the user, while plain SessionStart
// stdout would land in Claude's context. Installing the plugin alone changes
// nothing on screen, so the hint is how a new user learns about setup.
//
// /statusline-for-claude-code:setup runs it too, with the plugin root and data
// dir as arguments (the Bash tool's environment has neither variable); it
// then prints the staged path.

const fs = require('fs');
const path = require('path');
const { defaultSettingsPath, readSettings } = require('./configure-statusline');

const HINT_MARKER = 'setup-hint-shown';
const HINT = "statusline-for-claude-code is installed, but your status line isn't using it yet. "
  + 'Run /statusline-for-claude-code:setup to preview the change and apply it. This tip shows once.';

function stage(root, dataDir) {
  const next = fs.readFileSync(path.join(root, 'statusline.js'));
  const dest = path.join(dataDir, 'statusline.js');
  let current = null;
  try { current = fs.readFileSync(dest); } catch {}
  if (!current || !current.equals(next)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dest, next);
  }
  return dest;
}

// The hint, or null when statusLine already runs the staged copy or the hint
// was shown before. The marker is written first, so a data dir that can't
// take it means no hint rather than a hint on every session.
function setupHint(dest, dataDir, settingsPath) {
  const marker = path.join(dataDir, HINT_MARKER);
  if (fs.existsSync(marker)) return null;
  const command = readSettings(settingsPath).settings.statusLine?.command;
  const norm = s => s.replace(/\\/g, '/').toLowerCase();
  if (typeof command === 'string' && norm(command).includes(norm(dest))) return null;
  fs.writeFileSync(marker, '');
  return HINT;
}

if (require.main === module) {
  try {
    const [rootArg, dataArg] = process.argv.slice(2);
    const root = rootArg || process.env.CLAUDE_PLUGIN_ROOT;
    const dataDir = dataArg || process.env.CLAUDE_PLUGIN_DATA;
    if (root && dataDir) {
      const dest = stage(root, dataDir);
      if (rootArg) {
        // settings.json wants forward slashes on Windows too.
        process.stdout.write(`${dest.replace(/\\/g, '/')}\n`);
      } else {
        const hint = setupHint(dest, dataDir, defaultSettingsPath());
        if (hint) process.stdout.write(`${JSON.stringify({ systemMessage: hint })}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`stage-statusline error: ${err.message}\n`);
  }
  process.exit(0);
}

module.exports = { stage };
