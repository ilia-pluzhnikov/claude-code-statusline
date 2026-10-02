# claude-code-statusline

A single-file Node.js statusline for Claude Code, plus an optional companion hook that surfaces git state at session start.

This file is the project's only agent instructions file: Codex and Claude Code (v2.1.277+) read `AGENTS.md` directly, Gemini CLI once `context.fileName` in its settings lists it. Don't add a `CLAUDE.md` or `GEMINI.md` copy.

## Project shape

- `statusline.js` — entry point. Reads JSON from stdin (model, workspace, session_id, context_window, rate_limits) and writes one ANSI-coloured line to stdout.
- `optional-hooks/github-sync-check.js` — SessionStart git status + cached `origin` divergence + background fetch for next session.
- `.claude-plugin/plugin.json` + `marketplace.json` — the repo root is also the Claude Code plugin `statusline-for-claude-code` and a one-plugin marketplace `ilia-pluzhnikov`. The optional hook is not part of the plugin.
- `hooks/hooks.json` → `scripts/stage-statusline.js` — plugin SessionStart hook: copies `statusline.js` into `CLAUDE_PLUGIN_DATA`, the path that survives plugin updates.
- `commands/setup.md` → `scripts/configure-statusline.js` — `/statusline-for-claude-code:setup`: previews, then writes the `statusLine` key. A plugin can't set `statusLine` itself; Claude Code applies only `agent` and `subagentStatusLine` from plugin settings.

## Rules for contributors (and AI agents)

- **No dependencies.** Everything is built-in Node.js (`fs`, `path`, `os`, `child_process`). Don't add a `package.json` with deps. If a feature needs an npm package, the answer is probably "the feature doesn't belong here".
- **Single-file per concern.** `statusline.js` is one file. Each hook and plugin script is one file. No build step, no transpiler.
- **Exit 0 on any error.** A broken hook must never block the user's tool call. Wrap risky logic in `try`/`catch` and `process.exit(0)` on failure. Same for `statusline.js` — empty output is acceptable, a thrown error that breaks Claude Code's UI is not.
- **Hot-path budget.** `statusline.js` is invoked on every status refresh. No network, no `git fetch` on the hot path. Use bridge files in `os.tmpdir()` and background `spawn(detached: true).unref()` for anything that takes >100ms.
- **Hide on happy path.** Segments only appear when they have something to say. `0 uncommitted` is invisible. `↑0 push` is invisible. Add new segments with the same discipline.
- **Cross-platform.** Use `path.join`, `os.homedir()`, `windowsHide: true` on every `execSync`. No hard-coded `/` or `\`. No assumptions about which shell.
- **Avoid TUI-incompatible ANSI attributes.** Blink (`\x1b[5m`), strikethrough, and underline-color extensions are silently dropped by Ink-based TUIs (Claude Code) and disabled by default in modern terminals. For attention without animation, use bold + bright color, inverse video (`\x1b[7m`), or a background-color badge. Stick to widely-supported codes: 30-37 (fg), 40-47 (bg), 1 (bold), 2 (dim), 7 (inverse), 38;2;R;G;B (truecolor).

## Testing

Manual. Pipe a sample statusline JSON into the script:

```bash
echo '{"model":{"display_name":"claude-opus-4-7"},"workspace":{"current_dir":"."},"session_id":"test","context_window":{"remaining_percentage":60}}' | node statusline.js
```

There is a smoke test suite at `tests/statusline-smoke.test.js`; run it with `node tests/statusline-smoke.test.js`. The plugin's scripts and manifests are covered by `node tests/plugin.test.js`, and `claude plugin validate .` checks the plugin and marketplace manifests. There is no CI yet.

## Releasing

Tag from `main`, cut a GitHub Release, then **attach `statusline.js` as a release asset** — don't skip this step. It's the single-file install users actually download, and GitHub's auto-generated "Source code" archives don't count toward download stats, so the attached asset is also the project's only permanent install-count metric (the `traffic/clones` API only keeps a rolling 14-day window).

```bash
git tag -a vX.Y.Z <sha> -m "<summary>"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "..." --notes "..."
gh release upload vX.Y.Z statusline.js   # ← the install artifact + download counter
```

Before tagging, raise `version` in `.claude-plugin/plugin.json` to the tag's `X.Y.Z`: plugin users stay on the old version until it changes.

The asset is a snapshot, so re-upload `statusline.js` on every release to keep the latest tag serving current code. Check the counter with `gh release view vX.Y.Z --json assets --jq '.assets[] | "\(.name): \(.downloadCount)"'`.

## License

MIT — see `LICENSE`.
