import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { SimulatorAdapter, AdapterError, type Evaluator } from '../src/simulator/adapter';
import { airportExpression, captureExpression, lifetimeExpression } from '../src/simulator/expressions';
import { recordedCyvr } from './fixtures';
import { CoherentError } from '../src/simulator/coherent';

// Synthetic mission/context; no simulator endpoint is used by these tests.
const mission = (i = 0) => ({ missionIndex: i, missionGUID: `guid-${i}`, title: 'Example',
  specialization: { valueStr: 'Cargo' }, departure: { iCAO: 'TEST' }, arrival: { iCAO: 'CYVR' } });
const record = () => ({ screen: 'browse', observedAt: '2026-09-05T00:00:00.000Z',
  first: 1, final: 1, firstGuid: 'guid-0', finalFirstGuid: 'guid-0', items: [mission()] });
class FakeEvaluator implements Evaluator {
  calls: string[] = [];
  closed = false;
  constructor(public values: unknown[]) {}
  async connect() {}
  async evaluate(source: string): Promise<unknown> {
    this.calls.push(source);
    const next = this.values.shift();
    if (next instanceof Error) throw next;
    return next === undefined ? undefined : JSON.parse(JSON.stringify(next));
  }
  close() { this.closed = true; }
}
async function setup(values: unknown[], facility: unknown = recordedCyvr) {
  const main = new FakeEvaluator([1000, ...values]);
  const efb = new FakeEvaluator([1000, facility]);
  const adapter = new SimulatorAdapter(19999, {
    discover: async () => ({ mainId: 'main', efbId: 'efb' }),
    createClient: (_port: number, id: string) => id === 'main' ? main : efb,
  });
  await adapter.connect();
  main.calls.length = 0; // Capture assertions count captures, independently of the connection probe.
  return { adapter, main, efb };
}
const evaluate = (source: string, context: object = {}) => runInNewContext(source, context);
function browserContext(count = 1) {
  const ranges: number[][] = [];
  const items = Array.from({ length: count }, (_, i) => mission(i));
  const api = {
    requestRange: async (start: number, size: number) => { ranges.push([start, size]); return count; },
    getElement: async (i: number) => items[i],
  };
  const browser = { _componentName: 'missions_browser_content', manipulator: { isActive: true, fetcher: { api } } };
  return { ranges, items, api, browser, context: { document: { querySelectorAll: () => [browser] } } };
}

test('airport identifiers remain serialized data in old-engine expressions', () => {
  const ident = 'X";throw Error("bad");//';
  const source = airportExpression(ident);
  assert.ok(source.includes(JSON.stringify(ident)));
  for (const expression of [source, captureExpression(), lifetimeExpression()]) {
    assert.equal(expression.includes('?.'), false);
    assert.doesNotThrow(() => new Function('return ' + expression));
  }
});

test('adapter normalizes capture and optional missing payout/duration', async () => {
  const { adapter } = await setup([record()]);
  const capture = await adapter.capture();
  assert.equal(capture.screen, 'browse');
  assert.equal(capture.missions[0].destination, 'CYVR');
  assert.equal(capture.missions[0].payoutText, null);
  assert.equal(capture.missions[0].durationText, null);
});

test('adapter rejects duplicate GUIDs, indices, malformed capture identity', async () => {
  const invalid = [
    { ...record(), first: 2, final: 2, items: [mission(), { ...mission(1), missionGUID: 'guid-0' }] },
    { ...record(), items: [mission(1)] },
    { ...record(), items: [{ ...mission(), missionGUID: '' }] },
    { ...record(), items: [{ ...mission(), arrival: { iCAO: '' } }] },
    { ...record(), observedAt: 'not a date' },
    { ...record(), first: 1.5 },
    { ...record(), items: [] },
  ];
  for (const value of invalid) {
    const { adapter, main } = await setup([value]);
    await assert.rejects(adapter.capture(), (e: unknown) => e instanceof AdapterError && e.state === 'unsupported');
    assert.equal(main.calls.length, 1);
  }
});

