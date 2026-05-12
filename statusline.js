#!/usr/bin/env node
// Claude Code Statusline
// Shows: model | directory | git sync | context usage

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const shortModel = (name) => {
      const m = name.match(/^(?:claude-)?(Opus|Sonnet|Haiku|Mythos)[\s-]+(\d+(?:[.-]\d+)?)(?:\s*\(([^)]+)\))?/i);
      if (!m) return name;
      const family = m[1].charAt(0).toUpperCase() + m[1].charAt(1).toLowerCase();
      const version = m[2].replace('-', '.');
      const ctx = m[3];
      let suffix = `${family} ${version}`;
      if (ctx) {
        const ctxMatch = ctx.match(/(\d+)\s*([KMG])/i);
        if (ctxMatch) suffix += ` (${ctxMatch[1]}${ctxMatch[2].toLowerCase()})`;
      }
      return suffix;
    };
    const model = shortModel(data.model?.display_name || 'Claude');
    const dir = data.workspace?.current_dir || process.cwd();
    // session_id is used to build paths under os.tmpdir() and ~/.claude/projects.
    // Claude Code emits a UUID, but treat any unexpected shape as absent so a
    // malformed value can't traverse out of those locations (e.g. "../foo").
    const rawSession = data.session_id || '';
    const session = /^[A-Za-z0-9_-]{1,128}$/.test(rawSession) ? rawSession : '';
    const rawRemaining = data.context_window?.remaining_percentage;
    const remaining = (rawRemaining == null || rawRemaining === '') ? NaN : Number(rawRemaining);
    const homeDir = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');

    const fmt = (n) => {
      if (n < 1000) return String(n);
      if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      if (n < 1000000) return Math.round(n / 1000) + 'k';
      return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    };

    // --- Context window ---
    let ctx = '';
    if (Number.isFinite(remaining)) {
      // Absolute token counts (e.g. "480k/1M"). Numerator is total_input_tokens
      // (input + cache_creation + cache_read); denominator is context_window_size.
      // When both are present we drive the bar from them directly \u2014 more honest
      // than remapping `remaining_percentage` through a hardcoded compact buffer
      // that doesn't scale across context window sizes.
      const totalInput = Number(data.context_window?.total_input_tokens) || 0;
      const ctxSize = Number(data.context_window?.context_window_size) || 0;
      const haveAbs = totalInput > 0 && ctxSize > 0;
      const used = haveAbs
        ? Math.max(0, Math.min(100, Math.round((totalInput / ctxSize) * 100)))
        : Math.max(0, Math.min(100, Math.round(100 - remaining)));

      // Bridge file for context-monitor PostToolUse hook
      if (session) {
        try {
          const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
          fs.writeFileSync(bridgePath, JSON.stringify({
            session_id: session,
            remaining_percentage: remaining,
            used_pct: used,
            timestamp: Math.floor(Date.now() / 1000)
          }));
        } catch (e) {}
      }

      const steps = Math.max(0, Math.min(10, Math.floor(used / 10)));
      let bar = '';
      for (let i = 0; i < 5; i++) {
        const cell = Math.max(0, Math.min(2, steps - i * 2));
        bar += cell === 2 ? '\u2588' : cell === 1 ? '\u258c' : '\u2591';
      }

      const abs = haveAbs ? ` ${fmt(totalInput)}/${fmt(ctxSize)}` : '';

      let color, prefix = '';
      if (used < 50) color = '\x1b[38;2;255;125;218m';
      else if (used < 65) color = '\x1b[33m';
      else if (used < 80) color = '\x1b[38;2;255;140;0m';
      else { color = '\x1b[31m'; prefix = '\uD83D\uDC80 '; }

      // Absolute token cap: 250k is the pricing/quality cliff regardless of how
      // wide the context window is. Bump pink \u2192 yellow once we cross it, so a
      // 1M session at 250k/1M (25% used) doesn't render as "still cozy pink".
      if (haveAbs && totalInput >= 250000 && color === '\x1b[38;2;255;125;218m') {
        color = '\x1b[33m';
      }

      ctx = ` ${color}${prefix}${bar}${abs}\x1b[0m`;
    }

    // --- Git status (live, local, no network) ---
    let gitInfo = '';
    let branch = '';
    let detachedSha = '';
    try {
      const gitExec = (args) => {
        try {
          return execFileSync('git', args, { encoding: 'utf8', cwd: dir, windowsHide: true, timeout: 1000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        } catch (e) { return null; }
      };
      const parts = [];

      // Uncommitted changes — bucketed by VS Code-style status codes
      const status = gitExec(['status', '--porcelain']);
      if (status) {
        const buckets = { M: 0, A: 0, D: 0, R: 0, '?': 0, '!': 0 };
        for (const line of status.split('\n')) {
          if (!line) continue;
          const X = line.charAt(0);
          const Y = line.charAt(1);
          if (X === '?' && Y === '?') buckets['?']++;
          else if (X === 'U' || Y === 'U' || (X === 'D' && Y === 'D') || (X === 'A' && Y === 'A')) buckets['!']++;
          else if (Y === 'D' || X === 'D') buckets.D++;
          else if (X === 'R') buckets.R++;
          else if (X === 'A' || X === 'C') buckets.A++;
          else buckets.M++;
        }
        const dimBuckets = [];
        for (const k of ['M', 'A', 'D', 'R', '?']) {
          if (buckets[k] > 0) dimBuckets.push(`${buckets[k]}${k}`);
        }
        if (dimBuckets.length > 0) parts.push(`\x1b[2m${dimBuckets.join(' ')}\x1b[0m`);
        if (buckets['!'] > 0) parts.push(`\x1b[31m${buckets['!']}!\x1b[0m`);
      }

      // Behind/ahead origin
      branch = gitExec(['branch', '--show-current']) || '';
      if (!branch) {
        detachedSha = gitExec(['rev-parse', '--short', 'HEAD']) || '';
      }
      if (branch) {
        const remoteRef = `refs/remotes/origin/${branch}`;
        const behind = parseInt(gitExec(['rev-list', '--count', `HEAD..${remoteRef}`]) || '0', 10);
        const ahead = parseInt(gitExec(['rev-list', '--count', `${remoteRef}..HEAD`]) || '0', 10);
        if (behind > 0) parts.push(`\x1b[31m\u2193${behind} pull\x1b[0m`);
        if (ahead > 0) parts.push(`\x1b[33m\u2191${ahead} push\x1b[0m`);
      }

      // MD sync check: drift between CLAUDE.md ↔ AGENTS.md ↔ GEMINI.md
      try {
        const claudeMd = path.join(dir, 'CLAUDE.md');
        const agentsMd = path.join(dir, 'AGENTS.md');
        const geminiMd = path.join(dir, 'GEMINI.md');
        if (fs.existsSync(claudeMd) && fs.existsSync(agentsMd) && fs.existsSync(geminiMd)) {
          const SYNC_LINE_RE = /^> \*\*(?:Синхронизация|Sync):\*\*.*$/m;
          const norm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
          const cs = norm(claudeMd).replace(SYNC_LINE_RE, '');
          const as = norm(agentsMd).replace(SYNC_LINE_RE, '');
          const gs = norm(geminiMd).replace(SYNC_LINE_RE, '');
          if (cs !== as || cs !== gs) {
            parts.push('\x1b[31m\u26A0 md drift\x1b[0m');
          }
        }
      } catch (e) {}

      if (parts.length > 0) {
        gitInfo = ' ' + parts.join(' ');
      }
    } catch (e) {}

    // --- Prompt cache state ---
    // Counters come from stdin (current_usage of the latest API call).
    // TTL bucket and last-touch timestamp come from the transcript — stdin
    // exposes neither ephemeral_1h vs ephemeral_5m nor a per-message timestamp.
    let cacheSegment = '';
    try {
      const usage = data.context_window?.current_usage;
      const usageNull = usage === null || usage === undefined;
      const read = (usage && Number(usage.cache_read_input_tokens)) || 0;
      const write = (usage && Number(usage.cache_creation_input_tokens)) || 0;
      const freshInput = (usage && Number(usage.input_tokens)) || 0;

      let lastTouchTs = null;
      let lastWriteTtl = null;
      let hadCacheBefore = false;

      // Parse transcript when we need TTL/timestamp OR want to detect a /compact
      // reset (current_usage is null but earlier messages had cache activity).
      if (session && (read > 0 || write > 0 || usageNull)) {
        try {
          // Claude Code slug encoding: drive colon, separators, AND dots → '-'
          // (e.g. C:\Users\ilyap\.openclaw → C--Users-ilyap--openclaw).
          // Without the dot replacement, transcripts inside hidden dirs aren't
          // found and the cache TTL/timestamp segment silently drops.
          const slug = dir.replace(/[:\\\/.]/g, '-');
          const transcriptPath = path.join(claudeDir, 'projects', slug, `${session}.jsonl`);
          if (fs.existsSync(transcriptPath)) {
            const stat = fs.statSync(transcriptPath);
            // Read 1 extra byte before the window so the first \n distinguishes
            // a partial line from a clean line boundary.
            const desired = Math.min(stat.size, 16384);
            const startOffset = Math.max(0, stat.size - desired - 1);
            const readBytes = stat.size - startOffset;
            const buf = Buffer.alloc(readBytes);
            const fd = fs.openSync(transcriptPath, 'r');
            fs.readSync(fd, buf, 0, readBytes, startOffset);
            fs.closeSync(fd);
            let content = buf.toString('utf8');
            if (startOffset > 0) {
              const nl = content.indexOf('\n');
              if (nl >= 0) content = content.slice(nl + 1);
            }
            const lines = content.split('\n').filter(Boolean);

            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const rec = JSON.parse(lines[i]);
                const u = rec && rec.type === 'assistant' && rec.message ? rec.message.usage : null;
                if (!u || !rec.timestamp) continue;
                const r = u.cache_read_input_tokens || 0;
                const w = u.cache_creation_input_tokens || 0;
                if (r === 0 && w === 0) continue;

                hadCacheBefore = true;
                if (!lastTouchTs) {
                  const ts = new Date(rec.timestamp).getTime();
                  lastTouchTs = Number.isFinite(ts) ? ts : 0;
                }
                if (!lastWriteTtl && w > 0 && u.cache_creation) {
                  if (u.cache_creation.ephemeral_1h_input_tokens > 0) lastWriteTtl = '1h';
                  else if (u.cache_creation.ephemeral_5m_input_tokens > 0) lastWriteTtl = '5m';
                }
                if (lastTouchTs && lastWriteTtl) break;
              } catch (e) {}
            }
          }
        } catch (e) {}
      }

      if (read > 0 || write > 0) {
        const parts = ['\x1b[2mcache\x1b[0m'];

        // Hit ratio: read / (input + cache_creation + cache_read).
        // Matches the input-only formula used for used_percentage.
        // ratio === 0 means a full cache miss / invalidation — surface it loudly
        // instead of hiding the segment, since it's a costly event worth noticing.
        const denom = read + write + freshInput;
        if (denom > 0) {
          const ratio = read > 0 ? Math.round(read / denom * 100) : 0;
          let ratioColor;
          if (ratio === 0) ratioColor = '\x1b[1;31m';
          else if (ratio >= 90) ratioColor = '\x1b[1;32m';
          else if (ratio >= 75) ratioColor = '\x1b[32m';
          else if (ratio >= 50) ratioColor = '\x1b[33m';
          else ratioColor = '\x1b[38;2;255;140;0m';
          parts.push(`${ratioColor}${ratio}%\x1b[0m`);
        }

        if (read > 0) {
          parts.push(`\x1b[1;32m↓${fmt(read)}\x1b[0m`);
        }
        if (write > 0) {
          const sym = read > 0 ? '+' : '↑';
          parts.push(`\x1b[33m${sym}${fmt(write)}\x1b[0m`);
        }
        if (lastWriteTtl && lastTouchTs) {
          const ttlMs = lastWriteTtl === '5m' ? 300000 : 3600000;
          const remainingSec = (ttlMs - (Date.now() - lastTouchTs)) / 1000;
          const bucketColor = lastWriteTtl === '5m' ? '\x1b[33m' : '\x1b[2;36m';
          let suffix = `${bucketColor}${lastWriteTtl}\x1b[0m`;
          let timeStr;
          if (remainingSec <= 0) timeStr = '0m';
          else if (remainingSec < 60) timeStr = Math.ceil(remainingSec) + 's';
          else if (remainingSec < 3600) timeStr = Math.ceil(remainingSec / 60) + 'm';
          else {
            const h = Math.floor(remainingSec / 3600);
            const m = Math.floor((remainingSec % 3600) / 60);
            timeStr = h + 'h' + (m > 0 ? m + 'm' : '');
          }
          const pct = remainingSec > 0 ? (remainingSec * 1000) / ttlMs : 0;
          let countColor;
          if (pct <= 0) countColor = '\x1b[31m';
          else if (pct < 0.1) countColor = '\x1b[38;2;255;140;0m';
          else if (pct < 0.25) countColor = '\x1b[33m';
          else countColor = '\x1b[2m';
          suffix += `${countColor}:${timeStr}\x1b[0m`;
          parts.push(suffix);
        }
        cacheSegment = parts.join(' ');
      } else if (usageNull && hadCacheBefore) {
        // current_usage is null after /compact until the next API call repopulates it.
        // Show that the live cache view is reset, not just absent.
        cacheSegment = '\x1b[2mcache:\x1b[0m\x1b[33mreset\x1b[0m';
      }
    } catch (e) {}

    // --- Rate limits (subscription) ---
    const limitParts = [];
    const rl = data.rate_limits;
    if (rl) {
      const colorPct = (pct) => {
        if (pct < 50) return `\x1b[38;2;255;125;218m${pct}%\x1b[0m`;
        if (pct < 65) return `\x1b[33m${pct}%\x1b[0m`;
        if (pct < 80) return `\x1b[38;2;255;140;0m${pct}%\x1b[0m`;
        return `\x1b[31m${pct}%\x1b[0m`;
      };
      const formatReset = (resetTs, opts) => {
        if (!Number.isFinite(resetTs)) return null;
        const coarse = !!(opts && opts.coarse);
        const resetMin = Math.max(0, Math.ceil((resetTs * 1000 - Date.now()) / 60000));
        if (resetMin >= 1440) {
          const d = Math.floor(resetMin / 1440);
          const h = Math.floor((resetMin % 1440) / 60);
          if (coarse && d >= 2) return `${d}d`;
          if (d === 1 && h === 0) return '24h';
          return `${d}d${h}h`;
        }
        if (resetMin >= 60) {
          const h = Math.floor(resetMin / 60);
          const m = resetMin % 60;
          return m > 0 ? `${h}h${m}m` : `${h}h`;
        }
        return `${resetMin}m`;
      };
      const withReset = (label, bucket, opts) => {
        const rawUsedPct = bucket.used_percentage;
        const usedPct = (rawUsedPct == null || rawUsedPct === '') ? NaN : Number(rawUsedPct);
        if (!Number.isFinite(usedPct)) return null;
        const pct = Math.round(usedPct);
        const reset = formatReset(bucket.resets_at, opts);
        const main = `${label}:${colorPct(pct)}`;
        return reset ? `${main}\x1b[2m(${reset})\x1b[0m` : main;
      };
      const parts = [];
      if (rl.five_hour) {
        const p = withReset('5h', rl.five_hour);
        if (p) parts.push(p);
      }
      if (rl.seven_day) {
        const p = withReset('7d', rl.seven_day, { coarse: true });
        if (p) parts.push(p);
      }
      for (const p of parts) limitParts.push(p);
    }

    // --- Output ---
    const dirRaw = path.basename(dir);
    const dirShort = dirRaw.length > 15
      ? dirRaw.slice(0, 7) + '…' + dirRaw.slice(-7)
      : dirRaw;
    const buildDirSegment = (name) => {
      let s = `\x1b[2m${name}\x1b[0m`;
      if (branch) s += ` \x1b[36m(${branch})\x1b[0m`;
      else if (detachedSha) s += ` \x1b[31m(HEAD@${detachedSha})\x1b[0m`;
      return s;
    };
    const segments = [`\x1b[2m${model}\x1b[0m`];
    const dirIndex = segments.length;
    segments.push(buildDirSegment(dirRaw));
    if (gitInfo) segments.push(gitInfo.trim());
    if (ctx) segments.push(ctx.trim());
    if (cacheSegment) segments.push(cacheSegment);
    for (const lp of limitParts) segments.push(lp);

    // Truncate dirname only if the line crosses 100 visible columns.
    if (dirRaw !== dirShort) {
      const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
      let visible = -3; // " \u2502 " separator is 3 chars; pre-subtract one to undo over-counting.
      for (const seg of segments) visible += 3 + stripAnsi(seg).length;
      if (visible > 100) segments[dirIndex] = buildDirSegment(dirShort);
    }

    process.stdout.write(segments.join(' \u2502 '));
  } catch (e) {}
});
