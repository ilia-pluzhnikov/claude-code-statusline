const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const statusline = path.join(root, 'statusline.js');
const source = fs.readFileSync(statusline, 'utf8');

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function runStatusline(input, env = {}, execFileSyncStub = () => '') {
  let stdout = '';
  const stdin = new EventEmitter();
  stdin.setEncoding = () => {};
  const context = {
    require: (name) => {
      if (name === 'child_process') return { execFileSync: execFileSyncStub };
      return require(name);
    },
    process: {
      env: { ...process.env, ...env },
      stdin,
      stdout: { write: (s) => { stdout += s; } },
      cwd: () => root,
      exit: (code) => { throw new Error(`unexpected exit ${code}`); }
    },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    Date
  };
  vm.runInNewContext(source, context, { filename: statusline });
  stdin.emit('data', JSON.stringify(input));
  stdin.emit('end');
  return { raw: stdout, text: stripAnsi(stdout) };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-test-'));
}

function inputFor(dir, overrides = {}) {
  return {
    model: { display_name: 'Claude' },
    workspace: { current_dir: dir },
    session_id: 'test-session',
    ...overrides
  };
}

function remainingForDisplayedUsed(used) {
  return 100 - used;
}

function contextSegment(text) {
  return text.split(' │ ').find(p => /^(?:💀 )?[█▌░]{5}(?: |$)/.test(p));
}

function contextBar(segment) {
  return segment.startsWith('💀 ') ? segment.split(' ')[1] : segment.split(' ')[0];
}

function slugFor(dir) {
  return dir.replace(/[:\\\/.]/g, '-');
}

function writeTranscript(claudeDir, dir, session, records) {
  const projectDir = path.join(claudeDir, 'projects', slugFor(dir));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), records.join('\n') + '\n');
}

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`${name}\n${e.stack || e}`);
  }
}

check('model shortening', () => {
  const dir = makeTempDir();
  const cases = [
    ['Opus 4.7 (1M context)', 'Op 4.7 (1m)'],
    ['Sonnet 4.6', 'So 4.6'],
    ['Haiku 4.5', 'Ha 4.5'],
    ['Claude', 'Claude'],
    ['claude-opus-4-7', 'Op 4.7'],
    ['Opus 5.0 (200K context)  ', 'Op 5.0 (200k)'],
    ['Æther 4.7', 'Æther 4.7'],
    ['', 'Claude']
  ];

  for (const [display_name, expected] of cases) {
    const { text } = runStatusline(inputFor(dir, { model: { display_name } }));
    assert.strictEqual(text.split(' │ ')[0], expected, display_name);
  }
});

check('effort tier renders as a 2-letter code attached to the model', () => {
  const dir = makeTempDir();

  // No effort object → first segment is just the model (unsupported model / back-compat).
  const none = runStatusline(inputFor(dir, { model: { display_name: 'Opus 4.8' } }));
  assert.strictEqual(none.text.split(' │ ')[0], 'Op 4.8', `no effort: ${none.text}`);

  // Each documented level maps to its dim 2-letter code (same as the model), glued to it.
  const map = { low: 'Lo', medium: 'Md', high: 'Hi', xhigh: 'Xh', max: 'Mx' };
  for (const [level, code] of Object.entries(map)) {
    const { raw, text } = runStatusline(inputFor(dir, {
      model: { display_name: 'Opus 4.8' },
      effort: { level }
    }));
    assert.strictEqual(text.split(' │ ')[0], `Op 4.8 ${code}`, `${level}: ${text}`);
    assert(raw.includes(`\x1b[2m${code}\x1b[0m`), `${level} should be dim like the model: ${raw}`);
  }

  // Unknown future level falls back to capitalised first two chars (never vanishes).
  const future = runStatusline(inputFor(dir, {
    model: { display_name: 'Opus 4.8' },
    effort: { level: 'ultra' }
  }));
  assert.strictEqual(future.text.split(' │ ')[0], 'Op 4.8 Ul', `unknown level: ${future.text}`);

  // Object.prototype keys must not resolve through the EFFORT_CODES prototype
  // chain (e.g. 'constructor' → the Object function rendered into the line);
  // they take the generic first-two-chars fallback like any unknown level.
  const proto = runStatusline(inputFor(dir, {
    model: { display_name: 'Opus 4.8' },
    effort: { level: 'constructor' }
  }));
  assert.strictEqual(proto.text.split(' │ ')[0], 'Op 4.8 Co', `prototype key: ${proto.text}`);
});

