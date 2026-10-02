#!/usr/bin/env node
// Plugin SessionStart hook: copies this plugin version's statusline.js into
// CLAUDE_PLUGIN_DATA. The plugin root is versioned and moves on every
// update; the data dir stays put, so settings.json points at the copy and
// picks up new releases without re-running setup. Prints nothing in hook
// mode (SessionStart stdout would land in Claude's context). Never blocks;
// exits 0 on any error.
//
// /statusline-for-claude-code:setup runs it too, with the plugin root and data
// dir as arguments (the Bash tool's environment has neither variable); it
// then prints the staged path.

const fs = require('fs');
const path = require('path');

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

if (require.main === module) {
  try {
    const [rootArg, dataArg] = process.argv.slice(2);
    const root = rootArg || process.env.CLAUDE_PLUGIN_ROOT;
    const dataDir = dataArg || process.env.CLAUDE_PLUGIN_DATA;
    if (root && dataDir) {
      const dest = stage(root, dataDir);
      // settings.json wants forward slashes on Windows too.
      if (rootArg) process.stdout.write(`${dest.replace(/\\/g, '/')}\n`);
    }
  } catch (err) {
    process.stderr.write(`stage-statusline error: ${err.message}\n`);
  }
  process.exit(0);
}

module.exports = { stage };
