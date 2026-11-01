/** Same active-frequency key event used by the installed EFB's FacilityFrequencyToolbox.
 * No standby writes or transmissions. Runtime guards deliberately limit recovery to
 * high, level flight; this is a conservative envelope, not an inferred FMC phase.
 */
export function weatherCycleExpression(frequency: number): string {
  if (!Number.isFinite(frequency) || frequency < 118 || frequency > 136.99) throw new TypeError('Invalid recovery frequency');
  return `(async function() {
    if (typeof SimVar === 'undefined' || typeof SimVar.GetSimVarValue !== 'function' || typeof SimVar.SetSimVarValue !== 'function') return 'unavailable';
    function get(name, unit) { return SimVar.GetSimVarValue(name, unit); }
    var radios = [1,2].filter(function(n) { return get('COM TRANSMIT:' + n, 'Bool') === 1; });
    if (radios.length !== 1 || get('SIM ON GROUND','Bool') !== 0 || get('GPS IS APPROACH ACTIVE','Bool') !== 0 ||
      !(get('INDICATED ALTITUDE','feet') >= 18000) || !(Math.abs(get('VERTICAL SPEED','feet per minute')) <= 300)) return 'unavailable';
    var radio = radios[0], active = 'COM ACTIVE FREQUENCY:' + radio;
    var original = get(active, 'Hz'), temporary = get('COM STANDBY FREQUENCY:' + radio, 'Hz');
    function same(a,b) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) < 500; }
    if (!same(original, ${Math.round(frequency * 1e6)}) || !Number.isFinite(temporary) || temporary < 118000000 || temporary > 136990000 || same(original,temporary)) return 'unavailable';
    var event = radio === 1 ? 'K:COM_RADIO_SET_HZ' : 'K:COM2_RADIO_SET_HZ';
    function delay() { return new Promise(function(resolve) { setTimeout(resolve, 100); }); }
    async function waitFor(target, previous) {
      for (var i=0; i<20; i++) {
        var current = get(active,'Hz');
        if (same(current,target)) return;
        if (!same(current,previous)) throw Error('Radio frequency changed during weather recovery; check radios manually.');
        await delay();
      }
      throw Error('Radio frequency change was not confirmed; check radios manually.');
    }
    try {
      await SimVar.SetSimVarValue(event,'number',temporary);
      await waitFor(temporary,original);
      await delay();
      if (!same(get(active,'Hz'),temporary)) throw Error('Radio frequency changed during weather recovery; check radios manually.');
    } finally {
      // Complete the requested round trip even if the first event rejects after
      // taking effect, but never overwrite a different frequency chosen manually.
      if (same(get(active,'Hz'),temporary)) {
        await SimVar.SetSimVarValue(event,'number',original);
        await waitFor(original,temporary);
      }
    }
    if (!same(get(active,'Hz'),original)) throw Error('Original radio frequency was not restored; check radios manually.');
    return 'restored';
  })()`;
}
