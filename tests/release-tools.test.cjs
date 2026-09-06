const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const asar = require('@electron/asar');
const { validateTag } = require('../scripts/validate-tag.cjs');
const { verifyArchive, verifyWindowsInstaller, verifyInstalledRuntime } = require('../scripts/verify-artifact.cjs');
const { writeZip, pe } = require('./helpers/zip-fixtures.cjs');
const common = ['v8_context_snapshot.bin', 'snapshot_blob.bin', 'vk_swiftshader_icd.json', 'icudtl.dat', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'LICENSE', 'LICENSES.chromium.html', 'version', 'locales/en-US.pak'];
const platformFiles = {
  linux: ['career-companion', 'chrome-sandbox', 'chrome_crashpad_handler', 'libvulkan.so.1', 'libffmpeg.so', 'libvk_swiftshader.so'],
  win32: ['career-companion.exe', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'vk_swiftshader.dll', 'vulkan-1.dll'],
};
async function fixture(t, platform, extraAsar) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-artifact-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  for (const name of ['.webpack/main/index.js', '.webpack/renderer/main_window/index.js', '.webpack/renderer/main_window/index.js.LICENSE.txt', '.webpack/renderer/main_window/preload.js', '.webpack/renderer/main_window/index.html', '.webpack/renderer/0123456789abcdefabcd.css', ...(extraAsar ? [extraAsar] : [])]) {
    mkdirSync(join(source, name, '..'), { recursive: true });
    writeFileSync(join(source, name), 'synthetic build');
  }
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '0.1.0', main: '.webpack/main' }));
  const archive = join(dir, 'app.asar'); await asar.createPackage(source, archive);
  const files = [...common, ...platformFiles[platform]].map(name => ({ name, data: name.endsWith('.exe') ? pe() : 'runtime' }));
  files.push({ name: 'resources/THIRD-PARTY-LICENSES.md', data: readFileSync(join(__dirname, '../THIRD-PARTY-LICENSES.md')) });
  files.push({ name: 'resources/app.asar', data: readFileSync(archive) });
  const root = platform === 'win32' ? '' : `MSFS Career Approach Companion-${platform}-x64/`;
  const zip = join(dir, 'package.zip');
  const pack = (entries = files, separator = '/') => writeZip(zip, entries.map(e => ({ ...e, name: (root + e.name).replaceAll('/', separator) })));
  await pack(); return { dir, zip, files, pack, root };
}
test('release tags must exactly match package semantic versions', () => {
  assert.equal(validateTag('v0.1.0', '0.1.0'), false);
  assert.equal(validateTag('v1.2.3-rc.1', '1.2.3-rc.1'), true);
  assert.equal(validateTag('v1.2.3+build.4', '1.2.3+build.4'), false);
  assert.throws(() => validateTag('v1.2.3+build.4\n', '1.2.3+build.4\n'));
  for (const tag of ['v0.1.1', '0.1.0', 'v01.1.0', 'v0.1.0;echo bad', 'v0.1.0\n']) assert.throws(() => validateTag(tag, '0.1.0'));
});
for (const platform of ['linux', 'win32']) {
  test(`${platform}: accepts complete runtime and rejects missing files, wrong version/platform and debug files`, async t => {
    const f = await fixture(t, platform);
    await verifyArchive(f.zip, '0.1.0', platform);
    await assert.rejects(verifyArchive(f.zip, '0.1.1', platform), /version/i);
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform === 'linux' ? 'win32' : 'linux'), /Unexpected ZIP/);
    await f.pack(f.files.filter(e => !e.name.endsWith('THIRD-PARTY-LICENSES.md')));
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /Missing runtime asset: resources\/THIRD-PARTY-LICENSES/);
    await f.pack(f.files.map(e => e.name.endsWith('THIRD-PARTY-LICENSES.md') ? { ...e, data: 'Missing upstream license' } : e));
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /notice/i);
    await f.pack(f.files.filter(e => e.name !== 'icudtl.dat'));
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /Missing runtime asset: icudtl.dat/);
    await f.pack([...f.files, { name: 'SPIKE-debug.js' }]);
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /Unexpected ZIP/);
    await f.pack(f.files.filter(e => !e.name.startsWith('locales/')));
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /locale/i);
  });
  test(`${platform}: rejects raw evidence in ASAR and cleans inspection directories`, async t => {
    const f = await fixture(t, platform, 'evidence/raw.json');
    const before = readdirSync(tmpdir()).filter(n => n.startsWith('companion-inspect-')).sort();
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /Unexpected ASAR/);
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('companion-inspect-')).sort(), before);
  });
  test(`${platform}: rejects unsafe ZIP paths, symlinks and normalized duplicates`, async t => {
    const f = await fixture(t, platform);
    for (const name of ['/escape', 'C:/escape', '../escape', f.root + '../escape', f.root + 'resources/../../escape', '\\\\server\\share', f.root + 'x:ads', f.root + 'CON', f.root + 'x.']) {
      await writeZip(f.zip, [{ name }]);
      await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /path|absolute|relative|unsafe/i, name);
    }
    await f.pack([...f.files, { name: 'escape', data: '../../outside', mode: 0o120777 }]);
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /symlink/i);
    await writeZip(f.zip, [...f.files.map(e => ({ ...e, name: f.root + e.name })), { name: (f.root + 'resources/app.asar').replaceAll('/', '\\') }]);
    await assert.rejects(verifyArchive(f.zip, '0.1.0', platform), /duplicate/i);
  });
}
test('Windows backslash ZIP entries work and application PE must be x64', async t => {
  const f = await fixture(t, 'win32'); await f.pack(f.files, '\\');
  await verifyArchive(f.zip, '0.1.0', 'win32');
  await f.pack(f.files.map(e => e.name.endsWith('.exe') ? { ...e, data: pe(0x14c) } : e));
  await assert.rejects(verifyArchive(f.zip, '0.1.0', 'win32'), /x64/);
});
test('Squirrel payload exactly matches runtime; x86 setup bootstrapper may carry x64 app', async t => {
  const f = await fixture(t, 'win32');
  const verified = await verifyArchive(f.zip, '0.1.0', 'win32');
  const setup = join(f.dir, 'setup.exe'); writeFileSync(setup, pe(0x14c));
  const nupkg = join(f.dir, 'app.nupkg');
  const extras = [
    { name: 'lib/net45/squirrel.exe', data: pe(0x14c) },
    { name: 'lib/net45/career-companion_ExecutionStub.exe', data: pe(0x14c) },
    { name: 'msfsCareerApproachCompanion.nuspec', data: '<package><metadata><id>msfsCareerApproachCompanion</id><version>0.1.0</version></metadata></package>' },
    { name: '[Content_Types].xml' }, { name: '_rels/.rels' },
    { name: 'package/services/metadata/core-properties/0123456789abcdef0123456789abcdef.psmdcp' },
  ];
  const payload = f.files.map(e => ({ ...e, name: 'lib/net45/' + e.name }));
  const pack = entries => writeZip(nupkg, [...entries, ...extras]);
  await pack(payload); await verifyWindowsInstaller(nupkg, setup, verified, '0.1.0');
  await pack(payload.filter(e => !e.name.endsWith('THIRD-PARTY-LICENSES.md')));
  await assert.rejects(verifyWindowsInstaller(nupkg, setup, verified, '0.1.0'), /Missing.*THIRD-PARTY/);
  await pack(payload.filter(e => !e.name.endsWith('LICENSES.chromium.html')));
  await assert.rejects(verifyWindowsInstaller(nupkg, setup, verified, '0.1.0'), /Missing.*LICENSES/);
  await pack(payload.map(e => e.name.endsWith('app.asar') ? { ...e, data: 'corrupt' } : e));
  await assert.rejects(verifyWindowsInstaller(nupkg, setup, verified, '0.1.0'), /mismatch/i);
  await pack([...payload, { name: 'lib/net45/unknown.dll' }]);
  await assert.rejects(verifyWindowsInstaller(nupkg, setup, verified, '0.1.0'), /Unexpected/);
  await pack([...payload, { name: 'lib/net45/Squirrel-UpdateSelf.log', data: 'installer log' }]);
  await assert.rejects(verifyWindowsInstaller(nupkg, setup, verified, '0.1.0'), /Unexpected Squirrel payload/);
  await pack(payload); writeFileSync(setup, 'MZ only');
  await assert.rejects(verifyWindowsInstaller(nupkg, setup, verified, '0.1.0'), /PE/);
});
test('installed runtime comparison catches corruption and extra app files', async t => {
  const f = await fixture(t, 'win32');
  const verified = await verifyArchive(f.zip, '0.1.0', 'win32');
  const installed = join(f.dir, 'installed');
  for (const e of f.files) { mkdirSync(join(installed, e.name, '..'), { recursive: true }); writeFileSync(join(installed, e.name), e.data); }
  verifyInstalledRuntime(installed, verified);
  writeFileSync(join(installed, 'Squirrel-UpdateSelf.log'), 'installer self-update log');
  verifyInstalledRuntime(installed, verified);
  writeFileSync(join(installed, 'icudtl.dat'), 'bad');
  assert.throws(() => verifyInstalledRuntime(installed, verified), /mismatch/i);
  writeFileSync(join(installed, 'icudtl.dat'), 'runtime'); writeFileSync(join(installed, 'debug.json'), 'bad');
  assert.throws(() => verifyInstalledRuntime(installed, verified), /Unexpected/);
});

