const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stageScript = path.join(root, 'scripts', 'stage-statusline.js');
const configureScript = path.join(root, 'scripts', 'configure-statusline.js');
const failures = [];

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-statusline-plugin-test-'));
}

function configure(mode, script, settingsPath) {
  const r = spawnSync(process.execPath, [configureScript, mode, script, settingsPath], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}

function check(name, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`${name}\n${e.stack || e}`);
  }
}

check('manifest, marketplace and hooks point at files that exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.strictEqual(marketplace.plugins[0].name, manifest.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);

  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  const commands = Object.values(hooks.hooks).flat().flatMap(m => m.hooks).map(h => h.command);
  assert(commands.length > 0, 'hooks.json declares no hook');
  for (const command of commands) {
    const m = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/);
    assert(m, `hook command is not rooted at CLAUDE_PLUGIN_ROOT: ${command}`);
    assert(fs.existsSync(path.join(root, m[1])), `missing ${m[1]}`);
  }

  const setup = fs.readFileSync(path.join(root, 'commands', 'setup.md'), 'utf8');
  for (const m of setup.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)) {
    assert(fs.existsSync(path.join(root, m[1])), `setup.md names missing ${m[1]}`);
  }
});

check('stage copies statusline.js and leaves an identical copy alone', () => {
  const dataDir = path.join(makeTempDir(), 'data');
  const printed = execFileSync(process.execPath, [stageScript, root, dataDir], { encoding: 'utf8' }).trim();
  const dest = path.join(dataDir, 'statusline.js');
  assert.strictEqual(printed, dest.replace(/\\/g, '/'));
  assert(fs.readFileSync(dest).equals(fs.readFileSync(path.join(root, 'statusline.js'))));

  const past = new Date(Date.now() - 60000);
  fs.utimesSync(dest, past, past);
  execFileSync(process.execPath, [stageScript, root, dataDir]);
  assert.strictEqual(fs.statSync(dest).mtimeMs, past.getTime(), 'identical copy was rewritten');

  fs.writeFileSync(dest, 'stale');
  execFileSync(process.execPath, [stageScript, root, dataDir]);
  assert(fs.readFileSync(dest).equals(fs.readFileSync(path.join(root, 'statusline.js'))), 'stale copy kept');
});

check('stage in hook mode prints nothing and never fails', () => {
  const dataDir = path.join(makeTempDir(), 'data');
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir };
  const out = execFileSync(process.execPath, [stageScript], { encoding: 'utf8', env, input: '{}' });
  assert.strictEqual(out, '');
  assert(fs.existsSync(path.join(dataDir, 'statusline.js')));

  const broken = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(dataDir, 'nowhere'), CLAUDE_PLUGIN_DATA: dataDir };
  const r = spawnSync(process.execPath, [stageScript], { encoding: 'utf8', env: broken });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

check('plan writes nothing and proposes the staged script', () => {
  const settingsPath = path.join(makeTempDir(), 'settings.json');
  const r = configure('plan', 'C:\\x\\statusline.js', settingsPath);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.out.current, null);
  assert.deepStrictEqual(r.out.proposed, { type: 'command', command: 'node "C:/x/statusline.js"', refreshInterval: 60 });
  assert.strictEqual(r.out.isAlreadySet, false);
  assert(!fs.existsSync(settingsPath), 'plan created settings.json');
});

check('apply rewrites statusLine alone and keeps the file style', () => {
  const settingsPath = path.join(makeTempDir(), 'settings.json');
  const original = [
    '{',
    '    "model": "opus",',
    '    "statusLine": {',
    '        "type": "command",',
    '        "command": "node old.js",',
    '        "refreshInterval": 5,',
    '        "padding": 0',
    '    },',
    '    "hooks": {}',
    '}',
    ''
  ].join('\r\n');
  fs.writeFileSync(settingsPath, original);

  const r = configure('apply', '/data/statusline.js', settingsPath);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.out.isChanged, true);
  assert.strictEqual(fs.readFileSync(`${settingsPath}.bak`, 'utf8'), original);

  const written = fs.readFileSync(settingsPath, 'utf8');
  assert(written.includes('\r\n    "model": "opus",\r\n'), written);
  assert(!/[^\r]\n/.test(written), 'bare LF in a CRLF file');
  const settings = JSON.parse(written);
  assert.deepStrictEqual(Object.keys(settings), ['model', 'statusLine', 'hooks']);
  assert.deepStrictEqual(settings.statusLine, {
    type: 'command', command: 'node "/data/statusline.js"', refreshInterval: 5, padding: 0
  });

  const again = configure('plan', '/data/statusline.js', settingsPath);
  assert.strictEqual(again.out.isAlreadySet, true);
  const noop = configure('apply', '/data/statusline.js', settingsPath);
  assert.strictEqual(noop.out.isChanged, false);
  assert.strictEqual(fs.readFileSync(`${settingsPath}.bak`, 'utf8'), original, 'no-op apply replaced the backup');
});

check('apply creates a missing settings file without a backup', () => {
  const settingsPath = path.join(makeTempDir(), 'nested', 'settings.json');
  const r = configure('apply', '/data/statusline.js', settingsPath);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.out.backupPath, null);
  assert.strictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.refreshInterval, 60);
});

check('invalid settings JSON is left untouched', () => {
  const settingsPath = path.join(makeTempDir(), 'settings.json');
  fs.writeFileSync(settingsPath, '{ "model": "opus", }');
  for (const mode of ['plan', 'apply']) {
    const r = configure(mode, '/data/statusline.js', settingsPath);
    assert.strictEqual(r.status, 1, `${mode} exited ${r.status}`);
    assert.match(r.stderr, /not valid JSON/);
  }
  assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{ "model": "opus", }');
  assert(!fs.existsSync(`${settingsPath}.bak`));
});

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
}
