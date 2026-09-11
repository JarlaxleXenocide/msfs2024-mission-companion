import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAirport, normalizeMission } from '../src/domain/normalize';
import { classify } from '../src/domain/classify';
import {
  recordedCyvr,
  recordedI73,
  recordedMmqt,
} from './fixtures';

// Faithful minimal extracts from evidence/milestone-2/initial.json, recorded
// 2026-09-05. Each field below belongs to the named mission record.
const recordedThreeHourMission = {
  missionGUID: 'F1D2DF8D-CACD-4612-984B-3F3FEAA7CD54',
  title: 'Private Transfer #PWO16   - Casper - LAST CALL',
  specialization: { valueStr: 'PRC' },
  departure: { iCAO: 'KAOO' },
  arrival: { iCAO: 'KCPR' },
  money: {
    valueStr: '2,146,860',
    value: 2146860,
    unit: 'Cr.',
    html: '<span class="value">2,146,860</span>&nbsp;<span class="unit">Cr.</span>',
  },
  duration: { valueStr: '3h', value: 10500 },
};

const recordedNinetyMinuteMission = {
  missionGUID: '5B3A40BD-F672-4CB4-BCAC-FDDC7259A211',
  title: 'Private Charter #PWO5910 - Mastodon - ON TIME',
  specialization: { valueStr: 'PRC' },
  departure: { iCAO: 'KAOO' },
  arrival: { iCAO: '50D' },
  money: { valueStr: '1,036,410', value: 1036410, unit: 'Cr.' },
  duration: { valueStr: '1h 30min', value: 4800 },
};

test('normalizes faithful recorded mission display fields', () => {
  assert.deepEqual(normalizeMission(recordedThreeHourMission), {
    guid: 'F1D2DF8D-CACD-4612-984B-3F3FEAA7CD54',
    title: 'Private Transfer #PWO16   - Casper - LAST CALL',
    activity: 'PRC',
    departure: 'KAOO',
    destination: 'KCPR',
    payoutText: '2,146,860 Cr.',
    payoutCredits: 2146860,
    durationText: '3h',
  });

  assert.deepEqual(normalizeMission(recordedNinetyMinuteMission), {
    guid: '5B3A40BD-F672-4CB4-BCAC-FDDC7259A211',
    title: 'Private Charter #PWO5910 - Mastodon - ON TIME',
    activity: 'PRC',
    departure: 'KAOO',
    destination: '50D',
    payoutText: '1,036,410 Cr.',
    payoutCredits: 1036410,
    durationText: '1h 30min',
  });
});

test('keeps valid mission identity when optional display fields are malformed', () => {
  const mission = normalizeMission({
    ...recordedThreeHourMission,
    money: { valueStr: 42, value: -1, unit: {} },
    duration: { valueStr: null, value: 4800 },
  });
  assert.equal(mission.payoutText, null);
  assert.equal(mission.payoutCredits, null);
  assert.equal(mission.durationText, null);
});

test('does not display a payout without a valid nonempty source unit', () => {
  for (const unit of [undefined, '', {}]) {
    const mission = normalizeMission({
      ...recordedThreeHourMission,
      money: { valueStr: '2,146,860', value: 2146860, unit },
    });
    assert.equal(mission.payoutText, null);
    assert.equal(mission.payoutCredits, 2146860);
  }
});

test('rejects missing mission identity, title, activity, or airport strings', () => {
  for (const invalid of [
    { ...recordedThreeHourMission, missionGUID: '' },
    { ...recordedThreeHourMission, title: null },
    { ...recordedThreeHourMission, specialization: {} },
    { ...recordedThreeHourMission, departure: { iCAO: '' } },
    { ...recordedThreeHourMission, arrival: null },
  ]) {
    assert.throws(() => normalizeMission(invalid), TypeError);
  }
});

