const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/ticker-technicals.js'), 'utf8');

function setup() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {textContent: '', hidden: new Set(), listeners: {},
            classList: {add(c) {element(id).hidden.add(c);}, remove(c) {element(id).hidden.delete(c);}, toggle(c, yes) {yes ? this.add(c) : this.remove(c);}},
            addEventListener(name, fn) {this.listeners[name] = fn;}});
        return elements.get(id);
    };
    const pending = [];
    const charts = [];
    let mode = 'all';
    const context = {window: {}, document: {getElementById: element}, AbortController, URLSearchParams,
        displaySymbol: s => s, formatPrice: (_s, n) => mode === 'percentage' ? '***' : '$' + n.toFixed(2),
        formatPercent: n => mode === 'absolute' ? '***' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%',
        hideAmounts: () => mode === 'percentage',
        Chart: function (_canvas, options) {const chart = {options, destroyed: false, destroy() {this.destroyed = true;}}; charts.push(chart); return chart;},
        bootstrap: {Modal: {getOrCreateInstance: () => ({show() {}})}},
        fetch: (url, options) => new Promise(resolve => pending.push({url, options, resolve})),
    };
    element('tickerTechnicalsChart').getContext = () => ({});
    vm.runInNewContext(source, context);
    return {ui: context.window.TickerTechnicalsUI, element, pending, charts, setMode(value) {mode = value;}};
}
const data = symbol => ({symbol, current_price: 110, quote_time: '2026-09-24T15:00:00Z',
    history_as_of: '2026-09-23', day_basis: 'trading sessions', series: [],
    averages: [{window: 50, value: 100, difference: 10, difference_percent: 10, position: 'above', observations: 50},
        {window: 200, value: null, observations: 150}],
});

test('comparison labels distinguish above, below, equal, short history and unavailable quote', () => {
    const {ui} = setup();
    const average = data('AAPL').averages[0];
    assert.equal(ui.comparisonText(average, 'AAPL'), 'Above by $10.00 (10.00%)');
    assert.match(ui.comparisonText({...average, position: 'below', difference: -10}, 'AAPL'), /^Below by \$10.00/);
    assert.match(ui.comparisonText({...average, position: 'at', difference: 0}, 'AAPL'), /^At the/);
    assert.equal(ui.comparisonText({...average, difference: null}, 'AAPL'), 'Latest quote unavailable');
    assert.match(ui.comparisonText(data('AAPL').averages[1], 'AAPL'), /150 of 200/);
});

test('rapid ticker switches reject late responses and abort the older request', async () => {
    const {ui, pending, element} = setup();
    const first = ui.open('AAPL');
    const second = ui.open('BTC-USD');
    assert.equal(pending[0].options.signal.aborted, true);
    assert.match(pending[1].url, /symbol=BTC-USD/);
    pending[1].resolve({ok: true, json: async () => data('BTC-USD')});
    await second;
    pending[0].resolve({ok: true, json: async () => ({...data('AAPL'), current_price: 999})});
    await first;
    assert.equal(element('tickerTechnicalsTitle').textContent, 'BTC-USD · Moving averages');
    assert.equal(element('tickerTechnicalsPrice').textContent, '$110.00');
    assert.equal(element('tickerSma200').textContent, 'Not enough history');
});

test('privacy refresh masks cached quote amounts or comparison percentages without fetching', async () => {
    const {ui, pending, element, charts, setMode} = setup();
    const opening = ui.open('AAPL');
    pending[0].resolve({ok: true, json: async () => ({...data('AAPL'), series: [{date: '2026-09-23', close: 110, sma50: 100, sma200: null}]})});
    await opening;
    assert.equal(charts.length, 1);
    setMode('percentage'); ui.refreshPrivacy();
    assert.equal(element('tickerTechnicalsPrice').textContent, '***');
    assert.equal(element('tickerSma50Comparison').textContent, 'Above by *** (10.00%)');
    assert.equal(charts[0].destroyed, true);
    assert.equal(element('tickerTechnicalsChartWrap').hidden.has('d-none'), true);
    setMode('absolute'); ui.refreshPrivacy();
    assert.equal(element('tickerTechnicalsPrice').textContent, '$110.00');
    assert.equal(element('tickerSma50Comparison').textContent, 'Above by $10.00 (***)');
    assert.equal(element('tickerTechnicalsChartWrap').hidden.has('d-none'), false);
    assert.equal(charts.length, 2);
    assert.equal(pending.length, 1);
});

test('HTTP failure hides old values and exposes retry; close cancels in-flight rendering', async () => {
    const {ui, pending, element} = setup();
    ui.init();
    const fail = ui.open('AAPL');
    pending[0].resolve({ok: false});
    await fail;
    assert.equal(element('tickerTechnicalsError').hidden.has('d-none'), false);
    assert.equal(element('tickerTechnicalsContent').hidden.has('d-none'), true);
    const closing = ui.open('BTC-USD');
    element('tickerTechnicalsModal').listeners['hide.bs.modal']();
    assert.equal(pending[1].options.signal.aborted, true);
    pending[1].resolve({ok: true, json: async () => data('BTC-USD')});
    await closing;
    assert.equal(element('tickerTechnicalsContent').hidden.has('d-none'), true);
});

test('delegated handlers allow newly rendered rows and keyboard activation in both tables', async () => {
    const {ui, pending, element} = setup();
    ui.init();
    const target = {closest: () => ({dataset: {moverSymbol: 'SOLD'}})};
    element('topGainersBody').listeners.click({target});
    let prevented = false;
    element('topLosersBody').listeners.keydown({target, key: 'Enter', preventDefault() {prevented = true;}});
    assert.equal(prevented, true);
    assert.equal(pending.length, 2);
    assert.match(pending[1].url, /symbol=SOLD/);
    for (const request of pending) request.resolve({ok: true, json: async () => data('SOLD')});
});

test('a ticker opened during the close animation waits until the modal can reopen', async () => {
    const {ui, pending, element} = setup();
    ui.init();
    const first = ui.open('AAPL');
    element('tickerTechnicalsModal').listeners['hide.bs.modal']();
    await ui.open('BTC-USD');
    assert.equal(pending.length, 1);
    element('tickerTechnicalsModal').listeners['hidden.bs.modal']();
    assert.equal(pending.length, 2);
    assert.match(pending[1].url, /symbol=BTC-USD/);
    for (const request of pending) request.resolve({ok: true, json: async () => data('BTC-USD')});
    await first;
    await new Promise(setImmediate);
    assert.equal(element('tickerTechnicalsTitle').textContent, 'BTC-USD · Moving averages');
    assert.equal(element('tickerTechnicalsContent').hidden.has('d-none'), false);
});
