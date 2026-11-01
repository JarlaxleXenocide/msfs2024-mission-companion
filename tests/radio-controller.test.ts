import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioController } from '../src/main/radio-controller';
import type { RadioSimulator } from '../src/simulator/radio-adapter';
import type { RadioSnapshot, RadioAction } from '../src/shared/radio';

const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
class Clock {
  time=0; id=0; timers=new Map<number,{at:number;fn:()=>void}>(); now=()=>this.time;
  setTimeout=(fn:()=>void,ms:number)=>{const id=++this.id;this.timers.set(id,{at:this.time+ms,fn});return id;};
  clearTimeout=(id:unknown)=>{this.timers.delete(id as number);};
  async advance(ms:number) { const end=this.time+ms; for (;;) { const due=[...this.timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!due)break; this.time=due[1].at;this.timers.delete(due[0]);due[1].fn();await flush(); } this.time=end; await flush(); }
}
const sample = ():RadioSnapshot => ({ lifetime:1000,count:1,frequency:120.55,agent:'EXAMPLE',complete:true,
  options:[{id:0,text:'1 - Acknowledge Handoff',enabled:true}],messages:[{index:0,outgoing:false,queued:false,text:'Example 123 contact Example Center on 133.25. Good day.'}] });
class Simulator implements RadioSimulator {
  data=sample(); reads=0; closes=0; connects=0; port=19999; sent:RadioAction[]=[];
  pending:Promise<RadioSnapshot>|null=null; failure:Error|null=null; sendFailure=false;
  async connect(){this.connects++;}
  async read(){this.reads++;if(this.failure)throw this.failure;return this.pending??structuredClone(this.data);}
  async select(_s:RadioSnapshot,a:RadioAction){this.sent.push(a);if(this.sendFailure)throw Error('Unknown outcome');return true;}
  close(){this.closes++;} setPort(value:number){this.port=value;}
}
test('radio is off by default; sequential polling sends one action and disabling stops polling',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  await clock.advance(5000);assert.equal(sim.reads,0);assert.equal(c.getState().enabled,false);
  c.setEnabled(true);await flush();await clock.advance(2000);assert.equal(sim.sent.length,1);
  await clock.advance(10000);assert.equal(sim.sent.length,1);
  c.setEnabled(false);const count=sim.reads;await clock.advance(5000);assert.equal(sim.reads,count);assert.equal(clock.timers.size,0);
});
test('disable during a pending read never sends a late action or overlaps another read',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  let resolve!:(s:RadioSnapshot)=>void;sim.pending=new Promise(r=>resolve=r);
  c.setEnabled(true);await flush();await clock.advance(5000);assert.equal(sim.reads,1);
  c.setEnabled(false);assert.throws(()=>c.setEnabled(true),/pending/i);
  resolve(sample());await flush();assert.equal(sim.sent.length,0);assert.equal(clock.timers.size,0);
});
test('read failure, uncertain submission and session reset turn radio off without retrying',async()=>{
  for(const mode of ['read','send','reset']){
    const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
    if(mode==='read')sim.failure=Error('Disconnected');if(mode==='send')sim.sendFailure=true;
    c.setEnabled(true);await flush();
    if(mode==='reset')sim.data={...sample(),lifetime:2000};
    await clock.advance(3000);assert.equal(c.getState().enabled,false,mode);assert.equal(c.getState().status,'paused');
    const n=sim.reads;await clock.advance(5000);assert.equal(sim.reads,n);assert.ok(sim.sent.length<=1);
  }
});
test('port change disarms radio and applies new port only after outstanding work settles',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  let resolve!:(s:RadioSnapshot)=>void;sim.pending=new Promise(r=>resolve=r);
  c.setEnabled(true);await flush();c.setPort(20000);assert.equal(c.getState().enabled,false);assert.equal(sim.port,19999);
  resolve(sample());await flush();sim.pending=null;c.setEnabled(true);await flush();assert.equal(sim.port,20000);c.stop();
});

test('unchanged idle polls do not republish the mission state',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  sim.data.options=[];let updates=0;c.subscribe(()=>updates++);
  c.setEnabled(true);await flush();const initial=updates;
  await clock.advance(10000);assert.equal(updates,initial);assert.equal(sim.reads,11);c.stop();
});

