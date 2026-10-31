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
    { minimumHours: 1.25, maximumHours: null }, { minimumHours: null, maximumHours: Infinity },
    { minimumHours: null, maximumHours: null, extra: true }]) {
    assert.throws(() => parsePreferences({ ...defaultPreferences, duration }));
  }
});

test('player distance preferences migrate older settings and validate exact inclusive bounds', () => {
  const legacy = { ...defaultPreferences };
  delete legacy.distance;
  assert.deepEqual(parsePreferences(legacy).distance, { minimumNm: null, maximumNm: null });
  for (const distance of [{ minimumNm: 0, maximumNm: 0 }, { minimumNm: 25.5, maximumNm: 100.25 }, { minimumNm: 0, maximumNm: null }]) {
    assert.deepEqual(parsePreferences({ ...defaultPreferences, distance }).distance, distance);
  }
  for (const distance of [null, {}, { minimumNm: 100, maximumNm: 25 }, { minimumNm: -1, maximumNm: null },
    { minimumNm: NaN, maximumNm: null }, { minimumNm: null, maximumNm: Infinity }, { minimumNm: '25', maximumNm: 100 },
    { minimumNm: null, maximumNm: null, extra: true }]) {
    assert.throws(() => parsePreferences({ ...defaultPreferences, distance }));
  }
});


test('duration preferences accept only whole or half-hour bounds', () => {
  for (const hours of [0, 0.5, 1, 1.5, 2.5, 24]) {
    const duration = { minimumHours: hours, maximumHours: hours };
    assert.deepEqual(parsePreferences({ ...defaultPreferences, duration }).duration, duration);
  }
  for (const hours of [0.1, 1.25, -0.5, NaN, Infinity, '1.5']) {
    assert.throws(() => parsePreferences({ ...defaultPreferences, duration: { minimumHours: hours, maximumHours: null } }));
    assert.throws(() => parsePreferences({ ...defaultPreferences, duration: { minimumHours: null, maximumHours: hours } }));
  }
});

test('total credits preferences default to unlimited and use 500k increments', () => {
  const legacy = { ...defaultPreferences }; delete legacy.credits;
  assert.deepEqual(parsePreferences(legacy).credits, { minimumCredits: null, maximumCredits: null });
  for (const credits of [{ minimumCredits: 0, maximumCredits: 0 }, { minimumCredits: 500000, maximumCredits: 1500000 }, { minimumCredits: null, maximumCredits: 10000000 }]) {
    assert.deepEqual(parsePreferences({ ...defaultPreferences, credits }).credits, credits);
  }
  for (const credits of [null, {}, { minimumCredits: 1000000, maximumCredits: 500000 },
    { minimumCredits: -500000, maximumCredits: null }, { minimumCredits: 250000, maximumCredits: null },
    { minimumCredits: null, maximumCredits: Infinity }, { minimumCredits: '500000', maximumCredits: null },
    { minimumCredits: null, maximumCredits: null, extra: 1 }]) {
    assert.throws(() => parsePreferences({ ...defaultPreferences, credits }));
  }
});
