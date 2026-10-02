# Optional Hooks

A small Claude Code hook that pairs well with `statusline.js`. It never blocks
your tools on failure (it `process.exit(0)`s on any error). It is not part of
the plugin: install it by hand if you want it.

| Hook | Event | Purpose |
|------|-------|---------|
| [`github-sync-check.js`](#github-sync-checkjs) | `SessionStart` | Warns about uncommitted files and `origin` divergence |

Recommended placement: drop the file directly into `~/.claude/hooks/` to keep
it alongside `statusline.js`. The examples below use that flat layout.

> Earlier releases also shipped `md-sync-check.js` and `sync-md.js`, which kept
> `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` in sync. They were removed in v1.3.0:
> Codex and Claude Code (v2.1.277+) read `AGENTS.md` directly, and Gemini CLI
> does once its `context.fileName` setting lists it, so one `AGENTS.md` serves
> all three. If you wired them up, remove their entries from `settings.json`
> before updating your copy of this repo.

---

## `github-sync-check.js`

**What it does.** On session start, surfaces three classes of warnings so you don't
sleepwalk into a dirty merge:

- 🟡 **Uncommitted changes** — count of files with local modifications
- 🟡 **Behind `origin`** — local branch trails the remote (suggests `git pull`)
- 🟡 **Ahead of `origin`** — local has unpushed commits (suggests `git push`)
- 🔴 **Diverged** — both ahead and behind, requires merge or rebase

Warnings are written to **both** stderr (visible in your terminal) and the agent's
system reminder via `additionalContext` (so Claude sees them too).

**How it stays fast.** The session-start check is purely local — no network. After
emitting whatever the previous session cached, it spawns a *detached* background
process that runs `git fetch origin --quiet --no-tags` and writes the fresh
ahead/behind counts to `~/.claude/cache/github-sync.json`. The next time you start
a session, that fresh data is what shows up. So the warning you see is always one
session stale — but you pay zero startup cost for it.

**Skips silently** when:

- Not inside a git repo
- The remote isn't `github.com`
- You're in detached HEAD state

**Install.**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/github-sync-check.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

---

## Combined snippet (the hook + the statusline)

If you want both wired up at once, here's the full block to merge into
`~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline.js\"",
    "refreshInterval": 60
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/absolute/path/to/github-sync-check.js\"", "timeout": 10 }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to/` with whatever you used (e.g. `C:/Users/you/.claude/hooks/`
on Windows). Restart Claude Code afterwards.
