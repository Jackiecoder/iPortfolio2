const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TodayPnl = require('../static/js/today-pnl.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');

function setup() {
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {textContent: '', className: '', innerHTML: '',
                classList: {toggle(name, yes) {yes ? classes.add(name) : classes.delete(name);}, contains: name => classes.has(name)},
                setAttribute() {}, getContext: () => ctx});
        }
        return elements.get(id);
    };
    const ctx = {canvas: get('intradayChart'), clearRect() {}, fillText() {}};
    const context = {document: {getElementById: get}, anonymousMode: false,
        intradayChart: null, renderedIntraday: null, holdingsData: [], baseHoldingsData: [],
        TodayPnl, marketTodayStr: () => '2026-09-24',
        updateHoldingsTable() {}, marketHoursPlugin: {}, hoverLinePlugin: {},
        formatCurrency: n => context.anonymousMode ? '***' : '$' + n.toFixed(2),
        formatCurrencyAlways: n => '$' + n.toFixed(2),
        formatPercent: n => n == null ? '--' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`,
        displaySymbol: s => s, escapeHtml: s => String(s),
        buildTradeActivityHtml: () => '', buildPositionPriceHtml: () => '',
        Chart: function (_ctx, config) {Object.assign(this, config); this.destroy = () => {};},
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function coveredCallPnlValue('), source.indexOf('function buildTotalRowHtml(')), context);
    vm.runInContext(source.slice(source.indexOf('function generateFullDayLabels('), source.indexOf('function updateAllocationChart(')), context);
    vm.runInContext(source.slice(source.indexOf('const TOP_MOVERS_LIMIT'), source.indexOf('function slicePerformance(')), context);
    const point = (time, pnl) => ({time, daily_pnl: pnl, daily_pnl_percent: pnl / 100,
        asset_changes: [{symbol: 'MU', pnl, pnl_percent: pnl / 100}]});
    const snapshot = {date: '2026-09-23', intraday: [point('09:30', -120), point('12:48', 224), point('17:45', 163)]};
    context.updateIntradayChart(snapshot, '1m');
    const explore = (time, type = 'mousemove') => {
        const chart = context.intradayChart;
        chart.options.onHover({type}, [{index: chart.data.labels.indexOf(time)}], chart);
    };
    return {context, get, explore, snapshot, point};
}

test('mouse exploration synchronizes headline, return, timestamp, colors and movers', () => {
    const {get, explore} = setup();
    explore('09:30');
    assert.equal(get('intradayLatestPnl').textContent, '$-120.00');
    assert.equal(get('intradayLatestReturn').textContent, '-1.20%');
    assert.equal(get('intradayPnlLabel').textContent, 'Daily P&L · 09:30 ET');
    assert.equal(get('topMoversTime').textContent, '09:30 · ');
    assert.match(get('topMoversDailyTotal').textContent, /\$-120.00 \(-1.20%\)/);
    assert.equal(get('intradayLatestPnl').classList.contains('text-danger'), true);
    assert.match(get('topLosersBody').innerHTML, /MU/);
});

test('touch exploration updates the same headline and return as movers', () => {
    const {get, explore} = setup();
    explore('12:48', 'touchmove');
    assert.equal(get('intradayLatestPnl').textContent, '+$224.00');
    assert.equal(get('intradayLatestReturn').textContent, '+2.24%');
    assert.match(get('intradayPnlLabel').textContent, /12:48 ET/);
    assert.match(get('topMoversDailyTotal').textContent, /\+\$224.00 \(\+2.24%\)/);
    assert.equal(get('intradayLatestPnl').classList.contains('text-success'), true);
});

test('leaving or cancelling restores the selected date latest point in both panels', () => {
    const {get, explore} = setup();
    for (const event of ['onmouseleave', 'ontouchcancel']) {
        explore('09:30');
        get('intradayChart')[event]();
        assert.equal(get('intradayPnlLabel').textContent, 'Latest daily P&L');
        assert.equal(get('intradayLatestPnl').textContent, '+$163.00');
        assert.equal(get('topMoversTime').textContent, '17:45 · ');
        assert.match(get('topMoversDailyTotal').textContent, /\+\$163.00/);
    }
});

test('missing/future points and empty active elements restore both panels together', () => {
    const {context, get, explore} = setup();
    explore('09:30');
    explore('23:00');
    assert.equal(get('intradayLatestPnl').textContent, '+$163.00');
    explore('12:48');
    context.intradayChart.options.onHover({}, [], context.intradayChart);
    assert.equal(get('intradayLatestPnl').textContent, '+$163.00');
    assert.equal(get('topMoversTime').textContent, '17:45 · ');
});

test('refresh rebuilds both panels from the new snapshot instead of old hover values', () => {
    const {context, get, explore, point} = setup();
    explore('09:30');
    context.updateIntradayChart({date: '2026-09-23', intraday: [point('18:00', 300)]}, '1m');
    assert.equal(get('intradayLatestPnl').textContent, '+$300.00');
    assert.equal(get('intradayPnlLabel').textContent, 'Latest daily P&L');
    assert.equal(get('topMoversTime').textContent, '18:00 · ');
});

test('exploration preserves headline privacy and supports zero/missing return', () => {
    const {context, get, explore} = setup();
    context.anonymousMode = true;
    explore('12:48');
    assert.equal(get('intradayLatestPnl').textContent, '***');
    context.anonymousMode = false;
    context.renderTopMoversAtTime('12:00', 0, null, []);
    assert.equal(get('intradayLatestPnl').textContent, '+$0.00');
    assert.equal(get('intradayLatestReturn').textContent, '--');
});


test('one original chart adds a known covered call contribution once with the original return basis', () => {
    const {context, get, point} = setup();
    const known = {...point('12:00', 1000), baseline_value: 50000, daily_pnl_percent: 2,
        options_present: true, options_complete: true, option_daily_pnl: -150,
        // Ignore inconsistent combined fields; combine the two contributions once.
        combined_daily_pnl: 9999, combined_daily_pnl_percent: 99};
    context.updateIntradayChart({date: '2026-09-23', intraday: [known]}, '1m');
    const chart = context.intradayChart;
    assert.equal(chart.data.datasets.length, 1);
    const dataset = chart.data.datasets[0];
    assert.equal(dataset.label, 'Daily P&L');
    assert.equal(dataset.pointRadius, 0);
    assert.equal(dataset.spanGaps, true);
    assert.equal(dataset.borderDash, undefined);
    assert.equal(chart.options.plugins.legend.display, false);
    assert.equal(dataset.data[dataset.lastDataIndex], 850);
    assert.equal(get('intradayLatestPnl').textContent, '+$850.00');
    assert.equal(get('intradayLatestReturn').textContent, '+1.70%');
    assert.equal(get('intradayPnlLabel').textContent, 'Latest daily P&L');
    assert.equal(get('topMoversDailyTotal').textContent, '+$850.00 (+1.70%)');
    assert.equal(get('coveredCallMover').hidden, false);
    assert.match(get('coveredCallMover').innerHTML, /Covered Call/);
    assert.match(get('coveredCallMover').innerHTML, /\$-150\.00/);
    assert.doesNotMatch(get('coveredCallMover').innerHTML, /data-mover-symbol|mover-detail-row/);
    assert.match(get('topGainersBody').innerHTML, /\+\$1000\.00/);
});

test('missing option prices affect only the contribution row and preserve original stock chart and return', () => {
    const {context, get, point} = setup();
    const pending = {...point('12:00', 1000), baseline_value: 50000, daily_pnl_percent: 2,
        options_present: true, options_complete: false, option_daily_pnl: null,
        option_known_daily_pnl: -200, option_details: [{pnl: -200}, {pnl: null}]};
    context.updateIntradayChart({date: '2026-09-23', intraday: [pending]}, '1m');
    assert.equal(get('intradayLatestPnl').textContent, '+$1000.00');
    assert.equal(get('intradayLatestReturn').textContent, '+2.00%');
    assert.equal(get('topMoversDailyTotal').textContent, '+$1000.00 (+2.00%)');
    assert.equal(get('intradayPnlLabel').textContent, 'Latest daily P&L');
    assert.match(get('coveredCallMover').innerHTML, /Pending · not included/);
    const ds = context.intradayChart.data.datasets[0];
    assert.equal(ds.data[ds.lastDataIndex], 1000);
    assert.equal(context.intradayChart.data.datasets.length, 1);
});

test('covered call zero and pending states stay visible outside top ten and hover follows each snapshot', () => {
    const {context, get, point, explore} = setup();
    const points = [
        {...point('09:30', 1000), baseline_value: 50000, daily_pnl_percent: 2,
            options_present: true, options_complete: false, option_daily_pnl: null},
        {...point('12:00', 1000), baseline_value: 50000, daily_pnl_percent: 2,
            options_present: true, options_complete: true, option_daily_pnl: 0},
        {...point('15:00', 1000), baseline_value: 50000, daily_pnl_percent: 2,
            options_present: true, options_complete: true, option_daily_pnl: -150},
    ];
    context.updateIntradayChart({date: '2026-09-23', intraday: points}, '1m');
    assert.equal(get('intradayLatestPnl').textContent, '+$850.00');
    explore('09:30');
    assert.equal(get('intradayLatestPnl').textContent, '+$1000.00');
    assert.match(get('coveredCallMover').innerHTML, /Pending · not included/);
    explore('12:00');
    assert.equal(get('coveredCallMover').hidden, false);
    assert.match(get('coveredCallMover').innerHTML, /\+\$0\.00/);
    assert.match(get('coveredCallMover').innerHTML, /est\./);
    context.anonymousMode = true;
    explore('15:00');
    assert.match(get('coveredCallMover').innerHTML, /\*\*\*/);
    assert.doesNotMatch(get('coveredCallMover').innerHTML, /150\.00/);
    get('intradayChart').onmouseleave();
    assert.equal(get('intradayPnlLabel').textContent, 'Latest daily P&L');
    context.updateIntradayChart({date: '2026-09-23', intraday: [point('12:00', 1000)]}, '1m');
    assert.equal(get('coveredCallMover').hidden, true);
});
