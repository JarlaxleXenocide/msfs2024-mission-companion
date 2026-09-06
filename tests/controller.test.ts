import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/main/controller';
import { AdapterError, type Simulator } from '../src/simulator/adapter';
import { CoherentError } from '../src/simulator/coherent';
import type { Airport, Capture, Icao, Mission, Preferences } from '../src/shared/model';
import { defaultPreferences } from '../src/shared/validate';
import { airport } from './fixtures';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Clock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id; };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  async advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await flush();
    }
    this.time = end; await flush();
  }
}
const mission = (guid: string, destination = guid): Mission => ({ guid, destination, departure: 'TEST', title: guid, activity: 'Cargo', payoutText: null, payoutCredits: null, durationText: null });
const capture = (...missions: Mission[]): Capture => ({ screen: 'browse', observedAt: '2026-09-05T00:00:00Z', missions });
const facility = (ident: string): Airport => ({ ...airport(), ident, icao: { ...airport().icao, ident } });
class FakeSimulator implements Simulator {
  efbLifetime: string | null = 'efb-1';
  mainLifetime: string | null = 'main-1';
  connects = 0; captures = 0; closes = 0; port = 19999;
  snapshot = capture();
  onConnect: (() => Promise<string>) | null = null;
  onCapture: (() => Promise<Capture>) | null = null;
  onAirport: ((ident: string) => Promise<Airport>) | null = null;
  calls: { ident: string; known?: Icao; work: ReturnType<typeof deferred<Airport>> }[] = [];
  async connect() { this.connects++; return this.onConnect ? this.onConnect() : `socket-${this.connects}`; }
  async capture() { this.captures++; return this.onCapture ? this.onCapture() : this.snapshot; }
  airport(ident: string, known?: Icao) { const work = deferred<Airport>(); this.calls.push({ ident, known, work }); return this.onAirport ? this.onAirport(ident) : work.promise; }
  close() { this.closes++; }
  setPort(port: number) { this.port = port; }
}
async function setup(...missions: Mission[]) {
  const simulator = new FakeSimulator(); simulator.snapshot = capture(...missions);
  const clock = new Clock(); const controller = new Controller(simulator, defaultPreferences, clock);
  controller.start(); await flush(); return { simulator, clock, controller };
}

test('late airport results cannot resurrect a replaced mission; duplicates share work', async () => {
  const { simulator, controller } = await setup(mission('A', 'CYVR'), mission('A2', 'CYVR'));
  assert.equal(simulator.calls.length, 1);
  simulator.snapshot = capture(mission('B', 'MMQT')); await controller.refresh();
  simulator.calls[0].work.resolve(facility('CYVR')); await flush();
  assert.deepEqual(controller.getState().rows.map(r => r.mission.guid), ['B']);
  assert.equal(controller.getState().revision, 2);
  simulator.calls[1].work.resolve(facility('MMQT')); await flush();
  assert.equal(controller.getState().rows[0].facility.status, 'ready'); controller.stop();
});

test('six destinations never exceed four underlying airport operations', async () => {
  const { simulator, controller } = await setup(...Array.from({ length: 6 }, (_, i) => mission(String(i))));
  assert.equal(simulator.calls.length, 4);
  simulator.calls[0].work.resolve(facility('0')); await flush(); assert.equal(simulator.calls.length, 5);
  simulator.calls[1].work.reject(new AdapterError('unsupported', 'bad airport')); await flush();
  assert.equal(simulator.calls.length, 6);
  assert.equal(controller.getState().rows[0].facility.status, 'ready');
  assert.equal(controller.getState().rows[1].decision?.verdict, 'unknown'); controller.stop();
});

test('polls at 2s visible and 10s minimized; restore and Refresh are immediate', async () => {
  const { simulator, clock, controller } = await setup();
  await clock.advance(1999); assert.equal(simulator.captures, 1);
  await clock.advance(1); assert.equal(simulator.captures, 2);
  controller.setMinimized(true); await clock.advance(9999); assert.equal(simulator.captures, 2);
  await clock.advance(1); assert.equal(simulator.captures, 3);
  controller.setMinimized(false); await flush(); assert.equal(simulator.captures, 4);
  await controller.refresh(); assert.equal(simulator.captures, 5); controller.stop();
  assert.equal(clock.timers.size, 0); await clock.advance(50000); assert.equal(simulator.captures, 5);
});

