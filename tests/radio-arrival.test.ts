import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioDecisions } from '../src/domain/radio';
import type { RadioSnapshot } from '../src/shared/radio';

function state(lines: string[], labels: string[], frequency = 118.7): RadioSnapshot {
  return {lifetime:1000,count:lines.length,frequency,agent:'EXAMPLE',complete:true,
    options:labels.map((text,id)=>({id,text,enabled:true})),
    messages:lines.map((text,index)=>({index,text:text.replace(/^>/,''),outgoing:text.startsWith('>'),queued:false}))};
}
function ready(s: RadioSnapshot, engine = new RadioDecisions(), at = 0) {
  engine.next(s,at);return engine.next(s,at+2000);
}
const cases = [
  ['Acknowledge Instruction','Example 123, Climb and maintain FL260, Keep speed not above 280 knots.','acknowledge-instruction'],
  ['Acknowledge Instruction','Example 123, Climb and maintain 15,000 ft.','acknowledge-instruction'],
  ['Acknowledge Descent Clearance','Example 123, descend via EXAMPLE2 to 5,000 ft. Expect ILS runway 25R approach via FIXIT transition.','acknowledge-descent'],
  ['Acknowledge Assigned Approach','Example 123,Maintain present heading and altitude Expect ILS runway 10 approach via FIXIT transition. Cleared to  FIXIT.','acknowledge-assigned-approach'],
  ['Acknowledge Approach Clearance','Example 123, Contact Example Tower on 118.7 when inbound on the approach.','acknowledge-approach'],
  ['Acknowledge Approach Clearance','Example 123, Cleared EXAMPLE1 arrival. Descend and maintain 10,000 ft Expect ILS runway 09 approach.','acknowledge-approach'],
  ['Acknowledge Pattern Entry Instructions','Example 123, Example Tower. Altimeter 2992, Cleared ILS Z runway 09 approach.','acknowledge-pattern-entry'],
  ['Acknowledge Landing Clearance','Example 123, Wind calm, cleared to land runway 09.','acknowledge-landing'],
  ['Acknowledge Ground Handoff','Example 123, contact ground on 121.9.','acknowledge-ground-handoff'],
  ['Acknowledge Taxi Clearance','Example 123, taxi to general aviation parking via taxiway A cross runway 18 A B.','acknowledge-taxi'],
] as const;

test('descent clearance requires descend-via route and altitude, leaving alternate selections alone',()=>{
  const menu=['1 - Acknowledge Descent Clearance','2 - Standby -- [ Select Another Runway for Landing ]','3 - Standby -- [ Select Another Approach ]','4 - Say Again'];
  for(const altitude of ['5,000 ft','5000 feet','FL180']) {
    const instruction=`Example 123, descend via EXAMPLE2 to ${altitude}. Expect RNAV runway 25R approach via FIXIT transition.`;
    assert.equal(ready(state([instruction],menu))?.option.id,0,altitude);
    assert.equal(ready(state([instruction],menu.slice(1))),null);
  }
  for(const text of ['Example 123, descend via EXAMPLE2.',
    'Example 123, descend via to 5,000 ft.',
    'Example 123, descend via   to 5,000 ft.',
    'Example 123, descend and maintain 5,000 ft.',
    'Example 123, Expect ILS runway 25R approach via FIXIT transition.',
    'Example 123, cleared to land runway 25R.']) {
    assert.equal(ready(state([text],menu)),null,text);
  }
});

test('assigned approach selects the acknowledgement without choosing an alternate approach',()=>{
  const menu=['1 - Acknowledge Assigned Approach','2 - Standby -- [ Select Another Approach ]','3 - Say Again'];
  for(const approach of ['ILS','RNAV','visual']) {
    const s=state([`Example 123, Maintain present heading and altitude Expect ${approach} runway 10 approach via FIXIT transition. Cleared to FIXIT.`],menu);
    assert.equal(ready(s)?.option.id,0,approach);
  }
  for(const text of ['Example 123, Expect ILS runway 10 approach.',
    'Example 123, Cleared to FIXIT.',
    'Example 123, Cleared ILS runway 10 approach.',
    'Example 123, Maintain present heading and altitude.',
    'Example 123, cleared to land runway 10.']) {
    assert.equal(ready(state([text],menu)),null,text);
  }
  const assignment='Example 123, Expect ILS runway 10 approach via FIXIT transition. Cleared to FIXIT.';
  assert.equal(ready(state([assignment],['1 - Acknowledge Approach Clearance'])),null,'Assignment is distinct from approach clearance');
  assert.equal(ready(state([assignment],menu.slice(1))),null,'Never select standby or another approach');
});

test('captured arrival labels acknowledge their matching current message',()=>{
  for(const [label,text,kind] of cases) {
    const s=state([text],[`1 - ${label}`,'2 - Say Again']);
    assert.equal(ready(s)?.kind,kind,label);
  }
});

test('all observed reminders preserve acknowledgement identity and renumbering cannot resend',()=>{
  for(const [label,text,kind] of cases) {
    const e=new RadioDecisions();const first=ready(state([text],[`1 - ${label}`]),e)!;
    assert.equal(first?.kind,kind);e.attempted(first);
    for(const reminder of ['please acknowledge.','acknowledge last transmission.','did you hear my last transmission?']) {
      const s=state([text,`Example 123, ${reminder}`],[`3 - ${label}`]);s.options[0].id=2;
      assert.equal(ready(s)?.key,first.key,reminder);
      assert.equal(ready(s,e,3000),null,`${label}: ${reminder}`);
    }
    const newOrder=state([text,`>${text}`,text],[`1 - ${label}`]);
    assert.notEqual(ready(newOrder,e,7000)?.key,first.key,'A new transmission is a new opportunity');
  }
});

