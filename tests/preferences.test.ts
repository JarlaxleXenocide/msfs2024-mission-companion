import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, chmod, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPreferences } from '../src/shared/validate';
import { readPreferences, writePreferences } from '../src/main/preferences';
import { restoreBounds, desktopCapabilities, withWindowBounds, applyWindowPreferences } from '../src/main/window';

async function temporary(run: (path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'companion-preferences-'));
  try { await run(join(dir, 'preferences.json'), dir); }
  finally { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
}

test('missing preferences use detached defaults without a warning', async () => temporary(async path => {
  const warnings: string[] = [];
  const value = await readPreferences(path, message => warnings.push(message));
  assert.deepEqual(value, defaultPreferences);
  value.criteria.categories.length = 0;
  assert.deepEqual(defaultPreferences.criteria.categories, ['ILS']);
  assert.deepEqual(warnings, []);
}));

test('corrupt JSON and invalid/unknown fields recover with a visible warning', async () => temporary(async path => {
  for (const content of ['{', JSON.stringify({ ...defaultPreferences, port: 0 }), JSON.stringify({ ...defaultPreferences, host: 'remote.invalid' })]) {
    await writeFile(path, content);
    const warnings: string[] = [];
    assert.deepEqual(await readPreferences(path, message => warnings.push(message)), defaultPreferences);
    assert.match(warnings[0], /preferences.*default/i);
    assert.equal(await readFile(path, 'utf8'), content);
  }
}));

test('rapid atomic writes serialize captured values, leaving only newest preferences', async () => temporary(async (path, dir) => {
  const first = { ...defaultPreferences, port: 20000 };
  const writing = writePreferences(path, first);
  first.port = 0;
  await Promise.all([writing, ...Array.from({ length: 30 }, (_, i) => writePreferences(path, { ...defaultPreferences, port: 21000 + i }))]);
  assert.equal((await readPreferences(path)).port, 21029);
  assert.deepEqual(await readdir(dir), ['preferences.json']);
  await assert.rejects(writePreferences(path, { ...defaultPreferences, port: 0 }));
  assert.equal((await readPreferences(path)).port, 21029);
}));

test('failed persistence preserves the last good file and later writes recover', { skip: process.platform !== 'linux' }, async () => temporary(async (path, dir) => {
  await writePreferences(path, defaultPreferences);
  await chmod(dir, 0o500);
  try { await assert.rejects(writePreferences(path, { ...defaultPreferences, port: 22000 })); }
  finally { await chmod(dir, 0o700); }
  assert.deepEqual(await readPreferences(path), defaultPreferences);
  await writePreferences(path, { ...defaultPreferences, port: 22001 });
  assert.equal((await readPreferences(path)).port, 22001);
}));

test('failed replacement leaves the write queue reusable without temporary files', async () => temporary(async (path, dir) => {
  await mkdir(path);
  await assert.rejects(writePreferences(path, { ...defaultPreferences, port: 22000 }));
  assert.deepEqual(await readdir(dir), ['preferences.json']);
  await rm(path, { recursive: true });
  await writePreferences(path, { ...defaultPreferences, port: 22001 });
  assert.equal((await readPreferences(path)).port, 22001);
  assert.deepEqual(await readdir(dir), ['preferences.json']);
}));

const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: 0, width: 1280, height: 720 }];
test('window recovery keeps supported placement visible and clamps removed/oversized monitors', () => {
  assert.deepEqual(restoreBounds({ ...defaultPreferences, x: -1250, y: 40, height: 600 }, displays, false), { x: -1250, y: 40, width: 1100, height: 600 });
  assert.deepEqual(restoreBounds({ ...defaultPreferences, x: 5000, y: -5000, width: 4000, height: 3000 }, displays, false), { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(restoreBounds({ ...defaultPreferences, x: 1850, y: 1000 }, displays, false), { x: 820, y: 280, width: 1100, height: 760 });
});

test('native Wayland omits position, reports KWin help and never calls unsupported pin API', () => {
  assert.deepEqual(restoreBounds({ ...defaultPreferences, x: 400, y: 300 }, displays, true), { width: 1100, height: 760 });
  const desktop = desktopCapabilities('wayland');
  assert.equal(desktop.keepOnTop, 'desktop-managed');
  assert.match(desktop.keepOnTopHelp!, /KWin.*Keep above/);
  const calls: boolean[] = [];
  const window = { setAlwaysOnTop: (value: boolean) => calls.push(value) };
  applyWindowPreferences(window, { ...defaultPreferences, keepOnTop: true }, true);
  assert.deepEqual(calls, []);
  applyWindowPreferences(window, defaultPreferences, false);
  applyWindowPreferences(window, { ...defaultPreferences, keepOnTop: true }, false);
  assert.deepEqual(calls, [false, true]);
});

test('unrelated appearance edits retain actual normal bounds, omitting coordinates on Wayland', () => {
  const bounds = { x: 50, y: 60, width: 900, height: 600 };
  const preferences = { ...defaultPreferences, appearance: 'night' as const, x: 999, y: 999 };
  assert.deepEqual(withWindowBounds(preferences, bounds, false), { ...preferences, ...bounds });
  const result = withWindowBounds(preferences, bounds, true);
  assert.equal(result.appearance, 'night');
  assert.equal(result.width, 900);
  assert.equal('x' in result, false);
  assert.equal('y' in result, false);
});
