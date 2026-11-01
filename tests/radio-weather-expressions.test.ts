import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { weatherCycleExpression } from '../src/simulator/radio-weather-expressions';
function setup() {
  const values:Record<string,number>={'SIM ON GROUND':0,'GPS IS APPROACH ACTIVE':0,'INDICATED ALTITUDE':35000,'VERTICAL SPEED':0,
    'COM TRANSMIT:1':1,'COM TRANSMIT:2':0,'COM ACTIVE FREQUENCY:1':133250000,'COM STANDBY FREQUENCY:1':128800000};
  const calls:number[]=[];let manual=false;
  const context={setTimeout:(fn:()=>void)=>{if(manual)values['COM ACTIVE FREQUENCY:1']=130500000;fn();},SimVar:{
    GetSimVarValue:(name:string)=>values[name],
    SetSimVarValue:async(name:string,unit:string,value:number)=>{assert.equal(name,'K:COM_RADIO_SET_HZ');assert.equal(unit,'number');calls.push(value);values['COM ACTIVE FREQUENCY:1']=value;},
  }};
  return {values,calls,manual:()=>{manual=true;},run:()=>runInNewContext(weatherCycleExpression(133.25),context)};
}
test('weather cycle tunes to standby and restores original active frequency without writing standby',async()=>{
  const f=setup();assert.equal(await f.run(),'restored');assert.deepEqual(f.calls,[128800000,133250000]);
  assert.equal(f.values['COM STANDBY FREQUENCY:1'],128800000);
});
test('weather cycle refuses approach, descent, low altitude, ground, wrong frequency and unavailable standby',async()=>{
  for(const [name,value] of [['GPS IS APPROACH ACTIVE',1],['VERTICAL SPEED',-1000],['INDICATED ALTITUDE',5000],['SIM ON GROUND',1],
    ['COM ACTIVE FREQUENCY:1',130500000],['COM STANDBY FREQUENCY:1',133250000],['COM TRANSMIT:2',1]] as const) {
    const f=setup();f.values[name]=value;assert.equal(await f.run(),'unavailable',name);assert.deepEqual(f.calls,[]);
  }
});
test('weather cycle does not overwrite a manual frequency change during the cycle',async()=>{
  const f=setup();f.manual();await assert.rejects(f.run(),/changed/i);
  assert.deepEqual(f.calls,[128800000]);assert.equal(f.values['COM ACTIVE FREQUENCY:1'],130500000);
});
