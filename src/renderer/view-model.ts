import type { Mission, Row, Procedure } from '../shared/model';

export type RowSort = 'title' | 'destination' | 'runway' | 'duration' | 'credits' | 'distance';
export type SortDirection = 'asc' | 'desc';
export interface SortCriterion { column: RowSort; direction: SortDirection }

export function cycleSort(sorts: SortCriterion[], column: RowSort): SortCriterion[] {
  const current = sorts.find(sort => sort.column === column);
  if (!current) return [...sorts, { column, direction: 'desc' }];
  return current.direction === 'asc'
    ? sorts.filter(sort => sort.column !== column)
    : sorts.map(sort => sort.column === column ? { column, direction: 'asc' } : sort);
}

export function parseMinimumFt(
  value: string,
  badInput: boolean,
): { valid: true; value: number | null } | { valid: false } {
  if (badInput) return { valid: false };
  if (value === '') return { valid: true, value: null };
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? { valid: true, value: parsed }
    : { valid: false };
}

export function visibleRows(
  rows: Row[],
  query: string,
  matchesOnly: boolean,
  sorts: SortCriterion[],
): Row[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = rows.filter(({ mission, decision }) =>
    (!needle || [mission.title, mission.departure, mission.destination]
      .some(value => value.toLocaleLowerCase().includes(needle))) &&
    (!matchesOnly || decision?.verdict === 'match'));
  return filtered.sort((a, b) => {
    for (const { column, direction } of sorts) {
      const left = sortValue(a, column);
      const right = sortValue(b, column);
      if (left === null && right === null) continue;
      if (left === null) return 1;
      if (right === null) return -1;
      const order = typeof left === 'number'
        ? left - (right as number)
        : left.localeCompare(right as string, undefined, { sensitivity: 'base' });
      if (order) return direction === 'asc' ? order : -order;
    }
    return 0;
  });
}

export function rowCounts(rows: Row[]): {
  match: number;
  noMatch: number;
  pending: number;
  unknown: number;
} {
  const counts = { match: 0, noMatch: 0, pending: 0, unknown: 0 };
  for (const { decision } of rows) {
    if (decision === null) counts.pending += 1;
    else if (decision.verdict === 'match') counts.match += 1;
    else if (decision.verdict === 'no-match') counts.noMatch += 1;
    else counts.unknown += 1;
  }
  return counts;
}

export function matchingRunwayLength(row: Row): number | null {
  if (row.facility.status !== 'ready' || row.decision?.verdict !== 'match') return null;
  const ids = new Set(row.decision.runwayIds);
  const lengths = (row.facility.airport.ends ?? [])
    .filter(end => ids.has(end.id))
    .map(end => end.physicalM !== null && end.thresholdM !== null &&
      Number.isFinite(end.physicalM) && Number.isFinite(end.thresholdM) &&
      end.physicalM >= end.thresholdM && end.thresholdM >= 0
      ? end.physicalM - end.thresholdM : null)
    .filter((length): length is number => length !== null);
  return lengths.length ? Math.max(...lengths) : null;
}

export function displayElevation(m: number | null): string {
  return m === null || !Number.isFinite(m)
    ? 'Unknown'
    : `${formatNumber(Math.round(m / 0.3048))} ft (${formatNumber(Math.round(m))} m)`;
}

export function displayLength(m: number | null): string {
  return m === null || !Number.isFinite(m) || m < 0
    ? 'Unknown'
    : `${formatNumber(Math.round(m / 0.3048))} ft (${formatNumber(Math.round(m))} m)`;
}

export function missionSummary(mission: Mission, _compact: boolean): {
  payout: string;
  duration: string;
} {
  return {
    payout: mission.payoutText ?? 'Unknown',
    duration: mission.durationText ?? 'Unknown',
  };
}

function sortValue(row: Row, sort: RowSort): string | number | null {
  if (sort === 'title') return row.mission.title;
  if (sort === 'destination') return row.mission.destination;
  if (sort === 'distance') return row.distanceNm ?? null;
  if (sort === 'credits') return row.mission.payoutCredits;
  if (sort === 'duration') {
    // Sort the advertised duration; raw simulator duration units are unverified.
    const match = /^(?:(\d+(?:\.\d+)?)\s*h\s*)?(?:(\d+(?:\.\d+)?)\s*min)?$/i.exec(row.mission.durationText?.trim() ?? '');
    if (!match || (!match[1] && !match[2])) return null;
    const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
    return Number.isFinite(minutes) ? minutes : null;
  }
  return matchingRunwayLength(row);
}

const numberFormat = new Intl.NumberFormat('en-US');
function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function availableCategories(row: Row): string[] {
  if (row.facility.status !== 'ready' || row.facility.airport.procedures === null) return [];
  const values = new Set<string>();
  for (const procedure of row.facility.airport.procedures) {
    if (procedure.type === 4) values.add('ILS');
    else if (procedure.type === 5) values.add('LOC');
    else if (procedure.type === 8) values.add('VOR');
    else if (procedure.type === 11) values.add('VOR/DME');
    else if (procedure.type === 10) {
      const minima = rnavMinima(procedure);
      if (isCircling(procedure)) values.add(`RNAV circling${minima.length ? ` (${minima.join(', ')})` : ''}`);
      else if (minima.length) for (const label of minima) values.add(label);
      else values.add('RNAV minima unavailable');
    }
  }
  return [...values];
}

export function procedureType(procedure: Procedure): string {
  const base = procedure.type === 4 ? 'ILS' : procedure.type === 5 ? 'LOC'
    : procedure.type === 8 ? 'VOR' : procedure.type === 11 ? 'VOR/DME'
    : procedure.type === 10 ? 'RNAV' : `Type ${procedure.type}`;
  if (procedure.type !== 10) return base;
  const minima = rnavMinima(procedure);
  const association = isCircling(procedure) ? ' · Circling'
    : procedure.runwayNumber === null || procedure.runwayDesignator === null ? ' · Runway unknown' : '';
  return `${base} · ${minima.length ? minima.join(' · ') : 'minima unavailable'}${association}`;
}

function isCircling(procedure: Procedure): boolean {
  return procedure.runwayNumber === 0 && procedure.runwayDesignator === 0;
}

function rnavMinima(procedure: Procedure): string[] {
  const flags = procedure.rnavFlags;
  if (flags === null || !Number.isInteger(flags) || flags <= 0) return [];
  const minima: string[] = [];
  // MSFS RnavTypeFlags describe minima, independently of runway association.
  for (const [flag, label] of [[8, 'LPV'], [2, 'LNAV/VNAV'], [4, 'LP'], [1, 'LNAV']] as const) {
    if ((flags & flag) !== 0) minima.push(label);
  }
  return minima;
}
