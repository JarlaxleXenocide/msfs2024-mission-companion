import { hasLandingClearance, weatherBroadcast } from './radio';
import type { RadioSnapshot } from '../shared/radio';

/** Detect actual repeated transmissions, never repeated samples of one entry. */
export class RadioWeatherRecovery {
  private lifetime = 0;
  private count = 0;
  private blocked = false;
  private readonly seen = new Map<string, number>();
  private readonly repeats = new Set<string>();
  private readonly tried = new Set<string>();
  private candidate = '';

  next(state: RadioSnapshot): boolean {
    if (state.lifetime !== this.lifetime || state.count < this.count) {
      this.lifetime = state.lifetime; this.count = 0; this.blocked = false;
      this.seen.clear(); this.repeats.clear(); this.tried.clear();
    }
    this.candidate = '';
    if (!state.complete) return false;
    if (this.count && state.count - this.count > state.messages.length) this.blocked = true;
    for (const message of state.messages) {
      if (message.index < this.count || message.outgoing) continue;
      if (!weatherBroadcast(message.text) && /\b(?:descend|descent|approach|arrival|tower|ground|taxi|land|landing)\b/i.test(message.text)) this.blocked = true;
      if (!weatherBroadcast(message.text)) continue;
      const text = message.text.trim().replace(/\s+/g, ' ').toLowerCase();
      if (this.seen.has(text)) this.repeats.add(text);
      this.seen.set(text, message.index);
      if (this.seen.size > 32) {
        const oldest = this.seen.keys().next().value!;
        this.seen.delete(oldest); this.repeats.delete(oldest); this.tried.delete(oldest);
      }
    }
    this.count = state.count;
    const latest = state.messages.at(-1);
    if (this.blocked || hasLandingClearance(state) || !latest || latest.outgoing || !weatherBroadcast(latest.text) ||
      state.messages.some(m => m.queued && (m.outgoing || !weatherBroadcast(m.text)))) return false;
    this.candidate = latest.text.trim().replace(/\s+/g, ' ').toLowerCase();
    return this.repeats.has(this.candidate) && !this.tried.has(this.candidate);
  }
  attempted(): void { if (this.candidate) this.tried.add(this.candidate); }
}
