const assert = require('node:assert/strict');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

test('test discovery returns sorted explicit compiled and source test filenames', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-test-launcher-'));
  try {
    mkdirSync(join(root, '.test-build/tests'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    for (const file of ['z.test.js', 'ignored.js', 'a.test.js']) writeFileSync(join(root, '.test-build/tests', file), '');
    for (const file of ['z.test.cjs', 'ignored.cjs', 'a.test.cjs']) writeFileSync(join(root, 'tests', file), '');

    const { discoverTestFiles } = require('../scripts/run-tests.cjs');
    assert.deepEqual(discoverTestFiles(root), [
      join(root, '.test-build/tests/a.test.js'),
      join(root, '.test-build/tests/z.test.js'),
      join(root, 'tests/a.test.cjs'),
      join(root, 'tests/z.test.cjs'),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launcher propagates the child test runner failure status', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-test-launcher-process-'));
  try {
    mkdirSync(join(root, '.test-build/tests'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    const launcher = join(root, 'run-tests.cjs');
    copyFileSync(join(__dirname, '../scripts/run-tests.cjs'), launcher);
    const fixture = join(root, 'tests/failure.test.cjs');
    writeFileSync(fixture, "require('node:test')('intentional launcher fixture failure', () => { throw new Error('launcher-fixture-failed'); });\n");
    // A nested Node test runner must not inherit the outer runner's child context.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const options = { cwd: root, encoding: 'utf8', env, timeout: 15_000 };
    const child = spawnSync(process.execPath, ['--test', fixture], options);
    assert.ifError(child.error);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    const result = spawnSync(process.execPath, [launcher], options);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.match(result.stdout + result.stderr, /launcher-fixture-failed/);
    assert.equal(result.status, child.status, result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
