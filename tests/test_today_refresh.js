const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');
const refreshSource = source.slice(source.indexOf('async function refreshData()'), source.indexOf('// Event handlers', source.indexOf('async function refreshData()')));
const allSource = source.slice(source.indexOf('async function loadAllData('), source.indexOf('async function refreshData()'));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function setup() {
    const events = [];
    const secondary = deferred();
    const context = {
        currentIntradayDate: null, intradayLoadRequestId: 0, currentInterval: '1m',
        secondaryRefreshTask: null, tickerHistoryInitialized: false,
        transactionCache: {}, apiCache: {clear() {}, set() {}}, console, setTimeout,
        fetch: async (url, options) => {
            events.push(['fetch', url, options.method]);
            return {ok: true, json: async () => ({intraday: [{time: '10:01'}]})};
        },
        updateIntradayIntervalBadge() {},
        updateIntradayChart(data) { events.push(['chart', data.intraday[0].time]); },
        loadAllData(options) { events.push(['secondary', options.skipIntraday]); return secondary.promise; },
    };
    vm.createContext(context);
    vm.runInContext(refreshSource, context);
    return { context, events, secondary };
}

test('manual refresh paints Today and returns before other pages finish', async () => {
    const {context, events, secondary} = setup();
    await context.refreshData();
    assert.deepEqual(events, [['fetch', '/api/intraday/refresh', 'POST'], ['chart', '10:01']]);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(events[2], ['secondary', true]);
    secondary.resolve();
    await context.secondaryRefreshTask;
});

test('failed refresh preserves the existing chart and does not launch other requests', async () => {
    const {context, events} = setup();
    context.fetch = async () => ({ok: false});
    await assert.rejects(context.refreshData());
    assert.deepEqual(events, []);
    assert.equal(context.secondaryRefreshTask, null);
});

test('date navigation during a request cannot be overwritten by its result', async () => {
    const {context, events, secondary} = setup();
    const request = deferred();
    let cacheWrites = 0;
    context.apiCache.set = () => { cacheWrites++; };
    context.fetch = () => request.promise;
    const refresh = context.refreshData();
    context.currentIntradayDate = '2026-09-03';
    context.intradayLoadRequestId++;
    request.resolve({ok: true, json: async () => ({intraday: [{time: '10:01'}]})});
    await refresh;
    assert.equal(events.filter(e => e[0] === 'chart').length, 0);
    assert.equal(cacheWrites, 0);
    assert.equal(context.secondaryRefreshTask, null);
    secondary.resolve();
    await context.secondaryRefreshTask;
});

test('repeated Today refreshes coalesce slower page work', async () => {
    const {context, events, secondary} = setup();
    await context.refreshData();
    const firstTask = context.secondaryRefreshTask;
    await context.refreshData();
    assert.equal(context.secondaryRefreshTask, firstTask);
    assert.equal(events.filter(e => e[0] === 'chart').length, 2);
    secondary.resolve();
    await firstTask;
    assert.equal(events.filter(e => e[0] === 'secondary').length, 1);
});

test('initial page waits for the Today render before requesting heavy endpoints', async () => {
    const {context, events} = setup();
    const chart = deferred();
    const heavy = deferred();
    context.loadIntradayData = () => { events.push(['today']); return chart.promise; };
    context.fetchTargets = () => {};
    for (const name of ['fetchSummary', 'fetchPerformance', 'fetchDividends', 'fetchSoldAssets', 'fetchDailyPnl', 'fetchMonthlyPnlData']) {
        context[name] = () => { events.push([name]); return heavy.promise; };
    }
    context.currentPeriod = 'YTD';
    context.portfolioPeriod = 'ALL';
    vm.runInContext(allSource, context);
    const load = context.loadAllData();
    assert.deepEqual(events, [['today']]);
    chart.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.some(e => e[0] === 'fetchSummary'));
    heavy.resolve(null);
    await load;
});

test('secondary pages never redraw an older Today chart', async () => {
    const {context, events} = setup();
    context.loadIntradayData = () => { throw new Error('Should skip intraday'); };
    context.fetchTargets = () => {};
    for (const name of ['fetchSummary', 'fetchPerformance', 'fetchDividends', 'fetchSoldAssets', 'fetchDailyPnl', 'fetchMonthlyPnlData']) context[name] = async () => null;
    context.currentPeriod = 'YTD';
    context.portfolioPeriod = 'ALL';
    context.renderedIntraday = {intraday: [{time: '10:02'}]};
    vm.runInContext(allSource, context);
    await context.loadAllData({skipIntraday: true});
    assert.deepEqual(events, []);
});