for (const [minimized, duration, nextStart] of [[false, 700, 2000], [true, 3000, 10000], [false, 2500, 4000]] as const) {
  test(`poll cadence skips occupied ticks with ${duration}ms captures, minimized=${minimized}`, async () => {
    const simulator = new FakeSimulator(); const clock = new Clock();
    const starts: number[] = [];
    simulator.onCapture = () => {
      starts.push(clock.now());
      return new Promise(resolve => clock.setTimeout(() => resolve(capture()), duration));
    };
    const controller = new Controller(simulator, defaultPreferences, clock);
    controller.setMinimized(minimized); controller.start(); await flush();
    await clock.advance(nextStart - 1); assert.deepEqual(starts, [0]);
    await clock.advance(1); assert.deepEqual(starts, [0, nextStart]);
    controller.stop();
  });
}

test('hanging capture stalls at 10s without overlap, retains rows, then recovers on settlement', async () => {
  const { simulator, clock, controller } = await setup(mission('A'));
  const work = deferred<Capture>(); simulator.onCapture = () => work.promise;
  void controller.refresh(); await flush();
  void controller.refresh(); controller.setMinimized(false);
  await clock.advance(10000);
  assert.equal(simulator.captures, 2); assert.equal(controller.getState().connection, 'stalled');
  assert.equal(controller.getState().stale, true); assert.equal(controller.getState().rows.length, 1);
  work.resolve(capture(mission('B'))); await flush(); assert.equal(controller.getState().revision, 2); controller.stop();
});

test('hanging connection/lifetime probe stalls and Retry cannot overlap it', async () => {
  const simulator = new FakeSimulator(); const clock = new Clock(); const work = deferred<string>();
  simulator.onConnect = () => work.promise;
  const controller = new Controller(simulator, defaultPreferences, clock); controller.start(); await flush();
  await clock.advance(10000); assert.equal(controller.getState().connection, 'stalled');
  void controller.retry(); await flush(); assert.equal(simulator.connects, 1);
  controller.stop(); work.resolve('old'); await flush(); assert.equal(simulator.captures, 0); assert.equal(clock.timers.size, 0);
});

test('airport timeout retains slots through refresh/retry until actual settlement', async () => {
  const { simulator, clock, controller } = await setup(...Array.from({ length: 6 }, (_, i) => mission(String(i))));
  await clock.advance(10000);
  assert.equal(controller.getState().connection, 'stalled');
  assert.ok(controller.getState().rows.every(r => r.facility.status === 'unknown'));
  await controller.refreshAirports(); await controller.retry(); assert.equal(simulator.calls.length, 4);
  for (const call of simulator.calls.slice()) call.work.resolve(facility(call.ident));
  await flush(); assert.equal(simulator.calls.length, 8); controller.stop();
});

for (const cause of ['transport-loss', 'ack-deadline'] as const) {
  test(`${cause} quarantines airport work across socket tokens, refresh and port changes`, async () => {
    const { simulator, controller } = await setup(mission('A'));
    simulator.calls[0].work.reject(new CoherentError(cause, 'lost')); await flush();
    await controller.retry(); await controller.refreshAirports();
    assert.equal(simulator.calls.length, 1); assert.equal(controller.getState().connection, 'stalled');
    controller.setPreferences({ ...defaultPreferences, port: 20000 }); await flush();
    assert.equal(simulator.port, 20000); assert.equal(simulator.calls.length, 1);
    simulator.efbLifetime = null; await controller.retry(); assert.equal(simulator.calls.length, 1);
    simulator.efbLifetime = 'efb-2'; await controller.retry(); await flush();
    assert.equal(simulator.calls.length, 2); controller.stop();
  });
}

test('disconnect backoff is 1/2/4/8/15 seconds, manual retry bypasses wait', async () => {
  const simulator = new FakeSimulator(); const clock = new Clock();
  simulator.onConnect = async () => { throw new CoherentError('transport-loss', 'offline'); };
  const controller = new Controller(simulator, defaultPreferences, clock); controller.start(); await flush();
  let attempts = 1;
  for (const ms of [1000, 2000, 4000, 8000, 15000, 15000]) {
    await clock.advance(ms - 1); assert.equal(simulator.connects, attempts);
    await clock.advance(1); assert.equal(simulator.connects, ++attempts);
  }
  await controller.retry(); assert.equal(simulator.connects, ++attempts); controller.stop();
});

