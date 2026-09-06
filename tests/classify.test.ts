import test from 'node:test';
import assert from 'node:assert/strict';
import type { Airport, Category, Procedure } from '../src/shared/model';
import { classify, groupRunways } from '../src/domain/classify';
import { airport } from './fixtures';

test('a long unrelated runway cannot rescue a short ILS runway', () => {
  const a = airport();
  const r = a.ends![0];
  a.ends = [
    { ...r, physicalM: 1000 },
    { ...r, id: '18', number: 18, physicalM: 3000 },
  ];
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: 5000 }), {
    verdict: 'no-match',
    runwayIds: ['09'],
    reasons: ['09: runway is below the minimum length'],
  });
});

test('unspecified RNAV capabilities remain unknown', () => {
  const a = airport();
  a.procedures![0] = { ...a.procedures![0], type: 10, rnavFlags: 0 };
  assert.deepEqual(classify(a, { categories: ['LPV'], minimumFt: null }), {
    verdict: 'unknown',
    runwayIds: ['09'],
    reasons: ['09: RNAV subtype is unspecified'],
  });
});

test('known false option conjuncts override uncertainty', () => {
  const cases: Array<{
    name: string;
    mutate: (value: Airport) => void;
    criteria: { categories: Category[]; minimumFt: number | null };
    reason: string;
  }> = [
    {
      name: 'missing closure with known absent glideslope',
      mutate: (value) => {
        value.ends![0] = { ...value.ends![0], closed: null, glideslope: false };
      },
      criteria: { categories: ['ILS'], minimumFt: null },
      reason: '09: ILS equipment does not satisfy the filter',
    },
    {
      name: 'unspecified RNAV subtype with definitively short runway',
      mutate: (value) => {
        value.procedures![0] = {
          ...value.procedures![0],
          type: 10,
          rnavFlags: 0,
        };
        value.ends![0] = { ...value.ends![0], physicalM: 1000 };
      },
      criteria: { categories: ['LPV'], minimumFt: 5000 },
      reason: '09: runway is below the minimum length',
    },
    {
      name: 'missing closure with definitively short runway',
      mutate: (value) => {
        value.ends![0] = {
          ...value.ends![0],
          closed: null,
          physicalM: 1000,
        };
      },
      criteria: { categories: ['ILS'], minimumFt: 5000 },
      reason: '09: runway is below the minimum length',
    },
    {
      name: 'missing ILS equipment with definitively short runway',
      mutate: (value) => {
        value.ends![0] = {
          ...value.ends![0],
          glideslope: null,
          physicalM: 1000,
        };
      },
      criteria: { categories: ['ILS'], minimumFt: 5000 },
      reason: '09: runway is below the minimum length',
    },
    {
      name: 'unspecified RNAV subtype on a known closed runway',
      mutate: (value) => {
        value.procedures![0] = {
          ...value.procedures![0],
          type: 10,
          rnavFlags: 0,
        };
        value.ends![0] = { ...value.ends![0], closed: true };
      },
      criteria: { categories: ['LPV'], minimumFt: null },
      reason: '09: runway is closed',
    },
  ];

  for (const entry of cases) {
    const a = airport();
    entry.mutate(a);
    assert.deepEqual(classify(a, entry.criteria), {
      verdict: 'no-match',
      runwayIds: ['09'],
      reasons: [entry.reason],
    }, entry.name);
  }
});

const categoryCases: Array<{
  name: string;
  type: number;
  category: Category;
  flags?: number;
  verdict: 'match' | 'no-match';
}> = [
  { name: 'ILS', type: 4, category: 'ILS', verdict: 'match' },
  { name: 'LOC', type: 5, category: 'LOC', verdict: 'match' },
  { name: 'localizer backcourse', type: 2, category: 'LOC', verdict: 'no-match' },
  { name: 'VOR', type: 8, category: 'VOR', verdict: 'match' },
  { name: 'LPV', type: 10, category: 'LPV', flags: 8, verdict: 'match' },
  {
    name: 'LNAV/VNAV',
    type: 10,
    category: 'LNAV_VNAV',
    flags: 2,
    verdict: 'match',
  },
  { name: 'VOR/DME', type: 11, category: 'VOR', verdict: 'match' },
];

