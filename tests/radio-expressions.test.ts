import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { radioReadExpression, radioSelectExpression } from '../src/simulator/radio-expressions';
import { parseRadioSnapshot, RadioDecisions } from '../src/domain/radio';

function setup() {
  let hydrated = false;
  const sent: string[] = []; const ranges: number[][] = [];
  const messages = [{ messageContent: 'Example 123 contact Example Center on 133.25. Good day.', outgoing: false, isQueued: false }];
  const data: Record<string, any> = {
    Options: [{ id: 0, content: '1 - Acknowledge Handoff ', enabled: true }], Messages: 1,
    Frequency: { value: 120.55 }, CurrentAgent: 'EXAMPLE',
  };
  const native = { getData(path: string) {
    const key = path.replace('Game/Communication/Atc/', '');
    return { value: key.startsWith('Messages/') ? hydrated ? messages[Number(key.split('/')[1])] : undefined : data[key] };
  } };
  const reader = { listener: native, async getData(path: string) { return native.getData(path).value; },
    async requestRange(_path: string, start: number, size: number) { ranges.push([start, size]); hydrated = true; return messages.length; } };
  const lib = { b: { m_listener: reader, Game: { Communication: { Atc: { SelectOption: { request: async (id: string) => { sent.push(id); } } } } } } };
  const context = { testLib: lib, performance: { timeOrigin: 1000 } };
  const evaluate = (expression: string) => runInNewContext(expression.replace("await import('/Global/lib.js')", 'testLib'), context);
  return { evaluate, ranges, sent, data, messages, context };
}
test('closed-panel capture requests and hydrates a bounded message tail', async () => {
  const f = setup(); const state = parseRadioSnapshot(await f.evaluate(radioReadExpression()));
  assert.deepEqual(f.ranges, [[0, 1]]); assert.equal(state.messages[0].text.includes('133.25'), true);
  assert.equal(state.complete, true); assert.deepEqual(f.sent, []);
});
test('native selection rejects stale menu, frequency, transcript, queued message or lifetime', async () => {
  for (const change of ['menu', 'frequency', 'transcript', 'queued', 'lifetime']) {
    const f = setup(), state = parseRadioSnapshot(await f.evaluate(radioReadExpression()));
    const e = new RadioDecisions(); e.next(state, 0); const action = e.next(state, 2000)!;
    if (change === 'menu') f.data.Options[0].content = '1 - Cancel IFR';
    if (change === 'frequency') f.data.Frequency.value = 133.25;
    if (change === 'transcript') f.messages[0].messageContent = 'Something else';
    if (change === 'queued') f.messages[0].isQueued = true;
    if (change === 'lifetime') f.context.performance.timeOrigin = 2000;
    assert.equal(await f.evaluate(radioSelectExpression(state, action)), false, change);
    assert.deepEqual(f.sent, []);
  }
});
test('native selection sends only the matched option and keeps text as data', async () => {
  const f = setup(), state = parseRadioSnapshot(await f.evaluate(radioReadExpression()));
  const e = new RadioDecisions(); e.next(state, 0); const action = e.next(state, 2000)!;
  assert.equal(await f.evaluate(radioSelectExpression(state, action)), true);
  assert.deepEqual(f.sent, ['0']);
  assert.throws(() => radioSelectExpression(state, { ...action, option: { ...action.option, id: NaN } }));
});

test('native action builder rejects a matching but unsupported option',async()=>{
  const f=setup();f.data.Options[0].content='1 - Cancel IFR';
  const state=parseRadioSnapshot(await f.evaluate(radioReadExpression()));
  assert.throws(()=>radioSelectExpression(state,{kind:'acknowledge',option:state.options[0],key:'forged'}),/Invalid radio action/);
});

test('radio snapshots and pre-submit checks use the older Coherent navigation timestamp when timeOrigin is absent',async()=>{
  const f=setup();(f.context.performance as any).timing={navigationStart:1000};delete (f.context.performance as any).timeOrigin;
  const state=parseRadioSnapshot(await f.evaluate(radioReadExpression()));
  assert.equal(state.lifetime,1000);
  const e=new RadioDecisions();e.next(state,0);const action=e.next(state,2000)!;
  assert.equal(await f.evaluate(radioSelectExpression(state,action)),true);
  (f.context.performance as any).timing.navigationStart=2000;
  assert.equal(await f.evaluate(radioSelectExpression(state,action)),false);
  assert.deepEqual(f.sent,['0']);
});

test('an allowed action key cannot authorize a different menu option',async()=>{
  const f=setup();f.data.Options.push({id:2,content:'3 - Cancel IFR',enabled:true});
  const state=parseRadioSnapshot(await f.evaluate(radioReadExpression()));
  const e=new RadioDecisions();e.next(state,0);const action=e.next(state,2000)!;
  assert.throws(()=>radioSelectExpression(state,{...action,option:state.options[1]}),/Invalid radio action/);
});

