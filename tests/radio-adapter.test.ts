import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioAdapter, discoverRadioPage } from '../src/simulator/radio-adapter';
import { CoherentError } from '../src/simulator/coherent';

test('radio discovery chooses the subtitles notification view, not the panel or main UI',()=>{
  const pages=[{id:2,title:'mainUi',url:'coui://html_UI/Global/mainUI.html'},
    {id:3,title:'notifications',url:'coui://html_UI/Global/notifications.html?type=SUBTITLES|OBJECTIVE'},
    {id:9,title:'notifications',url:'coui://html_UI/Global/notifications.html?type=MESSAGE'}];
  assert.equal(discoverRadioPage(pages),'3');
  assert.throws(()=>discoverRadioPage([...pages,pages[1]]));
  assert.throws(()=>discoverRadioPage([{...pages[1],url:'https://evil.invalid/?type=SUBTITLES'}]));
});
test('uncertain native read cannot be retried in the same view lifetime',async()=>{
  let lifetime=1000,reads=0;
  const adapter=new RadioAdapter(19999,{discover:async()=> '3',createClient:()=>({
    connect:async()=>{},close:()=>{},evaluate:async(source:string)=>{
      if(source.includes('timeOrigin')&&!source.includes('requestRange'))return lifetime;
      reads++;throw new CoherentError('transport-loss','lost');
    },
  })});
  await adapter.connect();await assert.rejects(adapter.read());adapter.close();
  await assert.rejects(adapter.connect(),/uncertain/i);assert.equal(reads,1);
  lifetime=2000;await adapter.connect();adapter.close();
});

test('a replaced view cannot supply an action under the old connection lifetime', async () => {
  let evaluations=0;
  const state={lifetime:2000,count:0,frequency:120,agent:'',options:[],messages:[],complete:true};
  const adapter=new RadioAdapter(19999,{discover:async()=> '3',createClient:()=>({
    connect:async()=>{},close:()=>{},evaluate:async(source:string)=>{evaluations++;return source.includes('requestRange')?state:1000;},
  })});
  await adapter.connect();
  await assert.rejects(adapter.read(),/view changed/i);
  await assert.rejects(adapter.select(state,{kind:'acknowledge',option:{id:0,text:'1 - Acknowledge Handoff',enabled:true},key:''}),/view changed/i);
  assert.equal(evaluations,2);adapter.close();
});