test('Squirrel self-update log is installed-only and must be an exact root file', async t => {
  const f = await fixture(t, 'win32');
  const verified = await verifyArchive(f.zip, '0.1.0', 'win32');
  await f.pack([...f.files, { name: 'Squirrel-UpdateSelf.log', data: 'installer log' }]);
  await assert.rejects(verifyArchive(f.zip, '0.1.0', 'win32'), /Unexpected ZIP entry/);
  const installed = join(f.dir, 'installed');
  for (const e of f.files) { mkdirSync(join(installed, e.name, '..'), { recursive: true }); writeFileSync(join(installed, e.name), e.data); }
  for (const name of ['resources/Squirrel-UpdateSelf.log', 'Squirrel-Install.log', 'Squirrel-UpdateSelf.log.exe']) {
    const path = join(installed, name); writeFileSync(path, 'unexpected');
    assert.throws(() => verifyInstalledRuntime(installed, verified), /Unexpected installed file/);
    rmSync(path);
  }
  const log = join(installed, 'Squirrel-UpdateSelf.log');
  mkdirSync(log);
  assert.throws(() => verifyInstalledRuntime(installed, verified), /Unexpected installed directory/);
  rmSync(log, { recursive: true });
  symlinkSync(join(installed, 'resources'), log, 'junction');
  assert.throws(() => verifyInstalledRuntime(installed, verified), /Installed symlink/);
  rmSync(log);
  writeFileSync(log, 'installer log');
  rmSync(join(installed, 'icudtl.dat'));
  assert.throws(() => verifyInstalledRuntime(installed, verified), /Missing installed runtime asset: icudtl.dat/);
});