test('an unconfirmed action retries with backoff while radio assist stays enabled',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  c.setEnabled(true);await flush();await clock.advance(19000);
  assert.equal(sim.sent.length,2);assert.equal(c.getState().enabled,true);
  await clock.advance(31000);assert.equal(sim.sent.length,2);
  await clock.advance(1000);assert.equal(sim.sent.length,3);
  await clock.advance(62000);assert.equal(sim.sent.length,4);
  await clock.advance(62000);assert.equal(sim.sent.length,5);
  assert.equal(c.getState().enabled,true);assert.equal(c.getState().lastShutdown,undefined);c.stop();
});

test('normal app startup uses the default clock without dependency injection',async()=>{
  const sim=new Simulator();sim.data.options=[];
  const c=new RadioController(sim,19999);
  try {
    assert.equal(c.getState().enabled,false);assert.equal(sim.connects,0);
    c.setEnabled(true);await flush();
    assert.equal(sim.connects,1);assert.equal(sim.reads,1);
    assert.equal(c.getState().status,'listening');
  } finally {c.stop();}
});


test('landing clearance stops polling and closes the connection before any further action',async()=>{
  for(const queued of [false,true]) {
    const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
    sim.data.options=[];c.setEnabled(true);await flush();
    sim.data.messages.push({index:1,outgoing:false,queued,text:'Example 123, wind calm, cleared to land runway 25R.'});
    sim.data.count=2;sim.data.options=[{id:0,text:'1 - Acknowledge Landing Clearance',enabled:true}];
    await clock.advance(1000);
    assert.equal(c.getState().enabled,false);assert.equal(c.getState().status,'off');
    assert.match(c.getState().message,/landing clearance/i);assert.equal(sim.closes,1);
    const reads=sim.reads;await clock.advance(60000);
    assert.equal(sim.reads,reads);assert.equal(sim.sent.length,0);assert.equal(clock.timers.size,0);
  }
});

test('approach clearance does not stop radio assist',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  sim.data.messages[0].text='Example 123, cleared ILS runway 25R approach.';
  sim.data.options[0].text='1 - Acknowledge Pattern Entry Instructions';
  c.setEnabled(true);await flush();await clock.advance(2000);
  assert.equal(c.getState().enabled,true);assert.equal(sim.sent[0]?.kind,'acknowledge-pattern-entry');c.stop();
});

test('a long queued weather broadcast does not time out or count as confirmation of a submitted action',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  c.setEnabled(true);await flush();await clock.advance(2000);assert.equal(sim.sent.length,1);
  sim.data.messages.push({index:1,outgoing:false,queued:true,text:'Example airport information Alpha. Wind calm. Visibility 10. Altimeter 2992.'});
  sim.data.count=2;
  await clock.advance(60000);assert.equal(c.getState().enabled,true);assert.equal(sim.sent.length,1);
  sim.data.messages[1].queued=false;
  await clock.advance(18000);
  assert.equal(c.getState().enabled,true);assert.equal(sim.sent.length,2);c.stop();
});


test('tower tune escapes looping weather, then contact waits for a quiet radio and is sent once',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  sim.data={...sample(),count:3,frequency:126.3,options:[{id:0,text:'1 - [ Tune Example Tower on 118.700 ]',enabled:true}],messages:[
    {index:0,text:'Example 123, contact Example Tower on 118.7.',outgoing:false,queued:false},
    {index:1,text:'Tower on 118.7, Example 123.',outgoing:true,queued:false},
    {index:2,text:'Example airport information Alpha. Wind calm. Altimeter 2992.',outgoing:false,queued:true},
  ]};
  c.setEnabled(true);await flush();await clock.advance(2000);
  assert.deepEqual(sim.sent.map(a=>a.kind),['tune']);
  sim.data.frequency=118.7;sim.data.options[0].text='1 - Contact Example Tower';
  await clock.advance(30000);assert.deepEqual(sim.sent.map(a=>a.kind),['tune']);
  sim.data.messages[2].queued=false;await clock.advance(3000);
  assert.deepEqual(sim.sent.map(a=>a.kind),['tune','contact']);
  sim.data.messages.push({index:3,text:'Example Tower, Example 123, inbound ILS runway 25R.',outgoing:true,queued:false});sim.data.count=4;
  await clock.advance(20000);assert.equal(sim.sent.length,2);assert.equal(c.getState().enabled,true);c.stop();
});

