import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppState } from '../shared/model';
import type { RadioAction, RadioShutdown, RadioSnapshot } from '../shared/radio';

export interface RadioEvent {
  at: number;
  type: string;
  reason?: string;
  phase?: string;
  result?: string;
  action?: RadioAction;
  snapshot?: RadioSnapshot | null;
  before?: RadioSnapshot | null;
  pending?: { state: RadioSnapshot; since: number; action: RadioAction } | null;
}
export interface RadioDiagnostics {
  readonly path?: string;
  readonly lastShutdown?: RadioShutdown;
  readonly warning?: string;
  record(event: RadioEvent): void;
}
/** Uses existing controller observations only; disk work never blocks radio I/O. */
export class RadioLog implements RadioDiagnostics {
  readonly path: string;
  lastShutdown?: RadioShutdown;
  warning?: string;
  private readonly session = randomUUID();
  private readonly queue: string[] = [];
  private work: Promise<void> | null = null;
  private shutdownDirty = false;
  private dropped = 0;
  private bytes = 0;
  private rotationPending = false;
  private lastBrowserObservation: string | null = null;
  constructor(private readonly directory: string, readonly version: string, readonly maxBytes = 5 * 1024 * 1024) {
    this.path = join(directory, 'radio.jsonl');
  }
  async initialize(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const value = JSON.parse(await readFile(join(this.directory, 'last-shutdown.json'), 'utf8'));
        if (!value || !Number.isFinite(value.at) || typeof value.reason !== 'string' || value.reason.length > 16384) throw new Error('Invalid saved shutdown');
        this.lastShutdown = { at: value.at, reason: value.reason };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failed(error); }
      try { this.bytes = (await stat(this.path)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch (error) { this.failed(error); }
    this.record({ at: Date.now(), type: 'app-start', reason: 'Capture starts when Radio assist is enabled' });
  }
  record(event: RadioEvent): void {
    if (event.type === 'shutdown' && event.reason) {
      this.lastShutdown = { at: event.at, reason: event.reason };
      this.shutdownDirty = true;
    }
    // Serialize now so later simulator/state mutation cannot rewrite history.
    const line = this.line(event);
    if (this.queue.length >= 128 || Buffer.byteLength(line) > Math.min(this.maxBytes, 1024 * 1024)) {
      this.dropped++;
      this.warning = 'Radio log has gaps: the write queue or event size limit was exceeded.';
    } else this.queue.push(line);
    this.start();
  }
  observeMissionState(state: Pick<AppState, 'connection' | 'stale' | 'observedAt'>): void {
    // Inactive/unsupported does NOT mean on the ground. Never infer a flight end
    // from radio shutdown, landing clearance, disconnection, or process startup.
    if (state.connection !== 'ready' || state.stale || !state.observedAt) {
      this.rotationPending = false;
      return;
    }
    const age = Date.now() - Date.parse(state.observedAt);
    if (!Number.isFinite(age) || age < -1000 || age > 5000 || state.observedAt === this.lastBrowserObservation) return;
    this.lastBrowserObservation = state.observedAt;
    this.rotationPending = true;
    this.start();
  }
  private start(): void {
    if (!this.work) this.work = this.drain().finally(() => {
      this.work = null;
      if (this.queue.length || this.dropped || this.shutdownDirty || this.rotationPending) this.start();
    });
  }
  async flush(): Promise<void> { while (this.work) await this.work; }
  private line(event: object): string { return JSON.stringify({ ...event, session: this.session, version: this.version }) + '\n'; }
  private failed(error: unknown): void {
    this.warning = `Radio log could not be saved: ${error instanceof Error ? error.message : String(error)}`;
  }
  private async drain(): Promise<void> {
    while (this.queue.length || this.dropped || this.shutdownDirty || this.rotationPending) {
      if (this.rotationPending && !this.queue.length && !this.dropped && !this.shutdownDirty) {
        this.rotationPending = false;
        const age = Date.now() - Date.parse(this.lastBrowserObservation ?? '');
        if (Number.isFinite(age) && age >= -1000 && age <= 5000 && this.bytes >= this.maxBytes) {
          try { await this.rotate(); }
          catch (error) { this.failed(error); }
        }
      }
      // Preserve the most recent shutdown even if transcript logging overflowed.
      if (this.shutdownDirty) {
        this.shutdownDirty = false;
        const saved = JSON.stringify(this.lastShutdown);
        try {
          const temporary = join(this.directory, 'last-shutdown.tmp');
          await writeFile(temporary, saved, { mode: 0o600 });
          await rename(temporary, join(this.directory, 'last-shutdown.json'));
        } catch (error) { this.failed(error); }
      }
      const line = this.queue.shift();
      if (line) {
        try { await this.append(line); }
        catch (error) { this.failed(error); this.dropped++; }
      } else if (this.dropped) {
        const dropped = this.dropped; this.dropped = 0;
        try { await this.append(this.line({ at: Date.now(), type: 'log-gap', dropped })); }
        catch (error) { this.failed(error); }
      }
    }
  }
  private async rotate(): Promise<void> {
    await rm(join(this.directory, 'radio.2.jsonl'), { force: true });
    for (const [from, to] of [['radio.1.jsonl', 'radio.2.jsonl'], ['radio.jsonl', 'radio.1.jsonl']]) {
      try { await rename(join(this.directory, from), join(this.directory, to)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.bytes = 0;
  }
  private async append(line: string): Promise<void> {
    const length = Buffer.byteLength(line);
    await appendFile(this.path, line, { mode: 0o600 });
    this.bytes += length;
  }
}
