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
        const savedTab = {320: '#trackerHoldings', 390: '#trackerPerformance', 430: '#trackerFinance', 1440: '#trackerTransactions'}[width];
        await page.addInitScript(previousTab => {
          localStorage.setItem('trackerActiveTab', previousTab);
          localStorage.setItem('summaryCardsExpanded', '1');
          localStorage.setItem('holdingsHiddenCols', JSON.stringify([3,8,9,11,12,13,14,15,16,17,18]));
        }, savedTab);
        await page.goto(baseURL + '/');
        await page.waitForSelector('#trackerToday.active');
        assert.equal(await page.locator('#today-tab').getAttribute('aria-selected'), 'true', `${engine} ${width}: Today must open despite saved ${savedTab}`);
        assert.equal(await page.locator('#summaryCardsCollapse').isVisible(), false, 'summary must start collapsed despite saved expanded state');
        assert.equal(await page.locator('#summaryToggleBtn').getAttribute('aria-expanded'), 'false');
        await page.waitForFunction(() => window.Chart?.getChart('intradayChart')?.data.labels.length > 0);
        await pause(page);
        const openingChart = await page.locator('#intradayChart').evaluate(canvas => {
          const bounds = canvas.getBoundingClientRect();
          return {height: bounds.height, bottom: bounds.bottom, viewport: innerHeight};
        });
        assert.ok(openingChart.height >= 160, `opening Today chart too short: ${JSON.stringify(openingChart)}`);
        assert.ok(openingChart.height <= (mobile ? 300 : 360) + 1, `opening Today chart too tall: ${JSON.stringify(openingChart)}`);
        assert.ok(openingChart.bottom <= openingChart.viewport + 1, `opening Today chart must fit on screen: ${JSON.stringify(openingChart)}`);
        await page.screenshot({path: `${output}/${engine}-${width}-today.png`});
        await page.locator('#holdings-tab').click();
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
          assert.equal(await page.locator('#summaryCardsCollapse').isVisible(), false, 'summary must remain collapsed after switching tabs');
          assert.equal(await page.locator('#summaryToggleBtn').getAttribute('aria-expanded'), 'false');
          await page.locator('#holdings-tab').click();
          await pause(page);
          assert.equal(await page.locator('#portfolioOverview').isVisible(), false);
          assert.ok(await page.evaluate(() => document.querySelector('#holdingsTable').getBoundingClientRect().top > 40), 'tab switch must return to start of holdings');
          // Crossing the breakpoint keeps the same page scroll surface.
          await page.setViewportSize({width: 1024, height: 768});
          await pause(page);
          assert.equal(await page.locator('#portfolioOverview').isVisible(), true);
          assert.equal(await page.locator('.holdings-table-scroll').evaluate(el => el.scrollTop), 0);
          assert.ok(await page.locator('.holdings-table-scroll').evaluate(el => el.scrollHeight - el.clientHeight <= 1), 'breakpoint must not introduce nested vertical scrolling');
        } else {
          assert.notEqual(initial.overview, 'none');
          assert.ok(initial.scrollHeight - initial.height <= 1, 'desktop must not use nested vertical scrolling');
          await page.mouse.move(width / 2, Math.min(620, initial.tableTop + 80));
          await page.mouse.wheel(0, Math.ceil(initial.tableTop) + 120);
          await pause(page);
          const position = await page.evaluate(() => {
            const scroller = document.querySelector('.holdings-table-scroll');
            const navbar = document.querySelector('.app-navbar');
            const nav = navbar.getBoundingClientRect();
            const table = scroller.getBoundingClientRect();
            const stickyToolbar = ['sticky', 'fixed'].includes(getComputedStyle(navbar).position)
              && nav.right > table.left && nav.left < table.right;
            return {page: scrollY, inner: scroller.scrollTop,
              head: document.querySelector('#holdingsTable th').getBoundingClientRect().top,
              toolbar: stickyToolbar ? Math.max(0, nav.bottom) : 0};
          });
          assert.ok(position.page > 0, 'desktop scroll over the table must move the page');
          assert.equal(position.inner, 0);
          assert.ok(Math.abs(position.head - position.toolbar) < 2, `desktop headings must pin below the toolbar: ${JSON.stringify(position)}`);
          await page.screenshot({path: `${output}/${engine}-${width}.png`});
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${engine} ${width}: table starts ${Math.round(initial.tableTop)}px; scrolling, labels and controls verified`);
        await context.close();
      }
    } finally { await browser.close(); }
  }
})().catch(error => {console.error(error); process.exit(1);});