test('repeated weather cycles the radio before pending acknowledgment and the real handoff',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock),events:string[]=[];
  const weather='Example airport information Alpha. Wind calm. Altimeter 2992.';
  Object.assign(sim,{recoverWeather:async()=>{events.push('out-and-back');return 'restored';}});
  const select=sim.select.bind(sim);sim.select=async(s,a)=>{events.push(a.kind);return select(s,a);};
  sim.data.messages.push({index:1,text:weather,outgoing:false,queued:true},{index:2,text:weather,outgoing:false,queued:true});sim.data.count=3;
  c.setEnabled(true);await flush();await clock.advance(1000);
  assert.deepEqual(events,['out-and-back']);
  sim.data.messages.forEach(m=>m.queued=false);await clock.advance(3000);
  assert.deepEqual(events,['out-and-back','acknowledge']);
  sim.data.messages.push({index:3,text:'Going to 133.25, Example 123.',outgoing:true,queued:false});sim.data.count=4;
  sim.data.options[0].text='1 - [ Tune Example Center on 133.250 ]';await clock.advance(3000);
  assert.deepEqual(events,['out-and-back','acknowledge','tune']);c.stop();
});

test('an ineligible weather cycle leaves ordinary ATC handling enabled',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  Object.assign(sim,{recoverWeather:async()=> 'unavailable'});
  const weather='Example airport information Alpha. Wind calm. Altimeter 2992.';
  sim.data.messages.push({index:1,text:weather,outgoing:false,queued:false},{index:2,text:weather,outgoing:false,queued:false});sim.data.count=3;
  c.setEnabled(true);await flush();await clock.advance(4000);
  assert.equal(c.getState().enabled,true);assert.equal(sim.sent[0]?.kind,'acknowledge');c.stop();
});

test('weather recovery does not mistake its round trip for confirmation of an earlier response',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);let cycles=0;
  Object.assign(sim,{recoverWeather:async()=>{cycles++;return 'restored';}});
  c.setEnabled(true);await flush();await clock.advance(2000);assert.equal(sim.sent.length,1);
  const weather='Example airport information Alpha. Wind calm. Altimeter 2992.';
  sim.data.messages.push({index:1,text:weather,outgoing:false,queued:true},{index:2,text:weather,outgoing:false,queued:true});sim.data.count=3;
  await clock.advance(1000);assert.equal(cycles,1);assert.equal(sim.sent.length,1);
  sim.data.messages.forEach(m=>m.queued=false);await clock.advance(18000);
  assert.equal(sim.sent.length,2);assert.equal(c.getState().enabled,true);c.stop();
});

test('diagnostics retain the shutdown reason after re-enabling and capture changed calls and response outcomes',async()=>{
  const sim=new Simulator(),clock=new Clock(),events:any[]=[];
  const c=new RadioController(sim,19999,clock,{record:(event:any)=>events.push(structuredClone(event))});
  c.setEnabled(true);await flush();await clock.advance(2000);
  assert.equal(events.filter(e=>e.type==='snapshot').length,1,'Idle polls must not flood disk');
  assert.equal(events.find(e=>e.type==='action-attempt').action.option.text,'1 - Acknowledge Handoff');
  assert.equal(events.find(e=>e.type==='action-result').result,'command-dispatched');
  sim.failure=Error('Socket closed');await clock.advance(1000);
  const shutdown=c.getState().lastShutdown;
  assert.match(shutdown!.reason,/Socket closed/);
  assert.equal(shutdown!.at,3000);
  const event=events.find(e=>e.type==='shutdown');
  assert.equal(event.phase,'reading');assert.equal(event.snapshot.messages[0].text,sim.data.messages[0].text);
  assert.equal(event.pending.action.kind,'acknowledge');
  sim.failure=null;c.setEnabled(true);await flush();assert.deepEqual(c.getState().lastShutdown,shutdown);
  sim.data.messages.push({index:1,text:'Going to 133.25, Example 123.',outgoing:true,queued:false});sim.data.count=2;
  await clock.advance(1000);
  assert.equal(events.at(-1).snapshot.messages.at(-1).outgoing,true);
  c.stop();
});

test('diagnostic write failures never disable or duplicate radio actions',async()=>{
  const sim=new Simulator(),clock=new Clock();
  const c=new RadioController(sim,19999,clock,{record:()=>{throw Error('Disk full');}});
  c.setEnabled(true);await flush();await clock.advance(2000);
  assert.equal(c.getState().enabled,true);assert.equal(sim.sent.length,1);
  assert.match(c.getState().logWarning??'',/Disk full/);c.stop();
});

