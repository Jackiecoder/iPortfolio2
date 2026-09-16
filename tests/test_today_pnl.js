const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TodayPnl = require('../static/js/today-pnl.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');
const date = '2026-09-08';
const snapshot = { date, intraday: [{ time: '12:00', holdings_complete: true, daily_pnl: 12.03,
    asset_changes: [{ symbol: 'AAPL', quantity: 2, pnl: 10.02, pnl_percent: 5 },
        { symbol: 'SOLD', quantity: 0, pnl: 2.01, pnl_percent: 2, current_price: 999,
            trade_activity: { opening_quantity: 1, bought_quantity: 0, sold_quantity: 1,
                net_quantity: -1, change_percent: -100, is_closed: true,
                last_sell_price: 24.99, last_sell_time: '10:22' } }] }] };
const holdings = [{ symbol: 'AAPL', quantity: 2, cost_basis: 100, market_value: 200, daily_change_amount: 999 },
    { symbol: 'CASH', quantity: 1, cost_basis: 50, market_value: 50 }];
const cents = rows => rows.reduce((sum, row) => sum + Math.round((row.daily_change_amount || 0) * 100), 0);

test('all displayed contributions including closed positions sum to chart, without altering current values', () => {
    const rows = TodayPnl.project(holdings, snapshot, date);
    assert.equal(cents(rows), Math.round(snapshot.intraday[0].daily_pnl * 100));
    assert.equal(rows.find(row => row.symbol === 'SOLD').today_only, true);
    assert.equal(rows.reduce((sum, row) => sum + row.market_value, 0), 250);
    assert.equal(rows.reduce((sum, row) => sum + row.cost_basis, 0), 150);
    assert.equal(holdings[0].daily_change_amount, 999);
});

test('pending prices do not prevent Today reconciliation and late summaries cannot overwrite it', () => {
    const early = TodayPnl.project(holdings.map(h => ({ ...h, prices_pending: true })), snapshot, date);
    const late = TodayPnl.project(holdings.map(h => ({ ...h, daily_change_amount: -123 })), snapshot, date);
    assert.equal(cents(early), 1203);
    assert.equal(cents(late), 1203);
    assert.equal(late.filter(row => row.symbol === 'SOLD').length, 1);
});

test('yesterday or incomplete top-ten data cannot supply Today amounts', () => {
    for (const data of [null, { ...snapshot, date: '2026-09-07' },
        { date, intraday: [{ asset_changes: snapshot.intraday[0].asset_changes }] }]) {
        const rows = TodayPnl.project(holdings, data, date);
        assert.ok(rows.every(row => row.daily_change_amount === null && row.today_pending));
        assert.equal(rows.length, holdings.length);
    }
});

function navigationContext() {
    const picker = { value: '2026-09-07', max: '2026-09-07' };
    const next = {}, prev = {}, events = [];
    const context = {
        observedMarketDate: '2026-09-07', currentIntradayDate: null,
        currentInterval: '1m', dashboardLoadRequestId: 2, intradayLoadRequestId: 2,
        latestTodaySnapshot: { ...snapshot, date: '2026-09-07' }, baseHoldingsData: holdings,
        marketTodayStr: () => date, apiCache: { clear: () => events.push('clear') },
        document: { getElementById: id => ({ intradayDatePicker: picker, intradayNextDate: next, intradayPrevDate: prev })[id] },
        updateIntradayChart: data => events.push(['chart', data]),
        updateHoldingsTable: data => events.push(['holdings', data]),
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function syncMarketDay()'), source.indexOf('function selectIntradayDate(')), context);
    return { context, picker, next, events };
}

test('midnight clears live snapshots, advances picker and invalidates in-flight requests exactly once', () => {
    const { context, picker, next, events } = navigationContext();
    assert.equal(context.syncMarketDay(), true);
    assert.equal(picker.value, date);
    assert.equal(picker.max, date);
    assert.equal(next.disabled, true);
    assert.equal(context.latestTodaySnapshot, null);
    assert.equal(context.intradayLoadRequestId, 3);
    assert.equal(context.dashboardLoadRequestId, 3);
    assert.equal(events[1][0], 'chart');
    assert.equal(events[1][1], null);
    const count = events.length;
    assert.equal(context.syncMarketDay(), false);
    assert.equal(events.length, count);
});

test('midnight preserves explicit historical date and enables next day', () => {
    const { context, picker, next, events } = navigationContext();
    context.currentIntradayDate = '2026-09-05';
    context.syncMarketDay();
    assert.equal(picker.value, '2026-09-05');
    assert.equal(picker.max, date);
    assert.equal(next.disabled, false);
    assert.equal(events.filter(e => Array.isArray(e) && e[0] === 'chart').length, 0);
});

test('the rendered Holdings row, total and category amounts use the displayed snapshot even after stale summaries', () => {
    const tbody = { innerHTML: '', querySelectorAll: () => [] };
    const category = { innerHTML: '' };
    const status = {};
    const context = {
        TodayPnl, latestTodaySnapshot: snapshot, marketTodayStr: () => date,
        baseHoldingsData: [], holdingsData: [], anonymousMode: false,
        targetAllocations: {}, targetGroups: {}, symbolToGroup: {},
        holdingsSortColumn: 'symbol', holdingsSortDirection: 'asc', holdingsViewMode: 'category',
        document: { getElementById: id => id === 'holdingsBody' ? tbody : category, querySelectorAll: () => [] },
        setDashboardStatus: (id, text) => status[id] = text,
        formatCurrencyAlways: n => '$' + Number(n || 0).toFixed(2),
        formatCurrency: n => '$' + Number(n || 0).toFixed(2),
        formatPercent: n => Number(n || 0).toFixed(2) + '%',
        formatNumber: n => String(n), formatPrice: (_symbol, n) => String(n ?? '--'),
        getCategory: symbol => symbol === 'CASH' ? 'Cash' : 'Individual Stocks',
        getTargetKey: symbol => symbol, displaySymbol: symbol => symbol, escapeHtml: s => s,
        getTargetPct: () => null, getAssetIconHtml: () => '', getGroupMarketValue: () => 0,
        renderTopMoversDefault() {},
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function sortHoldings('), source.indexOf('async function toggleTransactionDetail(')), context);
    vm.runInContext(source.slice(source.indexOf('function updateHoldingsTable('), source.indexOf('function updateDividendsTable(')), context);
    for (const prices_pending of [true, false]) {
        context.updateHoldingsTable(holdings.map(h => ({ ...h, prices_pending, daily_change_amount: -900 })));
        assert.match(tbody.innerHTML, /trade-activity-closed/);
        assert.match(tbody.innerHTML, /24\.99/);
        assert.match(tbody.innerHTML, /Last sale · 10:22 ET/);
        assert.match(tbody.innerHTML, /\+\$10\.02/);
        assert.match(tbody.innerHTML, /\+\$2\.01/);
        assert.match(tbody.innerHTML, /<strong>\+\$12\.03<\/strong>/);
        assert.match(category.innerHTML, /<strong>\+\$12\.03<\/strong>/);
        assert.ok(!tbody.innerHTML.includes('900.00'));
    }
    assert.match(status.holdingsTodayStatus, /2026-09-08 12:00 ET/);
});
