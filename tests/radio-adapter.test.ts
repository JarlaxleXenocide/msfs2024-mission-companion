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

test('weather recovery validates repeated messages and current radio state before opening its write path',async()=>{
  const weather='Example airport information Alpha. Wind calm. Altimeter 2992.';
  for(const mode of ['single','stale','restored','uncertain']) {
    let writes=0,closed=0;
    const state={lifetime:1000,count:mode==='single'?1:2,frequency:133.25,agent:'EXAMPLE',complete:true,options:[],
      messages:[{index:0,text:weather,outgoing:false,queued:false},...(mode==='single'?[]:[{index:1,text:weather,outgoing:false,queued:true}])]};
    const adapter=new RadioAdapter(19999,{discover:async()=> '3',discoverRecovery:async()=> '6',createClient:(_port,id)=>({
      connect:async()=>{},close:()=>{if(id==='6')closed++;},evaluate:async(source:string)=>{
        if(id==='6'){writes++;if(mode==='uncertain')throw new CoherentError('transport-loss','lost');return 'restored';}
        if(source.includes("var count = get('Messages');"))return state;
        if(source.includes('fingerprint(current)'))return mode!=='stale';
        return 1000;
      },
    })});
    await adapter.connect();const s=await adapter.read();
    if(mode==='uncertain'){
      await assert.rejects(adapter.recoverWeather(s),/lost/);adapter.close();await assert.rejects(adapter.connect(),/uncertain/i);
    }else{
      assert.equal(await adapter.recoverWeather(s),mode==='single'?'unavailable':mode==='stale'?'stale':'restored');
      assert.equal(writes,mode==='restored'?1:0);adapter.close();
    }
    if(mode==='restored'||mode==='uncertain')assert.ok(closed>=1);
  }
});
