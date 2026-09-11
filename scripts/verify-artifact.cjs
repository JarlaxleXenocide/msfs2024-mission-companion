const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, mkdirSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, basename, relative } = require('node:path');
const asar = require('@electron/asar');
const { withArchive } = require('./archive-tools.cjs');
const common = ['v8_context_snapshot.bin', 'snapshot_blob.bin', 'vk_swiftshader_icd.json', 'icudtl.dat', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'LICENSE', 'LICENSES.chromium.html', 'version', 'resources/app.asar', 'resources/THIRD-PARTY-LICENSES.md'];
const runtime = {
  linux: new Set([...common, 'career-companion', 'chrome-sandbox', 'chrome_crashpad_handler', 'libvulkan.so.1', 'libffmpeg.so', 'libvk_swiftshader.so']),
  // Electron 44.2.0 win32 x64 output. New runtime DLLs require explicit review.
  win32: new Set([...common, 'career-companion.exe', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'vk_swiftshader.dll', 'vulkan-1.dll']),
};
const built = new Set([
  '/.webpack', '/.webpack/main', '/.webpack/main/index.js', '/.webpack/renderer',
  '/.webpack/renderer/main_window', '/.webpack/renderer/main_window/index.html',
  '/.webpack/renderer/main_window/index.js', '/.webpack/renderer/main_window/index.js.LICENSE.txt', '/.webpack/renderer/main_window/preload.js',
  '/node_modules', '/package.json',
]);
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
function verifyPe(bytes, requireX64 = false) {
  assert(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'Invalid Windows PE header');
  const offset = bytes.readUInt32LE(60);
  assert(offset >= 64 && offset + 24 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0', 'Invalid Windows PE signature');
  const machine = bytes.readUInt16LE(offset + 4);
  const sections = bytes.readUInt16LE(offset + 6);
  const optionalSize = bytes.readUInt16LE(offset + 20);
  assert(sections > 0 && optionalSize >= 96 && offset + 24 + optionalSize + sections * 40 <= bytes.length, 'Truncated Windows PE structure');
  const magic = bytes.readUInt16LE(offset + 24);
  assert((machine === 0x8664 && magic === 0x20b) || (machine === 0x14c && magic === 0x10b), 'Unsupported Windows PE architecture');
  assert(bytes.readUInt16LE(offset + 22) & 2, 'PE is not executable');
  if (requireX64) assert.equal(machine, 0x8664, 'Windows runtime must target x64');
}
function verifyAsar(bytes, version) {
  const temp = mkdtempSync(join(tmpdir(), 'companion-inspect-'));
  try {
    const archive = join(temp, 'app.asar'); writeFileSync(archive, bytes);
    const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
    assert.equal(new Set(files).size, files.length, 'Duplicate ASAR entries');
    for (const name of files) {
      assert(built.has(name) || /^\/\.webpack\/renderer\/[a-f0-9]+\.css$/.test(name), `Unexpected ASAR entry: ${name}`);
      const stat = asar.statFile(archive, join(...name.slice(1).split('/')), false);
      assert(!stat.link && !stat.unpacked, `External ASAR entry: ${name}`);
    }
    for (const name of [...built].filter(name => /\.(js|html|json|txt)$/.test(name))) assert(files.includes(name), `Missing built asset: ${name}`);
    assert(files.some(name => name.endsWith('.css')), 'Missing built stylesheet');
    const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
    assert.equal(metadata.version, version, 'Packaged version must match source');
    assert.equal(metadata.main, '.webpack/main');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
async function verifyArchive(zip, version, platform = 'linux') {
  assert(runtime[platform], `Unsupported platform: ${platform}`);
  const root = platform === 'win32' ? '' : `career-companion-${platform}-x64/`;
  return withArchive(zip, async (entries, read) => {
    for (const entry of entries.keys()) {
      const name = entry.slice(root.length);
      assert(entry.startsWith(root) && (['', 'resources/', 'locales/'].includes(name) || runtime[platform].has(name) || /^locales\/[a-z]{2,3}(?:-[A-Za-z0-9]+)?\.pak$/.test(name)), `Unexpected ZIP entry: ${entry}`);
      assert(!entry.endsWith('/') || entries.get(entry).uncompressedSize === 0, `Nonempty ZIP directory: ${entry}`);
    }
    for (const name of runtime[platform]) assert(entries.has(root + name), `Missing runtime asset: ${name}`);
    assert(entries.has(root + 'locales/en-US.pak'), 'Missing runtime locale: en-US.pak');
    const files = new Map();
    for (const name of entries.keys()) {
      if (name.endsWith('/')) continue;
      const bytes = await read(name); const local = name.slice(root.length);
      assert(bytes.length > 0, `Empty runtime asset: ${local}`);
      if (local === 'resources/THIRD-PARTY-LICENSES.md') {
        assert.equal(bytes.toString(), readFileSync(join(__dirname, '../THIRD-PARTY-LICENSES.md'), 'utf8'), 'Packaged third-party notice must match source');
        assert(bytes.toString().replaceAll('\r\n', '\n').includes(readFileSync(require.resolve('leaflet/LICENSE'), 'utf8').replaceAll('\r\n', '\n').trim()), 'Missing upstream Leaflet notice');
      }
      if (local === 'resources/app.asar') verifyAsar(bytes, version);
      if (platform === 'win32' && local === 'career-companion.exe') verifyPe(bytes, true);
      files.set(local, hash(bytes));
    }
    return { platform, version, files };
  });
}
const supportFiles = new Set(['squirrel.exe', 'career-companion_ExecutionStub.exe']);
const nugetFiles = new Set(['msfsCareerApproachCompanion.nuspec', '[Content_Types].xml', '_rels/.rels']);
const nugetDirs = new Set(['lib/', 'lib/net45/', '_rels/', 'package/', 'package/services/', 'package/services/metadata/', 'package/services/metadata/core-properties/']);
async function verifyWindowsInstaller(nupkg, setup, verified, version) {
  assert.equal(verified.platform, 'win32'); assert.equal(verified.version, version);
  // Squirrel's bootstrapper is x86; architecture proof comes from the verified payload.
  verifyPe(readFileSync(setup));
  return withArchive(nupkg, async (entries, read) => {
    const found = new Set(); let properties = 0;
    for (const name of entries.keys()) {
      if (name.startsWith('lib/net45/')) {
        const local = name.slice('lib/net45/'.length);
        if (['', 'resources/', 'locales/'].includes(local)) continue;
        assert(verified.files.has(local) || supportFiles.has(local), `Unexpected Squirrel payload: ${name}`);
        const bytes = await read(name);
        if (supportFiles.has(local)) verifyPe(bytes);
        else assert.equal(hash(bytes), verified.files.get(local), `Squirrel runtime mismatch: ${local}`);
        found.add(local);
      } else {
        const property = /^package\/services\/metadata\/core-properties\/[a-f0-9]{32}\.psmdcp$/.test(name);
        assert(nugetFiles.has(name) || nugetDirs.has(name) || property, `Unexpected NuGet entry: ${name}`);
        if (property) properties++;
      }
    }
    for (const name of [...verified.files.keys(), ...supportFiles]) assert(found.has(name), `Missing Squirrel runtime asset: ${name}`);
    for (const name of nugetFiles) assert(entries.has(name), `Missing NuGet metadata: ${name}`);
    assert.equal(properties, 1, 'Expected one NuGet core properties file');
    const spec = (await read('msfsCareerApproachCompanion.nuspec')).toString();
    const { convertVersion } = require('electron-winstaller');
    assert.equal(spec.match(/<id>([^<]+)<\/id>/)?.[1], 'msfsCareerApproachCompanion', 'NuGet package identity mismatch');
    assert.equal(spec.match(/<version>([^<]+)<\/version>/)?.[1], convertVersion(version), 'NuGet package version mismatch');
  });
}
function verifyInstalledRuntime(directory, verified) {
  assert.equal(verified.platform, 'win32'); const found = new Set();
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry); const stat = lstatSync(path); const name = relative(directory, path).replaceAll('\\', '/');
      assert(!stat.isSymbolicLink(), `Installed symlink: ${name}`);
      if (stat.isDirectory()) { assert(['locales', 'resources'].includes(name), `Unexpected installed directory: ${name}`); walk(path); }
      else {
        // Squirrel's --updateSelf writes this log beside the installed Squirrel.exe.
        // It is generated during installation, never part of the ZIP/NuGet payload.
        const selfUpdateLog = name === 'Squirrel-UpdateSelf.log' && stat.isFile();
        assert(verified.files.has(name) || supportFiles.has(name) || selfUpdateLog, `Unexpected installed file: ${name}`);
        if (verified.files.has(name)) assert.equal(hash(readFileSync(path)), verified.files.get(name), `Installed runtime mismatch: ${name}`);
        else if (supportFiles.has(name)) verifyPe(readFileSync(path));
        found.add(name);
      }
    }
  }
  walk(directory);
  for (const name of verified.files.keys()) assert(found.has(name), `Missing installed runtime asset: ${name}`);
}
async function main() {
  const options = {};
  for (const arg of process.argv.slice(2)) { const match = /^--(platform|arch|installed-dir)=(.+)$/.exec(arg); assert(match, `Unknown argument: ${arg}`); assert(!options[match[1]], `Duplicate argument: ${arg}`); options[match[1]] = match[2]; }
  const platform = options.platform || 'linux'; assert(runtime[platform], 'Unsupported platform'); assert.equal(options.arch || 'x64', 'x64', 'Only x64 artifacts are supported');
  const directory = `out/make/zip/${platform}/x64`; const version = require('../package.json').version;
  const name = `career-companion-${platform}-x64-${version}.zip`;
  assert.deepEqual(readdirSync(directory).filter(file => file.endsWith('.zip')), [name], `Expected one ${platform} x64 ZIP`);
  const zip = join(directory, name); const verified = await verifyArchive(zip, version, platform);
  if (options['installed-dir']) { verifyInstalledRuntime(options['installed-dir'], verified); console.log('Installed Windows runtime matches verified ZIP'); return; }
  const manifest = [[platform === 'win32' ? 'msfs2024-mission-companion-windows-x64.zip' : name, zip]];
  if (platform === 'win32') {
    const dir = 'out/make/squirrel.windows/x64';
    const { convertVersion } = require('electron-winstaller');
    const packageName = `msfsCareerApproachCompanion-${convertVersion(version)}-full.nupkg`;
    const setupName = 'msfs2024-mission-companion-windows-x64-setup.exe';
    assert.deepEqual(readdirSync(dir).sort(), [packageName, setupName, 'RELEASES'].sort(), 'Expected exact Squirrel release files');
    await verifyWindowsInstaller(join(dir, packageName), join(dir, setupName), verified, version);
    const packageBytes = readFileSync(join(dir, packageName));
    const releases = readFileSync(join(dir, 'RELEASES'), 'utf8').trim().split(/\s+/);
    assert.deepEqual(releases, [hash(packageBytes, 'sha1').toUpperCase(), packageName, String(packageBytes.length)], 'Squirrel RELEASES must identify the verified package');
    for (const file of [setupName, packageName, 'RELEASES']) manifest.push([file, join(dir, file)]);
  }
  const delivery = platform === 'win32' ? 'out/verified/windows-x64' : directory;
  if (platform === 'win32') {
    mkdirSync(delivery, { recursive: true });
    const allowed = new Set([...manifest.map(([name]) => name), 'SHA256SUMS']);
    assert(readdirSync(delivery).every(name => allowed.has(name)), 'Unexpected stale Windows delivery file');
    for (const [name, path] of manifest) copyFileSync(path, join(delivery, name));
  }
  writeFileSync(join(delivery, 'SHA256SUMS'), manifest.map(([name, path]) => `${hash(readFileSync(path))}  ${name}\n`).join(''));
  console.log(`Verified ${platform} runtime/ASAR${platform === 'win32' ? ', Squirrel payload and setup PE' : ''}; wrote final-byte SHA256SUMS`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyArchive, verifyWindowsInstaller, verifyInstalledRuntime };