test('acknowledgements never reuse answered or superseded messages and reject contradictory menus',()=>{
  for(const [label,text] of cases) {
    const menu=[`1 - ${label}`];
    assert.equal(ready(state([text,'>Read back, Example 123.'],menu)),null,label);
    assert.equal(ready(state([text,'Example 123, hold position.'],menu)),null,label);
    assert.equal(ready(state([text,'>Read back, Example 123.','Example 123, please acknowledge.'],menu)),null,label);
    assert.equal(ready(state([text], [...menu,'2 - Acknowledge Instruction','3 - Acknowledge Landing Clearance'])),null,label);
    const disabled=state([text],menu);disabled.options[0].enabled=false;assert.equal(ready(disabled),null,label);
    const queued=state([text],menu);queued.messages[0].queued=true;assert.equal(ready(queued),null,label);
  }
  assert.equal(ready(state(['Example 123, Cleared ILS runway 09 approach.'],['1 - Acknowledge Landing Clearance'])),null);
  assert.equal(ready(state(['Example 123, cleared to land runway 09.'],['1 - Acknowledge Taxi Clearance'])),null);
  assert.equal(ready(state(['Example 123, Cleared ILS runway 09 approach.'],['1 - Acknowledge Clearance'])),null,'Unobserved label remains manual');
});

test('tower clearance acknowledgement, tune and check-in each follow current native options',()=>{
  const handoff='Example 123, Contact Example Tower on 118.7 when inbound on the approach.';
  const lines=[handoff,'>Tower on 118.7, Example 123.'];
  assert.equal(ready(state([handoff],['1 - Acknowledge Approach Clearance'],126.3))?.kind,'acknowledge-approach');
  assert.equal(ready(state(lines,['1 - [ Tune Example ATIS on 135.800 ]'],126.3)),null);
  assert.equal(ready(state(lines,['1 - [ Tune Example Tower on 118.700 ]'],126.3))?.kind,'tune');
  assert.equal(ready(state(lines,['1 - [ Tune Example Tower on 118.700 ]'],118.7)),null,'Automatic tuning is not repeated');
  assert.equal(ready(state(lines,['1 - Contact Example Tower'],118.7))?.kind,'contact');
  assert.equal(ready(state([...lines,'>Example Tower, Example 123, inbound ILS runway 09.'],['1 - Contact Example Tower'])),null);
});

const landed = [
  'Example 123, cleared to land runway 09.',
  'Example 123, turn next taxiway.',
  'Example 123, contact ground on 121.9.',
  '>Going to 121.9, Example 123.',
];
const taxiMenu=['1 - [ Tune Example ATIS on 135.800 ]','2 - Request Taxi to Parking','3 - Request Taxi to East Parking','4 - [ Taxi for Takeoff Options . . . ]','5 - [Ground Services]'];

test('generic ground handoff matches named Ground, and default taxi request needs no separate contact call',()=>{
  const tuneMenu=['1 - [ Tune Example Ground on 121.900 ]','2 - [ Tune Example ATIS on 135.800 ]'];
  assert.equal(ready(state(landed,tuneMenu))?.kind,'tune');
  assert.equal(ready(state(landed,['1 - [ Tune Example Ground on 120.900 ]'])),null);
  assert.equal(ready(state(landed,[...tuneMenu,'3 - [ Tune Another Ground on 121.900 ]'])),null,'Ambiguous named Ground options');
  const e=new RadioDecisions(),s=state(landed,taxiMenu,121.9);const taxi=ready(s,e)!;
  assert.equal(taxi?.kind,'request-taxi-parking');assert.equal(taxi?.option.text,'2 - Request Taxi to Parking');e.attempted(taxi);
  assert.equal(e.next(s,5000),null);
  const afterContact=state([...landed,'>Example Ground, Example 123.'],taxiMenu,121.9);
  assert.equal(ready(afterContact)?.kind,'request-taxi-parking','Explicit ground check-in, if present, does not preclude requesting taxi');
});

test('taxi request skips manual/automatic completion, departure context, wrong frequency, alternate parking and skipped taxi',()=>{
  for(const extra of ['>Example Ground, Example 123, taxi to parking.',
    'Example 123, taxi to general aviation parking via taxiway A.',
    '>Taxiing to general aviation parking via taxiway A, Example 123.']) {
    assert.equal(ready(state([...landed,extra],taxiMenu,121.9)),null,'Already requested/cleared, including a fresh controller');
  }
  assert.equal(ready(state(landed.slice(2),taxiMenu,121.9)),null,'No post-landing evidence');
  assert.equal(ready(state(landed,taxiMenu,118.7)),null,'Ground is not tuned');
  assert.equal(ready(state(landed,['1 - Request Taxi to East Parking'],121.9)),null);
  assert.equal(ready(state(landed,[],121.9)),null,'Skipping taxi or changing screens never authorizes a request');
  assert.equal(ready(state([...landed,'Example 123 contact Another Center on 130.5.'],taxiMenu,121.9)),null,'New handoff supersedes ground');
});