test('adapter owns exactly one retry for count or first GUID changes', async () => {
  for (const changed of [{ ...record(), final: 2 }, { ...record(), finalFirstGuid: 'new' }, { screen: 'updating' }]) {
    const success = await setup([changed, record()]);
    assert.equal((await success.adapter.capture()).missions.length, 1);
    assert.equal(success.main.calls.length, 2);
    const failure = await setup([changed, changed, record()]);
    await assert.rejects(failure.adapter.capture(), (e: unknown) => e instanceof AdapterError && e.state === 'updating');
    assert.equal(failure.main.calls.length, 2);
  }
});

test('capture expression pages by 25 and rechecks count and first identity', async () => {
  const fake = browserContext(26);
  const result = await evaluate(captureExpression(), fake.context);
  assert.equal(result.items.length, 26);
  assert.deepEqual(fake.ranges, [[0, 25], [0, 25], [25, 25], [0, 1]]);
  assert.equal(result.finalFirstGuid, 'guid-0');
  fake.api.requestRange = async () => fake.ranges.length++ === 4 ? 26 : 25;
  assert.equal((await evaluate(captureExpression(), fake.context)).screen, 'updating');
});

test('capture stops inactive/absent/unknown browser and count over ceiling without reading missions', async () => {
  const fake = browserContext();
  fake.browser.manipulator.isActive = false;
  assert.equal((await evaluate(captureExpression(), fake.context)).screen, 'inactive');
  assert.equal(fake.ranges.length, 0);
  assert.equal((await evaluate(captureExpression(), { document: { querySelectorAll: () => [] } })).screen, 'unsupported');
  const excessive = browserContext(2001);
  assert.equal((await evaluate(captureExpression(), excessive.context)).screen, 'unsupported');
  const { adapter } = await setup([{ screen: 'inactive', observedAt: record().observedAt }]);
  assert.equal((await adapter.capture()).screen, 'inactive');
});

function sdkContext(matches: unknown[] = [recordedCyvr.icaoStruct], flags = 73) {
  const calls: unknown[][] = [];
  const facility = { ...recordedCyvr, loadedDataFlags: flags, runways: recordedCyvr.rawRunways };
  class Loader {
    async awaitInitialization() { calls.push(['init']); }
    async searchByIdentWithIcaoStructs(...args: unknown[]) { calls.push(['search', ...args]); return matches; }
    async getFacility(...args: unknown[]) { calls.push(['load', ...args]); return facility; }
  }
  return { calls, facility, context: { msfssdk: { FacilityLoader: Loader, FacilityRepository: { INSTANCE: {} },
    FacilitySearchType: { Airport: 1 }, FacilityType: { Airport: 'APT' },
    RunwayUtils: { getOneWayRunwaysFromAirport: () => recordedCyvr.runways } } } };
}

test('airport expression exact-searches, loads mask 73 and preserves RNAV/RNP plus physical and SDK ends', async () => {
  const fake = sdkContext([{ type: 'V', ident: 'CYVR' }, recordedCyvr.icaoStruct, { type: 'A', ident: 'CYVR1' }]);
  const result = await evaluate(airportExpression('CYVR'), fake.context);
  assert.deepEqual(fake.calls, [['init'], ['search', 1, 'CYVR', 20], ['load', 'APT', recordedCyvr.icaoStruct, 73]]);
  assert.deepEqual(result.approaches, recordedCyvr.approaches);
  assert.deepEqual(result.rawRunways, recordedCyvr.rawRunways);
  assert.deepEqual(result.runways, recordedCyvr.runways);
  const { adapter } = await setup([], result);
  const airport = await adapter.airport('CYVR');
  assert.equal(airport.procedures![2].rnavFlags, 27);
  assert.equal(airport.procedures![1].rnpAr, true);
});

test('known ICAO skips search; invalid known identity rejects before evaluation', async () => {
  const fake = sdkContext([]);
  await evaluate(airportExpression('CYVR', recordedCyvr.icaoStruct), fake.context);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(fake.calls[1])), ['load', 'APT', recordedCyvr.icaoStruct, 73]);
  assert.throws(() => airportExpression('OTHER', recordedCyvr.icaoStruct));
});