check('context bar width and glyphs', () => {
  const dir = makeTempDir();
  for (let used = 0; used <= 100; used += 10) {
    const { text } = runStatusline(inputFor(dir, {
      context_window: { remaining_percentage: remainingForDisplayedUsed(used) }
    }));
    const segment = contextSegment(text);
    assert(segment, `missing context segment for ${used}%: ${text}`);
    const bar = contextBar(segment);
    assert.strictEqual([...bar].length, 5, `bad width for ${used}%: ${bar}`);
    assert(/^[█▌░]{5}$/.test(bar), `bad glyphs for ${used}%: ${bar}`);
    assert.strictEqual(segment.startsWith('💀 '), used >= 80, `bad skull state for ${used}%: ${text}`);
  }

  const over = runStatusline(inputFor(dir, {
    context_window: { remaining_percentage: 0 }
  })).text;
  assert(contextSegment(over).startsWith('💀 █████'), over);
});

check('context bar null/empty/zero handling', () => {
  const dir = makeTempDir();
  for (const remaining_percentage of [null, '', 'abc']) {
    const { text } = runStatusline(inputFor(dir, {
      context_window: { remaining_percentage }
    }));
    assert(!contextSegment(text), `context bar should be hidden for ${String(remaining_percentage)}: ${text}`);
  }

  const full = runStatusline(inputFor(dir, {
    context_window: { remaining_percentage: 0 }
  })).text;
  assert(contextSegment(full).startsWith('💀 █████'), full);
});

check('context bar shows absolute token counts when available', () => {
  const dir = makeTempDir();
  const { text } = runStatusline(inputFor(dir, {
    context_window: {
      remaining_percentage: 60,
      total_input_tokens: 480000,
      context_window_size: 1000000
    }
  }));
  const segment = contextSegment(text);
  assert(segment, text);
  assert(segment.includes('480k/1M'), segment);
});

check('context bar bumps pink → yellow at 250k absolute tokens', () => {
  const dir = makeTempDir();
  // 250k/1M = 25% used → would be pink by the percentage scale,
  // but absolute 250k is an "already too much" cliff regardless of window size.
  const { raw } = runStatusline(inputFor(dir, {
    context_window: {
      remaining_percentage: 75,
      total_input_tokens: 250000,
      context_window_size: 1000000
    }
  }));
  assert(raw.includes('\x1b[33m'), `expected yellow at 250k abs, got: ${raw}`);
  assert(!raw.includes('\x1b[38;2;255;125;218m'), `pink must not appear, got: ${raw}`);

  // Below threshold stays pink.
  const { raw: rawLow } = runStatusline(inputFor(dir, {
    context_window: {
      remaining_percentage: 75,
      total_input_tokens: 249999,
      context_window_size: 1000000
    }
  }));
  assert(rawLow.includes('\x1b[38;2;255;125;218m'), `expected pink at 249999, got: ${rawLow}`);
});

check('context bar prefers absolute tokens over remaining_percentage', () => {
  const dir = makeTempDir();
  // 800k/1M = 80% used → red + skull, regardless of what remaining_percentage says
  const { text } = runStatusline(inputFor(dir, {
    context_window: {
      remaining_percentage: 90,  // would render as ~10% used (pink, empty bar)
      total_input_tokens: 800000,
      context_window_size: 1000000
    }
  }));
  const segment = contextSegment(text);
  assert(segment, text);
  assert(segment.startsWith('💀 '), `expected skull at 80% real used, got: ${segment}`);
  assert(contextBar(segment) === '████░', `expected 4 full cells, got: ${contextBar(segment)}`);
});

