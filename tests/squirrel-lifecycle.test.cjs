const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { verifyLifecycle } = require('../scripts/verify-squirrel-lifecycle.cjs');

test('installer diagnostics require successful install and uninstall hooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'squirrel-test-'));
  const write = (event, close) => {
    const folder = join(root, 'msfs-career-squirrel-' + event);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'lifecycle.jsonl'), [
      { phase: 'start', event: '--squirrel-' + event },
      { stream: 'stderr', text: 'native updater output' },
      ...close,
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
  };
  try {
    assert.throws(() => verifyLifecycle(root), /install/);
    const good = [{ phase: 'close', code: 0, signal: null, error: null }];
    write('install', good);
    assert.throws(() => verifyLifecycle(root), /uninstall/);
    write('uninstall', [{ phase: 'close', code: 1, signal: null, error: null }]);
    assert.throws(() => verifyLifecycle(root), /uninstall.*failed/);
    write('uninstall', []);
    assert.throws(() => verifyLifecycle(root), /incomplete/);
    write('uninstall', [{ phase: 'close', code: null, signal: 'SIGTERM', error: null }]);
    assert.throws(() => verifyLifecycle(root), /failed/);
    write('uninstall', good);
    assert.doesNotThrow(() => verifyLifecycle(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