test('maps recorded physical runway ends by number and parallel designator', () => {
  const cyvr = normalizeAirport(recordedCyvr);
  const end08R = cyvr.ends?.find((end) => end.id === '08R');
  const end26L = cyvr.ends?.find((end) => end.id === '26L');
  const end08L = cyvr.ends?.find((end) => end.id === '08L');

  assert.equal(cyvr.key, 'A|CY||CYVR');
  assert.equal(end08R?.physicalM, 3714.50048828125);
  assert.equal(end08R?.thresholdM, 211.48255920410156);
  assert.equal(end08R?.thresholdElevationM, 2.0402207374572754);
  assert.equal(end26L?.thresholdElevationM, 3.0273542404174805);
  assert.equal(end08L?.physicalM, 3032.429443359375);
  assert.equal(end08L?.thresholdElevationM, 3.0604352951049805);
  assert.equal(end08R?.physicalElevationM, 2.497000217437744);
  assert.ok((end08R?.thresholdElevationM ?? 0) / 0.3048 > 6.69);
  assert.ok((end26L?.thresholdElevationM ?? 0) / 0.3048 > 9.93);
  assert.ok((end08R?.physicalM ?? 0) / 0.3048 > 12186);
  assert.ok((end08R?.physicalM ?? 0) / 0.3048 < 12187);
});

test('preserves recorded RNAV flags and RNP-AR fields from full procedures', () => {
  const procedures = normalizeAirport(recordedCyvr).procedures ?? [];
  assert.deepEqual(
    procedures.map(({ name, rnavFlags, rnpAr }) => ({ name, rnavFlags, rnpAr })),
    [
      { name: 'ILS 8R', rnavFlags: 0, rnpAr: false },
      { name: 'RNAV 8R X', rnavFlags: 0, rnpAr: true },
      { name: 'RNAV 8R Z', rnavFlags: 27, rnpAr: false },
      { name: 'RNAV 13', rnavFlags: 11, rnpAr: false },
    ],
  );
});

test('accepts required facility flag bits and short structured identifiers', () => {
  assert.equal(normalizeAirport(recordedMmqt).ends?.length, 2);
  assert.equal(normalizeAirport(recordedI73).ident, 'I73');
  assert.throws(
    () => normalizeAirport({ ...recordedI73, loadedDataFlags: 72 }),
    /required facility data flags/i,
  );
});

test('recorded airport extracts reproduce CYVR, MMQT, and I73 decisions', () => {
  const cyvr = normalizeAirport(recordedCyvr);
  const mmqt = normalizeAirport(recordedMmqt);
  const i73 = normalizeAirport(recordedI73);

  assert.deepEqual(
    classify(cyvr, { categories: ['LPV', 'LNAV_VNAV'], minimumFt: null }),
    {
      verdict: 'match',
      runwayIds: ['08R', '13'],
      reasons: ['08R meets selected filters', '13 meets selected filters'],
    },
  );
  assert.deepEqual(classify(mmqt, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'no-match',
    runwayIds: [],
    reasons: ['No selected approach is available'],
  });
  assert.deepEqual(classify(i73, { categories: ['LPV'], minimumFt: null }), {
    verdict: 'no-match',
    runwayIds: [],
    reasons: ['RNAV A: circling does not satisfy LPV or LNAV/VNAV filters'],
  });
});

test('preserves zero and negative elevations while nulling invalid optional values', () => {
  const input = structuredClone(recordedI73);
  input.rawRunways[0].primaryElevation = -2;
  input.rawRunways[0].elevation = 0;
  input.rawRunways[0].primaryThresholdLength = Number.NaN;
  const end = normalizeAirport(input).ends?.[0];

  assert.equal(end?.thresholdElevationM, -2);
  assert.equal(end?.physicalElevationM, 0);
  assert.equal(end?.thresholdM, null);
});

test('rejects malformed required facility structure', () => {
  for (const invalid of [
    null,
    { ...recordedI73, ident: '' },
    { ...recordedI73, icaoStruct: { type: 'A', ident: 'I73' } },
    { ...recordedI73, runways: {} },
    { ...recordedI73, approaches: {} },
  ]) {
    assert.throws(() => normalizeAirport(invalid), TypeError);
  }
});

test('facility positions validate degrees independently of capabilities', () => {
  assert.deepEqual(normalizeAirport({ ...recordedCyvr, lat: 0, lon: 0 }).position, { latitude: 0, longitude: 0 });
  assert.deepEqual(normalizeAirport({ ...recordedCyvr, lat: 49.194698333740234, lon: -123.18396759033203 }).position, { latitude: 49.194698333740234, longitude: -123.18396759033203 });
  assert.equal(normalizeAirport(recordedCyvr).position, null);
  for (const [lat, lon] of [[91, 0], [-91, 0], [0, 181], [0, -181], [NaN, 0], [0, Infinity], ['49', 0], [0, undefined]]) {
    const value = normalizeAirport({ ...recordedCyvr, lat, lon });
    assert.equal(value.position, null);
    assert.deepEqual(value.ends, normalizeAirport(recordedCyvr).ends);
  }
});