test('airport rejects absent SDK, zero/multiple exact matches, partial flags and wrong returned identity', async () => {
  await assert.rejects(evaluate(airportExpression('CYVR')), /SDK/);
  for (const matches of [[], [recordedCyvr.icaoStruct, recordedCyvr.icaoStruct]]) {
    await assert.rejects(evaluate(airportExpression('CYVR'), sdkContext(matches).context), /exact airport/);
  }
  await assert.rejects(evaluate(airportExpression('CYVR'), sdkContext(undefined, 1).context), /flags/);
  const wrong = await setup([], { ...recordedCyvr, ident: 'OTHER', icaoStruct: { ...recordedCyvr.icaoStruct, ident: 'OTHER' } });
  await assert.rejects(wrong.adapter.airport('CYVR'), /identity/);
});

test('connection tokens are separate from EFB lifetime, with conservative unknown fallback', async () => {
  let mainId = 'main-1';
  let origin: unknown = 1000;
  const adapter = new SimulatorAdapter(19999, {
    discover: async () => ({ mainId, efbId: 'efb' }),
    createClient: () => new FakeEvaluator([origin]),
  });
  const first = await adapter.connect();
  const efbLifetime = adapter.efbLifetime;
  adapter.close();
  mainId = 'main-2';
  const second = await adapter.connect();
  assert.notEqual(first, second);
  assert.equal(adapter.efbLifetime, efbLifetime);
  adapter.close();
  origin = null;
  await adapter.connect();
  assert.equal(adapter.efbLifetime, null);
  assert.equal(evaluate(lifetimeExpression()), null);
  assert.equal(evaluate(lifetimeExpression(), { performance: { timeOrigin: 1000 } }), 1000);
  assert.equal(evaluate(lifetimeExpression(), { performance: { timing: { navigationStart: 2000 } } }), 2000);
});


test('close while discovery is pending prevents resurrecting a connection', async () => {
  let discovered!: (ids: { mainId: string; efbId: string }) => void;
  let created = 0;
  const adapter = new SimulatorAdapter(19999, {
    discover: () => new Promise(resolve => { discovered = resolve; }),
    createClient: () => { created++; return new FakeEvaluator([1000]); },
  });
  const pending = adapter.connect();
  adapter.close();
  discovered({ mainId: 'main', efbId: 'efb' });
  await assert.rejects(pending, /replaced/);
  assert.equal(created, 0);
});

test('capture expression stops reads as soon as browser deactivates', async () => {
  const fake = browserContext();
  fake.api.getElement = async i => {
    fake.browser.manipulator.isActive = false;
    return fake.items[i];
  };
  assert.equal((await evaluate(captureExpression(), fake.context)).screen, 'inactive');
  assert.deepEqual(fake.ranges, [[0, 25], [0, 25]]);
});

test('expression detects end-of-capture first replacement and adapter accepts empty browse', async () => {
  const fake = browserContext();
  let reads = 0;
  fake.api.getElement = async i => ({ ...fake.items[i], missionGUID: reads++ ? 'changed' : 'guid-0' });
  const changed = await evaluate(captureExpression(), fake.context);
  assert.equal(changed.firstGuid, 'guid-0');
  assert.equal(changed.finalFirstGuid, 'changed');
  const { adapter, main } = await setup([changed, changed]);
  await assert.rejects(adapter.capture(), (e: unknown) => e instanceof AdapterError && e.state === 'updating');
  assert.equal(main.calls.length, 2);
  const empty = await evaluate(captureExpression(), browserContext(0).context);
  const ready = await setup([empty]);
  assert.deepEqual((await ready.adapter.capture()).missions, []);
});


test('adapter preserves uncertain transport causes without retry and closes both clients', async () => {
  const error = new CoherentError('transport-loss', 'lost');
  const { adapter, main, efb } = await setup([error, record()]);
  await assert.rejects(adapter.capture(), e => e === error);
  assert.equal(main.calls.length, 1);
  adapter.close();
  assert.equal(main.closed, true);
  assert.equal(efb.closed, true);
  await assert.rejects(adapter.capture(), /unavailable/);
});

