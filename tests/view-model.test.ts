import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/domain/classify';
import type { Airport, Mission, Row } from '../src/shared/model';
import {
  displayElevation,
  missionSummary,
  parseMinimumFt,
  rowCounts,
  visibleRows,
  cycleSort,
  type SortCriterion,
} from '../src/renderer/view-model';
import { airport } from './fixtures';

const mission = (guid: string, title: string, departure: string, destination: string): Mission => ({
  guid,
  title,
  activity: 'Private charter',
  departure,
  destination,
  payoutText: `${guid} Cr.`,
  payoutCredits: Number(guid),
  durationText: `${guid}h`,
});

function readyRow(value: Mission, facility: Airport, minimumFt: number | null = null): Row {
  return {
    mission: value,
    facility: { status: 'ready', airport: facility },
    decision: classify(facility, { categories: ['ILS'], minimumFt }),
  };
}

test('search matches mission title, departure, and destination without case sensitivity', () => {
  const rows = [
    readyRow(mission('1', 'VIP Transfer', 'KSEA', 'CYVR'), airport()),
    readyRow(mission('2', 'Cargo Run', 'KPDX', 'KSFO'), airport()),
  ];

  assert.deepEqual(visibleRows(rows, 'vip', false, []).map(row => row.mission.guid), ['1']);
  assert.deepEqual(visibleRows(rows, 'kpDx', false, []).map(row => row.mission.guid), ['2']);
  assert.deepEqual(visibleRows(rows, 'cyVr', false, []).map(row => row.mission.guid), ['1']);
});

test('sorts known values while leaving unknown runway values last in both directions', () => {
  const short = airport();
  short.ends![0] = { ...short.ends![0], physicalM: 1200, thresholdM: 100 };
  const long = airport();
  long.ends![0] = { ...long.ends![0], physicalM: 1800, thresholdM: 100 };
  const pending: Row = {
    mission: mission('3', 'Pending', 'KAAA', 'KCCC'),
    facility: { status: 'pending' },
    decision: null,
  };
  const rows = [pending, readyRow(mission('1', 'Short', 'KAAA', 'KAAA'), short), readyRow(mission('2', 'Long', 'KAAA', 'KBBB'), long)];

  assert.deepEqual(visibleRows(rows, '', false, [{ column: 'runway', direction: 'asc' }]).map(row => row.mission.guid), ['1', '2', '3']);
  assert.deepEqual(visibleRows(rows, '', false, [{ column: 'runway', direction: 'desc' }]).map(row => row.mission.guid), ['2', '1', '3']);
});

test('runway sorting uses only matching landing geometry and never an unrelated longest runway', () => {
  const misleading = airport();
  const ils = misleading.ends![0];
  misleading.ends = [
    { ...ils, physicalM: 1000, thresholdM: 0 },
    { ...ils, id: '18', number: 18, physicalM: 4000, thresholdM: 0, ilsMHz: null, glideslope: null },
  ];
  const ordinary = airport();
  ordinary.ends![0] = { ...ordinary.ends![0], physicalM: 1500, thresholdM: 0 };
  const rows = [
    readyRow(mission('1', 'Misleading', 'KAAA', 'KAAA'), misleading),
    readyRow(mission('2', 'Ordinary', 'KAAA', 'KBBB'), ordinary),
  ];

  assert.deepEqual(visibleRows(rows, '', false, [{ column: 'runway', direction: 'desc' }]).map(row => row.mission.guid), ['2', '1']);
});

test('no active sorts preserve source order without mutating the snapshot', () => {
  const pending: Row = {
    mission: mission('1', 'Zulu', 'KZZZ', 'KZZZ'),
    facility: { status: 'pending' },
    decision: null,
  };
  const rows = [pending, readyRow(mission('2', 'Alpha', 'KAAA', 'KAAA'), airport())];

  assert.deepEqual(visibleRows(rows, '', false, []).map(row => row.mission.guid), ['1', '2']);
  assert.deepEqual(rows.map(row => row.mission.guid), ['1', '2'], 'Sorting must not mutate the snapshot');
});