check('dirname middle ellipsis triggers only when line >100 cols', () => {
  const parent = makeTempDir();
  const exact15 = path.join(parent, '123456789012345');
  const exact16 = path.join(parent, '1234567890123456');
  const huge = path.join(parent, '0123456789'.repeat(12)); // 120 chars, alone breaks 100
  fs.mkdirSync(exact15);
  fs.mkdirSync(exact16);
  fs.mkdirSync(huge);

  // Short line → no truncation regardless of dirname length.
  const t15 = runStatusline(inputFor(exact15)).text;
  assert(t15.includes('123456789012345'), `len-15: full kept, got ${t15}`);
  assert(!t15.includes('…'), `len-15: no ellipsis expected, got ${t15}`);

  const t16 = runStatusline(inputFor(exact16)).text;
  assert(t16.includes('1234567890123456'), `len-16 short line: full kept, got ${t16}`);
  assert(!t16.includes('…'), `len-16 short line: no ellipsis, got ${t16}`);

  // Dotfile-style name should pass through.
  assert(runStatusline(inputFor(path.join(parent, '.claude'))).text.includes('.claude'));

  // Long line → middle ellipsis kicks in.
  const big = runStatusline(inputFor(huge)).text;
  assert(big.includes('0123456…3456789'), `huge dirname: ellipsis expected, got ${big}`);
  assert(!big.includes('0123456789012345'), `huge dirname: full must NOT appear, got ${big}`);
});

check('git segment buckets porcelain codes, branch, and ahead push', () => {
  const dir = makeTempDir();
  const git = (file, args) => {
    assert.strictEqual(file, 'git');
    const key = args.join(' ');
    const responses = {
      'status --porcelain': ' M foo.js\n?? bar.js',
      'branch --show-current': 'main',
      'rev-list --count HEAD..refs/remotes/origin/main': '0',
      'rev-list --count refs/remotes/origin/main..HEAD': '2'
    };
    return responses[key] || '';
  };

  const { text } = runStatusline(inputFor(dir), {}, git);
  assert(text.includes(`${path.basename(dir)} (main)`), text);
  assert(text.includes('1M 1?'), text);
  assert(text.includes('↑2 push'), text);
  assert(!text.includes('pull'), text);
  assert(!text.includes('dirty'), text);
});

check('git segment buckets all VS Code-style status codes', () => {
  const dir = makeTempDir();
  const cases = [
    // [porcelain, expected substring, description]
    [' M a.js',                    '1M',          'modified in WT'],
    ['M  a.js',                    '1M',          'modified staged'],
    ['MM a.js',                    '1M',          'modified twice'],
    ['A  a.js',                    '1A',          'added staged'],
    ['AM a.js',                    '1A',          'added then modified'],
    [' D a.js',                    '1D',          'deleted in WT'],
    ['D  a.js',                    '1D',          'deleted staged'],
    ['MD a.js',                    '1D',          'staged then deleted'],
    ['R  a.js -> b.js',            '1R',          'renamed'],
    ['?? note.txt',                '1?',          'untracked'],
    ['UU conflict.js',             '1!',          'merge conflict'],
    ['DD a.js',                    '1!',          'both deleted (unmerged)'],
    ['AA a.js',                    '1!',          'both added (unmerged)'],
    [' M a.js\n M b.js\n?? c.txt', '2M 1?',       'mixed'],
    [' M a.js\n D b.js\n?? c.txt', '1M 1D 1?',    'M+D+?'],
    [' M a.js\nUU b.js',           '1M',          'M present in dim'],
  ];

  for (const [porcelain, expected, desc] of cases) {
    const git = (file, args) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') return porcelain;
      if (key === 'branch --show-current') return 'main';
      return '';
    };
    const { text } = runStatusline(inputFor(dir), {}, git);
    assert(text.includes(expected), `${desc}: expected "${expected}" in: ${text}`);
  }

  // Conflict marker is rendered separately and stays visible
  const conflictGit = (file, args) => {
    const key = args.join(' ');
    if (key === 'status --porcelain') return ' M a.js\nUU b.js';
    if (key === 'branch --show-current') return 'main';
    return '';
  };
  const { text } = runStatusline(inputFor(dir), {}, conflictGit);
  assert(text.includes('1!'), `conflict marker missing: ${text}`);
});