for (const entry of categoryCases) {
  test(`classifies explicit ${entry.name} procedure type`, () => {
    const a = airport();
    a.procedures![0] = {
      ...a.procedures![0],
      name: entry.name,
      type: entry.type,
      rnavFlags: entry.flags ?? 0,
    };
    const decision = classify(a, {
      categories: [entry.category],
      minimumFt: null,
    });
    assert.equal(decision.verdict, entry.verdict);
    assert.deepEqual(decision.runwayIds, entry.verdict === 'match' ? ['09'] : []);
    assert.deepEqual(
      decision.reasons,
      entry.verdict === 'match'
        ? ['09 meets selected filters']
        : ['No selected approach is available'],
    );
  });
}

test('combined recorded RNAV flags identify both requested subtypes', () => {
  for (const flags of [11, 27]) {
    for (const category of ['LPV', 'LNAV_VNAV'] as const) {
      const a = airport();
      a.procedures![0] = { ...a.procedures![0], type: 10, rnavFlags: flags };
      assert.equal(classify(a, { categories: [category], minimumFt: null }).verdict, 'match');
    }
  }
});

test('missing runway or procedure collections remain unknown when relevant', () => {
  const a = airport();
  assert.deepEqual(classify({ ...a, ends: null }, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'unknown',
    runwayIds: [],
    reasons: ['Runway data is unavailable'],
  });
  assert.deepEqual(classify({ ...a, procedures: null }, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'unknown',
    runwayIds: [],
    reasons: ['Approach data is unavailable'],
  });
});

test('negative or missing runway dimensions make a relevant option unknown', () => {
  for (const change of [
    { physicalM: -1 },
    { thresholdM: -1 },
    { physicalM: Number.NaN },
    { thresholdM: Number.POSITIVE_INFINITY },
    { physicalM: null },
    { thresholdM: 1601 },
  ]) {
    const a = airport();
    a.ends![0] = { ...a.ends![0], ...change };
    assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: 1 }), {
      verdict: 'unknown',
      runwayIds: ['09'],
      reasons: ['09: runway dimensions are incomplete'],
    });
  }
});

test('known closed ends cannot qualify', () => {
  const a = airport();
  a.ends![0] = { ...a.ends![0], closed: true };
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'no-match',
    runwayIds: ['09'],
    reasons: ['09: runway is closed'],
  });
});

test('parallel runway designators are matched exactly', () => {
  const a = airport();
  const r = a.ends![0];
  a.ends = [
    { ...r, id: '09L', designator: 1, physicalM: 1000 },
    { ...r, id: '09R', designator: 2, physicalM: 3000 },
  ];
  a.procedures![0] = { ...a.procedures![0], runwayDesignator: 1 };
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: 5000 }), {
    verdict: 'no-match',
    runwayIds: ['09L'],
    reasons: ['09L: runway is below the minimum length'],
  });
});

test('uses the unrounded landing-threshold length at the exact boundary', () => {
  const a = airport();
  a.ends![0] = { ...a.ends![0], physicalM: 1525, thresholdM: 1 };
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: 5000 }), {
    verdict: 'match',
    runwayIds: ['09'],
    reasons: ['09 meets selected filters'],
  });
  a.ends![0] = { ...a.ends![0], physicalM: 1524.999 };
  assert.equal(classify(a, { categories: ['ILS'], minimumFt: 5000 }).verdict, 'no-match');
});

test('circling procedures qualify only when no runway minimum is selected', () => {
  const a = airport();
  a.procedures![0] = {
    ...a.procedures![0],
    name: 'VOR A',
    type: 8,
    runwayNumber: 0,
    runwayDesignator: 0,
  };
  assert.deepEqual(classify(a, { categories: ['VOR'], minimumFt: null }), {
    verdict: 'match',
    runwayIds: [],
    reasons: ['VOR A meets selected filters'],
  });
  assert.deepEqual(classify(a, { categories: ['VOR'], minimumFt: 1000 }), {
    verdict: 'unknown',
    runwayIds: [],
    reasons: ['VOR A: no runway is associated with the minimum length'],
  });
});

