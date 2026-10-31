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

// Reminders retain the original instruction identity. An outgoing reply or any
// unrelated newer instruction ends the prior acknowledgment opportunity.
function latestUnanswered(messages: RadioMessage[]): RadioMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.outgoing) return null;
    if (/^(?:[^,]+,\s*)?(?:please acknowledge|acknowledge last transmission|did you hear my last transmission)[.!?]?\s*$/i.test(message.text.trim())) continue;
    return message;
  }
  return null;
}
interface Handoff { message: RadioMessage; name: string; frequency: number; ground: boolean }
function handoff(message: RadioMessage): Handoff | null {
  if (message.outgoing) return null;
  const match = message.text.match(/\bcontact\s+(.+?)\s+on\s+(\d{3}\.\d{1,3})\b/i);
  if (!match || Number(match[2]) < 118 || Number(match[2]) > 137) return null;
  const name = match[1].trim();
  return {message, name, frequency:Number(match[2]), ground:/\bground$/i.test(name)};
}
function sameStation(name: string, target: Handoff): boolean {
  return target.name.toLowerCase() === 'ground' ? /^(?:.+\s+)?ground$/i.test(name.trim())
    : name.trim().toLowerCase() === target.name.toLowerCase();
}
const altitudeInstruction = (text: string) => /\b(?:(?:climb|descend) and maintain (?:FL\s*\d{1,3}|\d[\d,]*\s*(?:ft|feet))|maintain (?:present|current) altitude)\b/i.test(text);
const approachClearance = (text: string) => /\bcleared\b.*\b(?:arrival|approach)\b/i.test(text);
const landingClearance = (text: string) => /\bcleared to land\b/i.test(text);
const parkingTaxi = (text: string) => /\btaxi(?:ing)? to\b.*\bparking\b/i.test(text);
const acknowledgments = new Map<string, RadioAction['kind']>([
  ['acknowledge handoff','acknowledge'],
  ['acknowledge instruction','acknowledge-instruction'],
  ['acknowledge approach clearance','acknowledge-approach'],
  ['acknowledge pattern entry instructions','acknowledge-pattern-entry'],
  ['acknowledge landing clearance','acknowledge-landing'],
  ['acknowledge ground handoff','acknowledge-ground-handoff'],
  ['acknowledge taxi clearance','acknowledge-taxi'],
]);
function matchesAcknowledgment(kind: RadioAction['kind'], message: RadioMessage): boolean {
  const target = handoff(message);
  switch (kind) {
    case 'acknowledge': return !!target && !target.ground;
    case 'acknowledge-instruction': return altitudeInstruction(message.text);
    case 'acknowledge-approach': return approachClearance(message.text) || !!target && /\btower$/i.test(target.name);
    case 'acknowledge-pattern-entry': return /\bcleared\b.*\bapproach\b/i.test(message.text);
    case 'acknowledge-landing': return landingClearance(message.text);
    case 'acknowledge-ground-handoff': return !!target?.ground;
    case 'acknowledge-taxi': return parkingTaxi(message.text);
    default: return false;
  }
}
function action(state: RadioSnapshot, message: RadioMessage, kind: RadioAction['kind'], option: RadioOption): RadioAction {
  return {kind, option, key:JSON.stringify([state.lifetime, message.index, message.text, kind])};
}

/** Only the menu, transcript and actual radio state authorize a radio response. */
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
    const unanswered = latestUnanswered(state.messages);
    const offeredAcks = state.options.filter(o => acknowledgments.has(clean(o.text).toLowerCase()));
    if (offeredAcks.length) {
      const enabled = offeredAcks.filter(o => o.enabled);
      if (!unanswered || enabled.length !== 1 || state.options.some(o => o.enabled &&
          /^(?:Contact .+|\[\s*Tune .+\]|Request Taxi to Parking)$/i.test(clean(o.text)))) return null;
      const option = enabled[0], kind = acknowledgments.get(clean(option.text).toLowerCase())!;
      return matchesAcknowledgment(kind, unanswered) ? action(state, unanswered, kind, option) : null;
    }

    let target: Handoff | null = null;
    for (const message of state.messages) target = handoff(message) ?? target;
    if (!target || unanswered && unanswered.index !== target.message.index) return null;
    const selected = target;
    const later = state.messages.filter(m => m.index > selected.message.index);
    const contacted = later.some(m => m.outgoing && sameStation(m.text.split(',')[0], selected));
    const taxiStarted = target.ground && later.some(m => parkingTaxi(m.text));
    const postLanding = target.ground && state.messages.some(m => !m.outgoing && m.index < selected.message.index &&
      (landingClearance(m.text) || /\bturn next taxiway\b/i.test(m.text)));
    const tuned = sameFrequency(state.frequency, target.frequency);
    const candidates: RadioAction[] = [];
    for (const option of state.options) {
      if (!option.enabled) continue;
      const label = clean(option.text);
      const tune = label.match(/^\[\s*Tune (.+?) on (\d{3}\.\d{1,3})\s*\]$/i);
      if (!contacted && !taxiStarted && tune && sameStation(tune[1], target) && sameFrequency(Number(tune[2]), target.frequency) && !tuned) {
        candidates.push(action(state, target.message, 'tune', option));
      }
      const contact = label.match(/^Contact (.+)$/i);
      if (!contacted && !taxiStarted && contact && sameStation(contact[1], target) && tuned) {
        candidates.push(action(state, target.message, 'contact', option));
      }
      if (/^Request Taxi to Parking$/i.test(label) && postLanding && tuned && !taxiStarted) {
        candidates.push(action(state, target.message, 'request-taxi-parking', option));
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  }
}
