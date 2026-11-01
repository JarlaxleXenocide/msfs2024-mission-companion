import { localizedAcknowledgments, localizedCheckin, localizedHandoff, localizedInstruction, localizedLanding, localizedOption, localizedOperationalCue, localizedReminder, sameRadioStation, type RadioStation } from './radio-language';
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

const clean = (value: string) => value.normalize('NFKC').replace(/^\s*\p{Nd}+\s*[-–—]\s*/u, '').trim();
const sameFrequency = (a: number, b: number) => Math.abs(a - b) < 0.0005;

/** Observed simulator effects, never proof of automation or ATC acceptance. */
export function radioActionProgress(before: RadioSnapshot, current: RadioSnapshot, attempted: RadioAction): boolean {
  if (before.lifetime !== current.lifetime) return false;
  const target = localizedOption(clean(attempted.option.text));
  if (attempted.kind === 'tune') return target?.kind === 'tune' && sameFrequency(current.frequency, target.frequency!);
  const outgoing = current.messages.filter(m => m.index >= before.count && m.outgoing && !m.queued);
  if (attempted.kind === 'contact') return target?.kind === 'contact' && outgoing.some(m => localizedCheckin(m.text, target.station));
  // A completed outgoing reply ends an acknowledgment opportunity, including a
  // manual reply. Frequency changes and incoming broadcasts do not confirm speech.
  return outgoing.length > 0;
}

// Only clearly identified weather broadcasts are informational. Weather embedded
// in a clearance or instruction must still supersede the previous call.
export function weatherBroadcast(text: string): boolean {
  return /\b(?:airport information [a-z]+|information (?:alpha|alfa|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliett?|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|x-ray|yankee|zulu)|automatic terminal information service|automated weather (?:observation|observing) system)\b/i.test(text) &&
    /\bwind\b/i.test(text) && /\b(?:altimeter|QNH)\b/i.test(text) &&
    !/\b(?:contact|cleared|climb|descend|maintain|hold|taxi|go around)\b/i.test(text.replace(/\bon initial contact\b/gi, '')) && !localizedOperationalCue(text);
}
export function hasLandingClearance(state: RadioSnapshot): boolean {
  return state.messages.some(m => !m.outgoing && (/\bcleared to land\b/i.test(m.text) || localizedLanding(m.text)));
}

// Reminders retain the original instruction identity. An outgoing reply or any
// unrelated newer instruction ends the prior acknowledgment opportunity.
function latestUnanswered(messages: RadioMessage[]): RadioMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.outgoing) return null;
    if (weatherBroadcast(message.text)) continue;
    if (localizedReminder(message.text) || /^(?:[^,]+,\s*)?(?:please acknowledge|acknowledge last transmission|did you hear my last transmission)[.!?]?\s*$/i.test(message.text.trim())) continue;
    return message;
  }
  return null;
}
interface Handoff { message: RadioMessage; frequency: number; supported: boolean; station: RadioStation }
function handoff(message: RadioMessage): Handoff | null {
  if (message.outgoing) return null;
  const target = localizedHandoff(message.text);
  return target ? {message, frequency:target.frequency, supported:['center','approach','tower','departure'].includes(target.role), station:target} : null;
}
function matchesAcknowledgment(kind: RadioAction['kind'], message: RadioMessage): boolean {
  const target = handoff(message);
  switch (kind) {
    case 'acknowledge': return !!target && target.supported;
    case 'acknowledge-arrival': return localizedInstruction(kind, message.text);
    case 'acknowledge-instruction':
    case 'acknowledge-descent':
    case 'acknowledge-assigned-approach':
    case 'acknowledge-pattern-entry': return localizedInstruction(kind, message.text);
    case 'acknowledge-approach': return localizedInstruction(kind, message.text) || !!target && target.station.role === 'tower';
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
    const key = candidate ? JSON.stringify([candidate.key, candidate.option.id, candidate.option.text, state.frequency]) : '';
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
    if (hasLandingClearance(state) || !state.complete) return null;
    const queued = state.messages.filter(m => m.queued);
    // Tuning away from a looping weather station is not a spoken transmission.
    // Every queued entry must be a recognized incoming broadcast for this exception.
    if (queued.some(m => m.outgoing || !weatherBroadcast(m.text))) return null;
    const unanswered = latestUnanswered(state.messages);
    const offeredAcks = state.options.filter(o => localizedAcknowledgments(clean(o.text)).length);
    if (offeredAcks.length) {
      const enabled = offeredAcks.filter(o => o.enabled);
      if (queued.length || !unanswered || enabled.length !== 1 || state.options.some(o => o.enabled &&
          (localizedOption(clean(o.text)) || /^(?:Contact .+|\[\s*Tune .+\]|Request Taxi to Parking)$/i.test(clean(o.text))))) return null;
      const option = enabled[0], kinds = localizedAcknowledgments(clean(option.text)).filter(kind => matchesAcknowledgment(kind, unanswered));
      return kinds.length === 1 ? action(state, unanswered, kinds[0], option) : null;
    }

    let target: Handoff | null = null;
    for (const message of state.messages) target = handoff(message) ?? target;
    if (!target || !target.supported || unanswered && unanswered.index !== target.message.index) return null;
    const selected = target;
    const later = state.messages.filter(m => m.index > selected.message.index);
    const contacted = later.some(m => m.outgoing && localizedCheckin(m.text, selected.station));
    const tuned = sameFrequency(state.frequency, target.frequency);
    const candidates: RadioAction[] = [];
    for (const option of state.options) {
      if (!option.enabled) continue;
      const label = clean(option.text);
      const localized = localizedOption(label);
      if (localized && !contacted && sameRadioStation(localized.station, target.station)) {
        if (localized.kind === 'tune' && !tuned && sameFrequency(localized.frequency!, target.frequency)) candidates.push(action(state,target.message,'tune',option));
        if (localized.kind === 'contact' && tuned && !queued.length) candidates.push(action(state,target.message,'contact',option));
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  }
}