test('updating owns no extra retry; empty browse and inactive are distinct', async () => {
  const { simulator, controller } = await setup(mission('A'));
  simulator.onCapture = async () => { throw new AdapterError('updating', 'changing'); };
  await controller.refresh(); assert.equal(simulator.captures, 2);
  assert.equal(controller.getState().revision, 1); assert.equal(controller.getState().stale, true);
  simulator.onCapture = null; simulator.snapshot = { ...capture(), screen: 'inactive' }; await controller.refresh();
  assert.equal(controller.getState().connection, 'inactive'); assert.equal(controller.getState().rows.length, 1);
  simulator.snapshot = capture(); await controller.refresh();
  assert.equal(controller.getState().connection, 'ready'); assert.equal(controller.getState().rows.length, 0); controller.stop();
});

test('preferences reclassify locally, no-constraint pending rows match, unsubscribe and stop clean up', async () => {
  const { simulator, controller, clock } = await setup(mission('A'));
  let notifications = 0; const unsubscribe = controller.subscribe(() => notifications++);
  controller.setPreferences({ ...defaultPreferences, criteria: { categories: [], minimumFt: null }, theme: 'notes', compact: true });
  assert.equal(controller.getState().rows[0].decision?.verdict, 'match');
  assert.equal(controller.getState().rows[0].facility.status, 'pending'); assert.equal(simulator.captures, 1);
  simulator.calls[0].work.resolve(facility('A')); await flush();
  controller.setPreferences({ ...defaultPreferences, criteria: { categories: ['ILS'], minimumFt: 10000 } });
  assert.equal(controller.getState().rows[0].decision?.verdict, 'no-match');
  unsubscribe(); const count = notifications; controller.stop(); await clock.advance(20000);
  assert.equal(notifications, count); assert.equal(clock.timers.size, 0);
});

test('512-airport LRU evicts identity and facility together and touches on use', async () => {
  const { simulator, controller } = await setup(); simulator.onAirport = async ident => facility(ident);
  for (let i = 0; i < 512; i++) { simulator.snapshot = capture(mission(String(i))); await controller.refresh(); await flush(); }
  simulator.snapshot = capture(mission('0')); await controller.refresh(); assert.equal(simulator.calls.length, 512);
  simulator.snapshot = capture(mission('512')); await controller.refresh(); await flush();
  simulator.snapshot = capture(mission('0')); await controller.refresh(); assert.equal(simulator.calls.length, 513);
  simulator.snapshot = capture(mission('1')); await controller.refresh(); await flush();
  assert.equal(simulator.calls.length, 514); assert.equal(simulator.calls.at(-1)?.known, undefined);
  await controller.refreshAirports(); await flush(); assert.equal(simulator.calls.at(-1)?.known?.ident, '1');
  await controller.retry(); await flush(); assert.equal(simulator.calls.at(-1)?.known, undefined); controller.stop();
});

test('explicit refresh discards late cached results without freeing pending slots', async () => {
  const { simulator, controller } = await setup(mission('A'));
  await controller.refreshAirports(); assert.equal(simulator.calls.length, 1);
  simulator.calls[0].work.resolve(facility('A')); await flush();
  assert.equal(simulator.calls.length, 2); assert.equal(controller.getState().rows[0].facility.status, 'pending'); controller.stop();
});

test('port changes wait for a hanging capture to settle before closing or reconnecting', async () => {
  const { simulator, controller, clock } = await setup(mission('A'));
  const work = deferred<Capture>(); simulator.onCapture = () => work.promise;
  void controller.refresh(); await flush(); const closes = simulator.closes;
  controller.setPreferences({ ...defaultPreferences, port: 22222 }); await flush();
  await clock.advance(10000);
  assert.equal(simulator.closes, closes); assert.equal(simulator.port, 19999);
  assert.equal(simulator.captures, 2); assert.equal(controller.getState().connection, 'stalled');
  simulator.onCapture = null; work.resolve(capture(mission('OLD'))); await flush();
  assert.equal(simulator.port, 22222); assert.equal(simulator.connects, 2);
  assert.deepEqual(controller.getState().rows.map(r => r.mission.guid), ['A']); controller.stop();
});

