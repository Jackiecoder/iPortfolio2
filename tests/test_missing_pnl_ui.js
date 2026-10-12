const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const TodayPnl = require('../static/js/today-pnl.js');

const source = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');

function frontend() {
    const elements = new Map();
    for (const id of ['topMoversTime', 'topMoversDailyTotal', 'topMoversDailyLabel',
        'topMoversMissingPrices', 'topGainersBody', 'topLosersBody', 'dailyPnlList',
        'intradayLatestPnl', 'intradayLatestReturn', 'intradayPnlLabel', 'coveredCallMover']) {
        const classes = new Set();
        elements.set(id, {
            innerHTML: '', textContent: '', className: '', hidden: false,
            classList: { toggle(name, yes) { yes ? classes.add(name) : classes.delete(name); } },
            addEventListener() {}, querySelectorAll() { return []; },
        });
    }
    const canvasContext = {
        canvas: { width: 600, height: 250 },
        clearRect() {}, fillText() {},
    };
    elements.set('intradayChart', { getContext() { return canvasContext; } });
    const context = vm.createContext({
        document: {
            getElementById(id) { return elements.get(id) || null; },
            addEventListener() {},
        },
        TodayPnl, anonymousMode: false, intradayChart: null, renderedIntraday: null,
        holdingsData: [], baseHoldingsData: [], latestTodaySnapshot: null,
        targetAllocations: {}, targetGroups: {}, symbolToGroup: {},
        marketTodayStr: () => '2026-10-02', updateHoldingsTable() {},
        marketHoursPlugin: {}, hoverLinePlugin: {},
        console,
        Chart: function (_ctx, config) {
            Object.assign(this, config);
            this.destroy = () => {};
        },
    });
    for (const [start, end] of [
        ['function getAssetIconHtml(', '// Utility functions'],
        ['function formatCurrency(', 'function toggleAnonymousMode('],
        ['function buildTradeActivityHtml(', 'function buildHoldingRowHtml('],
        ['function buildHoldingRowHtml(', 'function renderHoldingsTable('],
        ['function coveredCallPnlValue(', 'function buildTotalRowHtml('],
        ['function updateCategoryTable(', 'function updateDividendsTable('],
        ['function generateFullDayLabels(', 'function updateAllocationChart('],
        ['function escapeHtml(', '// Today\'s date'],
        ['const TOP_MOVERS_LIMIT', 'function slicePerformance('],
        ['function updateDailyPnlList(', 'function updateMonthlyPnlList('],
    ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
    return { context, elements, run(code) { return vm.runInContext(code, context); } };
}

test('missing NIGHT baseline is excluded from movers and partial total is explained', () => {
    const ui = frontend();
    ui.run(`renderTopMoversAtTime('06:59', 25, 2.5, [
        {symbol: 'NIGHT-USD', pnl: null, pnl_percent: null, current_price: 0.0444},
        {symbol: 'BTC-USD', pnl: 25, pnl_percent: 2.5, current_price: 100}
    ], true, {time: '06:59', daily_pnl: 25, daily_pnl_percent: 2.5,
        missing_baseline_symbols: ['NIGHT-USD']});`);
    assert.equal(ui.elements.get('topMoversDailyLabel').textContent, 'Partial Daily P&L');
    assert.equal(ui.elements.get('topMoversDailyTotal').textContent, '+$25.00 (+2.50%)');
    assert.equal(ui.elements.get('topMoversMissingPrices').hidden, false);
    assert.equal(ui.elements.get('topMoversMissingPrices').textContent,
        'Daily P&L unavailable: NIGHT (missing reference price)');
    assert.doesNotMatch(ui.elements.get('topGainersBody').innerHTML, /NIGHT/);
    assert.match(ui.elements.get('topGainersBody').innerHTML, /BTC/);
});

test('all unknown contributions display unavailable rather than zero', () => {
    const ui = frontend();
    ui.run(`renderTopMoversAtTime('06:59', null, null,
        [{symbol: 'NIGHT-USD', pnl: null, pnl_percent: null}], true,
        {time: '06:59', daily_pnl: null, daily_pnl_percent: null, missing_baseline_symbols: ['NIGHT-USD']});`);
    assert.equal(ui.elements.get('topMoversDailyTotal').textContent, 'Unavailable');
    assert.match(ui.elements.get('topMoversDailyTotal').className, /text-muted/);
    assert.doesNotMatch(ui.elements.get('topGainersBody').innerHTML, /NIGHT/);

    ui.run(`renderTopMoversAtTime('07:00', 0, 0, []);`);
    assert.equal(ui.elements.get('topMoversDailyTotal').textContent, '+$0.00 (+0.00%)');
    assert.equal(ui.elements.get('topMoversMissingPrices').hidden, true);
    assert.equal(ui.elements.get('topMoversDailyLabel').textContent, 'Daily P&L');
});

test('holdings fallback percentage excludes assets with unknown daily contribution', () => {
    const ui = frontend();
    ui.run(`renderTopMovers([
        {symbol: 'NIGHT-USD', daily_change_amount: null, market_value: 4000},
        {symbol: 'BTC-USD', daily_change_amount: 10, daily_change_percent: 10, market_value: 110},
        {symbol: 'CASH', daily_change_amount: 0, market_value: 10000}
    ]);`);
    assert.equal(ui.elements.get('topMoversDailyTotal').textContent, '+$10.00 (+10.00%)');
    assert.equal(ui.elements.get('topMoversDailyLabel').textContent, 'Partial Daily P&L');
});

test('chart preserves unavailable points and carries missing symbols through default and hover', () => {
    const ui = frontend();
    ui.run(`updateIntradayChart({intraday: [
        {time: '00:00', daily_pnl: 0, daily_pnl_percent: 0, asset_changes: []},
        {time: '00:05', daily_pnl: null, daily_pnl_percent: null,
         asset_changes: [{symbol: 'NIGHT-USD', pnl: null}], missing_baseline_symbols: ['NIGHT-USD']},
        {time: '00:10', daily_pnl: 20, daily_pnl_percent: 2,
         asset_changes: [{symbol: 'BTC-USD', pnl: 20}], missing_baseline_symbols: ['NIGHT-USD']}
    ]}, '5m');`);
    assert.equal(ui.run('intradayChart.data.datasets[0].data[1]'), null);
    assert.equal(ui.run('intradayChart.data.datasets[0].spanGaps'), false);
    assert.equal(ui.elements.get('topMoversDailyLabel').textContent, 'Partial Daily P&L');
    assert.match(ui.elements.get('topMoversMissingPrices').textContent, /NIGHT/);

    ui.run('intradayChart.options.onHover({}, [{index: 1}], intradayChart);');
    assert.equal(ui.elements.get('topMoversDailyTotal').textContent, 'Unavailable');
    assert.equal(ui.elements.get('topMoversTime').textContent, '00:05 · ');
    ui.run('intradayChart.options.onHover({}, [{index: 0}], intradayChart);');
    assert.equal(ui.elements.get('topMoversMissingPrices').hidden, true);
    assert.equal(ui.elements.get('topMoversDailyTotal').textContent, '+$0.00 (+0.00%)');
});

test('latest unavailable chart point does not fall back to holdings or show zero', () => {
    const ui = frontend();
    ui.run(`holdingsData = [{symbol: 'NIGHT-USD', daily_change_amount: 4299.16}];
        updateIntradayChart({intraday: [{time: '06:55', daily_pnl: null,
          daily_pnl_percent: null, asset_changes: [{symbol: 'NIGHT-USD', pnl: null}],
          missing_baseline_symbols: ['NIGHT-USD']}]}, '5m');`);
    assert.equal(ui.elements.get('topMoversDailyTotal').textContent, 'Unavailable');
    assert.doesNotMatch(ui.elements.get('topGainersBody').innerHTML, /NIGHT|4,299/);
});

test('today list overrides contaminated old total with explicit unavailable or partial data', () => {
    const ui = frontend();
    ui.run(`const today = marketTodayStr();
        const oldSnapshot = {daily_pnl: [{date: today, daily_pnl: 4299.16,
          daily_pnl_percent: 0, asset_changes: [{symbol: 'NIGHT-USD', pnl: 4299.16}]}]};
        updateDailyPnlList(oldSnapshot, {date: today, intraday: [{time: '06:59', holdings_complete: true, daily_pnl: null,
          daily_pnl_percent: null, asset_changes: [{symbol: 'NIGHT-USD', pnl: null}],
          missing_baseline_symbols: ['NIGHT-USD']}]});`);
    const unavailable = ui.elements.get('dailyPnlList').innerHTML;
    assert.match(unavailable, /Unavailable/);
    assert.match(unavailable, /NIGHT \(missing reference price\)/);
    assert.doesNotMatch(unavailable, /4,299|\+0\.00%|\+\$0\.00/);

    ui.run(`updateDailyPnlList(oldSnapshot, {date: today, intraday: [{time: '07:00', holdings_complete: true, daily_pnl: 15,
        daily_pnl_percent: 1.5, asset_changes: [{symbol: 'BTC-USD', pnl: 15},
        {symbol: 'NIGHT-USD', pnl: null}], missing_baseline_symbols: ['NIGHT-USD']}]});`);
    const partial = ui.elements.get('dailyPnlList').innerHTML;
    assert.match(partial, /\+\$15\.00/);
    assert.match(partial, /\(partial\)/);
    assert.doesNotMatch(partial, /4,299/);
});

test('partial holdings totals retain covered calls and never replace unknown positions with zero', () => {
    const ui = frontend();
    ui.context.latestTodaySnapshot = {
        date: '2026-10-02', intraday: [{time: '07:00', holdings_complete: true,
            holdings_daily_pnl: 25, daily_pnl: 25, daily_pnl_percent: 2.5, baseline_value: 1000,
            options_present: true, options_complete: true, option_daily_pnl: -5,
            missing_baseline_symbols: ['NIGHT-USD'],
            asset_changes: [{symbol: 'NIGHT-USD', pnl: null}, {symbol: 'BTC-USD', pnl: 25}]}],
    };
    ui.context.rows = [
        {symbol: 'NIGHT-USD', daily_change_amount: null, market_value: 4000},
        {symbol: 'BTC-USD', daily_change_amount: 25, market_value: 1025},
    ];
    const total = ui.run('buildTotalRowHtml(rows, 5025)');
    assert.match(total, /data-col="5"[^>]*><strong>\+\$20\.00[^<]*<small[^>]*>\(partial\)/);
    assert.match(total, /data-col="6"><strong>\$5,025\.00/);
    const subtotal = ui.run("buildCategorySubtotalHtml('Crypto', rows, 5025, {}, 0)");
    assert.match(subtotal, /\+\$25\.00[^<]*<small[^>]*>\(partial\)/);

    ui.context.latestTodaySnapshot.intraday[0] = {
        ...ui.context.latestTodaySnapshot.intraday[0], holdings_daily_pnl: null, daily_pnl: null,
    };
    const unavailable = ui.run('buildTotalRowHtml(rows, 5025)');
    assert.match(unavailable, /data-col="5" class="text-muted"><strong>Unavailable/);
    assert.doesNotMatch(unavailable, /data-col="5"[^>]*>[^<]*<strong>\+\$0\.00/);

    const closed = ui.run("buildHoldingRowHtml({symbol: 'NIGHT-USD', quantity: 0, today_only: true, daily_change_amount: null}, 0, [], {})");
    assert.match(closed, /data-col="5" class="text-muted">Unavailable/);
});

test('headline uses the latest unavailable point and partial option totals match the chart', () => {
    const ui = frontend();
    ui.run(`updateIntradaySpotlight({intraday: [
        {time: '06:00', daily_pnl: 4299.16, daily_pnl_percent: 0},
        {time: '07:00', daily_pnl: null, daily_pnl_percent: null, missing_baseline_symbols: ['NIGHT-USD']}
    ]});`);
    assert.equal(ui.elements.get('intradayLatestPnl').textContent, 'Unavailable');
    assert.equal(ui.elements.get('intradayLatestReturn').textContent, '--');
    ui.run(`updateIntradayChart({intraday: [{time: '07:00', daily_pnl: 25,
        holdings_daily_pnl: 25, daily_pnl_percent: 2.5, baseline_value: 1000,
        options_present: true, options_complete: true, option_daily_pnl: -5,
        asset_changes: [{symbol: 'NIGHT-USD', pnl: null}, {symbol: 'BTC-USD', pnl: 25}],
        missing_baseline_symbols: ['NIGHT-USD']}]}, '5m');`);
    assert.equal(ui.run('intradayChart.data.datasets[0].data[84]'), 20);
    assert.equal(ui.elements.get('intradayLatestPnl').textContent, '+$20.00');
    assert.equal(ui.elements.get('intradayPnlLabel').textContent, 'Latest partial daily P&L');
    assert.equal(ui.elements.get('topMoversDailyTotal').textContent, '+$20.00 (+2.00%)');
    assert.match(ui.elements.get('coveredCallMover').innerHTML, /Covered Call|\$5\.00/);
});
