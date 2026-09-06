const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const output = resolve(process.env.MSFS_ROUTE_VISUAL_OUTPUT || tmpdir() + '/msfs-route-visual');
mkdirSync(output, { recursive: true });

const mission = (guid, departure, destination) => ({ guid, title: `Mission ${guid}`, activity: 'Synthetic', departure, destination, payoutText: null, payoutCredits: null, durationText: null });
const endpoint = (ident, latitude, longitude) => ({ ident, status: 'ready', position: { latitude, longitude } });

(async () => {
  const browser = await chromium.launch({ headless: process.env.CI === 'true' });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    let tileStatus = 200, tileRequests = 0;
    await page.route('https://tile.openstreetmap.org/**', route => {
      tileRequests++;
      if (tileStatus !== 200) return route.abort('failed');
      return route.fulfill({ status: tileStatus, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe7e2"/><path d="M0 64H256M0 128H256M0 192H256M64 0V256M128 0V256M192 0V256" stroke="#c4d1c8"/><text x="12" y="24" fill="#6b8074" font-size="10">LOCAL TILE FIXTURE</text></svg>' });
    });
    await page.addInitScript(() => {
      window.cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective));
      const mission = (guid, departure, destination) => ({ guid, title: `Mission ${guid}`, activity: 'Synthetic', departure, destination, payoutText: null, payoutCredits: null, durationText: null });
      const rows = ['one', 'two'].map((guid, index) => ({ mission: mission(guid, index ? 'CCC' : 'AAA', index ? 'DDD' : 'BBB'), facility: { status: 'pending' }, decision: null }));
      let state = { session: 'session-a', revision: 1, observedAt: null, connection: 'ready', stale: false, message: '', rows, route: null };
      let listener;
      window.routeTest = { selections: [], links: [], rows, push(patch) { state = { ...state, ...patch }; listener(state); } };
      window.companion = {
        getState: async () => state,
        getPreferences: async () => ({ port: 19999, criteria: { categories: ['ILS'], minimumFt: null }, matchesOnly: false, compact: false, theme: 'deck', appearance: 'night', keepOnTop: false, width: 900, height: 700 }),
        setPreferences: async value => value, refresh: async () => {}, refreshAirports: async () => {}, retry: async () => {},
        openAttribution: async key => { window.routeTest.links.push(key); },
        selectRoute: async guid => { window.routeTest.selections.push(guid); }, subscribe: fn => { listener = fn; return () => {}; },
      };
    });
    await page.goto(pathToFileURL(resolve('.webpack/x64/renderer/main_window/index.html')).href);
    await page.waitForFunction(() => document.querySelector('#app').ariaBusy === 'false');
    const routes = page.locator('.route-trigger');
    assert.equal(await routes.count(), 2, 'routes are real buttons');

    await routes.first().hover();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#route-map-popup').isVisible(), false, 'fast pass does not open');
    assert.equal(tileRequests, 0, 'dwell alone does not request tiles before coordinates');
    await page.waitForTimeout(70);
    assert.equal(await page.locator('#route-map-popup').isVisible(), true, '300 ms hover opens');
    assert.deepEqual(await page.evaluate(() => window.routeTest.selections), ['one']);
    await page.mouse.move(890, 10);
    await page.waitForTimeout(150);
    await page.locator('#route-map-popup').hover();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#route-map-popup').isVisible(), true, 'popup transfer cancels close grace');

    await page.locator('.table-scroll').evaluate(scroller => { scroller.style.maxHeight = '1px'; scroller.scrollTop = scroller.scrollHeight; scroller.dispatchEvent(new Event('scroll')); });
    assert.equal(await page.locator('#route-map-popup').isVisible(), false, 'scrolling the anchor out of view closes transient preview');
    await page.locator('.table-scroll').evaluate(scroller => { scroller.style.maxHeight = ''; scroller.scrollTop = 0; });
    await routes.first().hover();
    await page.waitForTimeout(320);
    await page.locator('#search').fill('missing');
    assert.equal(await page.locator('#route-map-popup').isVisible(), false, 'transient preview closes when its anchor leaves the view');
    await page.locator('#search').fill('');
    await routes.first().hover();
    await page.waitForTimeout(320);

    await page.locator('#route-pin').click();
    await page.mouse.move(890, 10);
    await page.waitForTimeout(230);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.locator('#route-map-popup').isVisible(), true, 'pin survives pointer leave and blur');
    await routes.nth(1).dispatchEvent('mouseover');
    await page.waitForTimeout(320);
    assert.match(await page.locator('#route-map-title').textContent(), /AAA.*BBB/, 'hover cannot replace pinned route');
    await routes.nth(1).dispatchEvent('click');
    assert.deepEqual(await page.evaluate(() => window.routeTest.selections), ['one', null, 'one', null, 'one', 'two']);

    const secondRoute = { mission: mission('two', 'CCC', 'DDD'), departure: endpoint('CCC', 40, -80), destination: endpoint('DDD', 42, -70) };
    await page.evaluate(route => window.routeTest.push({ route: { session: 'session-a', ...route } }), secondRoute);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#route-map .route-airport-label').count(), 2, `two current endpoint labels: ${await page.locator('#route-map-popup').isVisible()} ${await page.locator('#route-map-status').textContent()}`);
    assert.match(await page.locator('#route-map-status').textContent(), /Route locations available/);
    assert.equal(await page.locator('#route-map-popup a[href^="http"]').count(), 0, 'all attribution actions use the fixed-key bridge');
    const labelsFit = async () => page.locator('#route-map').evaluate(map => [...map.querySelectorAll('.route-airport-label')].every(label => {
      const outer = map.getBoundingClientRect(), inner = label.getBoundingClientRect();
      return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
    }));
    assert.equal(await labelsFit(), true, 'both endpoint labels fit initial framing');
    await page.locator('#route-departure').click();
    await page.locator('.leaflet-control-zoom-in').click();
    await page.locator('.leaflet-control-zoom-out').click();
    await page.locator('#route-departure').click();
    const departureTransform = await page.locator('#route-map .leaflet-map-pane').getAttribute('style');
    await page.evaluate(() => window.routeTest.push({ revision: 99 }));
    assert.equal(await page.locator('#route-map .leaflet-map-pane').getAttribute('style'), departureTransform, 'same-route polling retains the chosen view');
    await page.locator('#route-close').click();
    const requestsAtClose = tileRequests;
    await page.waitForTimeout(250);
    assert.equal(tileRequests, requestsAtClose, 'hidden map starts no new tile work');
    await routes.nth(1).click();
    await page.evaluate(route => window.routeTest.push({ route: { session: 'session-a', ...route } }), secondRoute);
    await page.waitForTimeout(100);
    const reopenBoxes = await page.locator('#route-map').evaluate(map => ({ outer: map.getBoundingClientRect().toJSON(), labels: [...map.querySelectorAll('.route-airport-label')].map(label => label.getBoundingClientRect().toJSON()) }));
    assert.equal(await labelsFit(), true, `reopen resets departure focus to both-endpoint framing ${JSON.stringify(reopenBoxes)}`);
    const mapCount = await page.locator('.leaflet-container').count();
    await page.evaluate(() => window.routeTest.push({ revision: 2 }));
    assert.equal(await page.locator('.leaflet-container').count(), mapCount, 'polling reuses singleton map');

    await page.locator('#search').fill('AAA');
    assert.equal(await page.locator('#route-map-popup').isVisible(), true, 'pinned snapshot survives filtering');
    assert.match(await page.locator('#route-map-status').textContent(), /no longer in the current view/);
    await page.evaluate(() => window.routeTest.push({ rows: [], stale: true, connection: 'stalled' }));
    assert.match(await page.locator('#route-map-status').textContent(), /no longer in the current list.*stale/i);
    await page.evaluate(() => window.routeTest.push({ session: 'session-b', route: { session: 'session-b', mission: window.routeTest.rows[1].mission, departure: { ident: 'CCC', status: 'ready', position: { latitude: 1, longitude: 2 } }, destination: { ident: 'DDD', status: 'ready', position: { latitude: 3, longitude: 4 } } } }));
    assert.equal(await page.locator('#route-map .route-airport-label').count(), 2, 'pinned geography survives session replacement');
    assert.equal(await labelsFit(), true, 'new-session completion cannot move pinned old-session endpoints');
    assert.match(await page.locator('#route-map-status').textContent(), /snapshot is stale/);
    await page.evaluate(() => window.routeTest.push({ session: 'session-a' }));

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#route-map-popup').isVisible(), false, 'Escape closes');
    assert.equal(await page.evaluate(() => window.routeTest.selections.at(-1)), null, 'close clears route demand');

    await page.locator('#search').fill('');
    await page.evaluate(() => window.routeTest.push({ rows: window.routeTest.rows, stale: false, connection: 'ready', route: null }));
    await routes.first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#route-map-popup').isVisible(), true, 'keyboard activation pins immediately');
    await page.locator('#route-close').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.classList.contains('route-trigger'));
    assert.equal(await routes.first().evaluate(el => el === document.activeElement), true, 'explicit keyboard close restores route focus');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#route-pin').getAttribute('aria-pressed'), 'true', 'Space pins the route');
    await page.locator('#route-close').click();

    await routes.first().click();
    await page.evaluate(() => window.routeTest.push({ route: { session: 'session-a', mission: window.routeTest.rows[1].mission, departure: { ident: 'CCC', status: 'ready', position: { latitude: 1, longitude: 2 } }, destination: { ident: 'DDD', status: 'ready', position: { latitude: 3, longitude: 4 } } } }));
    await page.locator('#route-pin').click();
    assert.match(await page.locator('#route-map-title').textContent(), /AAA.*BBB/, 'stale mission completion cannot replace selection');
    assert.equal(await page.locator('#route-map .route-airport-label').count(), 0, 'stale mission completion cannot draw its endpoints');
    await page.evaluate(({ mission, departure, destination }) => window.routeTest.push({ route: { session: 'session-a', mission, departure, destination } }), {
      mission: mission('one', 'AAA', 'BBB'), departure: endpoint('AAA', 45, -80), destination: { ident: 'BBB', status: 'unavailable', reason: 'Missing' },
    });
    assert.match(await page.locator('#route-map-status').textContent(), /Destination BBB unavailable/);
    await page.evaluate(() => window.routeTest.push({ route: { session: 'session-a', mission: { ...window.routeTest.rows[0].mission }, departure: { ident: 'AAA', status: 'unavailable', reason: 'Missing' }, destination: { ident: 'BBB', status: 'unavailable', reason: 'Missing' } } }));
    assert.match(await page.locator('#route-map-status').textContent(), /Airport locations unavailable/);
    assert.equal(await page.locator('#route-map .leaflet-tile').count(), 0, 'no-coordinate state does not create tiles');
    assert.equal(await page.locator('#route-map .route-airport-label').count(), 0, 'same-GUID unavailable update clears previous geography');
    await page.evaluate(() => window.routeTest.push({ route: { session: 'session-a', mission: window.routeTest.rows[0].mission, departure: { ident: 'AAA', status: 'unavailable', reason: 'Missing' }, destination: { ident: 'BBB', status: 'ready', position: { latitude: 45, longitude: -80 } } } }));
    assert.match(await page.locator('.route-airport-label').textContent(), /B · BBB · Destination/);
    assert.equal(await page.locator('#route-departure').isDisabled(), true);
    await page.evaluate(() => window.routeTest.push({ route: { session: 'session-a', mission: window.routeTest.rows[0].mission, departure: { ident: 'AAA', status: 'pending' }, destination: { ident: 'BBB', status: 'pending' } } }));
    assert.equal(await page.locator('#route-map .route-airport-label').count(), 0, 'same-GUID pending update clears previous geography');

    await page.locator('#route-close').click();
    tileStatus = 500;
    await routes.nth(1).click();
    await page.evaluate(route => window.routeTest.push({ route: { session: 'session-a', ...route } }), { ...secondRoute, departure: endpoint('CCC', -30, 100), destination: endpoint('DDD', -28, 110) });
    await page.waitForFunction(() => document.querySelector('#route-map-status').textContent.includes('Map imagery unavailable'));
    const failedRequests = tileRequests;
    await page.waitForTimeout(200);
    assert.equal(tileRequests, failedRequests, 'tile failure does not auto-retry');
    tileStatus = 200;
    await page.locator('#route-retry').click();
    await page.waitForFunction(() => !document.querySelector('#route-map-status').textContent.includes('Map imagery unavailable'));
    assert.ok(tileRequests > failedRequests, 'explicit retry creates the next tile attempt');

    await page.locator('#route-close').click();
    await page.evaluate(() => window.routeTest.push({ route: null }));
    await routes.nth(1).click();
    await page.evaluate(route => window.routeTest.push({ route: { session: 'session-a', ...route, destination: { ident: 'DDDD', status: 'pending' } } }), { ...secondRoute, departure: endpoint('CCCC', 40, -70) });
    await page.evaluate(route => window.routeTest.push({ route: { session: 'session-a', ...route } }), { ...secondRoute, departure: endpoint('CCCC', 40, -70), destination: endpoint('DDDD', 42, -80) });
    assert.equal(await labelsFit(), true, 'staggered westbound endpoints receive final initial framing');
    await page.locator('#route-show').click();
    assert.equal(await labelsFit(), true, 'westbound labels fit explicit route framing');

    await page.locator('#route-close').click();
    await page.evaluate(() => window.routeTest.push({ route: null }));
    await routes.nth(1).click();
    await page.evaluate(route => window.routeTest.push({ route: { session: 'session-a', ...route, destination: { ident: 'DDD', status: 'pending' } } }), secondRoute);
    const mapBox = await page.locator('#route-map').boundingBox();
    await page.mouse.move(mapBox.x + 180, mapBox.y + 130);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + 230, mapBox.y + 150, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    const userView = await page.locator('#route-map .leaflet-map-pane').getAttribute('style');
    await page.evaluate(route => window.routeTest.push({ route: { session: 'session-a', ...route } }), secondRoute);
    assert.equal(await page.locator('#route-map .leaflet-map-pane').getAttribute('style'), userView, 'late endpoint preserves intervening user pan');

    await page.locator('#route-close').click();
    const beforeDetachedHover = await page.evaluate(() => window.routeTest.selections.filter(guid => guid !== null).length);
    await routes.first().dispatchEvent('mouseover');
    await page.locator('#search').fill('missing');
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#route-map-popup').isVisible(), false, 'filtered pending hover cannot open');
    assert.equal(await page.evaluate(() => window.routeTest.selections.filter(guid => guid !== null).length), beforeDetachedHover, 'filtered pending hover cannot request endpoints');
    await page.locator('#search').fill('');
    await routes.first().dispatchEvent('mouseover');
    await page.evaluate(() => window.routeTest.push({ rows: window.routeTest.rows.map(row => ({ ...row, mission: { ...row.mission, title: row.mission.title + ' updated' } })) }));
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#route-map-popup').isVisible(), false, 'regenerated pending hover cannot open');
    assert.equal(await page.evaluate(() => window.routeTest.selections.filter(guid => guid !== null).length), beforeDetachedHover, 'regenerated pending hover cannot request endpoints');

    // All imagery remains intercepted locally throughout the visual matrix.
    await routes.nth(1).click();
    await page.evaluate(route => window.routeTest.push({ route: { session: 'session-a', ...route } }), secondRoute);
    await page.locator('[data-route-action="leaflet"]').click();
    await page.locator('[data-route-action="osm"]').click();
    assert.deepEqual(await page.evaluate(() => window.routeTest.links), ['leaflet', 'osm'], 'attribution uses the fixed-key bridge');
    const matrix = [];
    for (const [width, height] of [[1100, 760], [800, 600], [450, 400]]) {
      await page.setViewportSize({ width, height });
      for (const theme of ['clear', 'deck', 'notes']) for (const appearance of ['light', 'night']) for (const compact of [false, true]) {
        await page.locator('#route-close').click();
        await page.locator('.settings-disclosure').evaluate(el => { el.open = true; });
        await page.locator('#theme').selectOption(theme);
        await page.locator('#appearance').selectOption(appearance);
        await page.locator('#compact').setChecked(compact);
        await page.locator('.settings-disclosure').evaluate(el => { el.open = false; });
        await routes.nth(1).dispatchEvent('click');
        await page.evaluate(() => window.dispatchEvent(new Event('resize')));
        await page.locator('#route-show').click();
        assert.equal(await labelsFit(), true, `${theme}/${appearance}/${compact}/${width}: endpoint labels fit`);
        for (const selector of ['#route-pin', '#route-close', '#route-show', '#route-departure', '[data-route-action="leaflet"]', '[data-route-action="osm"]']) {
          const control = page.locator(selector);
          await control.scrollIntoViewIfNeeded();
          const box = await control.boundingBox();
          assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `${selector} reachable at ${width}×${height}`);
        }
        await page.locator('#route-map-popup').evaluate(el => { el.scrollTop = 0; });
        const name = `${theme}-${appearance}-${compact ? 'compact' : 'normal'}-${width}x${height}`;
        await page.screenshot({ path: resolve(output, name + '.png') });
        matrix.push(name);
      }
    }
    assert.deepEqual(await page.evaluate(() => window.cspViolations), [], 'Leaflet needs no CSP style exceptions');
    console.log(`Route visual matrix: ${matrix.length} combinations passed; screenshots: ${output}`);
    console.log('Route popup interaction, lifecycle, stale and unavailable checks passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
