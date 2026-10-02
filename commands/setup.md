---
description: Point your statusLine setting at this plugin's status line (shows the change and asks before writing)
---

Set up the statusline-for-claude-code plugin's status line. Work through these steps in order. If a command fails, stop and quote its error to the user.

1. Stage the script by running:

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/stage-statusline.js" "${CLAUDE_PLUGIN_ROOT}" "${CLAUDE_PLUGIN_DATA}"`

   It prints the path of the staged `statusline.js`. Use that exact path as SCRIPT in the next steps.

2. Preview the change by running:

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure-statusline.js" plan "SCRIPT"`

   It writes nothing and prints JSON with `settingsPath`, `current`, `proposed` and `isAlreadySet`.
   - If `isAlreadySet` is `true`, tell the user the status line is already set up, and stop.
   - Otherwise show the user `settingsPath`, the `current` statusLine (or say there is none) and the `proposed` one. Say that applying replaces only the `statusLine` key and first backs the file up to `settings.json.bak`.

3. Ask the user whether to apply the change, and wait for an explicit yes. On any other answer, stop without writing anything.

4. Apply the change by running:

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/configure-statusline.js" apply "SCRIPT"`

   Report `settingsPath` and `backupPath` from its output.

5. Tell the user that the status line appears on Claude Code's next refresh (restart Claude Code if it doesn't), that plugin updates reach it without running setup again, and that restoring `settings.json.bak` undoes the change.