test('a reconnected but unsupported capture preserves previous usable rows as stale', async () => {
  const { simulator, controller } = await setup(mission('A'));
  simulator.calls[0].work.resolve(facility('A')); await flush();
  simulator.onCapture = async () => { throw new AdapterError('unsupported', 'unsupported'); };
  await controller.retry();
  assert.equal(controller.getState().rows[0].facility.status, 'ready');
  assert.equal(controller.getState().stale, true); assert.equal(controller.getState().revision, 1);
  simulator.onCapture = null; await controller.refresh();
  assert.equal(controller.getState().rows[0].facility.status, 'pending');
  assert.equal(simulator.calls.length, 2); controller.stop();
});

test('all ICAO fields use collision-free cache keys rather than Airport.key', async () => {
  const { simulator, controller } = await setup();
  simulator.onAirport = async ident => ({ ...facility(ident), key: 'same-external-key', icao: { type: 'A', region: 'R', airport: ident === 'Q|Z' ? 'P' : 'P|Q', ident } });
  for (const ident of ['Q|Z', 'Z', 'Q|Z', 'Z']) {
    simulator.snapshot = capture(mission(ident)); await controller.refresh(); await flush();
    const result = controller.getState().rows[0].facility;
    assert.equal(result.status, 'ready'); if (result.status === 'ready') assert.equal(result.airport.ident, ident);
  }
  assert.equal(simulator.calls.length, 2); controller.stop();
});

test('views-unavailable and briefing remain distinct states', async () => {
  const { simulator, controller } = await setup();
  simulator.onConnect = async () => { throw new CoherentError('protocol', 'missing views'); };
  await controller.retry(); assert.equal(controller.getState().connection, 'views-unavailable');
  simulator.onConnect = null; simulator.snapshot = { ...capture(), screen: 'briefing' };
  await controller.retry(); assert.equal(controller.getState().connection, 'briefing'); controller.stop();
});

test('stop/start retains quarantines until a different known EFB lifetime', async () => {
  const { simulator, controller } = await setup(mission('A'));
  simulator.efbLifetime = null;
  controller.stop();
  simulator.calls[0].work.reject(new CoherentError('transport-loss', 'closed')); await flush();
  controller.start(); await flush();
  assert.equal(simulator.calls.length, 1); assert.equal(controller.getState().connection, 'stalled');
  simulator.efbLifetime = 'efb-2'; await controller.retry(); assert.equal(simulator.calls.length, 2); controller.stop();
});

test('unknown owning EFB lifetime cannot be cleared by a later known signal', async () => {
  const simulator = new FakeSimulator(); simulator.efbLifetime = null; simulator.snapshot = capture(mission('A'));
  const clock = new Clock(); const controller = new Controller(simulator, defaultPreferences, clock);
  controller.start(); await flush();
  simulator.calls[0].work.reject(new CoherentError('transport-loss', 'lost')); await flush();
  simulator.efbLifetime = 'first-known'; await controller.retry(); await controller.refreshAirports();
  assert.equal(simulator.calls.length, 1); assert.equal(controller.getState().connection, 'stalled');
  controller.stop(); controller.start(); await flush(); assert.equal(simulator.calls.length, 1); controller.stop();
});

test('stop rejects a late capture and clears pending airport and phase timers', async () => {
  const { simulator, controller, clock } = await setup(mission('A'));
  const work = deferred<Capture>(); simulator.onCapture = () => work.promise;
  void controller.refresh(); await flush();
  controller.stop(); assert.equal(clock.timers.size, 0);
  work.resolve(capture(mission('LATE'))); simulator.calls[0].work.resolve(facility('A')); await flush();
  assert.deepEqual(controller.getState().rows.map(r => r.mission.guid), ['A']);
  assert.equal(controller.getState().revision, 1); assert.equal(simulator.calls.length, 1);
  assert.equal(clock.timers.size, 0);
});

test('definite evaluation/protocol airport errors release slots without quarantine', async () => {
  for (const cause of ['evaluation', 'protocol'] as const) {
    const { simulator, controller } = await setup(...Array.from({ length: 5 }, (_, i) => mission(String(i))));
    simulator.calls[0].work.reject(new CoherentError(cause, 'definite')); await flush();
    assert.equal(simulator.calls.length, 5); assert.equal(controller.getState().connection, 'ready');
    assert.equal(controller.getState().rows[0].facility.status, 'unknown'); controller.stop();
  }
});

