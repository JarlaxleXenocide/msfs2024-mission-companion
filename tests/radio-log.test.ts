import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RadioLog } from '../src/main/radio-log';

test('radio history survives restart with shutdown reason and immutable event contents',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radio-log-'));
  try {
    const log=new RadioLog(dir,'test');await log.initialize();
    const event={at:100,type:'shutdown',phase:'reading',reason:'Connection lost'};
    log.record(event);event.reason='mutated';await log.flush();
    const lines=(await readFile(join(dir,'radio.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
    assert.equal(lines.at(-1).reason,'Connection lost');assert.equal(lines.at(-1).version,'test');
    assert.ok(lines.at(-1).session);
    const restored=new RadioLog(dir,'next');await restored.initialize();
    assert.deepEqual(restored.lastShutdown,{at:100,reason:'Connection lost'});await restored.flush();
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('rotation waits for a confirmed Career browser observation, including across restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radio-log-'));
  try {
    const log=new RadioLog(dir,'test',512);await log.initialize();
    log.record({at:1,type:'shutdown',reason:'No progress'});await log.flush();
    for(let i=0;i<20;i++){log.record({at:i+2,type:'snapshot',reason:'x'.repeat(120)});await log.flush();}
    assert.deepEqual((await readdir(dir)).filter(f=>f.endsWith('.jsonl')),['radio.jsonl'],'Size alone cannot rotate an active or unknown flight');
    const next=new RadioLog(dir,'test',512);await next.initialize();await next.flush();
    assert.deepEqual((await readdir(dir)).filter(f=>f.endsWith('.jsonl')),['radio.jsonl'],'Restarting in flight must keep the log intact');
    for(const connection of ['inactive','briefing','connecting','unavailable','unsupported'] as const) {
      next.observeMissionState({connection,stale:false,observedAt:new Date().toISOString()});await next.flush();
    }
    assert.deepEqual((await readdir(dir)).filter(f=>f.endsWith('.jsonl')),['radio.jsonl']);
    for(let flight=0;flight<4;flight++) {
      next.observeMissionState({connection:'ready',stale:false,observedAt:new Date(Date.now()+flight).toISOString()});await next.flush();
      for(let i=0;i<8;i++)next.record({at:i,type:'snapshot',reason:'x'.repeat(120)});
      await next.flush();
    }
    const files=await readdir(dir);assert.deepEqual(files.filter(f=>f.endsWith('.jsonl')).sort(),['radio.1.jsonl','radio.2.jsonl','radio.jsonl']);
    for(const f of files.filter(f=>f.endsWith('.jsonl'))){const text=await readFile(join(dir,f),'utf8');for(const line of text.trim().split('\n'))JSON.parse(line);}
    assert.equal(next.lastShutdown?.reason,'No progress');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('unwritable destination warns without throwing or losing the shutdown held in memory',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radio-log-'));
  try {
    const bad=join(dir,'file');await writeFile(bad,'not a directory');
    const log=new RadioLog(bad,'test');await log.initialize();
    assert.doesNotThrow(()=>log.record({at:1,type:'shutdown',reason:'Lost connection'}));await log.flush();
    assert.match(log.warning??'',/log/i);assert.equal(log.lastShutdown?.reason,'Lost connection');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('burst overflow is bounded and reported, and still preserves the last shutdown',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radio-log-'));
  try {
    const log=new RadioLog(dir,'test');await log.initialize();
    for(let i=0;i<500;i++)log.record({at:i,type:'snapshot',reason:'burst'});
    log.record({at:501,type:'shutdown',reason:'Final reason'});await log.flush();
    const lines=(await readFile(join(dir,'radio.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
    assert.ok(lines.length<140);assert.ok(lines.some(e=>e.type==='log-gap' && e.dropped>0));
    const next=new RadioLog(dir,'test');await next.initialize();assert.equal(next.lastShutdown?.reason,'Final reason');await next.flush();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('a record arriving while an empty drain settles is flushed without waiting for another event',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radio-log-'));
  try {
    const log=new RadioLog(dir,'test');await log.initialize();await log.flush();
    log.observeMissionState({connection:'ready',stale:false,observedAt:new Date().toISOString()});
    log.record({at:7,type:'enabled',reason:'immediate event'});await log.flush();
    assert.match(await readFile(join(dir,'radio.jsonl'),'utf8'),/immediate event/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('rotation drains the completed flight before archiving it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radio-log-'));
  try {
    const log=new RadioLog(dir,'test',512);await log.initialize();await log.flush();
    for(let i=0;i<10;i++)log.record({at:i,type:'snapshot',reason:'flight call '+i+'x'.repeat(100)});
    log.observeMissionState({connection:'ready',stale:false,observedAt:new Date().toISOString()});await log.flush();
    const archived=await readFile(join(dir,'radio.1.jsonl'),'utf8');
    assert.match(archived,/flight call 0/);assert.match(archived,/flight call 9/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('delayed writes cannot rotate using expired or revoked mission-browser evidence',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'radio-log-'));
  let now=1793541600000;t.mock.method(Date,'now',()=>now);
  try {
    const log=new RadioLog(dir,'test',512);await log.initialize();await log.flush();
    for(const mode of ['expired','revoked']) {
      for(let i=0;i<5;i++)log.record({at:i,type:'snapshot',reason:'x'.repeat(120)});
      log.observeMissionState({connection:'ready',stale:false,observedAt:new Date(now).toISOString()});
      if(mode==='expired')now+=6000;
      else log.observeMissionState({connection:'inactive',stale:true,observedAt:null});
      await log.flush();
      assert.deepEqual((await readdir(dir)).filter(f=>f.endsWith('.jsonl')),['radio.jsonl'],mode);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
