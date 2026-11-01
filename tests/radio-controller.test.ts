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

test('a submitted action with no observable simulator progress pauses instead of retrying',async()=>{
  const sim=new Simulator(),clock=new Clock(),c=new RadioController(sim,19999,clock);
  c.setEnabled(true);await flush();await clock.advance(18000);
  assert.equal(sim.sent.length,1);assert.equal(c.getState().enabled,false);
  assert.match(c.getState().message,/no progress/i);
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
  await clock.advance(16000);
  assert.equal(c.getState().enabled,false);assert.match(c.getState().message,/no progress/i);
  assert.equal(sim.sent.length,1,'Unconfirmed submission is never blindly retried');
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
  sim.data.messages.forEach(m=>m.queued=false);await clock.advance(16000);
  assert.equal(sim.sent.length,1);assert.equal(c.getState().enabled,false);assert.match(c.getState().message,/no progress/i);
});
