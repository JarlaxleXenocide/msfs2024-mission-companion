import type { Airport, AirportResult, AppState, Capture, ConnectionState, Icao, Preferences, RouteEndpoint } from '../shared/model';
import { parsePreferences } from '../shared/validate';
import { distanceNm } from '../domain/distance';
import { classify } from '../domain/classify';
import { AdapterError, type Simulator } from '../simulator/adapter';
import { CoherentError } from '../simulator/coherent';

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
const systemClock: Clock = {
  now: Date.now,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};
interface Operation {
  ident: string;
  lifetime: string | null;
  connection: string;
  cacheVersion: number;
  startedAt: number;
  timer?: unknown;
  overdue: boolean;
  uncertain: boolean;
}
interface CachedAirport { icao: Icao; airport: Airport | null }
const recoveryMessage = 'Simulator work has not completed. New airport queries are paused. Retry cannot cancel native work or replace an observable pending read. Wait for completion, or Retry after a simulator/view restart so a changed owning view lifetime can be verified; an unknown or unchanged lifetime keeps affected queries paused.';
const captureRecoveryMessage = 'Mission capture completion is unknown. New mission and airport queries are paused. Retry can check view lifetimes, but cannot cancel native work. A changed known main-view lifetime is required; an EFB replacement or unknown/unchanged main lifetime cannot resume captures.';

export class Controller {
  private preferences: Preferences;
  private state: AppState = { session: null, revision: 0, observedAt: null, connection: 'connecting', stale: false, message: 'Connecting to simulator', rows: [] };
  private readonly listeners = new Set<(state: AppState) => void>();
  private running = false;
  private minimized = false;
  private generation = 0;
  private connection: string | null = null;
  private inFlight: Promise<void> | null = null;
  private captureStartedAt = 0;
  private uncertainCapture: { lifetime: string | null } | null = null;
  private reconnectRequested = false;
  private pollTimer: unknown;
  private phaseTimer: unknown;
  private phaseOverdue = false;
  private failures = 0;
  private baseConnection: ConnectionState = 'connecting';
  private baseMessage = 'Connecting to simulator';
  private cacheVersion = 0;
  private rowsSession: string | null = null;
  private readonly cache = new Map<string, CachedAirport>();
  private readonly identities = new Map<string, string>();
  private readonly errors = new Map<string, AirportResult>();
  // Entries survive transport rejection: a rejected host Promise does not end native work.
  private readonly operations = new Set<Operation>();