check('git segment shows detached HEAD short sha', () => {
  const dir = makeTempDir();
  const git = (file, args) => {
    assert.strictEqual(file, 'git');
    const key = args.join(' ');
    const responses = {
      'status --porcelain': '',
      'branch --show-current': '',
      'rev-parse --short HEAD': 'deadbee'
    };
    return responses[key] || '';
  };

  const { text } = runStatusline(inputFor(dir), {}, git);
  assert(text.includes(`${path.basename(dir)} (HEAD@deadbee)`), text);
});

check('rate limits show 5h and 7d countdowns with coarse 7d', () => {
  const dir = makeTempDir();
  const now = Math.floor(Date.now() / 1000);

  // 5h shows precise h+m; 7d ≥2d is coarse (days only).
  const t1 = runStatusline(inputFor(dir, {
    rate_limits: {
      five_hour: { used_percentage: 35, resets_at: now + 8100 },     // 2h15m
      seven_day: { used_percentage: 42, resets_at: now + 388800 }    // 4d12h → "4d"
    }
  })).text;
  assert(t1.includes('5h:35%(2h15m)'), t1);
  assert(t1.includes('7d:42%(4d)'), t1);
  assert(!t1.includes('4d12h'), `7d must drop hours when ≥2d, got: ${t1}`);

  // 7d with <2d remaining keeps hours.
  const t2 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 88, resets_at: now + 169200 }    // 1d23h → "1d23h"
    }
  })).text;
  assert(t2.includes('7d:88%(1d23h)'), t2);

  // Exactly 2d → still coarse.
  const t3 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 50, resets_at: now + 172800 }    // 2d → "2d"
    }
  })).text;
  assert(t3.includes('7d:50%(2d)'), t3);

  // Exactly 1d → "24h", never bare "1d".
  const t4 = runStatusline(inputFor(dir, {
    rate_limits: {
      seven_day: { used_percentage: 90, resets_at: now + 86400 }     // 1d → "24h"
    }
  })).text;
  assert(t4.includes('7d:90%(24h)'), t4);
  assert(!/\(1d\)/.test(t4), `must not render bare "1d", got: ${t4}`);

  // No reset_at → no countdown; 7d still shows pct.
  const minimal = runStatusline(inputFor(dir, {
    rate_limits: { seven_day: { used_percentage: 99 } }
  })).text;
  assert(/7d:99%(?!\()/.test(minimal), minimal);
});

check('cache TTL and JSONL parsing', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const session = 'cache-session';
  const now = Date.now();

  writeTranscript(claude, dir, session, [
    '{bad json',
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - 6 * 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10 } } } })
  ]);

  let out = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: {
      current_usage: {
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
        input_tokens: 0
      }
    }
  }), { CLAUDE_CONFIG_DIR: claude }).text;
  assert(out.includes('cache 99% ↓1k +10 5m:0m'), out);

  writeTranscript(claude, dir, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - 61 * 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 2000, cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 20 } } } })
  ]);

  out = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: {
      current_usage: {
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 20,
        input_tokens: 0
      }
    }
  }), { CLAUDE_CONFIG_DIR: claude }).text;
  assert(out.includes('cache 99% ↓2k +20 1h:0m'), out);
});

check('cache miss renders bold red zero-percent hit ratio', () => {
  const dir = makeTempDir();
  const { raw, text } = runStatusline(inputFor(dir, {
    context_window: {
      current_usage: {
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 75000,
        input_tokens: 5000
      }
    }
  }));
  assert(raw.includes('\x1b[1;31m0%\x1b[0m'), raw);
  assert(text.includes('cache 0% ↑75k'), text);
});

