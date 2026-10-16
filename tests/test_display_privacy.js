const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');

function setup(saved = {}) {
    const values = new Map(Object.entries(saved));
    const options = ['all', 'percentage', 'absolute'].map(mode => ({dataset: {displayMode: mode},
        attributes: {}, setAttribute(k, v) {this.attributes[k] = v;}}));
    const button = {classList: {toggle() {}}, setAttribute(k, v) {this[k] = v;}};
    const hint = {};
    const calls = [];
    const context = vm.createContext({
        portfolioStorage: {getItem: key => values.get(key), setItem: (key, value) => values.set(key, String(value))},
        document: {querySelectorAll: () => options, getElementById: id => ({anonymousBtn: button, privacyModeHint: hint}[id] || null)},
        window: {TickerTechnicalsUI: {refreshPrivacy: () => calls.push('technicals')},
            coveredCallsUI: {refreshPrivacy: () => calls.push('options')}, financeUI: {refreshPrivacy: () => calls.push('finance')}},
        tooltipElement: null, baseHoldingsData: [], currentHoldingsForAllocation: null,
        transactionsLoaded: false, soldData: null,
        loadAllData() {throw new Error('Privacy must not wait for the network');},
    });
    vm.runInContext(source.slice(source.indexOf('// Migrate the old on/off'), source.indexOf('// Transaction detail cache')), context);
    vm.runInContext(source.slice(source.indexOf('function formatCurrency('), source.indexOf('function showToast(')), context);
    return {context, values, options, button, hint, calls,
        mode: () => vm.runInContext('displayMode', context)};
}

test('legacy anonymous preference migrates to percentage only; fresh and invalid preferences are safe', () => {
    assert.equal(setup({anonymousMode: 'true'}).mode(), 'percentage');
    assert.equal(setup().mode(), 'all');
    assert.equal(setup({displayMode: 'invalid', anonymousMode: 'true'}).mode(), 'percentage');
    assert.equal(setup({displayMode: 'absolute', anonymousMode: 'true'}).mode(), 'absolute');
});

test('percentage only hides every monetary formatter, bypass flags and position sizes', () => {
    const {context: c} = setup({displayMode: 'percentage'});
    assert.equal(c.formatCurrency(123456, true), '***');
    assert.equal(c.formatCurrencyAlways(123456), '***');
    assert.equal(c.formatPrice('MU', 123.45, true), '***');
    assert.equal(c.formatQuantity(1234), '***');
    assert.equal(c.formatPercent(-0.38), '-0.38%');
    assert.equal(c.formatRatio(12.34), '12.3%');
    assert.equal(c.formatCurrency(null), '--');
});

test('amounts only hides signed returns and unsigned allocations while retaining amounts', () => {
    const {context: c} = setup({displayMode: 'absolute'});
    assert.equal(c.formatCurrency(1234), '$1,234.00');
    assert.equal(c.formatCurrencyAlways(-567), '-$567.00');
    assert.equal(c.formatQuantity(20), '20.00');
    assert.equal(c.formatPercent(-12.34), '***');
    assert.equal(c.formatRatio(12.34), '***');
    assert.equal(c.formatPercent(null), '--');
});

test('changing mode immediately repaints cached content and mounted modules without a fetch', () => {
    const {context: c, values, options, hint, calls} = setup();
    vm.runInContext(`privacySnapshots.set(() => window.paintedAmount = formatCurrencyAlways(4567), []);`, c);
    c.setDisplayMode('percentage');
    assert.equal(c.window.paintedAmount, '***');
    assert.equal(values.get('displayMode'), 'percentage');
    assert.equal(options[1].attributes['aria-checked'], 'true');
    assert.equal(options[1].tabIndex, 0);
    assert.match(hint.textContent, /quantities are hidden/);
    assert.deepEqual(calls, ['technicals', 'options', 'finance']);
    c.setDisplayMode('absolute');
    assert.equal(c.window.paintedAmount, '$4,567.00');
    assert.equal(values.get('displayMode'), 'absolute');
    assert.equal(options[2].attributes['aria-checked'], 'true');
    c.setDisplayMode('all');
    assert.equal(values.get('anonymousMode'), 'false');
    assert.equal(options[0].attributes['aria-checked'], 'true');
});

test('invalid or unchanged mode does not mutate saved preferences or repaint', () => {
    const {context: c, values, calls} = setup();
    c.setDisplayMode('bogus');
    c.setDisplayMode('all');
    assert.equal(values.size, 0);
    assert.equal(calls.length, 0);
});

test('transaction delete errors cannot expose account names or share counts in percentage only mode', async () => {
    const detail = 'Insufficient unreserved MU shares in Private account: 25 owned, 100 required by covered calls';
    for (const mode of ['percentage', 'absolute', 'all']) {
        const {context: c} = setup({displayMode: mode});
        const alerts = [], confirmations = [];
        c.allTransactions = [{id: 1, date: '2026-10-16', action: 'BUY', asset: 'MU', quantity: 25}];
        c.confirm = message => {confirmations.push(message); return true;};
        c.alert = message => alerts.push(message);
        c.fetch = async () => ({ok: false, json: async () => ({detail})});
        vm.runInContext(source.slice(source.indexOf('async function deleteTransaction('), source.indexOf('function initTransactionsTab(')), c);
        await c.deleteTransaction(1);
        assert.equal(alerts.length, 1);
        if (mode === 'percentage') {
            assert.doesNotMatch(alerts[0], /Private account|25 owned|100 required/);
            assert.match(confirmations[0], /qty \*\*\*/);
        } else {
            assert.match(alerts[0], /Private account: 25 owned, 100 required/);
        }
    }
});
