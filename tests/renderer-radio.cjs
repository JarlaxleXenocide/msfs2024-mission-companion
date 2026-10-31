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
      let listener;window.radioTest={calls:[],fail:false,push:patch=>{Object.assign(radio,patch);listener(structuredClone(state));}};
      window.companion={getState:async()=>structuredClone(state),getPreferences:async()=>preferences,setPreferences:async v=>v,
        refresh:async()=>{},refreshAirports:async()=>{},retry:async()=>{},selectRoute:async()=>{},openAttribution:async()=>{},
        setRadioEnabled:async enabled=>{window.radioTest.calls.push(enabled);if(window.radioTest.fail)throw Error('Operation pending');
          window.radioTest.push({enabled,status:enabled?'listening':'off',message:enabled?'Listening for handoffs':'Radio assist is off'});return structuredClone(radio);},
        subscribe:fn=>{listener=fn;return()=>{listener=undefined;};}};
    });
    await page.goto(pathToFileURL(resolve('.webpack/x64/renderer/main_window/index.html')).href);
    const toggle=page.locator('#radio-enabled');await toggle.waitFor({timeout:5000});
    await page.waitForFunction(()=>document.querySelector('#app').ariaBusy==='false');
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
    await page.locator('#radio-activity summary').click();
    assert.match(await page.locator('#radio-frequency').textContent(),/135.300/);
    assert.equal(await page.locator('#radio-latest img').count(),0);
    assert.match(await page.locator('#radio-latest').textContent(),/<img/);
    await toggle.uncheck();assert.deepEqual(await page.evaluate(()=>window.radioTest.calls),[true,false]);
    await page.evaluate(()=>{window.radioTest.fail=true;});await toggle.click();
    await page.locator('#radio-error').waitFor({state:'visible'});
    assert.equal(await toggle.isChecked(),false);assert.match(await page.locator('#radio-error').textContent(),/pending/);
    for(const width of [1100,950]) {await page.setViewportSize({width,height:760});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    assert.deepEqual(errors,[]);
    if(process.env.RADIO_SCREENSHOT)await page.screenshot({path:process.env.RADIO_SCREENSHOT});
    console.log('Radio toggle, state updates, error recovery and text-only rendering passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