test('altitude acknowledgment uses only native SelectOption and refuses a changed instruction',async()=>{
  const f=setup();f.data.Options[0].content='1 - Acknowledge Instruction';
  f.messages[0].messageContent='Example 123, Descend and maintain FL290.';
  const state=parseRadioSnapshot(await f.evaluate(radioReadExpression()));
  const e=new RadioDecisions();e.next(state,0);const action=e.next(state,2000)!;
  assert.equal(action?.kind,'acknowledge-instruction');
  assert.equal(await f.evaluate(radioSelectExpression(state,action)),true);assert.deepEqual(f.sent,['0']);
  f.messages[0].messageContent='Example 123, Maintain present altitude.';
  assert.equal(await f.evaluate(radioSelectExpression(state,action)),false);assert.deepEqual(f.sent,['0']);
});

test('captured clearance labels submit only their option and reject a concurrent manual readback',async()=>{
  for(const [label,text] of [
    ['Acknowledge Instruction','Example 123, Keep speed not above 250 knots.'],
    ['Acknowledge Descent Clearance','Example 123, descend via EXAMPLE2 to 5,000 ft. Expect ILS runway 25R approach via FIXIT transition.'],
    ['Acknowledge Assigned Approach','Example 123,Maintain present heading and altitude Expect ILS runway 10 approach via FIXIT transition. Cleared to  FIXIT.'],
    ['Acknowledge Approach Clearance','Example 123, Contact Example Tower on 118.7 when inbound on the approach.'],
    ['Acknowledge Pattern Entry Instructions','Example 123, Cleared ILS runway 09 approach.'],
  ]) {
    const f=setup();f.data.Options[0].content=`1 - ${label}`;f.messages[0].messageContent=text;
    const s=parseRadioSnapshot(await f.evaluate(radioReadExpression()));const e=new RadioDecisions();e.next(s,0);const action=e.next(s,2000)!;
    assert.ok(action,label);assert.equal(await f.evaluate(radioSelectExpression(s,action)),true);assert.deepEqual(f.sent,['0']);
    f.data.Messages=2;f.messages.push({messageContent:'Read back, Example 123.',outgoing:true,isQueued:false});
    assert.equal(await f.evaluate(radioSelectExpression(s,action)),false);assert.deepEqual(f.sent,['0']);
  }
});

test('native action builder refuses ground and parking options',async()=>{
  const f=setup();f.messages[0].messageContent='Example 123, contact ground on 121.9.';
  for(const label of ['Request Taxi to Parking','Acknowledge Ground Handoff','Acknowledge Taxi Clearance','[ Tune Ground on 121.900 ]']) {
    f.data.Options[0].content=label;
    const s=parseRadioSnapshot(await f.evaluate(radioReadExpression()));
    assert.throws(()=>radioSelectExpression(s,{kind:'tune',option:s.options[0],key:'forged'}),/Invalid radio action/);
    assert.deepEqual(f.sent,[]);
  }
});


test('native tune can leave queued weather but refuses a new queued instruction',async()=>{
  const f=setup();f.data.Options[0].content='1 - [ Tune Example Center on 133.250 ]';
  f.messages.push({messageContent:'Example airport information Alpha. Wind calm. Visibility 10. Altimeter 2992.',outgoing:false,isQueued:true});
  f.data.Messages=2;
  const s=parseRadioSnapshot(await f.evaluate(radioReadExpression()));
  const e=new RadioDecisions();e.next(s,0);const action=e.next(s,2000)!;
  assert.equal(action?.kind,'tune');
  assert.equal(await f.evaluate(radioSelectExpression(s,action)),true);assert.deepEqual(f.sent,['0']);
  f.messages[1].messageContent='Example 123, maintain present altitude.';
  assert.equal(await f.evaluate(radioSelectExpression(s,action)),false);assert.deepEqual(f.sent,['0']);
});

test('localized native selection keeps the exact frequency and transcript guard',async()=>{
  for(const change of ['none','frequency','transcript']){
    const f=setup();f.data.Options[0].content='1 - [Example センター (133250) に合わせる]';
    f.messages[0].messageContent='Example 123 133.250 でExample センターと交信せよ。';
    const s=parseRadioSnapshot(await f.evaluate(radioReadExpression()));const e=new RadioDecisions();e.next(s,0);const action=e.next(s,2000)!;
    assert.equal(action?.kind,'tune');
    if(change==='frequency')f.data.Frequency.value=133.25;
    if(change==='transcript')f.messages[0].messageContent='Example 123 134.250 でExample センターと交信せよ。';
    assert.equal(await f.evaluate(radioSelectExpression(s,action)),change==='none');
    assert.deepEqual(f.sent,change==='none'?['0']:[]);
  }
});
