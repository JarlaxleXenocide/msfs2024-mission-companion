import { CoherentClient, CoherentError, discover } from './coherent';
import type { Evaluator } from './adapter';
import { lifetimeExpression } from './expressions';
import { RadioWeatherRecovery } from '../domain/radio-weather';
import { weatherCycleExpression } from './radio-weather-expressions';
import { radioGuardExpression, radioReadExpression, radioSelectExpression } from './radio-expressions';
import { parseRadioSnapshot } from '../domain/radio';
import type { RadioAction, RadioSnapshot } from '../shared/radio';

export interface RadioSimulator {
  connect(): Promise<void>;
  read(): Promise<RadioSnapshot>;
  select(snapshot: RadioSnapshot, action: RadioAction): Promise<boolean>;
  recoverWeather?(snapshot: RadioSnapshot): Promise<'restored' | 'unavailable' | 'stale'>;
  close(): void;
  setPort(port: number): void;
}
export function discoverRadioPage(input: unknown): string {
  if (!Array.isArray(input)) throw new Error('Radio views unavailable');
  const matches = input.filter(p => {
    if (!p || p.title !== 'notifications' || !Number.isSafeInteger(p.id) || p.id < 0 || typeof p.url !== 'string') return false;
    try {
      const url = new URL(p.url);
      return url.protocol === 'coui:' && url.hostname.toLowerCase() === 'html_ui' && url.pathname === '/Global/notifications.html' &&
        url.searchParams.get('type')?.split('|').includes('SUBTITLES');
    } catch { return false; }
  });
  if (matches.length !== 1) throw new Error('Radio notification view unavailable');
  return String(matches[0].id);
}
interface Dependencies { discover(port: number): Promise<string>; discoverRecovery?(port: number): Promise<string>; createClient(port: number, id: string): Evaluator }
export class RadioAdapter implements RadioSimulator {
  private client: Evaluator | null = null;
  private lifetime: number | null = null;
  private readonly uncertain = new Map<number, number | null>();
  private busy = false;
  private readonly weather = new RadioWeatherRecovery();
  private recoveryClient: Evaluator | null = null;
  constructor(private port: number, private readonly dependencies: Dependencies = {
    discover: async port => {
      const response = await fetch(`http://127.0.0.1:${port}/pagelist.json`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Radio discovery failed');
      return discoverRadioPage(await response.json());
    },
    createClient: (port, id) => new CoherentClient(port, id),
  }) { this.setPort(port); }

  setPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid radio port');
    if (this.busy) throw new Error('Radio operation is pending');
    if (this.port !== port) this.close();
    this.port = port;
  }
  async connect(): Promise<void> {
    if (this.client) return;
    if (this.busy) throw new Error('Radio operation is pending');
    this.busy = true;
    try {
      const id = await this.dependencies.discover(this.port);
      const client = this.dependencies.createClient(this.port, id);
      this.client = client;
      await this.deadline(client.connect(), client);
      const lifetime = await this.deadline(client.evaluate(lifetimeExpression()), client);
      if (typeof lifetime !== 'number' || !Number.isFinite(lifetime) || lifetime <= 0) throw new Error('Radio view lifetime unavailable');
      if (this.uncertain.has(this.port)) {
        const previous = this.uncertain.get(this.port);
        if (previous === null || previous === lifetime) throw new Error('Radio operation outcome is uncertain. A simulator/view restart is required before another attempt.');
        this.uncertain.delete(this.port);
      }
      this.lifetime = lifetime;
    } catch (error) { this.close(); throw error; }
    finally { this.busy = false; }
  }
  async read(): Promise<RadioSnapshot> {
    const value = await this.evaluate(radioReadExpression(), false);
    const snapshot = parseRadioSnapshot(value);
    if (snapshot.lifetime !== this.lifetime) throw new Error('Radio view changed. Reconnect before handling radios.');
    this.weather.next(snapshot);
    return snapshot;
  }
  async select(snapshot: RadioSnapshot, action: RadioAction): Promise<boolean> {
    if (snapshot.lifetime !== this.lifetime) throw new Error('Radio view changed. Reconnect before handling radios.');
    const result = await this.evaluate(radioSelectExpression(snapshot, action), true);
    if (typeof result !== 'boolean') {
      this.uncertain.set(this.port, this.lifetime);
      throw new Error('Radio action outcome is uncertain');
    }
    return result;
  }
  async recoverWeather(snapshot: RadioSnapshot): Promise<'restored' | 'unavailable' | 'stale'> {
    if (snapshot.lifetime !== this.lifetime || !this.weather.next(snapshot)) return 'unavailable';
    if (!await this.evaluate(radioGuardExpression(snapshot), false)) return 'stale';
    let submitted = false;
    try {
      const id = this.dependencies.discoverRecovery ? await this.dependencies.discoverRecovery(this.port) : (await discover(this.port)).efbId;
      const client = this.dependencies.createClient(this.port, id);
      this.recoveryClient = client;
      await this.deadline(client.connect(), client);
      if (!await this.evaluate(radioGuardExpression(snapshot), false)) return 'stale';
      this.weather.attempted(); this.busy = true; submitted = true;
      const result = await this.deadline(client.evaluate(weatherCycleExpression(snapshot.frequency)), client);
      if (result !== 'restored' && result !== 'unavailable') throw new Error('Radio recovery outcome is uncertain. Check radios manually.');
      return result;
    } catch (error) {
      if (submitted) this.uncertain.set(this.port, this.lifetime);
      throw error;
    } finally {
      this.busy = false; this.recoveryClient?.close(); this.recoveryClient = null;
    }
  }
  close(): void { this.recoveryClient?.close(); this.recoveryClient = null; this.client?.close(); this.client = null; this.lifetime = null; }

  private async evaluate(expression: string, action: boolean): Promise<unknown> {
    const client = this.client;
    if (!client || this.busy) throw new Error('Radio connection unavailable or busy');
    const lifetime = this.lifetime;
    this.busy = true;
    try { return await this.deadline(client.evaluate(expression), client); }
    catch (error) {
      if (action || error instanceof CoherentError && (error.cause === 'transport-loss' || error.cause === 'ack-deadline')) this.uncertain.set(this.port, lifetime);
      throw error;
    } finally { this.busy = false; }
  }
  private async deadline<T>(work: Promise<T>, client: Evaluator): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new CoherentError('ack-deadline', 'Radio operation timed out; its outcome may be uncertain'));
          client.close();
        }, 8000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
