import { randomUUID } from 'node:crypto';
import type { Airport, Capture, Icao } from '../shared/model';
import { normalizeAirport, normalizeMission } from '../domain/normalize';
import { CoherentClient, CoherentError, discover } from './coherent';
import { airportExpression, captureExpression, lifetimeExpression } from './expressions';

export interface Simulator {
  // Observed EFB navigation identity, independent of host connection tokens.
  // null supplies no evidence that unresolved native EFB work has ended.
  readonly efbLifetime: string | null;
  // Independent mainUi owner used only to recover uncertain mission captures.
  readonly mainLifetime: string | null;
  setPort(port: number): void;
  connect(): Promise<string>;
  capture(): Promise<Capture>;
  airport(ident: string, known?: Icao): Promise<Airport>;
  close(): void;
}

export interface Evaluator {
  connect(): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  close(): void;
}

export class AdapterError extends Error {
  constructor(readonly state: 'updating' | 'unsupported', message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

interface Dependencies {
  discover(port: number): Promise<{ mainId: string; efbId: string }>;
  createClient(port: number, pageId: string): Evaluator;
}

export class SimulatorAdapter implements Simulator {
  efbLifetime: string | null = null;
  mainLifetime: string | null = null;
  private main: Evaluator | null = null;
  private efb: Evaluator | null = null;
  private session: string | null = null;
  private generation = 0;

  constructor(
    private port = 19999,
    private readonly dependencies: Dependencies = {
      discover,
      createClient: (port, id) => new CoherentClient(port, id),
    },
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('port must be an integer from 1 through 65535');
    }
  }

  setPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('port must be an integer from 1 through 65535');
    }
    if (port === this.port) return;
    this.close();
    this.port = port;
  }

  async connect(): Promise<string> {
    this.close();
    const generation = this.generation;
    const { mainId, efbId } = await this.dependencies.discover(this.port);
    if (generation !== this.generation) {
      throw new CoherentError('transport-loss', 'Simulator connection was replaced');
    }
    const main = this.dependencies.createClient(this.port, mainId);
    const efb = this.dependencies.createClient(this.port, efbId);
    this.main = main;
    this.efb = efb;
    try {
      await Promise.all([main.connect(), efb.connect()]);
      if (generation !== this.generation) {
        throw new CoherentError('transport-loss', 'Simulator connection was replaced');
      }
      const mainLifetime = await readLifetime(main, mainId);
      if (generation !== this.generation) {
        throw new CoherentError('transport-loss', 'Simulator connection was replaced');
      }
      const efbLifetime = await readLifetime(efb, efbId);
      if (generation !== this.generation) {
        throw new CoherentError('transport-loss', 'Simulator connection was replaced');
      }
      this.mainLifetime = mainLifetime;
      this.efbLifetime = efbLifetime;
      this.session = randomUUID();
      return this.session;
    } catch (error) {
      main.close();
      efb.close();
      if (this.main === main) this.close();
      throw error;
    }
  }

  async capture(): Promise<Capture> {
    const main = this.connected(this.main);
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await main.evaluate(captureExpression());
      this.assertCurrent(main, this.main);
      try {
        return normalizeCapture(raw);
      } catch (error) {
        if (attempt === 0 && error instanceof AdapterError && error.state === 'updating') continue;
        throw error;
      }
    }
    throw new AdapterError('updating', 'Mission list is updating');
  }

  async airport(ident: string, known?: Icao): Promise<Airport> {
    const efb = this.connected(this.efb);
    const source = airportExpression(ident, known);
    const raw = await efb.evaluate(source);
    this.assertCurrent(efb, this.efb);
    try {
      const airport = normalizeAirport(raw);
      if (airport.ident !== ident || airport.icao.type !== 'A' || (known &&
          (airport.icao.region !== known.region || airport.icao.airport !== known.airport))) {
        throw new TypeError('Airport identity mismatch');
      }
      return airport;
    } catch {
      throw new AdapterError('unsupported', 'Airport facility data or identity is unsupported');
    }
  }

  close(): void {
    this.generation++;
    this.main?.close();
    this.efb?.close();
    this.main = null;
    this.efb = null;
    this.session = null;
    this.efbLifetime = null;
    this.mainLifetime = null;
  }

  private connected(client: Evaluator | null): Evaluator {
    if (client === null || this.session === null) {
      throw new CoherentError('transport-loss', 'Simulator connection is unavailable');
    }
    return client;
  }

  private assertCurrent(client: Evaluator, current: Evaluator | null): void {
    if (client !== current || this.session === null) {
      throw new CoherentError('transport-loss', 'Simulator connection was replaced');
    }
  }
}

async function readLifetime(client: Evaluator, id: string): Promise<string | null> {
  let origin: unknown = null;
  try {
    origin = await client.evaluate(lifetimeExpression());
  } catch (error) {
    // Unsupported read-only probes may fall back; uncertain transport failures may not.
    if (!(error instanceof CoherentError) || error.cause === 'transport-loss' || error.cause === 'ack-deadline') throw error;
  }
  return typeof origin === 'number' && Number.isFinite(origin) && origin > 0
    ? JSON.stringify([id, origin]) : null;
}

function normalizeCapture(raw: unknown): Capture {
  const unsupported = () => new AdapterError('unsupported', 'Mission capture data is unsupported');
  if (!isRecord(raw)) throw unsupported();
  if (raw.screen === 'updating') throw new AdapterError('updating', 'Mission list is updating');
  if (typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt))) throw unsupported();
  if (raw.screen === 'inactive' || raw.screen === 'briefing' || raw.screen === 'unsupported') {
    return { screen: raw.screen, observedAt: raw.observedAt, missions: [] };
  }
  if (raw.screen !== 'browse' || !validCount(raw.first) || !validCount(raw.final) || !Array.isArray(raw.items)) throw unsupported();
  if (raw.items.length !== raw.first) throw unsupported();
  let missions;
  try {
    missions = raw.items.map((item, index) => {
      if (!isRecord(item) || item.missionIndex !== index) throw unsupported();
      return normalizeMission(item);
    });
  } catch {
    throw unsupported();
  }
  if (new Set(missions.map(m => m.guid)).size !== missions.length) throw unsupported();
  const firstGuid = missions[0]?.guid ?? null;
  if (raw.first > 0
    ? typeof raw.firstGuid !== 'string' || !raw.firstGuid.trim() ||
      typeof raw.finalFirstGuid !== 'string' || !raw.finalFirstGuid.trim()
    : raw.firstGuid !== null || raw.finalFirstGuid !== null) throw unsupported();
  if (raw.first !== raw.final || raw.firstGuid !== raw.finalFirstGuid) {
    throw new AdapterError('updating', 'Mission list is updating');
  }
  if (raw.firstGuid !== firstGuid) throw unsupported();
  return { screen: 'browse', observedAt: raw.observedAt, missions };
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
