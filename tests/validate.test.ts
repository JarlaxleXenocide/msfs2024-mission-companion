import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences, parsePreferences, parseCommand } from '../src/shared/validate';

test('rejects remote or invalid connection settings and negative minima', () => {
  assert.equal(parsePreferences(defaultPreferences).port, 19999);
  for (const port of [0, 65536, 1.5, '19999']) {
    assert.throws(() => parsePreferences({ ...defaultPreferences, port }));
  }
  assert.throws(() =>
    parsePreferences({ ...defaultPreferences, host: 'example.com' }),
  );
  for (const minimumFt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() =>
      parsePreferences({
        ...defaultPreferences,
        criteria: { categories: ['ILS'], minimumFt },
      }),
    );
  }
});

test('rejects unknown fields and approach categories', () => {
  assert.throws(() =>
    parsePreferences({ ...defaultPreferences, unexpected: true }),
  );
  assert.throws(() =>
    parsePreferences({
      ...defaultPreferences,
      criteria: { ...defaultPreferences.criteria, unexpected: true },
    }),
  );
  assert.throws(() =>
    parsePreferences({
      ...defaultPreferences,
      criteria: { categories: ['GPS'], minimumFt: null },
    }),
  );
  assert.throws(() =>
    parsePreferences({ ...defaultPreferences, criteria: null }),
  );
});

test('rejects invalid theme, appearance, flags, and geometry', () => {
  for (const update of [
    { theme: 'blue' },
    { appearance: 'dark' },
    { compact: 0 },
    { matchesOnly: 'false' },
    { keepOnTop: null },
    { width: 0 },
    { height: Number.POSITIVE_INFINITY },
    { x: 1.5 },
    { y: Number.NaN },
  ]) {
    assert.throws(() => parsePreferences({ ...defaultPreferences, ...update }));
  }
});

test('accepts all supported categories and finite geometry', () => {
  const parsed = parsePreferences({
    ...defaultPreferences,
    criteria: {
      categories: ['ILS', 'LPV', 'LNAV_VNAV', 'LOC', 'VOR'],
      minimumFt: 2500.5,
    },
    width: 900,
    height: 650,
    x: -1200,
    y: 30,
  });

  assert.deepEqual(parsed.criteria.categories, [
    'ILS',
    'LPV',
    'LNAV_VNAV',
    'LOC',
    'VOR',
  ]);
  assert.equal(parsed.criteria.minimumFt, 2500.5);
  assert.equal(parsed.x, -1200);
});


test('select-route accepts exactly one nonempty GUID or null', () => {
  for (const missionGuid of ['guid', null]) assert.deepEqual(parseCommand('companion:select-route', [missionGuid]), { channel: 'companion:select-route', missionGuid });
  for (const args of [[], [null, null], [''], ['  '], [undefined], [1], [{}], [[]], [true]]) assert.throws(() => parseCommand('companion:select-route', args));
});

test('range preferences accept legacy settings and reject invalid or reversed bounds', () => {
  const legacy = { ...defaultPreferences, criteria: { categories: ['ILS'], minimumFt: 2500 } };
  delete legacy.duration;
  assert.deepEqual(parsePreferences(legacy).duration, { minimumHours: null, maximumHours: null });
  assert.equal(parsePreferences(legacy).criteria.maximumFt, null);
  assert.equal(parsePreferences({ ...defaultPreferences, duration: { minimumHours: 2, maximumHours: 3 } }).duration?.maximumHours, 3);
  for (const maximumFt of [-1, Infinity, NaN, '5000', 2000]) {
    assert.throws(() => parsePreferences({ ...legacy, criteria: { ...legacy.criteria, maximumFt } }));
  }
  for (const duration of [null, { minimumHours: 3, maximumHours: 2 }, { minimumHours: -1, maximumHours: null },
    { minimumHours: 1.5, maximumHours: null }, { minimumHours: null, maximumHours: Infinity },
    { minimumHours: null, maximumHours: null, extra: true }]) {
    assert.throws(() => parsePreferences({ ...defaultPreferences, duration }));
  }
});
