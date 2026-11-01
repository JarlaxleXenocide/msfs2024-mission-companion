import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioWeatherRecovery } from '../src/domain/radio-weather';
import type { RadioSnapshot } from '../src/shared/radio';
const weather='Example airport information Alpha. Wind calm. Altimeter 2992.';
const snapshot=():RadioSnapshot=>({lifetime:1000,count:1,frequency:133.25,agent:'CENTER',complete:true,options:[],messages:[{index:0,text:weather,outgoing:false,queued:false}]});
function add(s:RadioSnapshot,text=weather){s.messages.push({index:s.count++,text,outgoing:false,queued:false});s.messages=s.messages.slice(-10);}
test('weather recovery requires two separate occurrences, not repeated polling or a queue update',()=>{
  const e=new RadioWeatherRecovery(),s=snapshot();
  assert.equal(e.next(s),false);assert.equal(e.next(s),false);
  s.messages[0].queued=true;assert.equal(e.next(s),false);
  s.messages[0].queued=false;add(s);assert.equal(e.next(s),true);
  e.attempted();assert.equal(e.next(s),false);add(s);assert.equal(e.next(s),false,'One cycle per repeated broadcast text');
});
test('approach and descent cues stay latched when they leave the message tail',()=>{
  for(const cue of ['Example 123, descend and maintain FL290.','Example 123, expect ILS runway 25R approach.','Example 123, contact Example Tower on 118.7.']) {
    const e=new RadioWeatherRecovery(),s=snapshot();e.next(s);add(s,cue);e.next(s);
    for(let i=0;i<12;i++){add(s);assert.equal(e.next(s),false);}
  }
});
test('a history gap, session change or incomplete data cannot authorize recovery',()=>{
  for(const mode of ['gap','session','incomplete']) {
    const e=new RadioWeatherRecovery(),s=snapshot();e.next(s);
    if(mode==='gap')for(let i=0;i<12;i++)add(s);
    else add(s);
    if(mode==='session'){s.lifetime=2000;s.messages=s.messages.slice(-1);s.messages[0].index=0;s.count=1;}
    if(mode==='incomplete')s.complete=false;
    assert.equal(e.next(s),false,mode);
  }
});