test('matches-only filtering does not hide aggregate pending or unknown counts', () => {
  const matching = readyRow(mission('1', 'Match', 'KAAA', 'KAAA'), airport());
  const noMatchAirport = airport();
  noMatchAirport.procedures = [];
  const noMatch = readyRow(mission('2', 'No match', 'KAAA', 'KBBB'), noMatchAirport);
  const pending: Row = { mission: mission('3', 'Pending', 'KAAA', 'KCCC'), facility: { status: 'pending' }, decision: null };
  const unknownAirport = airport();
  unknownAirport.ends = null;
  const unknown = readyRow(mission('4', 'Unknown', 'KAAA', 'KDDD'), unknownAirport);
  const rows = [matching, noMatch, pending, unknown];

  assert.deepEqual(visibleRows(rows, '', true, []).map(row => row.mission.guid), ['1']);
  assert.deepEqual(rowCounts(rows), { match: 1, noMatch: 1, pending: 1, unknown: 1 });
});

test('displays zero and negative threshold elevations without treating them as missing', () => {
  assert.equal(displayElevation(0), '0 ft (0 m)');
  assert.equal(displayElevation(-2), '-7 ft (-2 m)');
  assert.equal(displayElevation(null), 'Unknown');
  assert.equal(displayElevation(Number.NaN), 'Unknown');
});

test('compact mission summaries retain advertised payout and estimated duration', () => {
  const row = readyRow(mission('7', 'Charter', 'KAAA', 'KBBB'), airport());
  assert.deepEqual(missionSummary(row.mission, true), {
    payout: '7 Cr.',
    duration: '7h',
  });
  assert.deepEqual(missionSummary({ ...row.mission, payoutText: null, durationText: null }, true), {
    payout: 'Unknown',
    duration: 'Unknown',
  });
});

test('distinguishes an intentional blank runway minimum from incomplete numeric input', () => {
  assert.deepEqual(parseMinimumFt('', false), { valid: true, value: null });
  assert.deepEqual(parseMinimumFt('', true), { valid: false });
  assert.deepEqual(parseMinimumFt('1e', true), { valid: false });
});

test('accepts finite nonnegative runway minimums including fractions', () => {
  assert.deepEqual(parseMinimumFt('0', false), { valid: true, value: 0 });
  assert.deepEqual(parseMinimumFt('1234.5', false), { valid: true, value: 1234.5 });
  assert.deepEqual(parseMinimumFt('-0.1', false), { valid: false });
  assert.deepEqual(parseMinimumFt('Infinity', false), { valid: false });
});


test('column sorts cycle descending, ascending, off and retain activation priority', () => {
  let sorts: SortCriterion[] = [];
  sorts = cycleSort(sorts, 'duration');
  sorts = cycleSort(sorts, 'credits');
  assert.deepEqual(sorts, [{ column: 'duration', direction: 'desc' }, { column: 'credits', direction: 'desc' }]);
  sorts = cycleSort(sorts, 'duration');
  assert.deepEqual(sorts, [{ column: 'duration', direction: 'asc' }, { column: 'credits', direction: 'desc' }]);
  sorts = cycleSort(sorts, 'duration');
  assert.deepEqual(sorts, [{ column: 'credits', direction: 'desc' }]);
  sorts = cycleSort(sorts, 'duration');
  assert.deepEqual(sorts, [{ column: 'credits', direction: 'desc' }, { column: 'duration', direction: 'desc' }]);
});

test('duration and credits sort numerically with ordered tie breakers and unknowns last', () => {
  const rows = [
    ['1', '1h 30min', 900], ['2', '90 min', 1200], ['3', '10h', 100],
    ['4', null, null], ['5', '2 h', 9000], ['6', 'Unknown', 5],
    ['7', '0min', 0], ['8', '1h 30min', 1200],
  ].map(([guid, durationText, payoutCredits]) => readyRow({
    ...mission(String(guid), String(guid), 'AAA', 'BBB'),
    durationText: durationText as string | null, payoutCredits: payoutCredits as number | null,
  }, airport()));
  const ids = (sorts: SortCriterion[]) => visibleRows(rows, '', false, sorts).map(row => row.mission.guid);
  assert.deepEqual(ids([{ column: 'duration', direction: 'desc' }, { column: 'credits', direction: 'desc' }]), ['3', '5', '2', '8', '1', '7', '6', '4']);
  assert.deepEqual(ids([{ column: 'duration', direction: 'asc' }, { column: 'credits', direction: 'desc' }]), ['7', '2', '8', '1', '5', '3', '6', '4']);
  assert.deepEqual(ids([{ column: 'credits', direction: 'asc' }]), ['7', '6', '3', '1', '2', '8', '5', '4']);
  assert.deepEqual(ids([]), ['1', '2', '3', '4', '5', '6', '7', '8']);
});
