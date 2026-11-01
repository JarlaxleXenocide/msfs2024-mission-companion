import { RadioWeatherRecovery } from '../domain/radio-weather';
import { hasLandingClearance, RadioDecisions } from '../domain/radio';
import type { RadioSimulator } from '../simulator/radio-adapter';
import type { RadioSnapshot, RadioState } from '../shared/radio';

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
  private awaiting: { state: RadioSnapshot; since: number } | null = null;
  constructor(private readonly simulator: RadioSimulator, private port: number, private readonly clock: Clock = systemClock) {}

  getState(): RadioState { return { ...this.state }; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setEnabled(enabled: boolean): RadioState {
    if (typeof enabled !== 'boolean') throw new TypeError('Radio enabled must be boolean');
    if (enabled === this.state.enabled) return this.getState();
    if (enabled && this.work) throw new Error('A radio operation is still pending. Wait before enabling again.');
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
    this.setEnabled(false); this.port = port;
  }
  stop(): void { this.setEnabled(false); }

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
    try {
      if (!this.current(generation)) return;
      if (!this.connected) {
        this.simulator.setPort(this.port);
        await this.simulator.connect();
        if (!this.current(generation)) return;
        this.connected = true;
      }
      const value = await this.simulator.read();
      if (!this.current(generation)) return;
      const old = this.previous;
      this.previous = value;
      if (old && (old.lifetime !== value.lifetime || value.count < old.count || old.messages.some(m => !m.outgoing &&
        value.messages.some(n => n.index === m.index && !n.outgoing && n.text !== m.text)))) {
        throw new Error('The radio conversation changed session. Enable Radio assist again for this flight.');
      }
      if (hasLandingClearance(value)) {
        this.awaiting = null;
        this.state.enabled = false; this.state.status = 'off'; this.generation++;
        this.state.frequency = value.frequency; this.state.agent = value.agent;
        this.state.latestMessage = value.messages.at(-1)?.text ?? '';
        this.state.message = 'Landing clearance received · Radio assist off. Read back and handle ground radio manually.';
        this.publish();
        return;
      }
      const repeatedWeather = this.weather.next(value);
      if (this.awaiting) {
        const pending = this.awaiting;
        // A broadcast, disabled menu or new incoming message is not confirmation.
        const progressed = Math.abs(value.frequency - pending.state.frequency) >= 0.0005 ||
          value.messages.some(m => m.index >= pending.state.count && m.outgoing && !m.queued);
        if (progressed) this.awaiting = null;
        else if (!value.complete || value.messages.some(m => m.queued)) pending.since = this.clock.now();
        else if (this.clock.now() - pending.since >= 15000) throw new Error('No progress after the last radio action. Check ATC manually before enabling again.');
      }
      this.state.frequency = value.frequency;
      this.state.agent = value.agent;
      this.state.latestMessage = value.messages.at(-1)?.text ?? '';
      this.state.status = !this.awaiting && value.complete && !value.messages.some(m => m.queued) ? 'listening' : 'waiting';
      this.state.message = this.state.status === 'waiting' ? 'Waiting for radio transmission or message data' : 'Listening for supported ATC calls · handoffs, instructions and approach';
      if (repeatedWeather && this.simulator.recoverWeather) {
        this.state.status = 'acting'; this.state.message = 'Repeated weather broadcast · tuning away and back'; this.publish();
        if (!this.current(generation)) return;
        const result = await this.simulator.recoverWeather(value);
        if (result !== 'stale') this.weather.attempted();
        if (!this.current(generation)) return;
        this.decisions.resetStability();
        this.state.status = 'waiting';
        this.state.message = result === 'restored' ? 'Original frequency restored · checking pending ATC response'
          : result === 'unavailable' ? 'Weather recovery unavailable here · handle the weather loop manually' : 'Radio state changed · checking again';
        this.publish();
        return;
      }
      if (this.awaiting) this.decisions.resetStability();
      const action = this.awaiting ? null : this.decisions.next(value, this.clock.now());
      this.publish();
      if (!action || !this.current(generation)) return;
      this.decisions.attempted(action);
      this.state.status = 'acting'; this.state.message = `Sending ${action.option.text.replace(/^\s*\d+\s*-\s*/, '').trim()}`;
      this.publish();
      if (!this.current(generation)) { this.decisions.notSent(action); return; }
      const sent = await this.simulator.select(value, action);
      if (!sent) this.decisions.notSent(action);
      if (!this.current(generation)) return;
      if (sent) {
        this.state.lastAction = action.option.text.replace(/^\s*\d+\s*-\s*/, '').trim();
        this.awaiting = { state: value, since: this.clock.now() };
      }
      this.state.status = 'waiting';
      this.state.message = sent ? 'Action sent · waiting for simulator response' : 'Radio state changed · checking again';
      this.publish();
    } catch (error) {
      if (!this.current(generation)) return;
      this.state.enabled = false; this.state.status = 'paused'; this.generation++;
      this.state.message = error instanceof Error ? `Radio assist paused: ${error.message}` : 'Radio assist paused. Handle radios manually and enable again when ready.';
      this.publish();
    }
  }
  private disconnect(): void { this.simulator.close(); this.connected = false; }
  private clearTimer(): void { this.clock.clearTimeout(this.timer); this.timer = undefined; }
  private publish(): void {
    const next = JSON.stringify(this.state);
    if (next === this.published) return;
    this.published = next;
    for (const listener of this.listeners) listener();
  }
}
