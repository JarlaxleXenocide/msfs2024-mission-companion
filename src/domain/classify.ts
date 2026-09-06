import type {
  Airport,
  Category,
  Criteria,
  Decision,
  Procedure,
  RunwayEnd,
  RunwayGroup,
} from '../shared/model';

type State = 'match' | 'no-match' | 'unknown';

interface Outcome {
  state: State;
  runwayId: string | null;
  reason: string;
}

export function groupRunways(airport: Airport): RunwayGroup[] {
  const groups: RunwayGroup[] = (airport.ends ?? []).map((end) => ({
    end,
    procedures: [] as Procedure[],
  }));
  const unassociated: Procedure[] = [];

  for (const procedure of airport.procedures ?? []) {
    const group = groups.find(
      ({ end }) =>
        end !== null &&
        end.number === procedure.runwayNumber &&
        end.designator === procedure.runwayDesignator,
    );
    (group?.procedures ?? unassociated).push(procedure);
  }

  if (unassociated.length > 0) groups.push({ end: null, procedures: unassociated });
  return groups;
}

export function classify(
  airport: Airport | null,
  criteria: Criteria,
): Decision {
  if (criteria.categories.length === 0 && criteria.minimumFt === null) {
    return decision('match', [], ['No approach or runway constraints selected']);
  }
  if (airport === null) {
    return decision('unknown', [], ['Destination facility is unavailable']);
  }

  const outcomes =
    criteria.categories.length === 0
      ? evaluateRunways(airport.ends, criteria.minimumFt)
      : evaluateProcedures(airport, criteria.categories, criteria.minimumFt);

  const matches = outcomes.filter(({ state }) => state === 'match');
  if (matches.length > 0) return fromOutcomes('match', matches);

  const unknown = outcomes.filter(({ state }) => state === 'unknown');
  if (unknown.length > 0) return fromOutcomes('unknown', unknown);

  const failures = outcomes.filter(({ state }) => state === 'no-match');
  if (failures.length > 0) return fromOutcomes('no-match', failures);

  return decision('no-match', [], ['No selected approach is available']);
}

function evaluateRunways(
  ends: RunwayEnd[] | null,
  minimumFt: number | null,
): Outcome[] {
  if (ends === null) {
    return [outcome('unknown', null, 'Runway data is unavailable')];
  }
  if (ends.length === 0) {
    return [outcome('no-match', null, 'No runway ends are available')];
  }
  return ends.map((end) => evaluateEnd(end, minimumFt));
}

function evaluateProcedures(
  airport: Airport,
  categories: Category[],
  minimumFt: number | null,
): Outcome[] {
  if (airport.procedures === null) {
    return [outcome('unknown', null, 'Approach data is unavailable')];
  }

  const outcomes: Outcome[] = [];
  for (const procedure of airport.procedures) {
    const category = evaluateCategory(procedure, categories);
    if (category === 'no-match') continue;

    const association = associate(procedure, airport.ends);
    if (association.state !== 'match') {
      outcomes.push(association);
      continue;
    }
    if (association.end === null) {
      if (category === 'unknown') {
        outcomes.push(
          outcome('unknown', null, `${procedure.name}: RNAV subtype is unspecified`),
        );
      } else if (minimumFt === null) {
        outcomes.push(outcome('match', null, `${procedure.name} meets selected filters`));
      } else {
        outcomes.push(
          outcome(
            'unknown',
            null,
            `${procedure.name}: no runway is associated with the minimum length`,
          ),
        );
      }
      continue;
    }

    const end = association.end;
    outcomes.push(
      combineOption(end.id, [
        category === 'unknown'
          ? outcome('unknown', end.id, `${end.id}: RNAV subtype is unspecified`)
          : outcome('match', end.id, ''),
        evaluateClosure(end),
        evaluateIlsEquipment(procedure, categories, end),
        evaluateLength(end, minimumFt),
      ]),
    );
  }
  return outcomes;
}

function evaluateCategory(
  procedure: Procedure,
  categories: Category[],
): State {
  if (!Number.isFinite(procedure.type)) return 'unknown';
  if (procedure.type === 4) return categories.includes('ILS') ? 'match' : 'no-match';
  if (procedure.type === 5) return categories.includes('LOC') ? 'match' : 'no-match';
  if (procedure.type === 8 || procedure.type === 11) {
    return categories.includes('VOR') ? 'match' : 'no-match';
  }
  if (procedure.type !== 10) return 'no-match';

  const wantsLpv = categories.includes('LPV');
  const wantsLnavVnav = categories.includes('LNAV_VNAV');
  if (!wantsLpv && !wantsLnavVnav) return 'no-match';
  if (
    procedure.rnavFlags === null ||
    !Number.isInteger(procedure.rnavFlags) ||
    procedure.rnavFlags <= 0
  ) {
    return 'unknown';
  }
  if ((wantsLpv && (procedure.rnavFlags & 8) !== 0) ||
      (wantsLnavVnav && (procedure.rnavFlags & 2) !== 0)) {
    return 'match';
  }
  return 'no-match';
}