check('cache reset renders after compact when current_usage is null', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const session = 'compact-session';
  writeTranscript(claude, dir, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } })
  ]);

  const { text } = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: { current_usage: null }
  }), { CLAUDE_CONFIG_DIR: claude });
  assert(text.includes('cache:reset'), text);
});

check('malformed session_id is rejected before being used in paths', () => {
  const dir = makeTempDir();
  const claude = makeTempDir();
  const slugDir = path.join(claude, 'projects', slugFor(dir));
  fs.mkdirSync(slugDir, { recursive: true });

  // Plant a transcript at the path that '../valid' would resolve to when
  // joined under the project slug dir. Unguarded code would read this file
  // and render the TTL countdown; the validation should keep it untouched.
  const traversedPath = path.join(claude, 'projects', 'valid.jsonl');
  fs.writeFileSync(traversedPath, JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } }
  }) + '\n');

  const { text } = runStatusline(inputFor(dir, {
    session_id: '../valid',
    context_window: {
      current_usage: {
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
        input_tokens: 0
      }
    }
  }), { CLAUDE_CONFIG_DIR: claude });

  // Cache counters from stdin still render (they don't need a session_id),
  // but the TTL bucket/countdown — which comes from the transcript — must not.
  assert(text.includes('cache 99% ↓1k +10'), text);
  assert(!/\b(?:1h|5m):/.test(text), 'transcript at traversed path must not be read: ' + text);
});

check('transcript slug encoding replaces dots in directory paths', () => {
  const parent = makeTempDir();
  const dir = path.join(parent, 'dotted.proj');
  fs.mkdirSync(dir);
  const claude = makeTempDir();
  const session = 'dotted-session';
  writeTranscript(claude, dir, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } } })
  ]);

  const { text } = runStatusline(inputFor(dir, {
    session_id: session,
    context_window: {
      current_usage: {
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
        input_tokens: 0
      }
    }
  }), { CLAUDE_CONFIG_DIR: claude });
  assert(text.includes('cache 99% ↓1k +10 1h:'), text);
});

check('launch-dir breadcrumb appears only when project_dir differs from current_dir', () => {
  const parent = makeTempDir();
  const launch = path.join(parent, 'rootproj');
  const current = path.join(parent, 'subproj');
  fs.mkdirSync(launch);
  fs.mkdirSync(current);
  const base = (project_dir) => ({
    model: { display_name: 'Claude' },
    session_id: 'test-session',
    workspace: { current_dir: current, project_dir }
  });

  // Differs → "rootproj ▸ subproj" breadcrumb.
  const first = runStatusline(base(launch));
  assert(first.text.includes('rootproj ▸ subproj'), `breadcrumb expected: ${first.text}`);
  // Crumb and dir name share one dim span — no reset/re-open seam inside the segment.
  assert(first.raw.includes('\x1b[2mrootproj ▸ subproj\x1b[0m'), `single dim span: ${JSON.stringify(first.raw)}`);

  // Branch still binds to the current dir, not the launch root.
  const git = (file, args) => args.join(' ') === 'branch --show-current' ? 'feat' : '';
  const withBranch = runStatusline(base(launch), {}, git).text;
  assert(withBranch.includes('rootproj ▸ subproj (feat)'), `branch on current dir: ${withBranch}`);

  // Equal dirs → no breadcrumb, no triangle.
  const same = runStatusline(base(current)).text;
  assert(same.includes('subproj'), same);
  assert(!same.includes('▸'), `no breadcrumb when equal: ${same}`);

  // project_dir absent → no breadcrumb (back-compat with older Claude Code).
  const absent = runStatusline(inputFor(current)).text;
  assert(!absent.includes('▸'), `no breadcrumb when project_dir absent: ${absent}`);
});

