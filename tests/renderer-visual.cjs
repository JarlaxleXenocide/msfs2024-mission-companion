// Synthetic QA only. These missions resemble the approved study; they are not live simulator evidence.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const output = resolve(process.env.MSFS_VISUAL_OUTPUT || join(tmpdir(), 'msfs-visual-remediation'));
fs.mkdirSync(output, { recursive: true });
(async () => {
 const browser = await chromium.launch({ headless: process.env.CI === 'true' });
 try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.addInitScript(() => {
   const end = (id, number, designator, physicalM, elevation) => ({id,number,designator,physicalM,thresholdM:0,thresholdElevationM:elevation,physicalElevationM:3,closed:false,ilsMHz:110.3,glideslope:true});
   const proc = (name,type,runwayNumber,runwayDesignator,rnavFlags=0) => ({name,type,runwayNumber,runwayDesignator,rnavFlags,rnpAr:false});
   const airports = [
    { ends:[end('04',4,0,2157.3744,10)],procedures:[proc('ILS 04',4,4,0)] },
    { ends:[end('08R',8,2,3714.5976,2.1336),end('26L',26,1,3714.5976,3.048)],procedures:[proc('ILS 08R',4,8,2),proc('RNAV 08R Z',10,8,2,10),proc('LOC 08R',5,8,2),proc('ILS 26L Y / Z',4,26,1),proc('RNAV 26L Z',10,26,1,10),proc('LOC 26L Z',5,26,1)] },
    { ends:[end('09',9,0,3486.3024,0)],procedures:[proc('VOR/DME 09',11,9,0)] },
    { ends:[end('02',2,0,1062.228,-1)],procedures:[proc('RNAV A',10,0,0)] },
   ];
   const routes=[['#PWO79','VIP taxi flight','KMTJ','KLYH'],['#PWO78','Private charter','KMUO','CYVR'],['#PWO65','Private charter','KSGU','MMQT'],['#PWO83','Private charter','KMUO','I73']];
   const rows=routes.map(([title,activity,departure,destination],i)=>({mission:{guid:title,title,activity,departure,destination,payoutText:'125,000 Cr',payoutCredits:125000,durationText:'1 h 25 min'},facility:{status:'ready',airport:{...airports[i],key:destination,ident:destination,icao:{type:'A',region:'',airport:'',ident:destination}}},decision:{verdict:i<2?'match':i===2?'no-match':'unknown',runwayIds:i<2?airports[i].ends.map(e=>e.id):[],reasons:[]}}));
   let preferences={port:19999,criteria:{categories:['ILS','LPV'],minimumFt:null},matchesOnly:false,compact:false,theme:'clear',appearance:'night',keepOnTop:false,width:1100,height:900};
   let state={session:'SYNTHETIC',revision:1,observedAt:'2026-09-05T19:00:00Z',connection:'ready',stale:false,message:'SYNTHETIC QA — not live simulator data',rows};
   let listener;
   window.visualTest={push:patch=>{state={...state,...patch};listener(state)},rows,calls:0};
   window.companion={getState:async()=>state,getPreferences:async()=>preferences,setPreferences:async p=>(preferences=p),refresh:async()=>{window.visualTest.calls++;if(window.visualTest.failRefresh)throw Error('Synthetic refresh failure')},refreshAirports:async()=>{window.visualTest.calls++},retry:async()=>{window.visualTest.calls++},subscribe:fn=>{listener=fn;return()=>{}}};
  });
  await page.goto(pathToFileURL(resolve('.webpack/x64/renderer/main_window/index.html')).href);
  await page.waitForFunction(()=>document.querySelector('#app').ariaBusy==='false');
  await page.locator('.titlebar .kicker').evaluate(el=>el.textContent='SYNTHETIC QA · CAREER APPROACHES');
  // Polls must not move hit targets or replace unchanged row contents.
  const geometry=()=>page.locator('#refresh, #compact, #search, .expand').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));
  const settled=await geometry();
  await page.locator('.expand').first().focus();
  await page.evaluate(()=>{window.rowMutations=0;new MutationObserver(records=>window.rowMutations+=records.length).observe(document.querySelector('#mission-rows'),{childList:true,subtree:true})});
  for(let i=0;i<4;i++) {
   await page.evaluate(()=>window.visualTest.push({connection:'updating',stale:true,message:'Updating mission list'}));
   assert.deepEqual(await geometry(),settled,'Polling does not move controls or runway buttons');
   await page.evaluate(()=>window.visualTest.push({connection:'ready',stale:false,message:'Current candidates'}));
  }
  assert.equal(await page.evaluate(()=>window.rowMutations),0,'Unchanged rows survive freshness updates');
  assert.equal(await page.locator('.expand').first().evaluate(n=>n===document.activeElement),true,'Polling preserves keyboard focus');
  await page.evaluate(()=>window.visualTest.push({rows:Array.from({length:150},(_,i)=>({...window.visualTest.rows[i%4],mission:{...window.visualTest.rows[i%4].mission,guid:'long-'+i}}))}));
  const footer=await page.locator('.settings-disclosure summary').boundingBox();
  assert.ok(footer.y+footer.height<=900,'Settings footer stays in the viewport with 150 missions');
  await page.locator('.table-scroll').evaluate(n=>n.scrollTop=n.scrollHeight);
  assert.deepEqual(await page.locator('.settings-disclosure summary').boundingBox(),footer,'Mission scrolling does not move footer');
  await page.locator('.settings-disclosure summary').click();
  assert.equal(await page.locator('#theme').isVisible(),true);
  await page.screenshot({path:resolve(output,'long-list-footer.png')});
  await page.locator('.settings-disclosure summary').click();
  await page.evaluate(()=>window.visualTest.push({rows:window.visualTest.rows}));
  await page.locator('.table-scroll').evaluate(n=>n.scrollTop=0);
  await page.locator('.expand').nth(1).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.details-row').count(),1);
  assert.equal(await page.locator('.expand').nth(1).getAttribute('aria-expanded'),'true');
  await page.evaluate(()=>window.visualTest.push({revision:2,rows:[...window.visualTest.rows].reverse()}));
  assert.equal(await page.locator('.expand[aria-expanded=true]').getAttribute('aria-label'),'Hide runway details for #PWO78');
  await page.evaluate(()=>window.visualTest.push({revision:3,rows:window.visualTest.rows}));
  assert.equal(await page.locator('.details-row').count(),1,'Expansion survives new snapshot');
  await page.locator('.expand').nth(0).click();
  assert.equal(await page.locator('.details-row').count(),2,'Multiple independent expansions');
  await page.locator('.expand').nth(0).click();
  await page.locator('.mission-row').nth(1).click();
  await page.locator('.titlebar .kicker').evaluate(el=>el.textContent='SYNTHETIC QA · CAREER APPROACHES');
  const initialHeight=(await page.locator('.mission-row').first().boundingBox()).height;
  for(const theme of ['clear','deck','notes']) for(const appearance of ['night','light']) {
   await page.locator('.settings-disclosure summary').click();
   await page.locator('#theme').selectOption(theme);
   await page.locator('#appearance').selectOption(appearance);
   await page.locator('.settings-disclosure summary').click();
   for(const compact of [false,true]) {
    await page.locator('#compact').setChecked(compact);
    assert.equal(await page.locator('thead th').count(),7);
    assert.equal(await page.locator('.mission-row').count(),4);
    assert.match(await page.locator('.mission-row').first().textContent(),/1 h 25 min.*125,000 Cr/);
    assert.equal(await page.locator('.table-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.locator('.runway-card').count(),2);
    const bad=await page.locator('td, .runway-card, .metric strong, .procedure').evaluateAll(nodes=>nodes.filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.className));
    assert.deepEqual(bad,[],`${theme}/${appearance}/${compact}: text containment`);
    const lowContrast=await page.locator('.selected .secondary, .detail-heading, .badge, #counts').evaluateAll(nodes=>{
     const luminance=color=>color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).reduce((sum,v,i)=>sum+[.2126,.7152,.0722][i]*(v<=.04045?v/12.92:((v+.055)/1.055)**2.4),0);
     return nodes.filter(node=>{
      let parent=node,bg='rgba(0, 0, 0, 0)';
      while(parent && bg==='rgba(0, 0, 0, 0)'){bg=getComputedStyle(parent).backgroundColor;parent=parent.parentElement;}
      const [dark,light]=[luminance(getComputedStyle(node).color),luminance(bg)].sort((a,b)=>a-b);
      return (light+.05)/(dark+.05)<4.5;
     }).map(node=>node.className);
    });
    assert.deepEqual(lowContrast,[],`${theme}/${appearance}: small text contrast`);
    await page.screenshot({path:resolve(output,`${theme}-${appearance}${compact?'-compact':''}.png`),fullPage:true});
   }
  }
  assert.ok((await page.locator('.mission-row').first().boundingBox()).height<initialHeight,'Compact reduces row density');
  assert.equal(await page.evaluate(()=>window.visualTest.calls),0,'Theme/density do not query simulator');
  await page.evaluate(()=>window.visualTest.failRefresh=true);
  await page.locator('#refresh').click();
  assert.equal(await page.locator('#connection-message').isVisible(),true,'Action failure is visible while connected');
  assert.match(await page.locator('#connection-message').textContent(),/Synthetic refresh failure/);
  await page.evaluate(()=>window.visualTest.push({desktop:{backend:'wayland',keepOnTop:'desktop-managed',keepOnTopHelp:'Use KDE Keep above',minimizePolling:'desktop-limited',preferenceWarning:null}}));
  assert.equal(await page.locator('#minimize-help').isVisible(),true,'Native Wayland limitation remains visible with settings collapsed');
  await page.locator('.settings-disclosure summary').click();
  await page.locator('#appearance').selectOption('system');
  for(const colorScheme of ['dark','light']) { await page.emulateMedia({colorScheme}); await page.waitForFunction(mode=>document.documentElement.dataset.mode===mode,colorScheme==='dark'?'night':'light'); }
  await page.locator('.settings-disclosure summary').click();
  await page.locator('#search').fill('cyvr');
  assert.equal(await page.locator('.mission-row').count(),1);
  await page.locator('#search').fill('missing');
  assert.match(await page.locator('.empty-row').textContent(),/current view/);
  await page.locator('#search').fill('');
  await page.locator('#matches-only').check();
  assert.equal(await page.locator('.mission-row').count(),2);
  assert.match(await page.locator('#counts').textContent(),/1 unknown/);
  await page.locator('#matches-only').uncheck();
  const titles=()=>page.locator('.mission-title').allTextContents();
  const sourceOrder=await titles();
  for(const [sort,ascending] of [['destination',['#PWO78','#PWO83','#PWO79','#PWO65']],['title',['#PWO65','#PWO78','#PWO79','#PWO83']],['runway',['#PWO79','#PWO78','#PWO65','#PWO83']]]) {
   const button = page.locator(`[data-sort="${sort}"]`);
   await button.click();
   const descending=sort==='runway'?['#PWO78','#PWO79','#PWO65','#PWO83']:[...ascending].reverse();
   assert.deepEqual(await titles(),descending,sort+' starts descending; unknowns remain last');
   await page.evaluate(()=>window.visualTest.push({revision:10}));
   assert.deepEqual(await titles(),descending,'Polling preserves chosen sorting');
   await button.click();
   assert.deepEqual(await titles(),ascending,sort+' ascending');
   await button.click();
   assert.deepEqual(await titles(),sourceOrder,'Off restores simulator order');
  }
  await page.evaluate(()=>window.visualTest.push({rows:window.visualTest.rows.map((row,i)=>({...row,mission:{...row.mission,durationText:['1h','2h','1h','30min'][i],payoutCredits:[100,10,200,500][i]}}))}));
  const duration = page.locator('[data-sort="duration"]');
  const credits = page.locator('[data-sort="credits"]');
  await duration.focus();
  await page.keyboard.press('Enter');
  await credits.click();
  assert.deepEqual(await titles(),['#PWO78','#PWO65','#PWO79','#PWO83'],'First activated duration stays primary');
  assert.match(await duration.textContent(),/↓ 1/);
  assert.match(await credits.textContent(),/↓ 2/);
  await page.evaluate(()=>window.visualTest.push({revision:11}));
  assert.deepEqual(await titles(),['#PWO78','#PWO65','#PWO79','#PWO83'],'Refresh preserves stacked sorts');
  await duration.click();
  assert.deepEqual(await titles(),['#PWO83','#PWO65','#PWO79','#PWO78']);
  await duration.click();
  assert.deepEqual(await titles(),['#PWO83','#PWO65','#PWO79','#PWO78'],'Removing duration promotes credits');
  assert.match(await credits.textContent(),/↓ 1/);
  await credits.click();
  assert.deepEqual(await titles(),['#PWO78','#PWO79','#PWO65','#PWO83']);
  await credits.click();
  assert.deepEqual(await titles(),sourceOrder);
  await page.evaluate(()=>window.visualTest.push({rows:window.visualTest.rows}));
  for(const connection of ['connecting','updating','unavailable','views-unavailable','inactive','briefing','unsupported','stalled']) {
   await page.evaluate(connection=>window.visualTest.push({connection,stale:true,message:`SYNTHETIC ${connection} state`}),connection);
   assert.match(await page.locator('#connection-label').textContent(),connection==='updating'?/Connected · updating/:/stale/);
   assert.match(await page.locator('#counts').textContent(),/Last known/);
   assert.equal(await page.locator('.message-strip').isVisible(),true);
   await page.screenshot({path:resolve(output,`state-${connection}.png`)});
  }
  await page.evaluate(()=>window.visualTest.push({connection:'ready',stale:false,rows:[]}));
  await page.screenshot({path:resolve(output,'state-empty.png')});
  assert.equal(await page.locator('.mission-row').count(),0);
  assert.match(await page.locator('.empty-row').textContent(),/current Career list is empty/i);
  await page.evaluate(()=>window.visualTest.push({rows:window.visualTest.rows.map(row=>({...row,facility:{status:'pending'},decision:null}))}));
  assert.match(await page.locator('#counts').textContent(),/4 pending/);
  await page.screenshot({path:resolve(output,'state-loading.png')});
  await page.evaluate(()=>window.visualTest.push({rows:window.visualTest.rows}));
  await page.locator('#compact').uncheck();
  await page.locator('.expand').nth(1).click();
  for(const width of [760,450]) {
   await page.setViewportSize({width,height:900});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Page fits narrow window');
   assert.equal(await page.locator('.table-scroll').evaluate(el=>el.scrollWidth>el.clientWidth),true,'Table minimum plus reserved scrollbar scrolls at narrow widths');
   await page.screenshot({path:resolve(output,`width-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:450,height:400});
  await page.locator('.settings-disclosure summary').click();
  const shortFooter=await page.locator('.settings-footer').boundingBox();
  assert.ok(shortFooter.y+shortFooter.height<=400,`Open footer fits a short window: ${JSON.stringify(shortFooter)}`);
  await page.locator('#retry').scrollIntoViewIfNeeded();
  const retryBox=await page.locator('#retry').boundingBox();
  assert.ok(retryBox.y>=0 && retryBox.y+retryBox.height<=400,'Lower footer controls remain reachable');
  console.log('Synthetic visual/interaction checks passed; screenshots: '+output);
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
