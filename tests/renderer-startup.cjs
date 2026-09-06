// Run after npm run package/make; CI uses headless Chromium with a synthetic bridge.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: process.env.CI === 'true' });
  try {
    for (const pushFirst of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
      await page.addInitScript(() => {
        const snapshot = title => ({ session: 'synthetic-startup', revision: 1, observedAt: '2026-09-05T19:00:00Z',
          connection: 'ready', stale: false, message: title, rows: [{
            mission: { guid: title, title, activity: 'Synthetic', departure: 'AAA', destination: 'BBB', payoutText: '125,000 Cr', payoutCredits: 125000, durationText: '1 h 25 min' },
            facility: { status: 'ready', airport: { key: 'A|||BBB', ident: 'BBB', icao: { type: 'A', region: '', airport: '', ident: 'BBB' }, procedures: [{ name: 'VOR A', type: 2, rnavFlags: 0, runwayNumber: 0, runwayDesignator: 0, rnpAr: false }], ends: [12, 15, 30, 33].map(number => ({ id: String(number), number, designator: 0, physicalM: 1554.4857, thresholdM: 0, thresholdElevationM: 1681.954, physicalElevationM: 1684.17, closed: false, ilsMHz: null, glideslope: null })) } }, decision: { verdict: 'unknown', runwayIds: [], reasons: [] },
          }] });
        const preferences = { port: 19999, criteria: { categories: ['ILS'], minimumFt: null }, matchesOnly: false,
          compact: true, theme: 'notes', appearance: 'night', keepOnTop: false, width: 1100, height: 760 };
        let listener, finishPreferences;
        window.startupTest = { push: () => listener(snapshot('Newer pushed mission')), release: () => finishPreferences(preferences) };
        window.companion = {
          getState: async () => snapshot('Initial mission'),
          getPreferences: () => new Promise(resolve => { finishPreferences = resolve; }),
          setPreferences: async value => value, refresh: async () => {}, refreshAirports: async () => {}, retry: async () => {},
          subscribe: next => { listener = next; return () => { listener = undefined; }; },
        };
      });
      await page.goto(pathToFileURL(resolve('.webpack/x64/renderer/main_window/index.html')).href);
      await page.waitForFunction(() => window.startupTest && document.querySelector('link[rel=stylesheet]'));
      if (pushFirst) await page.evaluate(() => window.startupTest.push());
      await page.evaluate(() => window.startupTest.release());
      await page.waitForFunction(() => document.querySelector('#app').ariaBusy === 'false');
      const expected = pushFirst ? 'Newer pushed mission' : 'Initial mission';
      assert.equal(await page.locator('#connection-message').textContent(), expected);
      assert.equal(await page.locator('.mission-title').textContent(), expected);
      assert.equal(await page.locator('.table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Comparison fits the default window');
      assert.equal(await page.locator('thead th').count(), 6, 'Duration and credits have separate columns');
      assert.equal(await page.locator('.mission-row td:last-child .expand').count(), 1, 'Expansion belongs in Runway details');
      assert.equal(await page.locator('td td').count(), 0, 'Summary cells must not nest table cells');
      assert.match(await page.locator('.mission-row').textContent(), /AAA.*BBB/);
      assert.match(await page.locator('.mission-row').textContent(), /1 h 25 min.*125,000 Cr/);
      await page.locator('.settings-disclosure summary').click();
      for (const theme of ['clear', 'deck', 'notes']) {
        for (const appearance of ['light', 'night']) {
          await page.locator('#theme').selectOption(theme);
          await page.locator('#appearance').selectOption(appearance);
          for (const compact of [false, true]) {
            await page.locator('#compact').setChecked(compact);
            assert.equal(await page.locator('.table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${theme}/${appearance}/${compact} fits default width`);
          }
        }
      }
      await page.locator('.settings-disclosure summary').click();
      await page.locator('.expand').click();
      const cards = await page.locator('.runway-card').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
      assert.equal(cards[0], cards[1], 'Runway ends form pairs');
      assert.ok(cards[2] > cards[0], 'Additional runway ends start a new row');
      const overflow = await page.locator('.metric strong').evaluateAll(nodes => nodes.some(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const cell = node.getBoundingClientRect();
        return [...range.getClientRects()].some(text => text.right > cell.right + 1);
      }));
      assert.equal(overflow, false, 'Runway metric text stays inside its grid cell');
      const splitUnits = await page.locator('.metric strong').evaluateAll(nodes => nodes.some(node => {
        const text = node.textContent, start = text.indexOf('(');
        if (start < 0) return false;
        const range = document.createRange(); range.setStart(node.firstChild, start); range.setEnd(node.firstChild, text.length);
        return range.getClientRects().length > 1;
      }));
      assert.equal(splitUnits, false, 'Parenthesized metric number and unit stay on one line');
      await page.close();
    }
    console.log('Initial-only and push-before-preferences renderer startup and runway metric containment checks passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
