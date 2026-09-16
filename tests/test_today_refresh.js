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
        syncMarketDay: () => false, updateIntradayDateNavigation() {},
        marketTodayStr: () => '2026-09-07', TodayPnl: require('../static/js/today-pnl.js'),
        latestTodaySnapshot: null, baseHoldingsData: [],
        currentIntradayDate: null, intradayLoadRequestId: 0, currentInterval: '1m',
        secondaryRefreshTask: null, tickerHistoryInitialized: false,
        dashboardLoadRequestId: 0, holdingsData: [], allocationView: 'assets',
        transactionUpdateState: 'idle', holdingsLedgerKnown: false,
        portfolioChartView: 'investment', renderedIntraday: null,
        fetchPositions: async () => null,
        fetchTargets: async () => {},
        setDashboardStatus() {}, snapshotStatus: () => '', slicePerformance: data => data,
        renderHoldingsTable() {}, updateSummaryCards() {}, updateHoldingsTable() {},
        updateAllocationChart() {}, updateInvestmentChart: async () => {},
        updateSoldTable() {}, updateDividendsTable() {}, updateAnnualTable() {},
        updatePnlChart() {}, updateDailyPnlList() {}, updateMonthlyPnlList() {},
        transactionCache: {}, apiCache: {clear() {}, set() {}}, console, setTimeout,
        fetch: async (url, options) => {
            events.push(['fetch', url, options.method]);
            return {ok: true, json: async () => ({date: '2026-09-07', intraday: [{time: '10:01'}]})};
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
    request.resolve({ok: true, json: async () => ({date: '2026-09-07', intraday: [{time: '10:01'}]})});
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
    context.fetchTargets = async () => {};
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
    context.fetchTargets = async () => {};
    for (const name of ['fetchSummary', 'fetchPerformance', 'fetchDividends', 'fetchSoldAssets', 'fetchDailyPnl', 'fetchMonthlyPnlData']) context[name] = async () => null;
    context.currentPeriod = 'YTD';
    context.portfolioPeriod = 'ALL';
    context.renderedIntraday = {intraday: [{time: '10:02'}]};
    vm.runInContext(allSource, context);
    await context.loadAllData({skipIntraday: true});
    assert.deepEqual(events, []);
});

test('same-minute reuse avoids chart redraw and secondary page requests', async () => {
    const {context, events} = setup();
    const data = {intraday: [{time: '10:01'}], computed_at: '2026-09-07T10:01:02-04:00', date: '2026-09-07', refresh_skipped: true};
    context.renderedIntraday = data;
    context.fetch = async () => ({ok: true, json: async () => data});
    assert.equal((await context.refreshData()).refresh_skipped, true);
    assert.deepEqual(events, []);
    assert.equal(context.secondaryRefreshTask, null);
});

test('same-minute server cache still renders when this browser has no chart', async () => {
    const {context, events} = setup();
    context.renderedIntraday = null;
    context.fetch = async () => ({ok: true, json: async () => ({intraday: [{time: '10:01'}], computed_at: '2026-09-07T10:01:02-04:00', date: '2026-09-07', refresh_skipped: true})});
    await context.refreshData();
    assert.deepEqual(events, [['chart', '10:01']]);
    assert.equal(context.secondaryRefreshTask, null);
});

