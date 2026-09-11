const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

test('tracked files respect repository gitignore rules', () => {
  const result = spawnSync('git', ['ls-files', '-ci', '--exclude-per-directory=.gitignore'], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', `Ignored files are tracked:\n${result.stdout}`);
});

test('agent instructions and local diagnostics are ignored at every directory depth', () => {
  const paths = ['AGENTS.md', 'agents.md', 'src/AGENTS.md', 'notes/Agents.md', 'AGENTS.override.md', 'CLAUDE.md', '.codex/session.json', 'nested/.superpowers/plan.md', 'diagnostics/run.json', 'nested/evidence/probe.json', 'debug.log'];
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8', input: paths.join('\n') + '\n',
  });
  assert.ifError(result.error);
  assert.deepEqual(result.stdout.trim().split('\n'), paths);
});

test('source archives exclude agent and diagnostic paths but retain product documentation', () => {
  const paths = ['AGENTS.md', 'nested/agents.md', 'nested/.superpowers', 'diagnostics', 'nested/evidence', 'debug.log', 'README.md', 'THIRD-PARTY-LICENSES.md'];
  const result = spawnSync('git', ['check-attr', '--stdin', 'export-ignore'], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8', input: paths.join('\n') + '\n',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => line.split(': ').at(-1)),
    ['set', 'set', 'set', 'set', 'set', 'set', 'unspecified', 'unspecified']);
});
