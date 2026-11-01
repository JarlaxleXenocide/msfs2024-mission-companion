import { RadioWeatherRecovery } from '../domain/radio-weather';
import { hasLandingClearance, radioActionProgress, RadioDecisions } from '../domain/radio';
import type { RadioSimulator } from '../simulator/radio-adapter';
import type { RadioAction, RadioSnapshot, RadioState } from '../shared/radio';

import type { RadioDiagnostics, RadioEvent } from './radio-log';

interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void }
const systemClock: Clock = { now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) };

export class RadioController {
  private state: RadioState = { enabled: false, status: 'off', message: 'Radio assist is off', frequency: null, agent: '', latestMessage: '', lastAction: '' };
  private published = JSON.stringify(this.state);
  private readonly listeners = new Set<() => void>();
  private readonly decisions = new RadioDecisions();
  private readonly weather = new RadioWeatherRecovery();
  private work: Promise<void> | null = null;
  private timer: unknown;
  private generation = 0;
  private connected = false;
  private previous: RadioSnapshot | null = null;
  private awaiting: { state: RadioSnapshot; since: number; action: RadioAction; attempt: number; retryReady: boolean } | null = null;
  private observed = '';
  constructor(private readonly simulator: RadioSimulator, private port: number, private readonly clock: Clock = systemClock, private readonly diagnostics?: RadioDiagnostics) {
    if (diagnostics?.lastShutdown) this.state.lastShutdown = { ...diagnostics.lastShutdown };
    this.state.logPath = diagnostics?.path;
  }