test('shutdown diagnostics distinguish landing, read failure and session changes, and restore previous reason',async()=>{
  for(const mode of ['landing','read','session']) {
    const events:any[]=[],sim=new Simulator(),clock=new Clock();
    const c=new RadioController(sim,19999,clock,{lastShutdown:{at:1,reason:'Earlier shutdown'},record:e=>events.push(structuredClone(e))});
    assert.equal(c.getState().lastShutdown?.reason,'Earlier shutdown');
    c.setEnabled(true);await flush();
    // A new landing message must have its own index, not overwrite the old call.
    if(mode==='landing'){sim.data.messages[0]=sample().messages[0];sim.data.messages.push({index:1,text:'Example 123, cleared to land runway 25R.',outgoing:false,queued:false});sim.data.count=2;}
    if(mode==='read')sim.failure=Error('Socket closed');
    if(mode==='session')sim.data.lifetime=2000;
    await clock.advance(1000);
    const shutdown=events.find(e=>e.type==='shutdown');
    assert.equal(shutdown.phase,mode==='landing'?'landing-clearance':mode==='read'?'reading':'session-check');
    assert.equal(shutdown.before.lifetime,1000);
    assert.notEqual(c.getState().lastShutdown?.reason,'Earlier shutdown');
    const copy=c.getState();copy.lastShutdown!.reason='tampered';assert.notEqual(c.getState().lastShutdown?.reason,'tampered');
  }
});
test('logs track queued text changes and observed progress without claiming a manual response was automated',async()=>{
  const events:any[]=[],sim=new Simulator(),clock=new Clock();
  const c=new RadioController(sim,19999,clock,{record:e=>events.push(structuredClone(e))});
  c.setEnabled(true);await flush();await clock.advance(2000);
  sim.data.messages.push({index:1,text:'Going to 133.25, Example 123.',outgoing:true,queued:true});sim.data.count=2;
  await clock.advance(1000);assert.equal(events.filter(e=>e.type==='action-progress').length,0);
  sim.data.messages[1].queued=false;await clock.advance(1000);
  assert.equal(events.filter(e=>e.type==='action-progress').length,1);
  assert.equal(events.filter(e=>e.type==='snapshot').length,3);
  assert.match(events.find(e=>e.type==='action-progress').reason,/not proof/);c.stop();
});

test('an asynchronous log warning is published even when radio data stays unchanged',async()=>{
  const sim=new Simulator(),clock=new Clock(),diagnostics={record:()=>{},warning:''};sim.data.options=[];
  const c=new RadioController(sim,19999,clock,diagnostics);let updates=0;c.subscribe(()=>updates++);
  c.setEnabled(true);await flush();const initial=updates;
  diagnostics.warning='Radio log could not be saved: disk full';await clock.advance(1000);
  assert.ok(updates>initial);assert.match(c.getState().logWarning??'',/disk full/);c.stop();
});

const denver = ():RadioSnapshot => ({lifetime:1000,count:2,frequency:134.5,agent:'DENVER',complete:true,
  options:[{id:0,text:'1 - Contact Denver Center',enabled:true}],messages:[
    {index:0,text:'Boeing PAO1111  contact Denver Center on 134.5. Good day.',outgoing:false,queued:false},
    {index:1,text:'Going to 134.5, Boeing PAO1111 . ',outgoing:true,queued:false},
  ]});
