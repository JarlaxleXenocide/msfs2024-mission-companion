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
