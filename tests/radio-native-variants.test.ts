import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './fixtures/radio-native-variants.json';
import { RadioDecisions, hasLandingClearance } from '../src/domain/radio';
import type { RadioSnapshot } from '../src/shared/radio';

function snapshot(text:string,menu:string):RadioSnapshot {
  return {lifetime:1,count:1,frequency:124.85,agent:'EXAMPLE',complete:true,
    options:[{id:0,text:menu,enabled:true}],messages:[{index:0,text,outgoing:false,queued:false}]};
}
function decide(s:RadioSnapshot){const d=new RadioDecisions();d.next(s,0);return d.next(s,2000);}
for(const f of fixtures) {
  test(`${f.locale}: native altitude words and numeric formats work in instructions and descent clearances`,()=>{
    assert.equal(decide(snapshot(f.nativeClimb,f.instructionMenu))?.kind,'acknowledge-instruction');
    assert.equal(decide(snapshot(f.nativeDescent,f.descentMenu))?.kind,'acknowledge-descent');
  });
  test(`${f.locale}: localizer condition is acknowledged only with a current enabled response`,()=>{
    for(const text of f.localizerApproaches){const combined=snapshot(text,f.approachMenu);assert.equal(decide(combined)?.kind,'acknowledge-approach',text);assert.equal(hasLandingClearance(combined),false);}
    const s=snapshot(f.localizerInstruction,f.instructionMenu);
    assert.equal(decide(s)?.kind,'acknowledge-instruction');assert.equal(hasLandingClearance(s),false);
    s.options[0].enabled=false;assert.equal(decide(s),null);s.options[0].enabled=true;
    s.messages[0].queued=true;assert.equal(decide(s),null);s.messages[0].queued=false;
    s.messages.push({index:1,text:'Manual readback',outgoing:true,queued:false});s.count=2;assert.equal(decide(s),null);
  });
  test(`${f.locale}: arrival optional sidestep and circling variants remain arrival acknowledgments`,()=>{
    for(const text of f.arrivalVariants){const s=snapshot(text,f.arrivalMenu);assert.equal(hasLandingClearance(s),false);assert.equal(decide(s)?.kind,'acknowledge-arrival',text);}
  });
}
test('localizer clause combines with approach clearance but never implies landing clearance',()=>{
  for(const text of [
    'Boeing PAO4511, Cleared ILS runway 10R approach. Maintain 5,000 ft until established on the localizer.',
    'Boeing PAO4511, Maintain 5,000 ft until established on the localizer. Cleared ILS runway 10R approach.',
  ]){const s=snapshot(text,'Acknowledge Approach Clearance');assert.equal(decide(s)?.kind,'acknowledge-approach');assert.equal(hasLandingClearance(s),false);}
  assert.equal(decide(snapshot('Boeing PAO4511, Maintain 5,000 ft until established on the localizer.','Acknowledge Instruction'))?.kind,'acknowledge-instruction');
});
test('native decimal metre values remain bounded numbers and unknown conditions stay manual',()=>{
  assert.equal(decide(snapshot('Boeing PAO4511, 365,76 m irtifaya yükselin ve koruyun.','Talimatı Kabul Edin'))?.kind,'acknowledge-instruction');
  for(const amount of ['unknown','-304,8','304,8,2','304e8','1234567'])assert.equal(decide(snapshot(`Boeing PAO4511, ${amount} m irtifaya yükselin ve koruyun.`,'Talimatı Kabul Edin')),null);
  for(const text of [
    'Boeing PAO4511, Maintain 5,000 ft until established on something else.',
    'Boeing PAO4511, Do not maintain 5,000 ft until established on the localizer.',
    'Boeing PAO4511, Maintain 5,000 ft until established on the localizer. Cancel that instruction.',
  ])assert.equal(decide(snapshot(text,'Acknowledge Instruction')),null,text);
});