  getState(): RadioState { return { ...this.state, lastShutdown: this.state.lastShutdown && { ...this.state.lastShutdown }, logWarning: this.diagnostics?.warning || this.state.logWarning }; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setEnabled(enabled: boolean, reason = 'Disabled by user'): RadioState {
    if (typeof enabled !== 'boolean') throw new TypeError('Radio enabled must be boolean');
    if (enabled === this.state.enabled) return this.getState();
    if (enabled && this.work) throw new Error('A radio operation is still pending. Wait before enabling again.');
    this.record({ type: enabled ? 'enabled' : 'disabled', reason: enabled ? 'Enabled by user; capture resumes' : reason, pending: this.awaiting });
    if (enabled) this.observed = '';
    this.generation++;
    this.clearTimer(); this.decisions.resetStability(); this.awaiting = null;
    this.state.enabled = enabled;
    this.state.status = enabled ? 'connecting' : 'off';
    this.state.message = enabled ? 'Connecting radio assist' : 'Radio assist is off';
    this.publish();
    if (enabled) this.poll();
    else if (!this.work) this.disconnect();
    return this.getState();
  }
  setPort(port: number): void {
    if (this.port === port) return;
    this.setEnabled(false, 'Simulator port changed'); this.port = port;
  }
  stop(): void { this.setEnabled(false, 'Companion stopping'); }

  private poll(): void {
    if (!this.state.enabled || this.work) return;
    const generation = this.generation;
    const work = Promise.resolve().then(() => this.run(generation));
    this.work = work;
    void work.finally(() => {
      if (this.work !== work) return;
      this.work = null;
      if (!this.state.enabled) this.disconnect();
      else this.timer = this.clock.setTimeout(() => this.poll(), 1000);
    });
  }
  private current(generation: number): boolean { return this.state.enabled && generation === this.generation; }
  private async run(generation: number): Promise<void> {
    let phase = 'connecting';
    let before: RadioSnapshot | null = this.previous;
    try {
      if (!this.current(generation)) return;
      if (!this.connected) {
        this.simulator.setPort(this.port);
        await this.simulator.connect();
        if (!this.current(generation)) return;
        this.connected = true;
      }
      phase = 'reading';
      const value = await this.simulator.read();
      if (!this.current(generation)) return;
      const old = this.previous;
      before = old;
      const observed = JSON.stringify(value);
      if (observed !== this.observed) { this.record({ type: 'snapshot', snapshot: value }); this.observed = observed; }
      this.previous = value;
      phase = 'session-check';
      if (old && (old.lifetime !== value.lifetime || value.count < old.count || old.messages.some(m => !m.outgoing &&
        value.messages.some(n => n.index === m.index && !n.outgoing && n.text !== m.text)))) {
        throw new Error('The radio conversation changed session. Enable Radio assist again for this flight.');
      }
      if (hasLandingClearance(value)) {
        this.state.enabled = false; this.state.status = 'off'; this.generation++;
        this.state.frequency = value.frequency; this.state.agent = value.agent;
        this.state.latestMessage = value.messages.at(-1)?.text ?? '';
        this.state.message = 'Landing clearance received · Radio assist off. Read back and handle ground radio manually.';
        this.shutdown('landing-clearance', before);
        this.awaiting = null;
        this.publish();
        return;
      }
      const repeatedWeather = this.weather.next(value);
      if (this.awaiting) {
        phase = 'awaiting-progress';
        const pending = this.awaiting;
        const progressed = radioActionProgress(pending.state, value, pending.action);
        if (progressed) {
          this.record({ type: 'action-progress', action: pending.action, snapshot: value, attempt: pending.attempt,
            reason: 'Requested frequency or outgoing transmission observed; may be manual, not proof that ATC accepted the response' });
          this.awaiting = null;
        } else if (!value.complete || value.messages.some(m => m.queued)) {
          pending.since = this.clock.now(); pending.retryReady = false;
        } else if (!pending.retryReady && this.clock.now() - pending.since >= Math.min(60000, 15000 * 2 ** Math.min(pending.attempt - 1, 2))) {
          this.record({ type: 'action-unconfirmed', action: pending.action, snapshot: value, attempt: pending.attempt,
            reason: 'No expected simulator effect observed; keeping assist enabled and revalidating the current conversation and option before retrying' });
          this.decisions.notSent(pending.action);
          pending.retryReady = true;
        }
      }
      this.state.frequency = value.frequency;
      this.state.agent = value.agent;
      this.state.latestMessage = value.messages.at(-1)?.text ?? '';
      this.state.status = !this.awaiting && value.complete && !value.messages.some(m => m.queued) ? 'listening' : 'waiting';
      const waitingForFrequency = this.awaiting?.retryReady && this.awaiting.action.kind !== 'tune' && Math.abs(value.frequency - this.awaiting.state.frequency) >= 0.0005;
      this.state.message = waitingForFrequency ? 'Last response unconfirmed · waiting for its original radio frequency before retrying'
        : this.awaiting?.retryReady ? 'Last action unconfirmed · waiting for a matching ATC option to retry'
        : this.state.status === 'waiting' ? 'Waiting for radio transmission or message data' : 'Listening for supported ATC calls · handoffs, instructions and approach';
      if (repeatedWeather && this.simulator.recoverWeather) {
        this.state.status = 'acting'; this.state.message = 'Repeated weather broadcast · tuning away and back'; this.publish();
        if (!this.current(generation)) return;
        phase = 'weather-recovery';
        this.record({ type: 'weather-attempt', snapshot: value });
        const result = await this.simulator.recoverWeather(value);
        this.record({ type: 'weather-result', result });
        if (result !== 'stale') this.weather.attempted();
        if (!this.current(generation)) return;
        this.decisions.resetStability();
        this.state.status = 'waiting';
        this.state.message = result === 'restored' ? 'Original frequency restored · checking pending ATC response'
          : result === 'unavailable' ? 'Weather recovery unavailable here · handle the weather loop manually' : 'Radio state changed · checking again';
        this.publish();
        return;
      }
      if (this.awaiting && !this.awaiting.retryReady) this.decisions.resetStability();
      const action = this.awaiting && !this.awaiting.retryReady ? null : this.decisions.next(value, this.clock.now());
      this.publish();
      if (!action || !this.current(generation)) return;
      if (this.awaiting?.action.key === action.key && action.kind !== 'tune' && Math.abs(value.frequency - this.awaiting.state.frequency) >= 0.0005) {
        this.decisions.resetStability();
        return;
      }
      this.decisions.attempted(action);
      this.state.status = 'acting'; this.state.message = `Sending ${action.option.text.replace(/^\s*\d+\s*-\s*/, '').trim()}`;
      this.publish();
      if (!this.current(generation)) { this.decisions.notSent(action); return; }
      phase = 'selecting-response';
      const attempt = this.awaiting?.action.key === action.key ? this.awaiting.attempt + 1 : 1;
      this.record({ type: 'action-attempt', action, snapshot: value, attempt });
      const sent = await this.simulator.select(value, action);
      this.record({ type: 'action-result', action, attempt, result: sent ? 'command-dispatched' : 'stale-not-sent' });
      if (!sent) this.decisions.notSent(action);
      if (!this.current(generation)) return;
      if (sent) {
        this.state.lastAction = action.option.text.replace(/^\s*\d+\s*-\s*/, '').trim();
        this.awaiting = { state: value, since: this.clock.now(), action, attempt, retryReady: false };
      }
      this.state.status = 'waiting';
      this.state.message = sent ? 'Menu command dispatched · waiting for simulator confirmation' : 'Radio state changed · checking again';
      this.publish();
    } catch (error) {
      this.record({ type: 'operation-error', phase, reason: error instanceof Error ? error.message : String(error), snapshot: this.previous, pending: this.awaiting });
      if (!this.current(generation)) return;
      this.state.enabled = false; this.state.status = 'paused'; this.generation++;
      this.state.message = error instanceof Error ? `Radio assist paused: ${error.message}` : 'Radio assist paused. Handle radios manually and enable again when ready.';
      this.shutdown(phase, before);
      this.publish();
    }
  }
  private shutdown(phase: string, before: RadioSnapshot | null): void {
    this.state.lastShutdown = { at: this.clock.now(), reason: this.state.message };
    this.record({ type: 'shutdown', phase, reason: this.state.message, snapshot: this.previous, before, pending: this.awaiting });
  }
  private record(event: Omit<RadioEvent, 'at'>): void {
    try { this.diagnostics?.record({ ...event, at: this.clock.now() }); }
    catch (error) { this.state.logWarning = `Radio logging failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  private disconnect(): void { this.simulator.close(); this.connected = false; }
  private clearTimer(): void { this.clock.clearTimeout(this.timer); this.timer = undefined; }
  private publish(): void {
    const next = JSON.stringify(this.getState());
    if (next === this.published) return;
    this.published = next;
    for (const listener of this.listeners) listener();
  }
}
