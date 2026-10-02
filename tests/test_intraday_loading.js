const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');
const today = '2026-09-25';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function setup() {
    const overlay = { style: { display: 'none' } };
    const requests = [], charts = [];
    const context = vm.createContext({
        document: { getElementById: id => id === 'intradayLoadingOverlay' ? overlay : null },
        currentIntradayDate: null, intradayLoadRequestId: 0, currentInterval: '1m',
        transactionUpdateState: 'idle', renderedIntraday: null, observedMarketDate: today,
        dashboardLoadRequestId: 0, latestTodaySnapshot: null, baseHoldingsData: [],
        secondaryRefreshTask: null, tickerHistoryInitialized: false, transactionCache: {},
        apiCache: { clear() {}, set() {} }, marketTodayStr: () => today,
        updateHoldingsTable() {}, updateIntradayIntervalBadge() {}, console, setTimeout,
        loadAllData: async () => {},
        updateIntradayChart: data => charts.push(data),
        fetch: () => {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
    });
    const helperStart = source.indexOf('function beginIntradayRequest(');
    if (helperStart !== -1) {
        vm.runInContext(source.slice(helperStart, source.indexOf('// Load intraday data for a given date', helperStart)), context);
    }
    vm.runInContext(source.slice(source.indexOf('async function loadIntradayData('), source.indexOf('function escapeHtml(')), context);
    vm.runInContext(source.slice(source.indexOf('function syncMarketDay()'), source.indexOf('function selectIntradayDate(')), context);
    vm.runInContext(source.slice(source.indexOf('async function refreshData()'), source.indexOf('// Event handlers')), context);
    context.fetchIntradayAutoInterval = () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
    };
    const data = date => ({ date, intraday: [{ time: '10:10' }], refresh_skipped: true });
    return { context, overlay, requests, charts, data };
}

for (const first of ['navigation', 'refresh']) {
    test(`Live takes over a date load without leaving its overlay (${first} finishes first)`, async () => {
        const { context, overlay, requests, charts, data } = setup();
        const navigation = context.loadIntradayData(null, false);
        assert.equal(overlay.style.display, 'flex');
        const refresh = context.refreshData();
        assert.equal(overlay.style.display, 'none');
        const finishNavigation = async () => {
            requests[0].resolve({ data: data(today), interval: '1m' });
            await navigation;
        };
        const finishRefresh = async () => {
            requests[1].resolve({ ok: true, json: async () => data(today) });
            await refresh;
        };
        if (first === 'navigation') { await finishNavigation(); await finishRefresh(); }
        else { await finishRefresh(); await finishNavigation(); }
        assert.equal(overlay.style.display, 'none');
        assert.equal(charts.length, 1);
    });
}

test('a failed Live refresh cannot leave the superseded loading overlay visible', async () => {
    const { context, overlay, requests, data } = setup();
    const navigation = context.loadIntradayData(null, false);
    const refresh = context.refreshData();
    requests[1].reject(new Error('offline'));
    await assert.rejects(refresh, /offline/);
    requests[0].resolve({ data: data(today), interval: '1m' });
    await navigation;
    assert.equal(overlay.style.display, 'none');
});

test('an older date request cannot dismiss a newer date request overlay or repaint its chart', async () => {
    const { context, overlay, requests, charts, data } = setup();
    const older = context.loadIntradayData('2026-09-23', false);
    const newer = context.loadIntradayData('2026-09-24', false);
    requests[0].resolve({ data: data('2026-09-23'), interval: '1m' });
    await older;
    assert.equal(overlay.style.display, 'flex');
    assert.equal(charts.length, 0);
    requests[1].resolve({ data: data('2026-09-24'), interval: '1m' });
    await newer;
    assert.equal(overlay.style.display, 'none');
    assert.equal(charts[0].date, '2026-09-24');
});

test('a later date navigation keeps its overlay when an earlier refresh finishes', async () => {
    const { context, overlay, requests, data } = setup();
    const refresh = context.refreshData();
    const navigation = context.loadIntradayData('2026-09-24', false);
    requests[0].resolve({ ok: true, json: async () => data(today) });
    await refresh;
    assert.equal(overlay.style.display, 'flex');
    requests[1].resolve({ data: data('2026-09-24'), interval: '1m' });
    await navigation;
    assert.equal(overlay.style.display, 'none');
});

test('market-day rollover releases the invalidated request overlay', async () => {
    const { context, overlay, requests, data } = setup();
    const navigation = context.loadIntradayData(null, false);
    context.marketTodayStr = () => '2026-09-26';
    context.syncMarketDay();
    assert.equal(overlay.style.display, 'none');
    requests[0].resolve({ data: data(today), interval: '1m' });
    await navigation;
    assert.equal(overlay.style.display, 'none');
});
