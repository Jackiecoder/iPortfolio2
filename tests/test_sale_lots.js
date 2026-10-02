const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, selectedAllocations } = require('../static/js/sale-lots.js');

class Element {
    constructor(value = '') {
        this.value = value; this.listeners = {}; this.dataset = {}; this.innerHTML = '';
        const classes = new Set();
        this.classList = { add: c => classes.add(c), remove: c => classes.delete(c),
            toggle: (c, on) => on ? classes.add(c) : classes.delete(c) };
    }
    addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); }
    fire(event, target = this) { (this.listeners[event] || []).forEach(fn => fn({ target })); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    appendChild() {}
}
const waitForDebounce = () => new Promise(resolve => setTimeout(resolve, 270));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
    const elements = Object.fromEntries(['saleLotsPanel', 'sellCostBasisMethod', 'saleLotsList',
        'saleLotsStatus', 'saleLotsSummary', 'saleLotsCustomize', 'saleLotsMethodHelp', 'saleLotsAccount']
        .map(id => [id, new Element()]));
    elements.sellCostBasisMethod.value = 'HIGH_COST';
    const form = new Element();
    form.ownerDocument = { getElementById: id => elements[id], createElement: () => new Element() };
    form.elements = Object.fromEntries(Object.entries({ quantity: '5', ave_price: '100', amount: '',
        date: '2026-09-21', transaction_time: '12:00' }).map(([name, value]) => [name, new Element(value)]));
    const modal = new Element(), assetSelect = new Element('DEMO'), brokerSelect = new Element('test');
    let active = true;
    const requests = [], originalFetch = global.fetch;
    global.fetch = (url, options) => new Promise((resolve, reject) => requests.push({
        body: JSON.parse(options.body), resolve: data => resolve({ ok: true, json: async () => data }), reject,
    }));
    const component = create({ form, modal, assetSelect, assetOther: new Element(), brokerSelect,
        brokerOther: new Element(), isActive: () => active });
    t.after(() => { active = false; component.refresh(); global.fetch = originalFetch; });
    return { form, elements, component, requests, setActive: value => { active = value; } };
}
const result = (quantity = '5') => ({ valid: true, error: null, broker: 'test', accounts: ['test'],
    lots: [{ lot_id: 7, purchase_date: '2026-01-01', quantity: 10, quantity_exact: '10',
        cost_per_share: 120, cost_basis: 1200, term: 'ST' }],
    allocations: [{ lot_id: 7, quantity }], quantity: Number(quantity), proceeds: 500,
    realized_pnl: -100, st_realized_pnl: -100, lt_realized_pnl: 0, cost_basis: 600, remaining_cost_basis: 600 });

test('exact fractional quantities survive automatic preview to save and manual conversion', async t => {
    const f = fixture(t); f.component.refresh(); await waitForDebounce();
    f.requests[0].resolve(result('0.123456789123456789')); await tick();
    assert.equal(f.component.selection().lot_allocations[0].quantity, '0.123456789123456789');
    f.elements.saleLotsCustomize.fire('click'); await waitForDebounce();
    assert.equal(f.requests[1].body.cost_basis_method, 'SPECIFIC');
    assert.deepEqual(f.requests[1].body.lot_allocations, [{ lot_id: 7, quantity: '0.123456789123456789' }]);
});

test('editing invalidates immediately and a late old request cannot enable saving', async t => {
    const f = fixture(t); f.component.refresh(); await waitForDebounce();
    f.form.elements.quantity.value = '6'; f.component.refresh();
    assert.throws(() => f.component.selection(), /valid lot preview/);
    await waitForDebounce();
    f.requests[1].resolve(result('6')); await tick();
    f.requests[0].resolve(result('5')); await tick();
    assert.equal(f.component.selection().lot_allocations[0].quantity, '6');
    f.form.elements.quantity.value = '7';
    assert.throws(() => f.component.selection(), /valid lot preview/);
});

test('network failure and leaving SELL never reuse a previously valid selection', async t => {
    const f = fixture(t); f.component.refresh(); await waitForDebounce();
    f.requests[0].resolve(result()); await tick();
    f.component.refresh(); await waitForDebounce();
    f.requests[1].reject(new Error('offline')); await tick();
    assert.throws(() => f.component.selection());
    assert.match(f.elements.saleLotsStatus.textContent, /offline/);
    f.setActive(false); f.component.refresh();
    assert.throws(() => f.component.selection());
});

test('manual payload ignores unselected lots and preserves invalid negatives for server rejection', () => {
    assert.deepEqual(selectedAllocations({ 1: '', 2: '0', 3: '0.00000001', 4: '-2' }),
        [{ lot_id: 3, quantity: '0.00000001' }, { lot_id: 4, quantity: '-2' }]);
});
