const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { writeZip } = require('./helpers/zip-fixtures.cjs');
const packagerRequire = createRequire(require.resolve('@electron/packager'));
const imported = packagerRequire('extract-zip');
const extract = imported.default ?? imported;
test('packager rejects a ZIP symlink escaping the extraction directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-zip-security-'));
  try {
    await writeZip(join(dir, 'attack.zip'), [{ name: 'escape', data: '../../outside', mode: 0o120777 }]);
    await assert.rejects(extract(join(dir, 'attack.zip'), { dir: join(dir, 'output') }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('Leaflet is pinned and its upstream notice is retained for packaging', () => {
  const metadata = require('../package.json');
  const leaflet = require('leaflet/package.json');
  assert.equal(metadata.dependencies.leaflet, '1.9.4');
  assert.equal(leaflet.version, metadata.dependencies.leaflet);
  const notice = readFileSync(join(__dirname, '../THIRD-PARTY-LICENSES.md'), 'utf8').replaceAll('\r\n', '\n');
  assert.ok(notice.includes(readFileSync(require.resolve('leaflet/LICENSE'), 'utf8').replaceAll('\r\n', '\n').trim()));
  assert.match(notice, /Leaflet 1\.9\.4/);
});
