const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

test('installer smoke retains the first failure and captures leftovers before cleanup', { skip: process.platform !== 'win32' }, () => {
  const script = resolve('tests/fixtures/installer-smoke-failures.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('installer smoke only accepts verified nonlaunchable Squirrel residue', { skip: process.platform !== 'win32' }, () => {
  const script = resolve('tests/fixtures/installer-smoke-residue.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
