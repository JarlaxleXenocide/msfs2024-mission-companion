// Synthetic bridge only: never connects to or sends commands to the simulator.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1100,height:760}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      const radio={enabled:false,status:'off',message:'Radio assist is off',frequency:null,agent:'',latestMessage:'',lastAction:''};
      const state={session:null,revision:0,observedAt:null,connection:'inactive',stale:true,message:'Mission scans paused',rows:[],radio};
      const preferences={port:19999,criteria:{categories:['ILS'],minimumFt:null},matchesOnly:false,compact:false,theme:'clear',appearance:'night',keepOnTop:false,width:1100,height:760};
      let listener;window.radioTest={calls:[],refreshes:[],fail:false,push:patch=>{Object.assign(radio,patch);listener(structuredClone(state));}};
      window.companion={getState:async()=>structuredClone(state),getPreferences:async()=>preferences,setPreferences:async v=>v,
        refresh:async()=>{window.radioTest.refreshes.push('scan');},refreshAirports:async()=>{window.radioTest.refreshes.push('airports');},retry:async()=>{},selectRoute:async()=>{},openAttribution:async()=>{},
        setRadioEnabled:async enabled=>{window.radioTest.calls.push(enabled);if(window.radioTest.fail)throw Error('Operation pending');
          window.radioTest.push({enabled,status:enabled?'listening':'off',message:enabled?'Listening for handoffs':'Radio assist is off'});return structuredClone(radio);},
        subscribe:fn=>{listener=fn;return()=>{listener=undefined;};}};
    });
    await page.goto(pathToFileURL(resolve('.webpack/x64/renderer/main_window/index.html')).href);
    const toggle=page.locator('#radio-enabled');await toggle.waitFor({timeout:5000});
    await page.waitForFunction(()=>document.querySelector('#app').ariaBusy==='false');
    assert.equal(await page.locator('.title-actions #radio-enabled').count(),1,'Pilot toggle lives in the header');
    await page.locator('#refresh').click();
    assert.deepEqual(await page.evaluate(()=>window.radioTest.refreshes),['airports'],'Top Refresh clears airport data');
    assert.equal(await page.locator('#refresh-airports').count(),0,'No duplicate settings refresh');
    const suggestions=page.locator('#recommendations');
    await suggestions.locator('summary').click();
    await page.evaluate(()=>window.radioTest.push({latestMessage:'Updated while collapsed'}));
    assert.equal(await suggestions.evaluate(el=>el.open),false,'Live updates preserve collapse');
    assert.equal(await toggle.isChecked(),false);
    const icon=page.locator('#radio-icon');
    await page.waitForFunction(()=>document.querySelector('#radio-icon').naturalWidth===256);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#radio-icon')).filter==='grayscale(1)');
    await toggle.focus();await page.keyboard.press('Space');await page.waitForFunction(()=>window.radioTest.calls.length===1);
    assert.equal(await toggle.isChecked(),true);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#radio-icon')).filter.includes('drop-shadow') && getComputedStyle(document.querySelector('#radio-icon')).opacity==='1');
    assert.notEqual(await page.locator('.radio-pilot').evaluate(el=>getComputedStyle(el).boxShadow),'none');
    assert.equal(await page.locator('#radio-power').textContent(),'On');
    if(process.env.RADIO_SCREENSHOT)await page.screenshot({path:process.env.RADIO_SCREENSHOT.replace('.png','-enabled.png')});
    assert.match(await page.locator('#radio-status').textContent(),/Listening/);
    await page.evaluate(()=>window.radioTest.push({frequency:135.3,agent:'EXAMPLE',latestMessage:'<img src=x onerror=alert(1)>',lastAction:'Contact Example Center'}));
    const tableTop=await page.locator('.results').evaluate(el=>el.getBoundingClientRect().top);
    await page.locator('#radio-activity').click();
    assert.equal(await page.locator('.results').evaluate(el=>el.getBoundingClientRect().top),tableTop,'Activity floats without moving missions');
    assert.equal(await page.locator('#radio-activity-panel').isVisible(),true);
    assert.match(await page.locator('#radio-frequency').textContent(),/135.300/);
    assert.equal(await page.locator('#radio-latest img').count(),0);
    assert.match(await page.locator('#radio-latest').textContent(),/<img/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#radio-activity-panel').isVisible(),false);
    assert.equal(await page.locator('#radio-activity').evaluate(el=>el===document.activeElement),true);
    await page.locator('#radio-activity').click();await page.locator('h1').click();
    assert.equal(await page.locator('#radio-activity-panel').isVisible(),false,'Outside click dismisses activity');
    await page.evaluate(()=>window.radioTest.push({enabled:false,status:'paused',message:'Radio assist paused: check ATC'}));
    assert.equal(await page.locator('#radio-alert').isVisible(),true,'Paused state remains visible with activity closed');
    await page.evaluate(()=>window.radioTest.push({enabled:true,status:'listening',lastShutdown:{at:1793541600000,reason:'Radio assist paused: <img src=x> No progress'},logPath:'/tmp/radio-logs/radio.jsonl',logWarning:'Radio log could not be saved: disk full'}));
    await page.locator('#radio-activity').click();
    assert.equal(await page.locator('#radio-last-shutdown').isVisible(),true);
    assert.match(await page.locator('#radio-last-shutdown').textContent(),/Last automatic shutoff.*No progress/);
    assert.equal(await page.locator('#radio-last-shutdown img').count(),0);
    assert.match(await page.locator('#radio-log-path').textContent(),/radio.jsonl/);
    assert.match(await page.locator('#radio-log-warning').textContent(),/disk full/);
    await page.keyboard.press('Escape');
    await toggle.uncheck();assert.deepEqual(await page.evaluate(()=>window.radioTest.calls),[true,false]);
    await page.evaluate(()=>{window.radioTest.fail=true;});await toggle.click();
    await page.locator('#radio-error').waitFor({state:'visible'});
    assert.equal(await toggle.isChecked(),false);assert.match(await page.locator('#radio-error').textContent(),/pending/);
    for(const width of [1100,950]) {await page.setViewportSize({width,height:760});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    await page.evaluate(()=>window.radioTest.push({latestMessage:'Weather observation, wind calm, visibility ten miles. '.repeat(60)}));
    for(const width of [950,700,450]) {
      await page.setViewportSize({width,height:500});
      await page.locator('#radio-activity').click();
      const panel=await page.locator('#radio-activity-panel').boundingBox();
      assert.ok(panel && panel.x>=0 && panel.x+panel.width<=width && panel.y+panel.height<=500,'Long activity stays inside the viewport at '+width);
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors,[]);
    if(process.env.RADIO_SCREENSHOT)await page.screenshot({path:process.env.RADIO_SCREENSHOT});
    console.log('Radio toggle, state updates, error recovery and text-only rendering passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
