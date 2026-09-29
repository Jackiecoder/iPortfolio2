// Browser regression: run against a preview or a deployed shell. API requests
// are fulfilled with the public synthetic adapter; no private data is used.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium, webkit } = require('playwright');
const demo = require(path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..'), 'static/js/demo-portfolio.js'));
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8768';
const output = process.env.SCREENSHOT_DIR || '/tmp/holdings-layout-check';
fs.mkdirSync(output, {recursive: true});
const pause = page => page.waitForTimeout(250); // Bootstrap tab transition + paint.

(async () => {
  for (const engine of (process.env.BROWSER_ENGINES || 'chromium,webkit').split(',')) {
    const browser = await ({chromium, webkit}[engine]).launch({headless: true,
      ...(engine === 'chromium' && process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
    try {
      for (const width of [320, 390, 430, 1440]) {
        const mobile = width < 768;
        const context = await browser.newContext({viewport: {width, height: mobile ? 844 : 700}, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block'});
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const fixture = demo.create();
        await page.route('**/api/**', async route => {
          const response = await fixture.fetch(route.request().url(), {method: route.request().method()});
          await route.fulfill({status: response.status, contentType: 'application/json', body: JSON.stringify(await response.json())});
        });
        await page.addInitScript(() => {
          localStorage.setItem('trackerActiveTab', '#trackerHoldings');
          localStorage.setItem('summaryCardsExpanded', '1');
          localStorage.setItem('holdingsHiddenCols', JSON.stringify([3,8,9,11,12,13,14,15,16,17,18]));
        });
        await page.goto(baseURL + '/');
        await page.waitForSelector('#holdingsBody .holding-row');
        await pause(page);
        const initial = await page.evaluate(() => {
          const s = document.querySelector('.holdings-table-scroll');
          return {pageWidth: document.documentElement.scrollWidth, width: innerWidth,
            tableTop: document.querySelector('#holdingsTable').getBoundingClientRect().top,
            scrollHeight: s.scrollHeight, height: s.clientHeight,
            overview: getComputedStyle(document.querySelector('#portfolioOverview')).display};
        });
        assert.equal(initial.pageWidth, initial.width, `${engine} ${width}: page overflow`);
        if (mobile) {
          assert.equal(initial.overview, 'none');
          assert.ok(initial.tableTop < 300, `table starts at ${initial.tableTop}`);
          assert.ok(initial.scrollHeight - initial.height <= 1, 'nested vertical scrolling');
          await page.screenshot({path: `${output}/${engine}-${width}-initial.png`});
          await page.mouse.move(width / 2, initial.tableTop + 100);
          if (engine === 'chromium') {
            const touch = await context.newCDPSession(page);
            const y = Math.min(680, initial.tableTop + 400);
            await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: width / 2, y}]});
            for (let step = 1; step <= 10; step++) {
              await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: width / 2, y: y - step * 30}]});
              await page.waitForTimeout(20);
            }
            await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
            await touch.detach();
          } else {
            // Playwright does not expose swipe input in mobile WebKit.
            await page.evaluate(() => window.scrollBy(0, 350));
          }
          await pause(page);
          const position = await page.evaluate(() => ({page: scrollY, inner: document.querySelector('.holdings-table-scroll').scrollTop,
            head: document.querySelector('#holdingsTable th').getBoundingClientRect().top,
            tabs: document.querySelector('#trackerTabs').getBoundingClientRect().bottom}));
          assert.ok(position.page > 0, 'scroll over the table must move the page');
          assert.equal(position.inner, 0);
          assert.ok(Math.abs(position.head - position.tabs) < 2, JSON.stringify(position));
          await page.evaluate(() => document.querySelector('.holdings-table-scroll').scrollLeft = 220);
          await pause(page);
          const alignment = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect();
            return {symbol: rect('#holdingsBody .holding-row [data-col="0"]').left,
              shell: rect('.holdings-table-scroll').left,
              header: rect('#holdingsTable th[data-col="4"]').left,
              body: rect('#holdingsBody .holding-row [data-col="4"]').left};
          });
          assert.ok(Math.abs(alignment.symbol - alignment.shell) < 2, 'symbol must stay pinned');
          assert.ok(Math.abs(alignment.header - alignment.body) < 2, 'header/body horizontal mismatch');
          await page.screenshot({path: `${output}/${engine}-${width}-scrolled.png`});
          await page.locator('#holdingsTable th[data-col="0"]').click();
          assert.ok(await page.locator('#holdingsTable th[data-col="0"]').evaluate(el => el.classList.contains('asc')), 'sticky sort control');
          await page.evaluate(() => {window.scrollTo(0, 0); document.querySelector('.holdings-table-scroll').scrollLeft = 0;});
          await page.locator('#colToggleBtn').click();
          await page.locator('#colToggleMenu label').filter({hasText: /^Price$/}).locator('input').uncheck();
          await page.locator('#colToggleBtn').click();
          assert.equal(await page.locator('#holdingsTable th[data-col="4"]').isVisible(), false);
          await page.locator('#holdingsBody .holding-row').first().click();
          await page.waitForSelector('#holdingsBody .txn-detail-row');
          await page.locator('#holdingsOverviewToggle').click();
          assert.equal(await page.locator('#portfolioOverview').isVisible(), true);
          await page.locator('#holdingsOverviewToggle').click();
          assert.equal(await page.locator('#portfolioOverview').isVisible(), false);
          await page.evaluate(() => window.scrollTo(0, 450));
          await pause(page);
          await page.locator('#today-tab').click();
          await pause(page);
          assert.equal(await page.locator('#portfolioOverview').isVisible(), true);
          assert.equal(await page.evaluate(() => localStorage.getItem('summaryCardsExpanded')), '1');
          await page.locator('#holdings-tab').click();
          await pause(page);
          assert.equal(await page.locator('#portfolioOverview').isVisible(), false);
          assert.ok(await page.evaluate(() => document.querySelector('#holdingsTable').getBoundingClientRect().top > 40), 'tab switch must return to start of holdings');
          // Crossing the breakpoint restores desktop scrolling and clears the offset.
          await page.setViewportSize({width: 1024, height: 768});
          await pause(page);
          assert.equal(await page.locator('#portfolioOverview').isVisible(), true);
          assert.equal(await page.locator('.holdings-table-scroll').evaluate(el => el.style.getPropertyValue('--holdings-header-offset')), '');
        } else {
          assert.notEqual(initial.overview, 'none');
          assert.ok(initial.scrollHeight > initial.height, 'desktop retains bounded table scroll');
          await page.locator('.holdings-table-scroll').evaluate(el => el.scrollTop = 200);
          const diff = await page.evaluate(() => document.querySelector('#holdingsTable th').getBoundingClientRect().top - document.querySelector('.holdings-table-scroll').getBoundingClientRect().top);
          assert.ok(Math.abs(diff) < 2, 'desktop header remains sticky');
          await page.screenshot({path: `${output}/${engine}-${width}.png`});
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${engine} ${width}: table starts ${Math.round(initial.tableTop)}px; scrolling, labels and controls verified`);
        await context.close();
      }
    } finally { await browser.close(); }
  }
})().catch(error => {console.error(error); process.exit(1);});