function associate(
  procedure: Procedure,
  ends: RunwayEnd[] | null,
): { state: State; end: RunwayEnd | null; runwayId: string | null; reason: string } {
  if (procedure.runwayNumber === 0 && procedure.runwayDesignator === 0) {
    return { state: 'match', end: null, runwayId: null, reason: '' };
  }
  if (procedure.runwayNumber === null || procedure.runwayDesignator === null) {
    return {
      state: 'unknown',
      end: null,
      runwayId: null,
      reason: `${procedure.name}: runway identity is incomplete`,
    };
  }
  if (ends === null) {
    return {
      state: 'unknown',
      end: null,
      runwayId: null,
      reason: 'Runway data is unavailable',
    };
  }
  const end = ends.find(
    (candidate) =>
      candidate.number === procedure.runwayNumber &&
      candidate.designator === procedure.runwayDesignator,
  );
  if (!end) {
    return {
      state: 'unknown',
      end: null,
      runwayId: null,
      reason: `${procedure.name}: referenced runway is unavailable`,
    };
  }
  return { state: 'match', end, runwayId: end.id, reason: '' };
}

function evaluateEnd(end: RunwayEnd, minimumFt: number | null): Outcome {
  return combineOption(end.id, [
    evaluateClosure(end),
    evaluateLength(end, minimumFt),
  ]);
}

function evaluateClosure(end: RunwayEnd): Outcome {
  if (end.closed === true) {
    return outcome('no-match', end.id, `${end.id}: runway is closed`);
  }
  if (end.closed === null) {
    return outcome('unknown', end.id, `${end.id}: runway closure status is unknown`);
  }
  return outcome('match', end.id, '');
}

function evaluateIlsEquipment(
  procedure: Procedure,
  categories: Category[],
  end: RunwayEnd,
): Outcome {
  if (procedure.type !== 4 || !categories.includes('ILS')) {
    return outcome('match', end.id, '');
  }
  if (
    end.ilsMHz === null ||
    !Number.isFinite(end.ilsMHz) ||
    end.glideslope === null
  ) {
    return outcome('unknown', end.id, `${end.id}: ILS equipment data is incomplete`);
  }
  if (end.ilsMHz <= 0 || !end.glideslope) {
    return outcome(
      'no-match',
      end.id,
      `${end.id}: ILS equipment does not satisfy the filter`,
    );
  }
  return outcome('match', end.id, '');
}

function evaluateLength(end: RunwayEnd, minimumFt: number | null): Outcome {
  if (minimumFt !== null) {
    if (
      end.physicalM === null ||
      end.thresholdM === null ||
      !Number.isFinite(end.physicalM) ||
      !Number.isFinite(end.thresholdM) ||
      end.physicalM < 0 ||
      end.thresholdM < 0 ||
      end.thresholdM > end.physicalM
    ) {
      return outcome('unknown', end.id, `${end.id}: runway dimensions are incomplete`);
    }
    if ((end.physicalM - end.thresholdM) / 0.3048 < minimumFt) {
      return outcome('no-match', end.id, `${end.id}: runway is below the minimum length`);
    }
  }
  return outcome('match', end.id, '');
}

function combineOption(runwayId: string, conjuncts: Outcome[]): Outcome {
  const failure = conjuncts.find(({ state }) => state === 'no-match');
  if (failure) return failure;
  const unknown = conjuncts.find(({ state }) => state === 'unknown');
  if (unknown) return unknown;
  return outcome('match', runwayId, `${runwayId} meets selected filters`);
}

function outcome(
  state: State,
  runwayId: string | null,
  reason: string,
): Outcome {
  return { state, runwayId, reason };
}

function fromOutcomes(verdict: State, outcomes: Outcome[]): Decision {
  return decision(
    verdict,
    unique(outcomes.flatMap(({ runwayId }) => (runwayId === null ? [] : [runwayId]))),
    unique(outcomes.map(({ reason }) => reason)),
  );
}

function decision(
  verdict: State,
  runwayIds: string[],
  reasons: string[],
): Decision {
  return { verdict, runwayIds, reasons };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