test('preferences and published state cannot be mutated through retained caller references', async () => {
  const { controller } = await setup(mission('A'));
  const prefs: Preferences = { ...defaultPreferences, criteria: { categories: [], minimumFt: null } };
  controller.setPreferences(prefs); prefs.criteria.minimumFt = 10000;
  const state = controller.getState(); state.rows.length = 0;
  assert.equal(controller.getState().rows.length, 1);
  assert.equal(controller.getState().rows[0].decision?.verdict, 'match'); controller.stop();
});

test('synchronous subscriber refresh shares the already-claimed native cycle', async () => {
  const simulator = new FakeSimulator(); const clock = new Clock(); const connecting = deferred<string>();
  simulator.onConnect = () => connecting.promise;
  const controller = new Controller(simulator, defaultPreferences, clock);
  let refreshed = false;
  controller.subscribe(() => { if (!refreshed) { refreshed = true; void controller.refresh(); } });
  controller.start(); await flush();
  assert.equal(simulator.connects, 1);
  connecting.resolve('socket'); await flush(); assert.equal(simulator.captures, 1); controller.stop();
});

test('synchronous subscriber stop prevents native work after lifecycle notification', async () => {
  const simulator = new FakeSimulator(); const clock = new Clock();
  const controller = new Controller(simulator, defaultPreferences, clock);
  controller.subscribe(() => controller.stop()); controller.start(); await flush();
  assert.equal(simulator.connects, 0); assert.equal(simulator.captures, 0); assert.equal(clock.timers.size, 0);
});

test('airport transport failure preserves an observable capture through Retry until actual completion', async () => {
  const { simulator, controller, clock } = await setup(mission('A'));
  const work = deferred<Capture>(); let nativeRunning = true;
  simulator.onCapture = () => work.promise;
  simulator.close = () => { simulator.closes++; work.reject(new CoherentError('transport-loss', 'host closed while native capture runs')); };
  void controller.refresh(); await flush(); const closes = simulator.closes;
  simulator.calls[0].work.reject(new CoherentError('transport-loss', 'airport socket lost')); await flush();
  void controller.retry(); await clock.advance(10000);
  assert.equal(simulator.closes, closes); assert.equal(simulator.captures, 2);
  assert.equal(nativeRunning, true); assert.equal(controller.getState().connection, 'stalled');
  nativeRunning = false; simulator.onCapture = null; work.resolve(capture(mission('B'))); await flush();
  assert.equal(simulator.connects, 2); assert.equal(simulator.captures, 3);
  assert.equal(controller.getState().connection, 'stalled'); // The airport's native work is still uncertain.
  controller.stop();
});

for (const cause of ['transport-loss', 'ack-deadline'] as const) {
  test(`capture ${cause} retains native uncertainty across reconnects until the owning main lifetime changes`, async () => {
    const { simulator, controller, clock } = await setup();
    simulator.onCapture = async () => { throw new CoherentError(cause, 'capture completion unknown'); };
    await controller.refresh(); simulator.onCapture = null;
    assert.equal(controller.getState().connection, 'stalled');
    await controller.retry(); await controller.refreshAirports();
    assert.equal(simulator.captures, 2);
    simulator.efbLifetime = 'efb-2'; await controller.retry();
    assert.equal(simulator.captures, 2); // EFB replacement does not end main-view work.
    simulator.mainLifetime = null; await controller.retry(); assert.equal(simulator.captures, 2);
    simulator.mainLifetime = 'main-1'; await clock.advance(10000); assert.equal(simulator.captures, 2);
    controller.setPreferences({ ...defaultPreferences, port: 22222 }); await flush();
    assert.equal(simulator.captures, 2); assert.equal(simulator.port, 22222);
    simulator.mainLifetime = 'main-2'; await controller.retry();
    assert.equal(simulator.captures, 3); assert.equal(controller.getState().connection, 'ready'); controller.stop();
  });
}

test('unknown owning main lifetime cannot be cleared by later known probes or stop/start', async () => {
  const { simulator, controller } = await setup(); simulator.mainLifetime = null;
  simulator.onCapture = async () => { throw new CoherentError('transport-loss', 'unknown owner'); };
  await controller.refresh(); simulator.onCapture = null; simulator.mainLifetime = 'main-known';
  controller.stop(); controller.start(); await flush(); await controller.retry();
  assert.equal(simulator.captures, 2); assert.equal(controller.getState().connection, 'stalled'); controller.stop();
});