  constructor(private readonly simulator: Simulator, preferences: Preferences, private readonly clock: Clock = systemClock) {
    this.preferences = parsePreferences(preferences);
    simulator.setPort(this.preferences.port);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const operation of this.operations) this.watchAirport(operation);
    void this.refresh();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.connection = null;
    this.clearPoll();
    this.clearPhase();
    for (const operation of this.operations) this.clock.clearTimeout(operation.timer);
    this.simulator.close();
  }

  getState(): AppState { return structuredClone(this.state); }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setPreferences(preferences: Preferences): void {
    const parsed = parsePreferences(preferences);
    const portChanged = parsed.port !== this.preferences.port;
    this.preferences = parsed;
    if (portChanged) {
      // Wait for an acknowledged capture/probe to settle before replacing its transport.
      this.generation++;
      this.reconnectRequested = true;
      if (this.running) void this.refresh();
    }
    this.publish();
  }

  selectRoute(missionGuid: string | null): void {
    if (missionGuid === null) this.state.route = null;
    else {
      const mission = this.state.rows.find(row => row.mission.guid === missionGuid)?.mission;
      if (!mission || !this.connection || this.rowsSession !== this.connection) throw new TypeError('Unknown current mission');
      this.state.route = { session: this.connection, mission: structuredClone(mission),
        departure: { ident: mission.departure, status: 'pending' },
        destination: { ident: mission.destination, status: 'pending' } };
    }
    this.publish(); this.pump();
  }

  setMinimized(value: boolean): void {
    if (this.minimized === value) return;
    this.minimized = value;
    if (!this.running) return;
    this.clearPoll();
    if (!value) void this.refresh();
    else if (!this.inFlight) this.schedule();
  }

  refresh(): Promise<void> {
    this.clearPoll();
    if (!this.running) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (this.reconnectRequested) {
      this.simulator.setPort(this.preferences.port);
      this.disconnect();
      this.reconnectRequested = false;
    }
    // Claim the cycle before run() can publish to synchronous subscribers.
    const attempt = Promise.resolve().then(() => this.run());
    this.inFlight = attempt;
    void attempt.finally(() => {
      if (this.inFlight !== attempt) return;
      this.inFlight = null;
      if (!this.running) return;
      if (this.reconnectRequested) void this.refresh();
      else this.schedule();
    });
    return attempt;
  }

  refreshAirports(): Promise<void> {
    this.cacheVersion++;
    for (const entry of this.cache.values()) entry.airport = null;
    this.errors.clear();
    if (this.state.route?.session === this.connection) {
      this.state.route.departure = { ident: this.state.route.mission.departure, status: 'pending' };
      this.state.route.destination = { ident: this.state.route.mission.destination, status: 'pending' };
    }
    if (this.state.pilotLocation) this.state.pilotLocation = { ident: this.state.pilotLocation.ident, status: 'pending' };
    this.state.rows = this.state.rows.map(row => ({ ...row, departureLocation: { ident: row.mission.departure, status: 'pending' }, distanceNm: null, facility: { status: 'pending' }, decision: null }));
    this.publish();
    return this.refresh();
  }

  retry(): Promise<void> {
    this.failures = 0;
    // Do not close or replace an acknowledged, still-pending capture/probe.
    if (this.inFlight) return this.refresh();
    this.disconnect();
    this.errors.clear();
    return this.refresh();
  }

  private async run(): Promise<void> {
    const generation = this.generation;
    if (!this.current(generation)) return;
    let captureOwner: { lifetime: string | null } | null = null;
    try {
      if (this.connection === null || this.uncertainCapture !== null) {
        this.baseConnection = 'connecting';
        this.baseMessage = 'Connecting to simulator';
        this.watchPhase(); this.publish();
        if (!this.current(generation)) return;
        const connection = await this.simulator.connect();
        if (!this.current(generation)) return;
        this.clearPhase();
        this.connection = connection;
        this.state.session = connection;
        this.clearCache();
        const lifetime = this.simulator.efbLifetime;
        for (const operation of this.operations) {
          if (operation.lifetime !== null && lifetime !== null && operation.lifetime !== lifetime) {
            this.clock.clearTimeout(operation.timer);
            this.operations.delete(operation);
          }
        }
      }
      if (this.uncertainCapture !== null) {
        const lifetime = this.simulator.mainLifetime;
        if (this.uncertainCapture.lifetime !== null && lifetime !== null && this.uncertainCapture.lifetime !== lifetime) {
          this.uncertainCapture = null;
        } else {
          this.publish();
          return;
        }
      }
      this.baseConnection = 'updating';
      this.baseMessage = 'Updating mission list';
      this.watchPhase(); this.publish();
      if (!this.current(generation)) return;
      captureOwner = { lifetime: this.simulator.mainLifetime };
      this.captureStartedAt = this.clock.now();
      const capture = await this.simulator.capture();
      captureOwner = null;
      if (!this.current(generation)) return;
      this.clearPhase();
      this.failures = 0;
      this.accept(capture);
      this.publish(); this.pump();
    } catch (error) {
      // Port/stop generation invalidation cannot turn host rejection into native completion.
      if (captureOwner !== null && error instanceof CoherentError &&
          (error.cause === 'transport-loss' || error.cause === 'ack-deadline')) {
        this.uncertainCapture = captureOwner;
      }
      if (!this.current(generation)) return;
      this.clearPhase();
      if (error instanceof AdapterError) {
        this.baseConnection = error.state;
        this.baseMessage = error.message;
      } else {
        const wasConnecting = this.connection === null;
        this.disconnect();
        this.failures++;
        this.baseConnection = wasConnecting && error instanceof CoherentError && error.cause === 'protocol'
          ? 'views-unavailable' : 'unavailable';
        this.baseMessage = this.baseConnection === 'views-unavailable'
          ? 'Required simulator views are unavailable. Open Career and the EFB, then Retry.'
          : 'Simulator connection is unavailable. Retrying automatically.';
      }
      this.publish();
    } finally {
      this.clearPhase();
    }
  }

  private current(generation: number): boolean { return this.running && this.generation === generation; }

  private disconnect(): void {
    this.generation++;
    this.connection = null;
    this.simulator.close();
  }

  private accept(capture: Capture): void {
    this.baseConnection = capture.screen === 'browse' ? 'ready' : capture.screen;
    this.baseMessage = capture.screen === 'browse' ? (capture.missions.length ? 'Mission list is current' : 'No missions in the current map list')
      : capture.screen === 'inactive' ? 'Career mission list is inactive or collapsed'
      : capture.screen === 'briefing' ? 'Mission briefing is open'
      : 'This simulator screen or data shape is unsupported';
    if (capture.screen !== 'browse') return;
    const previous = new Map(this.rowsSession === this.connection
      ? this.state.rows.map(row => [row.mission.destination, row.facility]) : []);
    this.rowsSession = this.connection;
    const previousDepartures = new Map(this.state.rows.map(row => [row.mission.departure, row.departureLocation]));
    const pilot = this.state.pilotLocation;
    this.state.pilotLocation = capture.pilotIdent
      ? pilot?.ident === capture.pilotIdent ? pilot : { ident: capture.pilotIdent, status: 'pending' }
      : null;
    const destinations = new Set(capture.missions.flatMap(mission => [mission.destination, mission.departure]));
    if (capture.pilotIdent) destinations.add(capture.pilotIdent);
    if (this.state.route?.session === this.connection) {
      destinations.add(this.state.route.mission.departure);
      destinations.add(this.state.route.mission.destination);
    }
    for (const ident of this.errors.keys()) if (!destinations.has(ident)) this.errors.delete(ident);
    this.state.revision++;
    this.state.observedAt = capture.observedAt;
    this.state.rows = capture.missions.map(mission => ({ mission,
      departureLocation: previousDepartures.get(mission.departure) ?? { ident: mission.departure, status: 'pending' },
      facility: this.available(mission.destination, previous.get(mission.destination)), decision: null }));
  }

  private available(ident: string, previous?: AirportResult): AirportResult {
    const cached = this.cached(ident);
    if (cached?.airport) return { status: 'ready', airport: cached.airport };
    if (previous?.status === 'ready') return previous;
    const error = this.errors.get(ident);
    if (error) return error;
    if (this.stalled()) return { status: 'unknown', reason: this.uncertainCapture ? captureRecoveryMessage : recoveryMessage };
    return { status: 'pending' };
  }

  private stalled(): boolean {
    return this.uncertainCapture !== null || this.phaseOverdue || [...this.operations].some(operation => operation.overdue || operation.uncertain);
  }

  private publish(): void {
    if (!this.running) return;
    const stalled = this.stalled();
    this.state.connection = stalled ? 'stalled' : this.baseConnection;
    this.state.stale = stalled || this.baseConnection !== 'ready';
    this.state.message = this.uncertainCapture ? captureRecoveryMessage : stalled ? recoveryMessage : this.baseMessage;
    if (this.state.pilotLocation) this.state.pilotLocation = this.endpoint(this.state.pilotLocation);
    this.state.rows = this.state.rows.map(row => {
      const departureLocation = this.endpoint(row.departureLocation ?? { ident: row.mission.departure, status: 'pending' });
      const pilot = this.state.pilotLocation;
      const distance = pilot?.status === 'ready' && departureLocation.status === 'ready'
        ? distanceNm(pilot.position, departureLocation.position) : null;
      const facility = this.available(row.mission.destination, row.facility);
      const unconstrained = this.preferences.criteria.categories.length === 0 && this.preferences.criteria.minimumFt === null;
      const decision = facility.status === 'pending' && !unconstrained ? null
        : classify(facility.status === 'ready' ? facility.airport : null, this.preferences.criteria);
      return { ...row, facility, decision, departureLocation, distanceNm: distance };
    });
    if (this.state.route?.session === this.connection) {
      this.state.route.departure = this.endpoint(this.state.route.departure);
      this.state.route.destination = this.endpoint(this.state.route.destination);
    }
    for (const listener of this.listeners) listener(this.getState());
  }

  private endpoint(previous: RouteEndpoint): RouteEndpoint {
    const ident = previous.ident;
    const row = this.rowsSession === this.connection ? this.state.rows.find(row => row.mission.destination === ident) : undefined;
    const result = this.available(ident, row?.facility);
    if (result.status === 'ready') return result.airport.position
      ? { ident, status: 'ready', position: result.airport.position }
      : { ident, status: 'unavailable', reason: 'Airport coordinates are unavailable' };
    if (previous.status === 'ready') return previous;
    return result.status === 'unknown' ? { ident, status: 'unavailable', reason: result.reason } : { ident, status: 'pending' };
  }

  private pump(): void {
    if (!this.running || !this.connection || this.baseConnection !== 'ready' || this.stalled()) return;
    const route = this.state.route?.session === this.connection ? this.state.route : null;
    const demand = [
      ...(route ? [route.departure, route.destination] : []),
      ...(this.state.pilotLocation ? [this.state.pilotLocation] : []),
      ...this.state.rows.map(row => ({ ident: row.mission.destination, status: row.facility.status })),
      ...(this.state.pilotLocation ? this.state.rows.map(row => row.departureLocation!) : []),
    ];
    for (const { ident, status } of demand) {
      if (this.operations.size >= 4) return;
      if (status !== 'pending' || [...this.operations].some(operation => operation.ident === ident)) continue;
      const operation: Operation = { ident, lifetime: this.simulator.efbLifetime, connection: this.connection,
        cacheVersion: this.cacheVersion, startedAt: this.clock.now(), overdue: false, uncertain: false };
      this.operations.add(operation);
      this.watchAirport(operation);
      void this.loadAirport(operation);
    }
  }

  private async loadAirport(operation: Operation): Promise<void> {
    try {
      const airport = await this.simulator.airport(operation.ident, this.cached(operation.ident)?.icao);
      if (this.operations.has(operation) && this.running && operation.connection === this.connection && operation.cacheVersion === this.cacheVersion) {
        this.put(airport);
        this.state.rows = this.state.rows.map(row => row.mission.destination === operation.ident
          ? { ...row, facility: { status: 'ready', airport } } : row);
      }
    } catch (error) {
      if (!this.operations.has(operation)) return;
      if (error instanceof CoherentError && (error.cause === 'transport-loss' || error.cause === 'ack-deadline')) {
        operation.uncertain = true;
        if (this.running && operation.connection === this.connection) {
          // Keep an acknowledged main capture observable until it actually settles.
          if (this.inFlight) this.reconnectRequested = true;
          else this.disconnect();
          this.failures++;
          this.baseConnection = 'unavailable';
          if (!this.inFlight) this.schedule();
        }
      } else if (this.running && operation.connection === this.connection && operation.cacheVersion === this.cacheVersion) {
        this.errors.set(operation.ident, { status: 'unknown', reason: error instanceof Error ? error.message : 'Airport facility is unavailable' });
      }
    } finally {
      this.clock.clearTimeout(operation.timer);
      if (!operation.uncertain) this.operations.delete(operation);
      if (this.running) { this.publish(); this.pump(); }
    }
  }

  private watchAirport(operation: Operation): void {
    if (operation.uncertain || operation.overdue) return;
    operation.timer = this.clock.setTimeout(() => {
      operation.overdue = true;
      this.publish();
    }, Math.max(0, 10000 - (this.clock.now() - operation.startedAt)));
  }

  private watchPhase(): void {
    this.clearPhase();
    this.phaseTimer = this.clock.setTimeout(() => { this.phaseOverdue = true; this.publish(); }, 10000);
  }

  private clearPhase(): void {
    this.clock.clearTimeout(this.phaseTimer);
    this.phaseTimer = undefined;
    this.phaseOverdue = false;
  }

  private clearPoll(): void {
    this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private schedule(): void {
    this.clearPoll();
    if (!this.running || this.inFlight) return;
    const interval = this.minimized ? 10000 : 2000;
    // Keep the request cadence and skip elapsed ticks instead of catching up.
    const pollDelay = interval - Math.max(0, this.clock.now() - this.captureStartedAt) % interval;
    const delay = this.connection === null && this.failures > 0
      ? Math.min(15000, 1000 * 2 ** Math.min(this.failures - 1, 4))
      : pollDelay;
    this.pollTimer = this.clock.setTimeout(() => { void this.refresh(); }, delay);
  }

  private cached(ident: string): CachedAirport | undefined {
    const key = this.identities.get(ident);
    if (key === undefined) return;
    const entry = this.cache.get(key);
    if (entry) { this.cache.delete(key); this.cache.set(key, entry); }
    return entry;
  }

  private put(airport: Airport): void {
    const { type, region, airport: parent, ident } = airport.icao;
    const key = JSON.stringify([type, region, parent, ident]);
    const oldKey = this.identities.get(airport.ident);
    if (oldKey !== undefined) this.cache.delete(oldKey);
    this.cache.set(key, { icao: airport.icao, airport });
    this.identities.set(airport.ident, key);
    if (this.cache.size > 512) {
      const oldest = this.cache.entries().next().value!;
      this.cache.delete(oldest[0]);
      this.identities.delete(oldest[1].icao.ident);
    }
  }

  private clearCache(): void {
    this.state.pilotLocation = null;
    this.state.rows = this.state.rows.map(row => ({ ...row, departureLocation: undefined, distanceNm: null }));
    this.cacheVersion++;
    this.cache.clear(); this.identities.clear(); this.errors.clear();
  }
}