function setupPanels() {
    const { context, events } = setup();
    const requests = Object.fromEntries(['positions','summary','performance','daily','monthly','sold','dividends'].map(key => [key,deferred()]));
    Object.assign(context, {
        currentPeriod: 'YTD', portfolioPeriod: '1Y',
        fetchPositions: () => requests.positions.promise,
        fetchSummary: () => requests.summary.promise,
        fetchPerformance: () => requests.performance.promise,
        fetchDailyPnl: () => requests.daily.promise,
        fetchMonthlyPnlData: () => requests.monthly.promise,
        fetchSoldAssets: () => requests.sold.promise,
        fetchDividends: () => requests.dividends.promise,
        updateHoldingsTable(data) { events.push(['holdings',data]); context.holdingsData=data; },
        updateAnnualTable(data) { events.push(['annual',data]); },
        updateSoldTable(data) { events.push(['sold',data]); },
        updateDividendsTable(data) { events.push(['dividends',data]); },
    });
    vm.runInContext(allSource, context);
    return { context, events, requests, finish() { Object.values(requests).forEach(request => request.resolve(null)); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('post-save positions and summary render while Today is still waiting', async () => {
    const {context, events, requests, finish} = setupPanels();
    const today = deferred();
    context.loadIntradayData = () => today.promise;
    const task = context.loadAllData({prioritizeIntraday: false});
    requests.positions.resolve({holdings: [{symbol: 'AAPL', quantity: 6, cost_basis: 620, prices_pending: true}]});
    await settle();
    assert.equal(context.holdingsData[0].quantity, 6);
    assert.equal(context.holdingsData[0].cost_basis, 620);
    requests.summary.resolve({holdings: [{symbol: 'AAPL', quantity: 6, cost_basis: 620, current_price: 130}]});
    await settle();
    assert.equal(context.holdingsData[0].current_price, 130);
    assert.equal(events.filter(event => event[0] === 'holdings').length, 2);
    today.resolve(true); finish(); await task;
});

test('a failed post-save panel reports an update error and a later retry recovers', async () => {
    const {context, requests, finish} = setupPanels();
    const states = [];
    context.transactionUpdateState = 'updating';
    context.setTransactionUpdateState = state => { states.push(state); context.transactionUpdateState = state; };
    const task = context.loadAllData({skipIntraday: true});
    requests.summary.resolve(null); finish(); await task;
    assert.equal(states.at(-1), 'error');
    context.transactionUpdateState = 'updating';
    context.fetchPositions = async () => ({holdings: []});
    context.fetchSummary = async () => ({holdings: []});
    for (const name of ['fetchPerformance', 'fetchDailyPnl', 'fetchMonthlyPnlData', 'fetchSoldAssets', 'fetchDividends']) context[name] = async () => ({});
    await context.loadAllData({skipIntraday: true});
    assert.equal(states.at(-1), 'idle');
});

test('positions render before Today or any slow market requests complete', async () => {
    const {context,events,requests,finish} = setupPanels();
    const today = deferred();context.loadIntradayData = () => today.promise;
    const task = context.loadAllData();
    requests.positions.resolve({holdings:[{symbol:'AAPL',quantity:5,cost_basis:100,prices_pending:true}]});
    await settle();
    assert.equal(events[0][0], 'holdings');
    assert.equal(events[0][1][0].quantity, 5);
    today.resolve();finish();await task;
});

test('a pending history calculation never blocks holdings, sales or dividends', async () => {
    const {context,events,requests,finish} = setupPanels();
    const task = context.loadAllData({skipIntraday:true});
    requests.summary.resolve({holdings:[{symbol:'AAPL',current_price:150}]});
    requests.sold.resolve({sold_assets:[]});requests.dividends.resolve({by_asset:[]});
    await settle();
    assert.deepEqual(events.map(event => event[0]).sort(), ['dividends','holdings','sold']);
    finish();await task;
});

test('a late ledger-only response cannot erase loaded prices', async () => {
    const {context,events,requests,finish} = setupPanels();
    const task = context.loadAllData({skipIntraday:true});
    requests.summary.resolve({holdings:[{symbol:'AAPL',current_price:150}]});await settle();
    requests.positions.resolve({holdings:[{symbol:'AAPL',prices_pending:true}]});await settle();
    assert.equal(events.filter(event => event[0]==='holdings').length,1);
    assert.equal(context.holdingsData[0].current_price,150);
    finish();await task;
});

test('stale summary paints immediately and is replaced once its shared refresh finishes', async () => {
    const {context,events,requests,finish} = setupPanels();
    const fresh = deferred();
    context.fetchSummary = (_cached,waitFresh) => waitFresh ? fresh.promise : requests.summary.promise;
    const task = context.loadAllData({skipIntraday:true});
    requests.summary.resolve({holdings:[{symbol:'AAPL',current_price:100}],cache_status:'stale'});
    await settle();assert.equal(context.holdingsData[0].current_price,100);
    fresh.resolve({holdings:[{symbol:'AAPL',current_price:105}],cache_status:'fresh'});
    await settle();assert.equal(context.holdingsData[0].current_price,105);
    assert.equal(events.filter(event => event[0]==='holdings').length,2);
    finish();await task;
});

test('a superseded load cannot overwrite holdings after a ledger change', async () => {
    const {context,events,requests,finish} = setupPanels();
    const task = context.loadAllData({skipIntraday:true});
    context.dashboardLoadRequestId++;
    requests.summary.resolve({holdings:[{symbol:'OLD'}]});
    requests.positions.resolve({holdings:[{symbol:'OLD',prices_pending:true}]});
    finish();await task;
    assert.equal(events.filter(event => event[0]==='holdings').length,0);
});

test('response spanning midnight cannot render or populate the new day cache', async () => {
    const { context, events } = setup();
    const request = deferred();
    let cacheWrites = 0;
    context.apiCache.set = () => cacheWrites++;
    context.fetch = () => request.promise;
    const pending = context.refreshData();
    context.marketTodayStr = () => '2026-09-08';
    request.resolve({ ok: true, json: async () => ({ date: '2026-09-07', intraday: [{ time: '23:59' }] }) });
    assert.equal(await pending, null);
    assert.equal(cacheWrites, 0);
    assert.deepEqual(events, []);
});

test('wrong-date server response cannot be displayed under Today', async () => {
    const { context, events } = setup();
    context.fetch = async () => ({ ok: true, json: async () => ({ date: '2026-09-06', intraday: [{ time: '23:59' }] }) });
    await assert.rejects(context.refreshData(), /date changed/);
    assert.deepEqual(events, []);
});