test('adapter discards a completed old capture after reconnect', async () => {
  const { adapter, main } = await setup([]);
  let complete!: (value: unknown) => void;
  main.evaluate = () => new Promise(resolve => { complete = resolve; });
  const pending = adapter.capture();
  adapter.close();
  complete(record());
  await assert.rejects(pending, /replaced/);
});

test('unknown browser shape and malformed optional values stay conservative', async () => {
  assert.equal((await evaluate(captureExpression(), { document: { querySelectorAll: () => [
    { _componentName: 'missions_browser_content', manipulator: { isActive: 'true' } },
  ] } })).screen, 'unsupported');
  const value = record();
  const { adapter } = await setup([{ ...value, items: [{ ...mission(), money: 500, duration: { valueStr: 100 } }] }]);
  const capture = await adapter.capture();
  assert.equal(capture.missions[0].payoutText, null);
  assert.equal(capture.missions[0].payoutCredits, null);
  assert.equal(capture.missions[0].durationText, null);
});

test('first GUID replacement retries even when the API mutates a retained record', async () => {
  const fake = browserContext();
  let reads = 0;
  fake.api.getElement = async i => {
    if (reads++) fake.items[i].missionGUID = 'replacement';
    return fake.items[i];
  };
  const changed = await evaluate(captureExpression(), fake.context);
  const { adapter, main } = await setup([changed, record()]);
  assert.equal((await adapter.capture()).missions[0].guid, 'guid-0');
  assert.equal(main.calls.length, 2);
});

for (const continuedInstability of [false, true]) {
  test(`final count shrinking to zero retries once: ${continuedInstability ? 'still updating' : 'stable empty'}`, async () => {
    const { adapter, main } = await setup([]);
    let evaluations = 0;
    let elementReads = 0;
    main.evaluate = async source => {
      const shrinking = ++evaluations === 1 || continuedInstability;
      const fake = browserContext(shrinking ? 1 : 0);
      let ranges = 0;
      fake.api.requestRange = async () => {
        if (shrinking && ++ranges === 3) fake.items.length = 0;
        return fake.items.length;
      };
      fake.api.getElement = async i => { elementReads++; return fake.items[i]; };
      return JSON.parse(JSON.stringify(await evaluate(source, fake.context)));
    };
    if (continuedInstability) {
      await assert.rejects(adapter.capture(), (e: unknown) => e instanceof AdapterError && e.state === 'updating');
    } else {
      const result = await adapter.capture();
      assert.equal(result.screen, 'browse');
      assert.deepEqual(result.missions, []);
    }
    assert.equal(evaluations, 2);
    assert.equal(elementReads, continuedInstability ? 2 : 1);
  });
}

test('validated port changes close the old connection and affect discovery and both clients', async () => {
  const discoveryPorts: number[] = []; const clientPorts: number[] = [];
  const clients: FakeEvaluator[] = [];
  const adapter = new SimulatorAdapter(19999, {
    discover: async port => { discoveryPorts.push(port); return { mainId: 'main', efbId: 'efb' }; },
    createClient: (port, id) => { clientPorts.push(port); const client = new FakeEvaluator(id === 'efb' ? [1000] : [1000, record()]); clients.push(client); return client; },
  });
  await adapter.connect();
  for (const port of [0, 65536, 1.5, NaN]) assert.throws(() => adapter.setPort(port), TypeError);
  assert.equal(clients[0].closed, false);
  adapter.setPort(19999); assert.equal(clients[0].closed, false);
  adapter.setPort(22222); assert.equal(clients[0].closed, true); assert.equal(clients[1].closed, true);
  assert.equal(adapter.efbLifetime, null);
  await adapter.connect();
  assert.deepEqual(discoveryPorts, [19999, 22222]); assert.deepEqual(clientPorts, [19999, 19999, 22222, 22222]);
  adapter.close();
});