check('launch-dir basename stays full on short lines (no eager ellipsis)', () => {
  const parent = makeTempDir();
  const launch = path.join(parent, '0123456789'.repeat(3)); // 30 chars
  const current = path.join(parent, 'work');
  fs.mkdirSync(launch);
  fs.mkdirSync(current);

  const { text } = runStatusline({
    model: { display_name: 'Claude' },
    session_id: 'test-session',
    workspace: { current_dir: current, project_dir: launch }
  });
  assert(text.includes(`${'0123456789'.repeat(3)} ▸ work`), `full launch name on a short line: ${text}`);
});

check('breadcrumb participates in the 100-column budget: full → shortened → dropped', () => {
  const parent = makeTempDir();
  const launch = path.join(parent, '0123456789'.repeat(3)); // 30 chars
  const current = path.join(parent, 'work'); // ≤15 chars: the old dirRaw!==dirShort gate never fired
  fs.mkdirSync(launch);
  fs.mkdirSync(current);
  const at = (modelLen) => runStatusline({
    model: { display_name: 'M'.repeat(modelLen) }, // unrecognised → rendered as-is
    session_id: 'test-session',
    workspace: { current_dir: current, project_dir: launch }
  }).text;

  // model(50) + crumb(30+3) + dir(4) + separators = 90 visible cols → fits, full crumb.
  const fits = at(50);
  assert(fits.includes('012345678901234567890123456789 ▸ work'), `fits, full crumb: ${fits}`);

  // model(70) → 110 cols with the full crumb: launch name is shortened (→ 95).
  const mid = at(70);
  assert(mid.includes('0123456…3456789 ▸ work'), `shortened crumb: ${mid}`);

  // model(90) → over budget even shortened (115): the crumb is dropped, dir stays.
  const wide = at(90);
  assert(!wide.includes('▸'), `crumb dropped: ${wide}`);
  assert(wide.includes('work'), `dir name kept: ${wide}`);
});

check('no breadcrumb when project_dir is the same dir in a different spelling', () => {
  const current = makeTempDir();
  const { text } = runStatusline({
    model: { display_name: 'Claude' },
    session_id: 'test-session',
    workspace: { current_dir: current, project_dir: current + path.sep }
  });
  assert(!text.includes('▸'), `trailing separator must not fake a move: ${text}`);
});

check('cache TTL reads transcript_path from stdin, ignoring the current_dir slug', () => {
  const current = makeTempDir(); // current_dir — no transcript lives under its slug
  const claude = makeTempDir();
  const session = 'tp-session';
  // Plant the transcript at an arbitrary path and hand it to the script via
  // stdin. If the script still rebuilt a slug from current_dir it would miss it.
  const tpath = path.join(claude, 'elsewhere', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } }
  }) + '\n');

  const { text } = runStatusline(inputFor(current, {
    session_id: session,
    transcript_path: tpath,
    context_window: {
      current_usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, input_tokens: 0 }
    }
  }), { CLAUDE_CONFIG_DIR: claude });
  assert(text.includes('cache 99% ↓1k +10 1h:'), text);
});

check('cache TTL falls back to project_dir slug (not current_dir) when transcript_path absent', () => {
  const parent = makeTempDir();
  const launch = path.join(parent, 'launchdir'); // project_dir — transcript anchored here
  const current = path.join(parent, 'workdir');  // current_dir — moved here, nothing under its slug
  fs.mkdirSync(launch);
  fs.mkdirSync(current);
  const claude = makeTempDir();
  const session = 'fallback-session';
  writeTranscript(claude, launch, session, [
    JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 60 * 1000).toISOString(), message: { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } } } })
  ]);

  const { text } = runStatusline({
    model: { display_name: 'Claude' },
    session_id: session,
    workspace: { current_dir: current, project_dir: launch },
    context_window: {
      current_usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, input_tokens: 0 }
    }
  }, { CLAUDE_CONFIG_DIR: claude });
  assert(text.includes('cache 99% ↓1k +10 1h:'), text);
});

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
}
