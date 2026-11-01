import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './fixtures/radio-locales.json';
import { RadioDecisions, hasLandingClearance } from '../src/domain/radio';
import { RadioWeatherRecovery } from '../src/domain/radio-weather';
import type { RadioSnapshot } from '../src/shared/radio';
function state(text: string, menu: string, frequency = 120.55): RadioSnapshot {
  return { lifetime: 1000, count: 1, frequency, agent: 'EXAMPLE', complete: true,
    options: [{ id: 0, text: `1 - ${menu}`, enabled: true }],
    messages: [{ index: 0, text, outgoing: false, queued: false }] };
}
function ready(s: RadioSnapshot, e = new RadioDecisions(), at = 0) { e.next(s,at); return e.next(s,at+2000); }
function add(s: RadioSnapshot,text:string,outgoing=false) { s.messages.push({index:s.count++,text,outgoing,queued:false}); }
for (const f of fixtures) {
  test(`${f.locale}: handoff acknowledgment, station/frequency matching and completed check-in`,()=>{
    assert.equal(ready(state(f.handoff,f.ack))?.kind,'acknowledge');
    assert.equal(ready(state(f.handoff,f.tune))?.kind,'tune');
    assert.equal(ready(state(f.handoff,f.tune,133.25)),null);
    assert.equal(ready(state(f.handoff,f.contact,133.25))?.kind,'contact');
    assert.equal(ready(state(f.handoff,f.contact)),null);
    assert.equal(ready(state(f.handoff,f.tune.replace('250','350'))),null);
    assert.equal(ready(state(f.handoff,f.tune.replace('Example','Other'))),null);
    const s=state(f.handoff,f.contact,133.25);add(s,f.checkin,true);assert.equal(ready(s),null);
    assert.equal(ready(state('Unrelated traffic is taxiing.',f.ack)),null);
  });
  test(`${f.locale}: typed instruction, arrival contexts, reminders and landing cutoff`,()=>{
    for(const [text,menu,kind] of [[f.instruction,f.instructionMenu,'acknowledge-instruction'],[f.heading,f.instructionMenu,'acknowledge-instruction'],[f.pattern,f.patternMenu,'acknowledge-pattern-entry'],[f.descent,f.descentMenu,'acknowledge-descent'],[f.assigned,f.assignedMenu,'acknowledge-assigned-approach'],[f.arrival,f.arrivalMenu,'acknowledge-arrival'],[f.approach,f.approachMenu,'acknowledge-approach']]) {
      const s=state(text,menu);assert.equal(ready(s)?.kind,kind,text);
      s.messages[0].queued=true;assert.equal(ready(s),null);s.messages[0].queued=false;
      s.options[0].enabled=false;assert.equal(ready(s),null);s.options[0].enabled=true;
      add(s,'Manual reply',true);assert.equal(ready(s),null);
    }
    const e=new RadioDecisions(), s=state(f.instruction,f.instructionMenu), first=ready(s,e)!;
    assert.equal(first?.kind,'acknowledge-instruction');e.attempted(first);add(s,f.reminder);
    assert.equal(ready(s)?.key,first.key);assert.equal(ready(s,e,3000),null);
    assert.equal(ready(state(f.instruction.replace('230','fast'),f.instructionMenu)),null);
    assert.equal(hasLandingClearance(state(f.landing,f.instructionMenu)),true,f.landing);
    assert.equal(ready(state(f.landing,f.instructionMenu)),null);
    assert.equal(hasLandingClearance(state(f.approach,f.approachMenu)),false);
    const weather='Example airport information Alpha. Wind calm. Altimeter 2992.';
    const w=state(f.descent,''); const recovery=new RadioWeatherRecovery();recovery.next(w);add(w,weather);recovery.next(w);add(w,weather);assert.equal(recovery.next(w),false);
  });
}
test('independent localized literals cover Unicode digits, word order and station roles',()=>{
  assert.equal(ready(state('Example 123, Descendez à FL１９０.','Accepter consignes'))?.kind,'acknowledge-instruction');
  assert.equal(ready(state('Example 123, rufen Sie Example Center auf 133,250. Guten Tag.','[ Example einstellen Center auf 133.250 ]'))?.kind,'tune');
  assert.equal(ready(state('Example 123 133.250 でExample センターと交信せよ。','[Example センター (133250) に合わせる]'))?.kind,'tune');
  assert.equal(ready(state('Example 123 联系Example森特133.250，','[联络133.250，调频至Example 森特]'))?.kind,'tune');
  assert.equal(ready(state('Example 123, Turn left heading 070.','Acknowledge Instruction'))?.kind,'acknowledge-instruction');
  assert.equal(ready(state('Example 123, Example Tower. Altimeter 2992, Enter left downwind.','Acknowledge Pattern Entry Instructions'))?.kind,'acknowledge-pattern-entry');
  assert.equal(hasLandingClearance(state('Example 123, atterrissage piste 09R autorisé.','')),true);
  assert.equal(hasLandingClearance(state('Example 123, ILS piste 09R autorisé.','')),false);
});
test('unsupported station roles, ambiguous translations and mismatched roles fail closed',()=>{
  for(const role of ['Ground','Departure','ATIS','Unknown']){
    assert.equal(ready(state(`Example 123, contact Example ${role} on 133.250.`,`[ Tune Example ${role} on 133.250 ]`)),null,role);
    assert.equal(ready(state(`Example 123, contact Example ${role} on 133.250.`,'Acknowledge Handoff')),null,role);
  }
  assert.equal(ready(state('Example 123, contact Example Center on 133.250.','[ Tune Example Tower on 133.250 ]')),null);
  assert.equal(ready(state('Example 123联系Example进近133.250，','确认管制移交')),null,'Approach/departure share an indistinguishable translation');
  assert.equal(ready(state('Example 123, contact Center on 133.250.','[ Tune Center on 133.250 ]'))?.kind,'tune');
  assert.equal(ready(state('Example 123, contact Center on 133.250.','Contact Center',133.25))?.kind,'contact');
  assert.equal(ready(state('Example 123, contact Example Center on 133.2500.','Acknowledge Handoff')),null,'Never truncate a frequency');
});
test('localized labels require current context even across languages and collisions',()=>{
  assert.equal(ready(state('Example 123, Descend and maintain FL210.','指示の確認'))?.kind,'acknowledge-instruction');
  const f=fixtures.find(f=>f.locale==='zh-TW')!;
  assert.equal(ready(state(f.arrival,f.approachMenu))?.kind,'acknowledge-arrival','Same label is disambiguated by transcript');
  const s=state(f.instruction,f.instructionMenu);add(s,'Example 123，Example 塔?');assert.equal(ready(s),null,'No semantic reminder words');
  for(const text of ['Example 123, Turn sideways heading 070.','Example 123, Turn left heading 700.', 'Example 123, Descendez à perhaps.', 'Example 123, Expect fire trucks at runway 09.'])assert.equal(ready(state(text,'Accepter consignes')),null,text);
  s.messages=s.messages.slice(0,1);s.count=1;s.options.push({...s.options[0],id:4});assert.equal(ready(s),null);
});
test('bounded unmatched transcript stays manual without pathological matching cost',()=>{
  const s=state('Example 123, '+ 'Maint'.repeat(800), '指示の確認');
  const start=performance.now();for(let i=0;i<20;i++)assert.equal(ready(s),null);
  assert.ok(performance.now()-start<1500,'Bounded messages must remain cheap to reject');
});
test('mixed-language weather never masks a newer operational instruction',()=>{
  const f=fixtures.find(f=>f.locale==='fr-FR')!;
  const s=state(f.handoff,f.tune);
  add(s,'Example airport information Alpha. Wind calm. Altimeter 2992. Example 123, Descendez à FL210.');
  s.messages[1].queued=true;assert.equal(ready(s),null);
});
test('numeric locale forms preserve exact values without accepting truncated Japanese frequency',()=>{
  const f=fixtures.find(f=>f.locale==='ru-RU')!;
  assert.equal(ready(state('Example 123, Снижайтесь и удерживайте высоту ЭЛ210.','Подтвердить получение указания'))?.kind,'acknowledge-instruction');
  const de=fixtures.find(f=>f.locale==='de-DE')!;
  assert.equal(ready(state(de.handoff,de.tune.replace('133.250','133,250')))?.kind,'tune');
  const ja=fixtures.find(f=>f.locale==='ja-JP')!;
  assert.equal(ready(state(ja.handoff,ja.tune.replace('133250','13325'))),null);
  const s=state(f.instruction,f.instructionMenu);s.options[0].text=`１ – ${f.instructionMenu}`;assert.equal(ready(s)?.kind,'acknowledge-instruction');
});
test('unrelated text containing English instruction words is not an authorization',()=>{
  for(const text of ['Weather service reports pilots should keep speed not above 250 knots.', 'Example 123, expect an ambulance; not cleared for approach.', 'Example 123, descend via a route to somewhere at 5000 feet.']) {
    assert.equal(ready(state(text,'指示の確認')),null,text);
  }
});
test('a center handoff with appended traffic cannot authorize weather recovery',()=>{
  const s=state('Example 123 contact Example Center on 133.250. Example 123, Descendez à FL210.','');
  const recovery=new RadioWeatherRecovery();recovery.next(s);
  const weather='Example airport information Alpha. Wind calm. Altimeter 2992.';
  add(s,weather);recovery.next(s);add(s,weather);assert.equal(recovery.next(s),false);
});
for(const f of fixtures) {
  test(`${f.locale}: center, approach and tower handoffs preserve their own station roles`,()=>{
    for(const target of f.stations) {
      const supported=!(f.locale==='zh-CN' && target.role==='approach');
      assert.equal(ready(state(target.handoff,f.ack))?.kind,supported?'acknowledge':undefined,target.role);
      assert.equal(ready(state(target.handoff,target.tune))?.kind,supported?'tune':undefined,target.role);
      assert.equal(ready(state(target.handoff,target.contact,133.25))?.kind,supported?'contact':undefined,target.role);
    }
  });
}
test('handoff authorization requires one complete affirmative message',()=>{
  for(const text of [
    'Example 123, ne contactez pas Example Centre sur 133.250.',
    'Example 123, contactez Example Centre sur 133.250. Contactez Other Centre sur 134.500.',
    'Example 123, contactez Example Centre sur 133.250. Contactez Example Centre sur 133.250.',
    'Example 123, contactez Example Centre sur 133.250. Annulez cette instruction.',
    'Example 123, do not contact Example Center on 133.250.',
    'Example 123, contact Example Center on 133.250. Cancel that instruction.',
    'Example 123, contact Example Center on 133.250. Contact Other Center on 134.500.',
  ]) {
    for(const label of ['Acknowledge Handoff','[ Tune Example Center on 133.250 ]','[ Régler Example Centre sur 133.250 ]']) {
      assert.equal(ready(state(text,label)),null,`${label}: ${text}`);
    }
  }
});
test('complete approach vectors and tower contact envelopes remain actionable',()=>{
  for(const text of [
    'Example 123, Contact Example Tower on 118.700 when inbound on the approach.',
    'Example 123, Turn left heading 070, Descend and maintain 5,000 feet. Contact Example Tower on 118.700.',
    'Example 123, Cleared ILS runway 09 approach. Contact Example Tower on 118.700.',
    'Example 123, Descendez à FL190. Contactez Example Tour sur 118.700.',
  ]) {
    assert.equal(ready(state(text,'Acknowledge Approach Clearance'))?.kind,'acknowledge-approach',text);
    assert.equal(ready(state(text,'[ Tune Example Tower on 118.700 ]'))?.kind,'tune',text);
  }
});
test('supplementary vector fragments preserve an actionable instruction without authorizing themselves',()=>{
  for(const text of [
    'Example 123, Climb and maintain 5,000 feet, Altimeter 2992.',
    'Example 123, Turn right heading 270, Expect FL210.',
    'Example 123, Maintain present altitude, resume own navigation.',
    'Example 123, Keep speed not above 230 knots, proceed on course, Altimeter 2992.',
    'Example 123, Descendez à FL190, Altimètre 2992.',
    'Example 123、降下して、FL190 を維持、FL210 を予期。',
  ])assert.equal(ready(state(text,'Acknowledge Instruction'))?.kind,'acknowledge-instruction',text);
  for(const text of ['Example 123, Altimeter 2992.','Example 123, Expect FL210.','Example 123, resume own navigation.',
    'Example 123, Climb and maintain 5,000 feet, unexpected arbitrary text.'])assert.equal(ready(state(text,'Acknowledge Instruction')),null,text);
});
test('an opaque callsign cannot absorb a negation before the handoff directive',()=>{
  for(const text of ['Do not contact Example Center on 133.250.',
    'Ne contactez pas Example Centre sur 133.250.',
    'Example 123 do not contact Example Center on 133.250.',
    'Example 123 ne contactez pas Example Centre sur 133.250.']) {
    assert.equal(ready(state(text,'Acknowledge Handoff')),null,text);
  }
  for(const text of ['Example 123 heavy contact Example Center on 133.250.',
    'Example G-ABCD contact Example Center on 133.250.',
    'Example N123AB contact Example Center on 133.250.']) {
    assert.equal(ready(state(text,'Acknowledge Handoff'))?.kind,'acknowledge',text);
  }
});
test('abbreviated registrations retain the current Cessna KUN handoff and check-in workflow',()=>{
  const s=state('Cessna KUN contact Marseille Center on 133.250. Good day.','Acknowledge Handoff');
  assert.equal(ready(s)?.kind,'acknowledge');
  s.options[0].text='[ Tune Marseille Center on 133.250 ]';assert.equal(ready(s)?.kind,'tune');
  s.frequency=133.25;s.options[0].text='Contact Marseille Center';assert.equal(ready(s)?.kind,'contact');
  add(s,'Marseille Center, Cessna F-GKUN, FL320.',true);assert.equal(ready(s),null);
  for(const text of ['DO NOT CONTACT Example Center on 133.250.',
    'Cessna KUN do not contact Example Center on 133.250.',
    'Cessna KUN DO NOT CONTACT Example Center on 133.250.'])assert.equal(ready(state(text,'Acknowledge Handoff')),null,text);
});
test('current Cessna KUN screenshot instructions stay supported',()=>{
  assert.equal(ready(state('Cessna KUN, Keep speed not above 250 knots.','Acknowledge Instruction'))?.kind,'acknowledge-instruction');
  assert.equal(ready(state('Cessna KUN, descend via NISA8R to 8,000 ft. Expect ILS Z runway 4R approach via MUS transition.','Acknowledge Descent Clearance'))?.kind,'acknowledge-descent');
  assert.equal(ready(state('Cessna KUN, you are 2300 ft below your assigned altitude. Climb and maintain FL320','Acknowledge Instruction'))?.kind,'acknowledge-instruction');
});

