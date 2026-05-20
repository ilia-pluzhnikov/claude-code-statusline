# Claude Code Statusline

<img width="1899" height="134" alt="image" src="https://github.com/user-attachments/assets/0f10afac-e1be-44f5-a953-d37132903765" />


A feature-rich, single-file Node.js statusline for [Claude Code](https://claude.ai/code).
One line at the bottom of your terminal that tells you everything you actually need:
which model you're on, the live git state of your repo, how much context you've
burned, your prompt-cache hit/write state, and your subscription rate limits.

No dependencies. No build step. Works on macOS, Linux, and Windows.

## Preview

```
Op 4.7 (1m) │ claude-…tusline (main) │ 3M 1? ↑2 push ⚠ md drift │ ██░░░ 480k/1M │ cache 87% ↓75k +360 1h:42m │ 5h:35%(2h15m) │ 7d:42%(4d)
```

Each segment is color-coded (dim, bright, cyan, pink, green, yellow, orange, red) so the
shape of the line itself communicates urgency at a glance. Labels are aggressively
shortened so the line fits in a 100-column terminal.

<img width="1280" height="636" alt="image" src="https://github.com/user-attachments/assets/c07f4e46-61cb-473e-99d6-d7b06a3fa3ec" />


## What you see, left to right


| Segment | Meaning |
|---------|---------|
| `Op 4.7 (1m)` | Current model, abbreviated: family (`Op`/`So`/`Ha`/`My`) + space + version + context size (dim). `Opus 4.7 (1M context)` becomes `Op 4.7 (1m)`. Unrecognised model names are shown as-is. |
| `claude-…tusline (main)` | Working directory basename (dim) + current branch in cyan; shows `(HEAD@<sha>)` in red for detached HEAD. The basename is trimmed to a 15-char `head…tail` middle ellipsis (7 chars each side) **only when the full status line would otherwise exceed 100 visible columns** — short lines keep the full name |
| `3M 1A 1D 1R 2? 1!` | Working tree status, bucketed by VS Code-style codes: `M` = modified, `A` = added/staged, `D` = deleted, `R` = renamed, `?` = untracked. All shown dim. `!` = unmerged conflict, rendered separately in **red** because it's the only one that blocks a commit. Empty buckets are hidden — clean repo shows nothing |
| `↑2 push` / `↓1 pull` | Local branch is ahead/behind `origin/<branch>` |
| `⚠ md drift` | `CLAUDE.md` ↔ `AGENTS.md` ↔ `GEMINI.md` are out of sync |
| `██░░░ 480k/1M` | Context window usage — 5-cell bar with half-block precision (`█▌░`, ~10% per step in 5 cells). When Claude Code provides absolute context counters, the bar is driven by `total_input_tokens / context_window_size` and the segment appends the raw counts (for example `480k/1M`). When only `remaining_percentage` is available, the bar falls back to `100 - remaining` |
| `cache 87% ↓75k +360 1h:42m` | Prompt cache state. Read/write/input counters come from stdin `context_window.current_usage`; the session transcript only supplies the TTL bucket (`1h`/`5m`) and last-touch timestamp for the countdown. Hit ratio is `read / (input + write + read)`: `≥90%` bold green, `≥75%` green, `≥50%` yellow, below that orange, and `0%` bold red for a full miss/invalidation. `↓` means tokens read from cache, `+` or `↑` means tokens written. After `/compact`, `cache:reset` appears while stdin `current_usage` is null but the transcript shows earlier cache activity |
| `5h:35%(2h15m)` | 5-hour rate limit usage + reset countdown (`Xh Ym` / `Mm`) |
| `7d:42%(4d)` | 7-day rate limit usage + reset countdown. Coarse format: `Nd` while ≥ 2 days remain; `1dXh` for the final day (renders as `24h` at exactly 1 day so the unit doesn't lie); `Xh Ym` / `Mm` below 1 day |

The context bar and rate-limit percentages share the same color scale:

| Used | Color |
|------|-------|
| < 50% | pink |
| 50-65% | yellow |
| 65-80% | orange |
| ≥ 80% | red with a 💀 prefix on the context bar |

The context bar has one extra absolute-token rule: once `total_input_tokens`
crosses **250k**, pink is promoted to yellow regardless of the percentage
scale. 250k is the practical "already a lot" cliff — model output quality
degrades and Anthropic's long-context pricing tier kicks in around there —
so a 1M-context session at 250k/1M (25% used) shouldn't render as cozy pink.

## Installation

1. **Clone or download** this repo.
2. **Drop `statusline.js`** anywhere you like. The natural location is `~/.claude/hooks/statusline.js`.
3. **Wire it up** in `~/.claude/settings.json`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"/absolute/path/to/statusline.js\"",
       "refreshInterval": 60
     }
   }
   ```

   On Windows use forward slashes inside the JSON string: `"node \"C:/Users/you/.claude/hooks/statusline.js\""`.

   `refreshInterval: 60` re-runs the script every 60 seconds in addition to event-driven updates (new assistant message, `/compact`, permission mode change, vim mode toggle). Without it, the cache TTL countdown freezes in idle — Claude Code only refreshes the statusline on those events, so a value rendered 50 minutes ago will keep showing `60m remaining` until you press Enter. 60 seconds is enough to step through the color thresholds (dim → yellow → red) cleanly while staying cheap (the script only reads the last 16 KB of the session transcript). Requires Claude Code ≥2.1.97.

4. **Restart Claude Code.** That's it.

The script reads the standard Claude Code statusline JSON from stdin (model,
workspace, session, context window, rate limits) and writes a single ANSI-coloured
line to stdout. It exits silently on any error so a broken statusline never blocks your
session.

## Optional companion hooks

### Why MD sync matters

Different coding agents read different memory files from your project root:

- **Claude Code** reads `CLAUDE.md`
- **OpenAI Codex** (and most agent-spec compliant tools) read `AGENTS.md`
- **Gemini CLI** reads `GEMINI.md`

If you use more than one agent on the same project, all three need to contain the
same project context — coding conventions, deploy instructions, "don't touch X"
rules. The moment they drift apart, one agent is following outdated rules while the
others aren't, and you start getting inconsistent behavior across tools without
knowing why. Worse: you update one file, forget the other two, and a week later a
different agent confidently violates a rule you thought you'd written down.

The drift detector turns this from an invisible bug into a visible one. The
`sync-md.js` hook below goes further and removes the manual work entirely: edit
`CLAUDE.md` and the other two regenerate from it automatically.

### The hooks

The MD-drift detector inside `statusline.js` only lights up if your project actually
keeps `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` as a synchronized trio. The
[`optional-hooks/`](./optional-hooks/) folder contains three small hooks that make
the rest of the experience whole:

- **`md-sync-check.js`** — `SessionStart` hook. Warns Claude (via `additionalContext`) when the trio drifts.
- **`sync-md.js`** — `PostToolUse` hook. When you `Edit`/`Write` `CLAUDE.md`, it auto-mirrors the content into `AGENTS.md` and `GEMINI.md`, rewriting the per-file `Sync:` line.
- **`github-sync-check.js`** — `SessionStart` hook. Warns about uncommitted files and tells you when your branch has drifted from `origin/<branch>`. Runs `git fetch` in the background so the next session has fresh data.

See [`optional-hooks/README.md`](./optional-hooks/README.md) for installation snippets.
None of them are required for the statusline itself to work.

## How it stays fast

- **All git checks are local.** No `git fetch`, no network, hard 1s timeout per command.
- **Bridge file in `os.tmpdir()`.** The context-usage value is written to `claude-ctx-{session_id}.json` so other hooks (e.g. a `PostToolUse` context monitor) can read the same number without re-parsing stdin.
- **Stdin timeout (3s)** — if Claude Code never sends data, the script exits cleanly instead of hanging.

## Cross-platform notes

- **Windows:** the script uses `windowsHide: true` on every git subprocess call, so no
  console flashes appear during git polling.
- **Path separators:** filesystem paths use `path.join` and `os.homedir()`;
  Claude transcript lookup intentionally mirrors Claude Code's project-slug
  convention by replacing drive colons, path separators, and dots with `-`.

## Customization

The script is 370 lines of dependency-free Node.js. Open it and tweak.
The most common customizations:

- **Hide the cache segment** — delete the `Prompt cache state` block. Useful if you don't run Claude Code in this terminal or don't want token counts visible.
- **Change the colour thresholds** — search for `< 50` / `< 65` / `< 80` and edit.
- **Hide the model name** — remove `\`\x1b[2m${model}\x1b[0m\`` from the `segments` array at the bottom.
- **Use a different separator** — change `' │ '` (the `│` character) on the final line.

## Requirements

- Node.js (any modern version — uses only built-in modules)
- Claude Code with statusline support (`statusLine` in `settings.json`)
- Optional: `git` on `PATH` for the git-status segment

А если хотите получше освоить Claude Code и вообще принцип работы AI, то у меня есть курс, где раз в месяц я набираю 10 людей и мы проходим 6 уровней, от установки до Context Engeenireng и теории про проактивных агентов по типу OpenClaw
https://ilia-pro-ai.com/

<img width="1480" height="1123" alt="image" src="https://github.com/user-attachments/assets/cb8e6b16-2d60-4107-85c0-b01115cdb10e" />


## License

MIT — see [LICENSE](./LICENSE).

## Credits

Built by [Ilya Pluzhnikov](https://github.com/ilia-pluzhnikov).
PRs and forks welcome.