test('a proven match overrides unknown and malformed alternatives', () => {
  const a = airport();
  const base = a.procedures![0];
  a.procedures = [
    { ...base, name: 'RNAV 09', type: 10, rnavFlags: 0 },
    { ...base, name: 'malformed', type: Number.NaN },
    base,
  ];
  assert.deepEqual(classify(a, { categories: ['ILS', 'LPV'], minimumFt: null }), {
    verdict: 'match',
    runwayIds: ['09'],
    reasons: ['09 meets selected filters'],
  });
});

test('no selected constraints match without facility data', () => {
  assert.deepEqual(classify(null, { categories: [], minimumFt: null }), {
    verdict: 'match',
    runwayIds: [],
    reasons: ['No approach or runway constraints selected'],
  });
});

test('missing facility is unknown when a constraint is selected', () => {
  assert.deepEqual(classify(null, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'unknown',
    runwayIds: [],
    reasons: ['Destination facility is unavailable'],
  });
});

test('confirmed empty procedures establish no match', () => {
  const a = airport();
  a.procedures = [];
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'no-match',
    runwayIds: [],
    reasons: ['No selected approach is available'],
  });
});

test('an unmatched nonzero runway identity is incomplete rather than circling', () => {
  const a = airport();
  a.procedures![0] = {
    ...a.procedures![0],
    name: 'ILS 18',
    runwayNumber: 18,
  };
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'unknown',
    runwayIds: [],
    reasons: ['ILS 18: referenced runway is unavailable'],
  });
});

test('groups procedures by exact runway end and keeps unassociated procedures separate', () => {
  const a = airport();
  const end09 = a.ends![0];
  const end18 = { ...end09, id: '18', number: 18 };
  const procedure09 = a.procedures![0];
  const circling: Procedure = {
    ...procedure09,
    name: 'VOR A',
    type: 8,
    runwayNumber: 0,
  };
  const unmatched: Procedure = {
    ...procedure09,
    name: 'ILS 27',
    runwayNumber: 27,
  };
  const grouped = groupRunways({ ...a, ends: [end09, end18], procedures: [circling, unmatched, procedure09] });

  assert.deepEqual(
    grouped.map((group) => [group.end?.id ?? null, group.procedures.map((procedure) => procedure.name)]),
    [
      ['09', ['ILS 09']],
      ['18', []],
      [null, ['VOR A', 'ILS 27']],
    ],
  );
});

test('length-only filtering evaluates known open runway ends', () => {
  const a = airport();
  assert.deepEqual(classify(a, { categories: [], minimumFt: 5000 }), {
    verdict: 'match',
    runwayIds: ['09'],
    reasons: ['09 meets selected filters'],
  });
  a.ends = [];
  assert.deepEqual(classify(a, { categories: [], minimumFt: 5000 }), {
    verdict: 'no-match',
    runwayIds: [],
    reasons: ['No runway ends are available'],
  });
});

test('ILS needs positive localizer and glideslope evidence on its matched end', () => {
  const a = airport();
  a.ends![0] = { ...a.ends![0], glideslope: false };
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'no-match',
    runwayIds: ['09'],
    reasons: ['09: ILS equipment does not satisfy the filter'],
  });
  a.ends![0] = { ...a.ends![0], glideslope: null };
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'unknown',
    runwayIds: ['09'],
    reasons: ['09: ILS equipment data is incomplete'],
  });
  a.ends![0] = { ...a.ends![0], ilsMHz: Number.NaN, glideslope: true };
  assert.deepEqual(classify(a, { categories: ['ILS'], minimumFt: null }), {
    verdict: 'unknown',
    runwayIds: ['09'],
    reasons: ['09: ILS equipment data is incomplete'],
  });
});

test('unrelated malformed procedures do not erase a proven match', () => {
  const a = airport();
  const malformed = { name: 'broken', type: Number.NaN } as Procedure;
  a.procedures = [malformed, ...a.procedures!];
  assert.equal(classify(a, { categories: ['ILS'], minimumFt: null }).verdict, 'match');
});

test('grouping tolerates missing facility collections', () => {
  const a: Airport = { ...airport(), ends: null, procedures: null };
  assert.deepEqual(groupRunways(a), []);
});