for(const f of fixtures) {
  test(`${f.locale}: descent clearance with vectors to final is acknowledged only in current context`,()=>{
    const s=state(f.descentVectors,f.descentMenu);
    assert.equal(ready(s)?.kind,'acknowledge-descent',f.descentVectors);
    assert.equal(ready(state(f.descentVectors+' Cancel that clearance.',f.descentMenu)),null);
    add(s,'Manual readback',true);assert.equal(ready(s),null);
  });
}
test('captured Seattle TMBRS4 descent with vectors to final survives a reminder',()=>{
  const s=state('Boeing PAO4511 , descend via TMBRS4 to 5,000 ft. Expect ILS runway 10R approach, vectors to final.','Acknowledge Descent Clearance',124.8499984741211);
  s.options.push({id:1,text:'2 - Standby -- [ Select Another Runway for Landing ]',enabled:true},{id:2,text:'3 - Standby -- [ Select Another Approach ]',enabled:true},{id:3,text:'4 - Say Again',enabled:true});
  assert.equal(ready(s)?.kind,'acknowledge-descent');
  add(s,'Boeing PAO4511 , acknowledge last transmission.');assert.equal(ready(s)?.kind,'acknowledge-descent');
  s.options[0].enabled=false;assert.equal(ready(s),null);
});