test('main and EFB lifetime probes identify their own independent native owners', async () => {
  let mainId = 'main'; let efbId = 'efb'; let mainOrigin: unknown = 1000; let efbOrigin: unknown = 2000;
  const adapter = new SimulatorAdapter(19999, {
    discover: async () => ({ mainId, efbId }),
    createClient: (_port, id) => new FakeEvaluator([id === mainId ? mainOrigin : efbOrigin]),
  });
  await adapter.connect();
  assert.equal(adapter.mainLifetime, JSON.stringify(['main', 1000]));
  const mainLifetime = adapter.mainLifetime; const efbLifetime = adapter.efbLifetime;
  efbId = 'efb-2'; efbOrigin = 2001; await adapter.connect();
  assert.equal(adapter.mainLifetime, mainLifetime); assert.notEqual(adapter.efbLifetime, efbLifetime);
  const newEfbLifetime = adapter.efbLifetime;
  mainId = 'main-2'; mainOrigin = 1001; await adapter.connect();
  assert.notEqual(adapter.mainLifetime, mainLifetime); assert.equal(adapter.efbLifetime, newEfbLifetime);
  for (const origin of [null, 0, -1, NaN, new CoherentError('evaluation', 'unsupported')]) {
    mainOrigin = origin; await adapter.connect(); assert.equal(adapter.mainLifetime, null);
    assert.equal(adapter.efbLifetime, newEfbLifetime);
  }
  mainOrigin = new CoherentError('transport-loss', 'lost probe');
  await assert.rejects(adapter.connect(), /lost probe/);
  assert.equal(adapter.mainLifetime, null); assert.equal(adapter.efbLifetime, null);
});

test('close during client connection prevents starting a lifetime probe afterward', async () => {
  let connected!: () => void;
  const pending = new Promise<void>(resolve => { connected = resolve; });
  const main = new FakeEvaluator([1000]); const efb = new FakeEvaluator([2000]);
  main.connect = () => pending;
  const adapter = new SimulatorAdapter(19999, {
    discover: async () => ({ mainId: 'main', efbId: 'efb' }),
    createClient: (_port, id) => id === 'main' ? main : efb,
  });
  const connection = adapter.connect(); await Promise.resolve();
  adapter.close(); connected(); await assert.rejects(connection, /replaced/);
  assert.equal(main.calls.length, 0); assert.equal(efb.calls.length, 0);
});

test('close during main lifetime probe cannot start the EFB probe or publish old lifetimes', async () => {
  let complete!: (value: unknown) => void;
  const main = new FakeEvaluator([]); const efb = new FakeEvaluator([2000]);
  main.evaluate = () => new Promise(resolve => { complete = resolve; });
  const adapter = new SimulatorAdapter(19999, {
    discover: async () => ({ mainId: 'main', efbId: 'efb' }),
    createClient: (_port, id) => id === 'main' ? main : efb,
  });
  const connection = adapter.connect(); for (let i = 0; i < 5; i++) await Promise.resolve();
  adapter.close(); complete(1000); await assert.rejects(connection, /replaced/);
  assert.equal(efb.calls.length, 0); assert.equal(adapter.mainLifetime, null); assert.equal(adapter.efbLifetime, null);
});


test('verified facility degree coordinates survive expression and adapter normalization', async () => {
  const { recordedPositions } = await import('./fixtures.js');
  for (const position of recordedPositions) {
    const fake = sdkContext([position.icaoStruct]);
    Object.assign(fake.facility, position);
    const result = await evaluate(airportExpression(position.ident), fake.context);
    const { adapter } = await setup([], result);
    assert.deepEqual((await adapter.airport(position.ident)).position, { latitude: position.lat, longitude: position.lon });
  }
});

test('capture exposes Career pilot airport and rejects malformed optional locations', async () => {
  for (const [pilotLocation, expected] of [[{ iCAO: 'C03' }, 'C03'], [null, null], [{ iCAO: '' }, null], [{ iCAO: 12 }, null]] as const) {
    const { adapter } = await setup([{ ...record(), pilotLocation }]);
    assert.equal((await adapter.capture()).pilotIdent, expected);
  }
});