test('port-invalidated capture transport loss still retains native uncertainty', async () => {
  const { simulator, controller } = await setup(); const work = deferred<Capture>();
  simulator.onCapture = () => work.promise; void controller.refresh(); await flush();
  controller.setPreferences({ ...defaultPreferences, port: 22222 });
  work.reject(new CoherentError('transport-loss', 'capture socket lost')); simulator.onCapture = null; await flush();
  await controller.retry(); assert.equal(simulator.captures, 2);
  assert.equal(controller.getState().connection, 'stalled'); controller.stop();
});

test('selected endpoints share slots, replace queued origins and retain running work', async () => {
  const missions = Array.from({ length: 6 }, (_, i) => ({ ...mission(String(i)), departure: `ORIGIN${i}` }));
  const { simulator, controller } = await setup(...missions);
  assert.throws(() => controller.selectRoute('missing'));
  controller.selectRoute('0'); controller.selectRoute('1');
  assert.equal(simulator.calls.length, 4);
  simulator.calls[0].work.resolve(facility('0')); await flush();
  assert.equal(simulator.calls[4].ident, 'ORIGIN1');
  controller.selectRoute('2');
  simulator.calls[1].work.resolve(facility('1')); await flush();
  assert.equal(simulator.calls[5].ident, 'ORIGIN2');
  simulator.calls[4].work.resolve({ ...facility('ORIGIN1'), position: { latitude: 1, longitude: 2 } }); await flush();
  assert.equal(controller.getState().route?.mission.guid, '2');
  assert.equal(controller.getState().route?.departure.status, 'pending');
  controller.selectRoute(null);
  assert.equal(controller.getState().route, null);
  controller.stop();
});

test('route uses cached destinations, deduplicates same airport and does not affect verdicts', async () => {
  const { simulator, controller } = await setup({ ...mission('A'), departure: 'A' });
  simulator.calls[0].work.resolve({ ...facility('A'), position: { latitude: 0, longitude: 0 } }); await flush();
  const decision = controller.getState().rows[0].decision;
  controller.selectRoute('A');
  assert.equal(simulator.calls.length, 1);
  assert.deepEqual(controller.getState().route?.departure, { ident: 'A', status: 'ready', position: { latitude: 0, longitude: 0 } });
  assert.deepEqual(controller.getState().route?.departure, controller.getState().route?.destination);
  assert.deepEqual(controller.getState().rows[0].decision, decision);
  controller.stop();
});

test('removed selected mission retains snapshot and route errors until explicit refresh', async () => {
  const { simulator, controller } = await setup(mission('A'));
  controller.selectRoute('A');
  simulator.calls[1].work.reject(new Error('origin unavailable')); await flush();
  simulator.calls[0].work.resolve(facility('A')); await flush();
  assert.equal(controller.getState().route?.destination.status, 'unavailable');
  simulator.snapshot = capture(); await controller.refresh();
  assert.equal(controller.getState().route?.mission.guid, 'A');
  assert.deepEqual(controller.getState().route?.departure, { ident: 'TEST', status: 'unavailable', reason: 'origin unavailable' });
  assert.equal(simulator.calls.length, 2);
  await controller.refreshAirports();
  assert.deepEqual(simulator.calls.slice(2).map(call => call.ident), ['TEST', 'A']);
  controller.stop();
});

test('route work respects stalls and new sessions cannot receive old route completions', async () => {
  const { simulator, controller, clock } = await setup(mission('A'));
  controller.selectRoute('A');
  await clock.advance(10000);
  assert.equal(controller.getState().connection, 'stalled');
  assert.equal(controller.getState().route?.departure.status, 'unavailable');
  controller.selectRoute(null); controller.selectRoute('A');
  assert.equal(simulator.calls.length, 2);
  simulator.efbLifetime = 'efb-2';
  await controller.retry();
  const retained = controller.getState().route;
  assert.equal(retained?.session, 'socket-1');
  assert.equal(controller.getState().session, 'socket-2');
  simulator.calls[1].work.resolve({ ...facility('TEST'), position: { latitude: 5, longitude: 6 } }); await flush();
  assert.deepEqual(controller.getState().route, retained);
  controller.selectRoute('A');
  assert.equal(controller.getState().route?.session, 'socket-2');
  assert.equal(controller.getState().route?.departure.status, 'pending');
  controller.stop();
});
