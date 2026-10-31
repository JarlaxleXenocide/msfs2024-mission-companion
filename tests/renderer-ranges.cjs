const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
const { tmpdir } = require('node:os');

(async () => {
  const browser = await chromium.launch({ headless: process.env.CI === 'true' });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let listener;
      let preferences = JSON.parse(localStorage.getItem('test-preferences') || 'null') ?? {
        port: 19999, criteria: { categories: ['ILS'], minimumFt: null }, matchesOnly: false,
        compact: false, theme: 'deck', appearance: 'night', keepOnTop: false, width: 1100, height: 760,
      };
      const rows = ['1h59min', '2h', '2h30min', '3h', '3h1min', null].map((durationText, index) => ({
        distanceNm: [0, 25, 50.5, 100, 100.1, null][index],
        mission: { guid: String(index), title: `Flight ${index}`, departure: 'KBOS', destination: 'EINN', activity: 'Cargo', payoutText: '100,000 Cr.', payoutCredits: 100000, durationText },
        facility: index === 5 ? { status: 'pending' } : { status: 'ready', airport: {
          ident: 'EINN', key: 'A|||EINN', icao: { type: 'A', region: '', airport: '', ident: 'EINN' }, position: null,
          ends: [{ id: '09', number: 9, designator: 0, physicalM: (index === 2 ? 10000 : 5000) * 0.3048, thresholdM: 0, thresholdElevationM: 0, physicalElevationM: 0, closed: false, ilsMHz: 110.3, glideslope: true }],
          procedures: [{ name: 'ILS 09', type: 4, runwayNumber: 9, runwayDesignator: 0, rnavFlags: 0, rnpAr: false }],
        } }, decision: null,
      }));
      const state = { rows, session: 'test', revision: 1, connection: 'ready', stale: false, message: '', observedAt: null };
      window.rangeTest = { saves: 0, preferences: () => preferences, push: () => listener(state),
        setDistance: (index, distanceNm) => { rows[index].distanceNm = distanceNm; listener(state); } };
      window.companion = {
        getState: async () => state, getPreferences: async () => preferences,
        setPreferences: async value => {
          preferences = value; window.rangeTest.saves++;
          localStorage.setItem('test-preferences', JSON.stringify(value)); return value;
        },
        refresh: async () => {}, refreshAirports: async () => {}, retry: async () => {}, selectRoute: async () => {},
        subscribe: fn => { listener = fn; return () => {}; },
      };
    });
    const url = pathToFileURL(resolve('.webpack/x64/renderer/main_window/index.html')).href;
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#app').ariaBusy === 'false');
    const ids = () => page.locator('.mission-row').evaluateAll(rows => rows.map(row => row.dataset.guid));
    const enter = async (id, value) => { await page.locator(id).fill(value); await page.locator(id).press('Tab'); };
    assert.equal(await page.locator('input[type=range]').count(), 6);
    assert.equal((await ids()).length, 6, 'No range excludes unknown values initially');
    await enter('#duration-minimum', '2'); await enter('#duration-maximum', '3');
    assert.deepEqual(await ids(), ['1', '2', '3']);
    assert.match(await page.locator('#counts').textContent(), /3 shown \/ 6 scanned/);
    await enter('#minimum', '4000'); await enter('#maximum', '6000');
    assert.deepEqual(await ids(), ['1', '3'], 'Ranges combine without Matches only');
    await page.evaluate(() => window.rangeTest.push());
    assert.deepEqual(await ids(), ['1', '3'], 'Polling retains filters');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#app').ariaBusy === 'false');
    assert.deepEqual(await ids(), ['1', '3'], 'Saved ranges survive reload');
    assert.equal(await page.locator('#duration-minimum').inputValue(), '2');
    await page.getByRole('button', { name: 'Clear runway length filter' }).click();
    assert.deepEqual(await ids(), ['1', '2', '3']);
    await page.getByRole('slider', { name: 'Minimum duration slider', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await ids(), ['3'], 'Keyboard moves the lower thumb by one hour');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#duration-minimum').inputValue(), '3', 'Thumbs cannot cross');
    await page.getByRole('slider', { name: 'Maximum duration slider', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#duration-maximum').inputValue(), '3');
    await enter('#duration-minimum', '4');
    assert.equal(await page.locator('#duration-minimum').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(await ids(), ['3'], 'Invalid range does not replace active filter');
    await page.getByRole('button', { name: 'Clear duration filter' }).click();
    assert.equal((await ids()).length, 6);
    const drag = async (root, which, from, to) => {
      const slider = page.locator(`${root} .range-${which}`);
      const box = await slider.boundingBox();
      const max = Number(await slider.getAttribute('max'));
      const x = value => box.x + 10 + (box.width - 20) * value / max;
      await page.mouse.move(x(from), box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(x(to), box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
    };
    await drag('#duration-filter', 'lower', 0, 2);
    await drag('#duration-filter', 'upper', 25, 3);
    assert.equal(await page.locator('#duration-minimum').inputValue(), '2');
    assert.equal(await page.locator('#duration-maximum').inputValue(), '3');
    assert.deepEqual(await ids(), ['1', '2', '3'], 'Pointer dragging sets a 2–3 hour range');
    await drag('#runway-filter', 'lower', 0, 4000);
    await drag('#runway-filter', 'upper', 15500, 6000);
    assert.deepEqual(await ids(), ['1', '3'], 'Pointer dragging sets both runway bounds');
    await page.getByRole('button', { name: 'Clear duration filter' }).click();
    await page.getByRole('button', { name: 'Clear runway length filter' }).click();
    await drag('#distance-filter', 'lower', 0, 25);
    await drag('#distance-filter', 'upper', 1025, 100);
    assert.deepEqual(await ids(), ['1', '2', '3'], 'Player distance dragging includes both bounds');
    await page.getByRole('slider', { name: 'Minimum distance from player slider', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#distance-minimum').inputValue(), '50', 'Distance keyboard step is 25 NM');
    assert.deepEqual(await ids(), ['2', '3']);
    await enter('#distance-minimum', '50.5'); await enter('#distance-maximum', '50.5');
    assert.deepEqual(await ids(), ['2'], 'Exact fractional distance is inclusive');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#app').ariaBusy === 'false');
    assert.deepEqual(await ids(), ['2'], 'Saved distance range survives reload');
    assert.equal(await page.locator('#distance-minimum').inputValue(), '50.5');
    await enter('#distance-minimum', '51');
    assert.equal(await page.locator('#distance-minimum').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(await ids(), ['2'], 'Reversed distance bounds leave the last valid filter active');
    await enter('#distance-minimum', '50.5'); await enter('#distance-maximum', '');
    assert.deepEqual(await ids(), ['2', '3', '4'], 'Distance permits an open upper bound');
    await page.getByRole('button', { name: 'Clear distance from player filter' }).click();
    assert.equal((await ids()).length, 6, 'Clearing distance restores unknown distances');
    await enter('#duration-minimum', '2'); await enter('#duration-maximum', '3');
    await enter('#minimum', '4000'); await enter('#maximum', '6000');
    await enter('#distance-minimum', '25'); await enter('#distance-maximum', '50.5');
    assert.deepEqual(await ids(), ['1'], 'All three ranges combine');
    await page.evaluate(() => window.rangeTest.setDistance(1, 75));
    assert.deepEqual(await ids(), [], 'Player movement updates filtered results');
    await page.evaluate(() => window.rangeTest.setDistance(1, 25));
    assert.deepEqual(await ids(), ['1']);
    await page.screenshot({ path: resolve(tmpdir(), 'msfs-range-filters.png') });
    for (const width of [800, 450]) {
      await page.setViewportSize({ width, height: 700 });
      for (const selector of ['#duration-minimum', '#duration-maximum', '#minimum', '#maximum', '#distance-minimum', '#distance-maximum']) {
        const control = page.locator(selector); await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width, `${selector} fits ${width}px`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.ok((await page.locator('.table-scroll').boundingBox()).height >= 100, 'Narrow layout retains a usable table viewport');
      await page.screenshot({ path: resolve(tmpdir(), `msfs-range-filters-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('Range filtering, persistence, drag, keyboard, validation and responsive checks passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
