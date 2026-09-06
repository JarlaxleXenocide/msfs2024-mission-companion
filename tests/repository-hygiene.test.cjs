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
