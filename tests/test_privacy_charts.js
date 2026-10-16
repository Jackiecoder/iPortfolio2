const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TodayPnl = require('../static/js/today-pnl.js');
const source = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');

function setup(mode = 'all') {
    const elements = new Map();
    const labels = [];
    const ctx = {canvas: {width: 1000, height: 300}, clearRect() {}, save() {}, restore() {},
        beginPath() {}, setLineDash() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
        fillText(value) { labels.push(value); }, measureText: value => ({width: value.length * 6})};
    const get = id => {
        if (!elements.has(id)) elements.set(id, {textContent: '', innerHTML: '', className: '',
            classList: {toggle() {}}, setAttribute() {}, querySelectorAll: () => [], getContext: () => ctx});
        return elements.get(id);
    };
    const context = {document: {getElementById: get}, displayMode: mode, privacySnapshots: new Map(),
        hideAmounts: () => context.displayMode === 'percentage',
        hidePercentages: () => context.displayMode === 'absolute',
        performanceChart: null, investmentChart: null, pnlChart: null, intradayChart: null, allocationChart: null,
        renderedIntraday: null, currentPerformanceData: null, currentHoldingsForAllocation: null,
        currentIntradayDate: '2026-09-23', holdingsData: [], baseHoldingsData: [],
        marketTodayStr: () => '2026-09-24', isMarketDay: () => false,
        TodayPnl, ChartDataLabels: {}, updateHoldingsTable() {}, renderCoveredCallMover() {},
        buildTradeActivityHtml: () => '', buildPositionPriceHtml: () => '',
        getCategory: () => 'Individual Stocks', escapeHtml: String,
        Chart: function (_ctx, config) {Object.assign(this, config); this.destroy = () => {};},
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function formatCurrency('), source.indexOf('function setDisplayMode(')), context);
    vm.runInContext(source.slice(source.indexOf('function updatePerformanceChart('), source.indexOf('function updateAnnualTable(')), context);
    vm.runInContext(source.slice(source.indexOf('const TOP_MOVERS_LIMIT'), source.indexOf('function slicePerformance(')), context);
    // The covered-call contribution has its own privacy tests.
    context.renderCoveredCallMover = () => {};
    const draw = chart => {
        labels.length = 0;
        chart.ctx = ctx;
        chart.scales = {x: {left: 0, right: 1000, getPixelForValue: () => 500},
            y: {top: 0, bottom: 300, getPixelForValue: () => 150}};
        for (const plugin of chart.plugins || []) {
            if (plugin.id !== 'hoverLine') plugin.afterDraw?.(chart);
        }
        return [...labels];
    };
    return {context, get, draw};
}

function intraday(context) {
    const point = {time: '12:00', daily_pnl: 600, daily_pnl_percent: 1.2,
        asset_changes: [{symbol: 'MU', pnl: 600, pnl_percent: 1.2}]};
    context.updateIntradayChart({date: '2026-09-23', intraday: [point]}, '1m');
    return context.intradayChart;
}

test('percentage mode plots real return units and masks amounts in axes, endpoint, hover and movers', () => {
    const {context, get, draw} = setup('percentage');
    const chart = intraday(context);
    const ds = chart.data.datasets[0];
    assert.equal(ds.data[ds.lastDataIndex], 1.2);
    assert.equal(ds.pnlAmountData[ds.lastDataIndex], 600);
    assert.equal(chart.options.scales.y.ticks.callback(1.2), '+1.20%');
    assert.deepEqual(draw(chart), ['+1.20%']);
    chart.options.onHover({}, [{index: ds.lastDataIndex}], chart);
    assert.equal(get('intradayLatestPnl').textContent, '***');
    assert.equal(get('intradayLatestReturn').textContent, '+1.20%');
    assert.equal(get('topMoversDailyTotal').textContent, '*** (+1.20%)');
    assert.doesNotMatch(get('topGainersBody').innerHTML, /\$|600/);
    assert.match(get('topGainersBody').innerHTML, /1\.20%/);
});

test('absolute mode keeps dollar chart units while removing percentage endpoint and mover values', () => {
    const {context, get, draw} = setup('absolute');
    const chart = intraday(context);
    const ds = chart.data.datasets[0];
    assert.equal(ds.data[ds.lastDataIndex], 600);
    assert.equal(chart.options.scales.y.ticks.callback(600), '+$600.00');
    assert.deepEqual(draw(chart), ['+$600.00']);
    assert.equal(get('intradayLatestReturn').textContent, '***');
    assert.equal(get('topMoversDailyTotal').textContent, '+$600.00');
    assert.doesNotMatch(get('topGainersBody').innerHTML, /%/);
});

test('all mode retains both endpoint units and privacy redraw uses cached snapshots', () => {
    const {context, get, draw} = setup();
    assert.deepEqual(draw(intraday(context)), ['+$600.00', '(+1.20%)']);
    context.displayMode = 'percentage';
    for (const [render, args] of context.privacySnapshots) render(...args);
    assert.equal(get('intradayLatestPnl').textContent, '***');
    assert.equal(context.intradayChart.data.datasets[0].data[720], 1.2);
});

test('missing percentage remains a chart gap instead of a dollar value on a percent axis', () => {
    const {context} = setup('percentage');
    context.updateIntradayChart({intraday: [
        {time: '12:00', daily_pnl: 600, daily_pnl_percent: null},
    ]}, '1m');
    const ds = context.intradayChart.data.datasets[0];
    assert.equal(ds.data[ds.lastDataIndex], null);
    assert.equal(ds.spanGaps, false);
});

test('P&L percentage plot, tick and endpoint share the starting investment denominator', () => {
    const {context, draw} = setup('percentage');
    context.updatePnlChart({performance: [
        {date: '2026-09-01', value: 55000, investment_value: 55000, cost_basis: 50000},
        {date: '2026-09-02', value: 56100, investment_value: 56100, cost_basis: 50000},
    ]});
    const chart = context.pnlChart;
    assert.deepEqual(Array.from(chart.data.datasets[0].data), [0, 2]);
    assert.equal(chart.options.scales.y.ticks.callback(2), '+2.00%');
    const endpoint = draw(chart).at(-1);
    assert.equal(endpoint, '+2.00%');
    const tooltip = chart.options.plugins.tooltip.callbacks.label({dataIndex: 1,
        dataset: chart.data.datasets[0], raw: 2});
    assert.doesNotMatch(tooltip.join(' '), /\$|1,100|6,100/);
    assert.match(tooltip.join(' '), /vs Start: \+2\.00%/);
});

test('allocation amounts and percentages follow the mode in tooltips and slice labels', () => {
    for (const mode of ['all', 'percentage', 'absolute']) {
        const {context} = setup(mode);
        context.updateAllocationChart([{symbol: 'MU', market_value: 6000}, {symbol: 'NVDA', market_value: 4000}]);
        const chart = context.allocationChart;
        const plugins = chart.options.plugins;
        const tooltip = plugins.tooltip.callbacks.label({raw: 6000, label: 'MU'});
        const label = plugins.datalabels.formatter(6000, {chart, dataIndex: 0});
        if (mode === 'percentage') {
            assert.equal(tooltip, 'MU: 60.0%');
            assert.equal(label, 'MU\n60.0%');
        } else if (mode === 'absolute') {
            assert.equal(tooltip, 'MU: $6,000.00');
            assert.equal(label, 'MU\n$6,000.00');
            assert.doesNotMatch(tooltip + label, /%/);
        } else {
            assert.equal(tooltip, 'MU: $6,000.00 (60.0%)');
        }
    }
});

test('a zero investment baseline does not use cash to invent a percentage return', () => {
    const {context} = setup('percentage');
    context.updatePnlChart({performance: [
        {date: '2026-09-01', value: 5000, investment_value: 0, cost_basis: 0},
        {date: '2026-09-02', value: 6000, investment_value: 1000, cost_basis: 900},
    ]});
    assert.deepEqual(Array.from(context.pnlChart.data.datasets[0].data), [null, null]);
});

test('investment privacy redraw consumes cached data and hides category amounts and totals', async () => {
    const {context} = setup();
    let fetches = 0;
    context.fetch = async () => {fetches++; return {json: async () => ({investments: [
        {month: '2026-09', by_category: {'Individual Stocks': 1000}, transactions: [{action: 'BUY', symbol: 'MU', amount: 1000}]},
    ]})};};
    await context.updateInvestmentChart(null);
    context.displayMode = 'percentage';
    for (const [render, args] of context.privacySnapshots) render(...args);
    assert.equal(fetches, 1);
    const chart = context.investmentChart;
    const plugins = chart.options.plugins;
    assert.equal(plugins.datalabels.formatter(1000, {}), '');
    assert.equal(plugins.tooltip.callbacks.label({raw: 1000, dataset: {label: 'Individual Stocks'}}), 'Individual Stocks: ***');
    assert.doesNotMatch(plugins.tooltip.callbacks.afterBody([{dataIndex: 0, datasetIndex: 0, label: '2026-09'}]).join(' '), /1000|\$/);
});
