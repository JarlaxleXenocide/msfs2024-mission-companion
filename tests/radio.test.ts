import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioDecisions, parseRadioSnapshot } from '../src/domain/radio';
import type { RadioSnapshot } from '../src/shared/radio';

export const snapshot = (text = '1 - Acknowledge Handoff'): RadioSnapshot => ({
  lifetime: 1000, count: 1, frequency: 120.55, agent: 'EXAMPLE', complete: true,
  options: [{ id: 0, text, enabled: true }],
  messages: [{ index: 0, outgoing: false, queued: false, text: 'Example 123 contact Example Center on 133.25. Good day.' }],
});
function ready(engine: RadioDecisions, value: RadioSnapshot, start = 0) {
  assert.equal(engine.next(value, start), null);
  return engine.next(value, start + 2000);
}

test('handoff actions follow current menu and frequency, without repeating an attempted action', () => {
  const e = new RadioDecisions(); const s = snapshot();
  const ack = ready(e, s)!; assert.equal(ack.kind, 'acknowledge'); e.attempted(ack);
  assert.equal(e.next(s, 3000), null);
  s.options[0].text = '1 - [ Tune Example Center on 133.250 ]';
  const tune = ready(e, s, 4000)!; assert.equal(tune.kind, 'tune'); e.attempted(tune);
  s.frequency = 133.25; s.options[0].text = '1 - Contact Example Center';
  const contact = ready(e, s, 8000)!; assert.equal(contact.kind, 'contact'); e.attempted(contact);
  assert.equal(e.next(s, 12000), null);
});

test('automatic/manual steps are skipped; wrong frequency and unrelated actions are never selected', () => {
  for (const label of ['1 - Request vector to next waypoint', '4 - Cancel IFR', '1 - Say Again', '1 - Contact Other Center', '1 - [ Tune Example Center on 130.100 ]']) {
    assert.equal(ready(new RadioDecisions(), snapshot(label)), null);
  }
  const s = snapshot('1 - Contact Example Center');
  assert.equal(ready(new RadioDecisions(), s), null);
  s.frequency = 133.25;
  assert.equal(ready(new RadioDecisions(), s)?.kind, 'contact');
  s.options[0].text = '1 - [ Tune Example Center on 133.250 ]';
  assert.equal(ready(new RadioDecisions(), s), null, 'Already tuned');
});

test('disabled, queued, incomplete and ambiguous menus wait without acting', () => {
  const variants = [snapshot(), snapshot(), snapshot(), snapshot()];
  variants[0].options[0].enabled = false;
  variants[1].messages[0].queued = true;
  variants[2].complete = false;
  variants[3].options.push({ ...variants[3].options[0], id: 1 });
  for (const s of variants) assert.equal(ready(new RadioDecisions(), s), null);
});

test('new handoff to the same center is a new action; a completed check-in prevents old acknowledgement', () => {
  const e = new RadioDecisions(); const s = snapshot(); const first = ready(e, s)!; e.attempted(first);
  s.messages.push({ ...s.messages[0], index: 1, text: 'Example 123 contact Example Center on 132.25. Good day.' }); s.count++;
  const second = ready(e, s, 3000)!; assert.equal(second.kind, 'acknowledge'); assert.notEqual(second.key, first.key);
  s.messages.push({ index: 2, outgoing: true, queued: false, text: 'Example Center, Example 123, FL360.' }); s.count++;
  s.frequency = 132.25;
  assert.equal(ready(new RadioDecisions(), s), null);
});

test('decoder rejects malformed data, missing tail entries, nonfinite frequencies and duplicated IDs', () => {
  assert.deepEqual(parseRadioSnapshot(snapshot()), snapshot());
  for (const value of [null, { ...snapshot(), lifetime: null }, { ...snapshot(), frequency: NaN },
    { ...snapshot(), count: -1 }, { ...snapshot(), options: [{ id: 0, text: 'x', enabled: 'yes' }] },
    { ...snapshot(), options: [snapshot().options[0], snapshot().options[0]] },
    { ...snapshot(), complete: true, messages: [] }]) assert.throws(() => parseRadioSnapshot(value));
  assert.equal(parseRadioSnapshot({ ...snapshot(), complete: false, messages: [] }).complete, false);
});

test('renumbering an already attempted handoff option cannot authorize another response',()=>{
  const e=new RadioDecisions(),s=snapshot();const first=ready(e,s)!;e.attempted(first);
  s.options[0]={id:1,text:'2 - Acknowledge Handoff',enabled:true};
  assert.equal(e.next(s,3000),null);assert.equal(e.next(s,6000),null);
  // A stale guard explicitly returning false is the only way to make this step retryable.
  e.notSent(first);assert.equal(ready(e,s,7000)?.kind,'acknowledge');
});

test('menu renumbering restarts the stabilization delay before an unattempted response',()=>{
  const e=new RadioDecisions(),s=snapshot();e.next(s,0);
  s.options[0]={id:1,text:'2 - Acknowledge Handoff',enabled:true};
  assert.equal(e.next(s,1500),null);assert.equal(e.next(s,3000),null);
  assert.equal(e.next(s,3500)?.option.id,1);
});
