import type { RadioAction, RadioMessage, RadioOption, RadioSnapshot } from '../shared/radio';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid radio data');
  return value as Record<string, unknown>;
}
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new TypeError('Invalid radio index');
  return value as number;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new TypeError('Invalid radio text');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Invalid radio flag');
  return value;
}
export function parseRadioSnapshot(input: unknown): RadioSnapshot {
  const v = object(input);
  if (typeof v.lifetime !== 'number' || !Number.isFinite(v.lifetime) || v.lifetime <= 0 ||
      typeof v.frequency !== 'number' || !Number.isFinite(v.frequency) || v.frequency < 0 || v.frequency > 200) {
    throw new TypeError('Radio view identity or frequency is unavailable');
  }
  const count = integer(v.count, 1_000_000);
  if (!Array.isArray(v.options) || v.options.length > 30 || !Array.isArray(v.messages) || v.messages.length > 10) throw new TypeError('Invalid radio list');
  const options: RadioOption[] = v.options.map(item => {
    const o = object(item);
    return { id: integer(o.id, 10000), text: text(o.text, 1000), enabled: boolean(o.enabled) };
  });
  const messages: RadioMessage[] = v.messages.map(item => {
    const m = object(item);
    return { index: integer(m.index, 1_000_000), text: text(m.text, 4096), outgoing: boolean(m.outgoing), queued: boolean(m.queued) };
  });
  if (new Set(options.map(o => o.id)).size !== options.length || messages.some((m, i) =>
    m.index >= count || m.index < Math.max(0, count - 10) || (i > 0 && m.index <= messages[i - 1].index))) throw new TypeError('Invalid radio identity');
  const complete = boolean(v.complete);
  if (complete && (messages.length !== Math.min(count, 10) || messages.some((m, i) => m.index !== Math.max(0, count - 10) + i))) throw new TypeError('Missing radio messages');
  return { lifetime: v.lifetime, count, frequency: v.frequency, agent: text(v.agent, 256), options, messages, complete };
}

const clean = (value: string) => value.replace(/^\s*\d+\s*-\s*/, '').trim();
const sameFrequency = (a: number, b: number) => Math.abs(a - b) < 0.0005;

/** Only the menu, handoff transcript and actual radio state authorize an action. */
export class RadioDecisions {
  private stable = '';
  private stableSince = 0;
  private readonly attempts = new Set<string>();

  next(state: RadioSnapshot, now: number): RadioAction | null {
    const candidate = this.candidate(state);
    const key = candidate ? JSON.stringify([candidate.key, candidate.option.id, candidate.option.text]) : '';
    if (key !== this.stable) { this.stable = key; this.stableSince = now; }
    return candidate && now - this.stableSince >= 2000 && !this.attempts.has(candidate.key) ? candidate : null;
  }
  attempted(action: RadioAction): void {
    this.attempts.add(action.key);
    if (this.attempts.size > 256) this.attempts.delete(this.attempts.values().next().value!);
  }
  notSent(action: RadioAction): void { this.attempts.delete(action.key); this.stable = ''; }
  resetStability(): void { this.stable = ''; }

  private candidate(state: RadioSnapshot): RadioAction | null {
    if (!state.complete || state.messages.some(m => m.queued)) return null;
    let target: { index: number; name: string; frequency: number; text: string } | null = null;
    for (const m of state.messages) {
      if (m.outgoing) continue;
      const match = m.text.match(/\bcontact\s+(.+?)\s+on\s+(\d{3}\.\d{1,3})\b/i);
      if (match) target = { index: m.index, name: match[1].trim(), frequency: Number(match[2]), text: m.text };
    }
    if (!target || target.frequency < 118 || target.frequency > 137) return null;
    if (sameFrequency(state.frequency, target.frequency) && state.messages.some(m => m.index > target!.index && m.outgoing &&
      m.text.trim().toLowerCase().startsWith(target!.name.toLowerCase() + ','))) return null;
    const candidates: { kind: RadioAction['kind']; option: RadioOption }[] = [];
    for (const option of state.options) {
      if (!option.enabled) continue;
      const label = clean(option.text);
      if (/^Acknowledge Handoff$/i.test(label)) candidates.push({ kind: 'acknowledge', option });
      const tune = label.match(/^\[\s*Tune (.+?) on (\d{3}\.\d{1,3})\s*\]$/i);
      if (tune && tune[1].toLowerCase() === target.name.toLowerCase() && sameFrequency(Number(tune[2]), target.frequency) &&
          !sameFrequency(state.frequency, target.frequency)) candidates.push({ kind: 'tune', option });
      if (label.toLowerCase() === `contact ${target.name}`.toLowerCase() && sameFrequency(state.frequency, target.frequency)) candidates.push({ kind: 'contact', option });
    }
    if (candidates.length !== 1) return null;
    const { kind, option } = candidates[0];
    return { kind, option, key: JSON.stringify([state.lifetime, target.index, target.text, kind]) };
  }
}
