import type { Icao } from '../shared/model';

// Fixed read-only expressions use syntax already observed in the Coherent engine.
// Host parsing is tested; engine compatibility and lifetime availability need Task 8.
export function captureExpression(): string {
  return `(async function () {
    function result(screen) { return {screen: screen, observedAt: new Date().toISOString()}; }
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return result('unsupported');
    function browserState() {
      var elements = Array.from(document.querySelectorAll('ui-resource-element'));
      var browsers = elements.filter(function (e) { return e._componentName === 'missions_browser_content'; });
      if (browsers.length !== 1 || !browsers[0].manipulator) return {screen: 'unsupported'};
      var manipulator = browsers[0].manipulator;
      if (manipulator.isActive === false) return {screen: 'inactive'};
      if (manipulator.isActive !== true || !manipulator.fetcher || !manipulator.fetcher.api) return {screen: 'unsupported'};
      var api = manipulator.fetcher.api;
      if (typeof api.requestRange !== 'function' || typeof api.getElement !== 'function') return {screen: 'unsupported'};
      return {screen: 'browse', api: api};
    }
    function validCount(n) { return Number.isInteger(n) && n >= 0 && n <= 2000; }
    var state = browserState();
    if (state.screen !== 'browse') return result(state.screen);
    var api = state.api;
    function checkState() {
      var current = browserState();
      if (current.screen !== 'browse') return result(current.screen);
      if (current.api !== api) return result('updating');
      return null;
    }
    var first = await api.requestRange(0, 25);
    if (!validCount(first)) return result('unsupported');
    var items = [];
    var firstGuid = null;
    for (var start = 0; start < first; start += 25) {
      var changed = checkState();
      if (changed) return changed;
      var count = await api.requestRange(start, 25);
      if (!validCount(count)) return result('unsupported');
      if (count !== first) return result('updating');
      for (var i = start; i < Math.min(start + 25, count); i++) {
        changed = checkState();
        if (changed) return changed;
        var item = await api.getElement(i);
        if (!item || item.missionIndex !== i || typeof item.missionGUID !== 'string' || !item.missionGUID.trim()) return result('unsupported');
        if (i === 0) firstGuid = item.missionGUID;
        items.push(item);
      }
    }
    changed = checkState();
    if (changed) return changed;
    var final = await api.requestRange(0, 1);
    if (!validCount(final)) return result('unsupported');
    changed = checkState();
    if (changed) return changed;
    if (final !== first) return result('updating');
    var firstAgain = first ? await api.getElement(0) : null;
    changed = checkState();
    if (changed) return changed;
    if (first && (!firstAgain || firstAgain.missionIndex !== 0 || typeof firstAgain.missionGUID !== 'string' || !firstAgain.missionGUID.trim())) return result('unsupported');
    return { screen: 'browse', observedAt: new Date().toISOString(), first: first, final: final,
      firstGuid: firstGuid, finalFirstGuid: firstAgain ? firstAgain.missionGUID : null, items: items };
  })()`;
}

export function airportExpression(ident: string, known?: Icao): string {
  if (typeof ident !== 'string' || !ident.trim()) throw new TypeError('Airport ident is required');
  if (known !== undefined && (
    known === null || typeof known !== 'object' || known.type !== 'A' ||
    known.ident !== ident || typeof known.region !== 'string' || typeof known.airport !== 'string'
  )) throw new TypeError('Known airport identity is invalid');
  const icao = known === undefined ? null : {
    type: known.type, region: known.region, airport: known.airport, ident: known.ident,
  };
  return `(async function () {
    var ident = ${JSON.stringify(ident)};
    var icao = ${JSON.stringify(icao)};
    if (typeof msfssdk === 'undefined') throw Error('Airport SDK unavailable');
    var s = msfssdk;
    if (!s || typeof s.FacilityLoader !== 'function' || !s.FacilityRepository ||
        !s.FacilitySearchType || !s.FacilityType || !s.RunwayUtils ||
        typeof s.RunwayUtils.getOneWayRunwaysFromAirport !== 'function') throw Error('Airport SDK unavailable');
    var loader = new s.FacilityLoader(s.FacilityRepository.INSTANCE);
    await loader.awaitInitialization();
    if (!icao) {
      var matches = (await loader.searchByIdentWithIcaoStructs(s.FacilitySearchType.Airport, ident, 20))
        .filter(function (i) { return i && i.type === 'A' && i.ident === ident; });
      if (matches.length !== 1) throw Error('Expected one exact airport match');
      icao = matches[0];
    }
    var f = await loader.getFacility(s.FacilityType.Airport, icao, 73);
    if (!f || !Number.isInteger(f.loadedDataFlags) || (f.loadedDataFlags & 73) !== 73) throw Error('Missing facility flags');
    return {ident: ident, icaoStruct: f.icaoStruct, loadedDataFlags: f.loadedDataFlags,
      lat: f.lat, lon: f.lon, approaches: f.approaches, rawRunways: f.runways,
      runways: Array.isArray(f.runways) ? s.RunwayUtils.getOneWayRunwaysFromAirport(f) : null};
  })()`;
}

export function lifetimeExpression(): string {
  return `(function () {
    if (typeof performance === 'undefined') return null;
    var origin = performance.timeOrigin;
    if (!(typeof origin === 'number' && Number.isFinite(origin) && origin > 0)) {
      origin = performance.timing && performance.timing.navigationStart;
    }
    return typeof origin === 'number' && Number.isFinite(origin) && origin > 0 ? origin : null;
  })()`;
}
