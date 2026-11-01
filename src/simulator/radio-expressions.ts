import { lifetimeExpression } from './expressions';
import { parseRadioSnapshot, RadioDecisions } from '../domain/radio';
import type { RadioAction, RadioSnapshot } from '../shared/radio';

// These fixed expressions use the simulator's own global store and native ATC action.
// No renderer-supplied code or option number reaches this boundary.
const prelude = `
  var lib = await import('/Global/lib.js');
  var descriptor = Object.getOwnPropertyDescriptor(lib.b, 'm_listener');
  if (!descriptor || !descriptor.value) throw Error('Radio store unavailable');
  var reader = descriptor.value;
  var base = 'Game/Communication/Atc/';
  function get(name) { var item = reader.listener.getData(base + name); return item && item.value; }
  function snapshot() {
    var count = get('Messages'), options = get('Options'), frequency = get('Frequency');
    if (!Number.isInteger(count) || count < 0 || count > 1000000 || !Array.isArray(options) || options.length > 30) throw Error('Radio data unavailable');
    var messages = [];
    for (var i = Math.max(0, count - 10); i < count; i++) {
      var m = get('Messages/' + i);
      if (m) messages.push({index:i, text:m.messageContent, outgoing:m.outgoing, queued:m.isQueued});
    }
    return {lifetime:${lifetimeExpression()}, count:count, frequency:frequency && frequency.value,
      agent:get('CurrentAgent'), options:options.map(function(o) { return {id:o.id, text:o.content, enabled:o.enabled}; }),
      messages:messages, complete:messages.length === Math.min(count, 10)};
  }
  function fingerprint(s) {
    return JSON.stringify([s.lifetime, s.count, s.frequency, s.agent, s.complete,
      s.options.map(function(o) { return [o.id,o.text,o.enabled]; }),
      s.messages.map(function(m) { return [m.index,m.text,m.outgoing,m.queued]; })]);
  }
`;
function fingerprint(s: RadioSnapshot): string {
  return JSON.stringify([s.lifetime, s.count, s.frequency, s.agent, s.complete,
    s.options.map(o => [o.id, o.text, o.enabled]), s.messages.map(m => [m.index, m.text, m.outgoing, m.queued])]);
}
export function radioReadExpression(): string {
  return `(async function() { ${prelude}
    var count = get('Messages');
    if (!Number.isInteger(count) || count < 0 || count > 1000000) throw Error('Radio count unavailable');
    if (count > 0) await reader.requestRange(base + 'Messages', Math.max(0, count - 10), Math.min(count, 10));
    return snapshot();
  })()`;
}
export function radioSelectExpression(expected: RadioSnapshot, action: RadioAction): string {
  const state = parseRadioSnapshot(expected);
  const decisions = new RadioDecisions();
  decisions.next(state, 0);
  const allowed = decisions.next(state, 2000);
  if (!allowed || allowed.kind !== action.kind || allowed.key !== action.key ||
      allowed.option.id !== action.option.id || allowed.option.text !== action.option.text) throw new TypeError('Invalid radio action');
  const option = state.options.find(o => o.id === action.option.id && o.text === action.option.text && o.enabled);
  // Recomputing the decision above is the action allowlist; no caller-selected kind bypasses it.
  if (!option || !state.complete) throw new TypeError('Invalid radio action');
  return `(async function() { ${prelude}
    var current = snapshot();
    if (!current.complete || fingerprint(current) !== ${JSON.stringify(fingerprint(state))}) return false;
    ${action.kind === 'tune' ? '// Exact fingerprint and decision allowlist above permit tuning away from queued weather.' : 'if (current.messages.some(function(m) { return m.queued; })) return false;'}
    await lib.b.Game.Communication.Atc.SelectOption.request(${JSON.stringify(String(option.id))});
    return true;
  })()`;
}

/** Read-only guard used immediately before an optional weather recovery cycle. */
export function radioGuardExpression(expected: RadioSnapshot): string {
  const state = parseRadioSnapshot(expected);
  return `(async function() { ${prelude}
    var current = snapshot();
    return current.complete && fingerprint(current) === ${JSON.stringify(fingerprint(state))};
  })()`;
}