test('captured Denver contact retries a no-op and observes the subsequent check-in without duplicating it',async()=>{
  const sim=new Simulator(),clock=new Clock(),events:any[]=[];sim.data=denver();
  const c=new RadioController(sim,19999,clock,{record:e=>events.push(structuredClone(e))});
  c.setEnabled(true);await flush();await clock.advance(19000);
  assert.equal(sim.sent.length,2);assert.equal(c.getState().enabled,true);
  assert.equal(events.filter(e=>e.type==='action-unconfirmed').length,1);
  assert.equal(events.filter(e=>e.type==='action-progress').length,0);
  sim.data.messages.push({index:2,text:'Denver Center, Boeing PAO1111 , FL350.',outgoing:true,queued:true});sim.data.count=3;
  await clock.advance(60000);assert.equal(sim.sent.length,2);
  sim.data.messages[2].queued=false;await clock.advance(1000);
  assert.equal(events.filter(e=>e.type==='action-progress').length,1);
  await clock.advance(120000);assert.equal(sim.sent.length,2);assert.equal(c.getState().enabled,true);c.stop();
});
test('manual check-in during retry stabilization prevents a duplicate command',async()=>{
  const sim=new Simulator(),clock=new Clock();sim.data=denver();const c=new RadioController(sim,19999,clock);
  c.setEnabled(true);await flush();await clock.advance(18000);
  sim.data.messages.push({index:2,text:'Denver Center, Boeing PAO1111 , FL350.',outgoing:true,queued:false});sim.data.count=3;
  await clock.advance(120000);assert.equal(sim.sent.length,1);assert.equal(c.getState().enabled,true);c.stop();
});
test('retries wait for complete data and the enabled matching option, then use its current ID',async()=>{
  for(const mode of ['missing','disabled','incomplete','wrong-frequency']) {
    const sim=new Simulator(),clock=new Clock();sim.data=denver();const c=new RadioController(sim,19999,clock);
    c.setEnabled(true);await flush();await clock.advance(2000);
    if(mode==='missing')sim.data.options=[];
    if(mode==='disabled')sim.data.options[0].enabled=false;
    if(mode==='incomplete')sim.data.complete=false;
    if(mode==='wrong-frequency')sim.data.frequency=132.7;
    await clock.advance(60000);assert.equal(sim.sent.length,1,mode);assert.equal(c.getState().enabled,true,mode);
    sim.data={...denver(),options:[{id:7,text:'1 - Contact Denver Center',enabled:true}]};
    await clock.advance(20000);assert.equal(sim.sent.length,2,mode);assert.equal(sim.sent[1].option.id,7,mode);c.stop();
  }
});
test('frequency changes do not confirm speech and unrelated speech does not confirm a contact',async()=>{
  for(const mode of ['frequency','unrelated-speech']) {
    const sim=new Simulator(),clock=new Clock(),events:any[]=[];sim.data=denver();
    const c=new RadioController(sim,19999,clock,{record:e=>events.push(structuredClone(e))});
    c.setEnabled(true);await flush();await clock.advance(2000);
    if(mode==='frequency')sim.data.frequency=132.7;
    else {sim.data.messages.push({index:2,text:'Salt Lake Center, Boeing PAO1111 , FL350.',outgoing:true,queued:false});sim.data.count=3;}
    await clock.advance(1000);assert.equal(events.filter(e=>e.type==='action-progress').length,0,mode);c.stop();
  }
});
test('tuning is confirmed only by the requested frequency, not speech or a different frequency',async()=>{
  const sim=new Simulator(),clock=new Clock(),events:any[]=[];
  sim.data={...denver(),frequency:128.35,options:[{id:0,text:'1 - [ Tune Denver Center on 134.500 ]',enabled:true}]};
  const c=new RadioController(sim,19999,clock,{record:e=>events.push(structuredClone(e))});
  c.setEnabled(true);await flush();await clock.advance(2000);
  sim.data.frequency=132.7;sim.data.messages.push({index:2,text:'Going to 134.5, Boeing PAO1111.',outgoing:true,queued:false});sim.data.count=3;
  await clock.advance(1000);assert.equal(events.filter(e=>e.type==='action-progress').length,0);
  sim.data.frequency=134.5;await clock.advance(1000);assert.equal(events.filter(e=>e.type==='action-progress').length,1);
  await clock.advance(60000);assert.equal(sim.sent.length,1);assert.equal(c.getState().enabled,true);c.stop();
});
test('a newer instruction replaces the timed-out action instead of retrying the old selection',async()=>{
  const sim=new Simulator(),clock=new Clock();sim.data=denver();const c=new RadioController(sim,19999,clock);
  c.setEnabled(true);await flush();await clock.advance(2000);
  sim.data.messages.push({index:2,text:'Boeing PAO1111, descend and maintain 8000 feet.',outgoing:false,queued:false});sim.data.count=3;
  sim.data.options=[{id:4,text:'1 - Acknowledge Instruction',enabled:true}];
  await clock.advance(17000);assert.deepEqual(sim.sent.map(a=>a.kind),['contact','acknowledge-instruction']);c.stop();
});

test('an old acknowledgment is not retried on a different frequency, and requires fresh stability after returning',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  c.setEnabled(true);await flush();await clock.advance(2000);
  sim.data.frequency=132.7;await clock.advance(60000);
  assert.equal(sim.sent.length,1);assert.equal(c.getState().enabled,true);
  sim.data.frequency=120.55;await clock.advance(2000);assert.equal(sim.sent.length,1);
  await clock.advance(1000);assert.equal(sim.sent.length,2);c.stop();
});
test('a new instruction on the changed frequency can replace an old unconfirmed acknowledgment',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  c.setEnabled(true);await flush();await clock.advance(2000);
  sim.data.frequency=132.7;
  sim.data.messages.push({index:1,text:'Example 123, descend and maintain 8000 feet.',outgoing:false,queued:false});sim.data.count=2;
  sim.data.options=[{id:4,text:'1 - Acknowledge Instruction',enabled:true}];
  await clock.advance(17000);assert.deepEqual(sim.sent.map(a=>a.kind),['acknowledge','acknowledge-instruction']);c.stop();
});
