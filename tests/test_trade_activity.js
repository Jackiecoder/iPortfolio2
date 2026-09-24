const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TodayPnl = require('../static/js/today-pnl.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');

function position(net, overrides = {}) {
    return { symbol: 'LYTE', quantity: 100 + net, current_price: 30, pnl: 423, pnl_percent: 5.98,
        daily_change_amount: 423, daily_change_percent: 5.98,
        trade_activity: { opening_quantity: 100, bought_quantity: Math.max(net, 0),
            sold_quantity: Math.max(-net, 0), net_quantity: net, change_percent: net,
            is_closed: net === -100, last_sell_price: net < 0 ? 24.99 : null,
            last_sell_time: net < 0 ? '10:22' : null, ...overrides } };
}

test('activity colors follow net trading and exact threshold boundaries, independently of gains', () => {
    for (const [net, kind] of [[-100, 'closed'], [-99, 'reduced'], [-50, 'reduced'],
        [-49.99, 'trimmed'], [-1, 'trimmed'], [1, 'added'], [24.99, 'added'], [25, 'bought']]) {
        assert.equal(TodayPnl.activity(position(net)).kind, kind);
    }
    assert.equal(TodayPnl.activity(position(5, {opening_quantity: 0, change_percent: null})).label, 'Opened');
    assert.equal(TodayPnl.activity(position(0, {bought_quantity: 10, sold_quantity: 10})).kind, 'traded');
    assert.equal(TodayPnl.activity(position(0)), null);
    assert.equal(TodayPnl.activity({quantity: 0}), null);
});

test('only closed positions use last execution price; reopening and partial sales use market price', () => {
    assert.equal(TodayPnl.displayPrice(position(-100)), 24.99);
    assert.equal(TodayPnl.displayPrice(position(-50)), 30);
    assert.equal(TodayPnl.displayPrice(position(-90, {bought_quantity: 10, sold_quantity: 100})), 30);
    assert.equal(TodayPnl.displayPrice(position(-100, {last_sell_price: null})), null);
    assert.equal(TodayPnl.displayPrice(position(25)), 30);
});

test('Holdings projection preserves trade metadata, market totals and P&L and clears stale activity', () => {
    const open = { ...position(-50), cost_basis: 1000, market_value: 1500 };
    const date = '2026-09-16';
    const sold = { ...position(-100), symbol: 'SOLD' };
    const snapshot = {date, intraday: [{holdings_complete: true, asset_changes: [open, sold]}]};
    const rows = TodayPnl.project([open], snapshot, date);
    assert.equal(TodayPnl.activity(rows[0]).kind, 'reduced');
    assert.equal(TodayPnl.displayPrice(rows[1]), 24.99);
    assert.equal(rows[1].market_value, 0);
    assert.equal(rows[1].cost_basis, 0);
    assert.equal(rows.reduce((n, h) => n + h.daily_change_amount, 0), 846);
    assert.equal(TodayPnl.project([open], snapshot, '2026-09-17')[0].trade_activity, null);
    assert.equal(TodayPnl.project([open], null, date)[0].trade_activity, null);
});

function renderingContext() {
    const elements = Object.fromEntries(['topGainersBody', 'topLosersBody', 'topMoversTime', 'topMoversDailyTotal'].map(id => [id, {}]));
    const context = { TodayPnl, anonymousMode: false, renderedIntraday: null,
        document: {getElementById: id => elements[id]},
        displaySymbol: s => s, escapeHtml: s => String(s), formatNumber: n => String(n),
        formatPrice: (_s, n) => '$' + n.toFixed(2), formatPercent: n => n.toFixed(2) + '%',
        formatCurrencyAlways: n => '$' + n.toFixed(2),
    };
    vm.createContext(context);
    const spotlightStart = source.indexOf('function updateIntradaySpotlight(');
    vm.runInContext(source.slice(spotlightStart, source.indexOf('\nfunction ', spotlightStart)), context);
    vm.runInContext(source.slice(source.indexOf('function buildTradeActivityHtml('), source.indexOf('function buildHoldingRowHtml(')), context);
    vm.runInContext(source.slice(source.indexOf('const TOP_MOVERS_LIMIT'), source.indexOf('function slicePerformance(')), context);
    return {context, elements};
}

test('default and hover movers show a red closed label, last sale price/time, and still-positive P&L', () => {
    const { context, elements } = renderingContext();
    for (const render of [() => context.renderTopMovers([position(-100)]),
        () => context.renderTopMoversAtTime('11:00', 423, 5.98, [position(-100)])]) {
        render();
        const html = elements.topGainersBody.innerHTML;
        assert.match(html, /trade-activity-closed/);
        assert.match(html, /\$24\.99/);
        assert.match(html, /Last sale · 10:22 ET/);
        assert.match(html, /text-success[^>]*>\+\$423\.00/);
        assert.doesNotMatch(html, /\$30\.00/);
    }
    context.renderTopMoversAtTime('10:00', 423, 5.98, [{...position(-100), trade_activity: null}]);
    assert.doesNotMatch(elements.topGainersBody.innerHTML, /trade-activity-closed|Last sale/);
    assert.match(elements.topGainersBody.innerHTML, /\$30\.00/);
    context.renderTopMovers([position(-50)]);
    assert.match(elements.topGainersBody.innerHTML, /trade-activity-reduced/);
    assert.match(elements.topGainersBody.innerHTML, /\$30\.00/);
});
