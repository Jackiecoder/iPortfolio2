const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const FinanceUI = require('../static/js/finance.js');

const transfer = { id: 1, version: 1, date: '2026-10-01', direction: 'out', amount: 12345.67, currency: 'USD', counterparty: 'Sensitive Person', from_account: 'Private bank', to_account: 'Secret account', reference: 'CONFIDENTIAL-REF', note: 'Private note', voided: false };
const loan = { id: 2, version: 3, date: '2026-10-01', direction: 'lent', principal: 500, repaid: 100, outstanding: 400, currency: 'USD', counterparty: 'Sensitive Person', due_date: '2026-11-01', status: 'partial', repayments: [{ id: 8, version: 1, date: '2026-10-02', amount: 100, note: 'Private repayment', voided: false }], voided: false };
const product = { id: 3, version: 1, name: 'Private product', sku: 'SKU-secret', unit: '箱', currency: 'USD', location: 'Private location', note: 'Private product note', quantity: 8, average_cost: 20, inventory_cost: 160, voided: false };
const movement = { id: 4, version: 2, date: '2026-10-01', product_id: 3, kind: 'purchase', quantity: 10, unit_price: 20, currency: 'USD', total: 200, initial_paid_amount: 30, paid_amount: 80, remaining_payment: 120, status: 'partial', counterparty: 'Private supplier', note: 'Private shipment note', voided: false, payments: [{ id: 9, version: 1, date: '2026-10-02', amount: 50, note: 'Private payment', voided: false }] };
const data = { transfers: [transfer], loans: [loan], products: [product], movements: [movement], summary: [{ currency: 'USD', transfer_in: 0, transfer_out: 12345.67, transfer_net: -12345.67, lent_outstanding: 400, borrowed_outstanding: 0, inventory_cost: 160, payable: 120, receivable: 0, realized_profit: 0 }] };

test('finance filters retain void history only on request and keep currencies separate', () => {
    const records = [transfer, { ...transfer, id: 5, currency: 'CNY', date: '2026-10-04' }, { ...transfer, id: 6, voided: true, date: '2026-10-03' }];
    assert.deepEqual(FinanceUI.filterRecords(records).map(r => r.id), [5, 1]);
    assert.deepEqual(FinanceUI.filterRecords(records, { currency: 'USD', showVoided: true }).map(r => r.id), [6, 1]);
    assert.deepEqual(FinanceUI.filterRecords(records, { search: 'private BANK' }).map(r => r.id), [5, 1]);
    assert.equal(FinanceUI.filterRecords([movement], { search: 'private product' }, [product]).length, 1);
});

test('record HTML escapes user input and masks names, notes, accounts, values and references', () => {
    const hostile = { ...transfer, counterparty: '<img src=x onerror=alert(1)>', note: '<script>unsafe()</script>' };
    const html = FinanceUI.renderRows([hostile], 'transfers');
    assert.ok(html.includes('&lt;img'));
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script>'));
    for (const [records, section] of [[[transfer], 'transfers'], [[loan], 'loans'], [[movement], 'movements']]) {
        const hidden = FinanceUI.renderRows(records, section, [product], true);
        for (const secret of ['Sensitive Person', 'Private bank', 'Secret account', 'CONFIDENTIAL-REF', 'Private note', 'Private product', 'Private supplier', '12,345.67', '400.00', '10 箱']) assert.ok(!hidden.includes(secret), secret);
        assert.ok(hidden.includes('***'));
        assert.ok(hidden.includes(' disabled'));
    }
});

test('partial payments validate against outstanding, not original principal', () => {
    assert.equal(FinanceUI.validatePayload('repayments', { date: '2026-10-03', amount: 400 }, loan), '');
    assert.match(FinanceUI.validatePayload('repayments', { date: '2026-10-03', amount: 401 }, loan), /余额/);
    assert.match(FinanceUI.validatePayload('payments', { date: '2026-09-30', amount: 10 }, movement), /日期/);
    assert.match(FinanceUI.validatePayload('movements', { date: '2026-10-01', kind: 'purchase', product_id: 3, quantity: 10, unit_price: 20, paid_amount: 151 }, movement), /后续收付款/);
    assert.equal(FinanceUI.validatePayload('movements', { date: '2026-10-01', kind: 'purchase', product_id: 3, quantity: 10, unit_price: 20, paid_amount: 150 }, movement), '');
});

test('idempotency retains UUID for unchanged retries and replaces it for changed payloads', () => {
    let counter = 0;
    const track = FinanceUI.createRequestTracker(() => `request-${++counter}`);
    assert.equal(track({ amount: 5 }), 'request-1');
    assert.equal(track({ amount: 5 }), 'request-1');
    assert.equal(track({ amount: 6 }), 'request-2');
});

test('API failures explain ledger constraints in Chinese without exposing server entity names', () => {
    assert.match(FinanceUI.errorMessage('Void the repayments before voiding this loan', 409), /先.*还款/);
    assert.match(FinanceUI.errorMessage('A product with inventory history cannot be voided', 409), /需要保留/);
    const message = FinanceUI.errorMessage('Insufficient inventory for Private product on 2026-10-01; check earlier stock records', 422);
    assert.match(message, /库存不足/);
    assert.ok(!message.includes('Private product'));
    assert.equal(FinanceUI.money('0.000001'), 'USD 0.000001');
});

function fixture(options = {}) {
    const requests = [], modals = [], fields = new Map(), elements = new Map();
    let uuid = 0, response = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(data)) });
    function element(id) {
        if (elements.has(id)) return elements.get(id);
        const el = { id, value: '', checked: false, disabled: false, textContent: '', dataset: {}, listeners: {}, inner: '', classes: new Set(),
            classList: { toggle(name, on) { if (on) el.classes.add(name); else el.classes.delete(name); } },
            setAttribute() {}, querySelector() { return element(id + '-child'); },
            addEventListener(event, fn) { this.listeners[event] = fn; },
            get innerHTML() { return this.inner; },
            set innerHTML(html) {
                this.inner = html;
                if (id !== 'financeFormFields') return;
                fields.clear();
                for (const match of html.matchAll(/<input\b([^>]+)>/g)) {
                    const attrs = match[1], name = /name="([^"]+)"/.exec(attrs)?.[1];
                    if (name) fields.set(name, { value: /value="([^"]*)"/.exec(attrs)?.[1] || '', disabled: /\bdisabled\b/.test(attrs) });
                }
                for (const match of html.matchAll(/<select\b([^>]+)>([\s\S]*?)<\/select>/g)) {
                    const attrs = match[1], name = /name="([^"]+)"/.exec(attrs)?.[1];
                    const opts = Array.from(match[2].matchAll(/<option value="([^"]*)"([^>]*)>/g));
                    const opt = opts.find(o => o[2].includes('selected')) || opts[0];
                    fields.set(name, { value: opt?.[1] || '', disabled: /\bdisabled\b/.test(attrs) });
                }
                for (const match of html.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields.set(match[1], { value: match[2], disabled: false });
            },
        };
        elements.set(id, el); return el;
    }
    element('financeForm').elements = { namedItem: name => fields.get(name) };
    const sectionButtons = ['transfers', 'loans', 'movements'].map(s => { const el = element(`section-${s}`); el.dataset.financeSection = s; return el; });
    const context = vm.createContext({
        console, Intl, Date, Number, String, Boolean, Map, Set, JSON, Object, Array,
        document: { getElementById: element, querySelector: () => element('finance-workspace'), querySelectorAll: () => sectionButtons },
        crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
        bootstrap: { Modal: { getOrCreateInstance: el => ({ show: () => modals.push(['show', el.id]), hide: () => modals.push(['hide', el.id]) }) } },
        fetch: async (url, opts) => { requests.push({ url, ...opts }); return response(url, opts); },
        FormData: class { get(name) { const f = fields.get(name); return !f?.disabled ? f?.value : null; } },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8'), context);
    const ui = context.FinanceUI.init({ demo: options.demo, private: () => false, today: '2026-10-12', toast() {} });
    const click = (dataset, inDetails = false) => {
        const button = { dataset, disabled: false, closest() { return this; } };
        element(inDetails ? 'financeDetailsModal' : 'finance-workspace').listeners.click({ target: button });
    };
    const submit = () => element('financeForm').listeners.submit({ preventDefault() {} });
    return { ui, requests, fields, elements, element, click, submit, modals, setResponse(fn) { response = fn; } };
}

test('demo initialization never accesses finance data', async () => {
    const f = fixture({ demo: true });
    await f.ui.load(); f.ui.refreshPrivacy();
    assert.equal(f.requests.length, 0);
});

test('editing inventory payment uses initial amount and preserves subsequent payments', async () => {
    const f = fixture(); await f.ui.load();
    f.click({ financeEdit: 'movements', id: '4' }, true);
    assert.equal(f.fields.get('paid_amount').value, '30');
    assert.equal(f.fields.get('product_id').disabled, true);
    assert.equal(f.fields.get('kind').disabled, true);
    await f.submit();
    const request = f.requests.at(-1);
    assert.equal(request.method, 'PUT'); assert.equal(request.url, '/api/finance/movements/4');
    const payload = JSON.parse(request.body);
    assert.equal(payload.paid_amount, '30');
    assert.equal(payload.product_id, 3);
    assert.equal(payload.kind, 'purchase');
    assert.equal(payload.version, 2);
});

test('void repayment and payment use parent-qualified route and version guard', async () => {
    for (const [type, id, parent, route] of [['repayments', 8, 2, '/api/finance/loans/2/repayments/8?version=1'], ['payments', 9, 4, '/api/finance/movements/4/payments/9?version=1']]) {
        const f = fixture(); await f.ui.load();
        f.click({ financeVoid: type, id: String(id), parent: String(parent) }, true);
        await f.element('financeVoidConfirm').listeners.click();
        const request = f.requests.at(-1);
        assert.equal(request.method, 'DELETE'); assert.equal(request.url, route);
    }
});

test('network retries reuse UUID and pending save cannot be double submitted', async () => {
    const f = fixture(); await f.ui.load();
    f.element('financeAdd').listeners.click();
    f.fields.get('amount').value = '5';
    let release;
    f.setResponse(() => new Promise(resolve => { release = resolve; }));
    const first = f.submit(); await f.submit();
    assert.equal(f.requests.length, 2);
    assert.equal(f.element('financeSave').disabled, true);
    release({ ok: false, status: 500, json: async () => ({ detail: 'Temporary failure' }) }); await first;
    assert.equal(f.element('financeSave').disabled, false);
    const firstId = JSON.parse(f.requests.at(-1).body).request_id;
    f.setResponse(async () => ({ ok: true, json: async () => data }));
    await f.submit();
    assert.equal(JSON.parse(f.requests.at(-1).body).request_id, firstId);
    assert.equal(f.element('financeFormFields').innerHTML, '');
});

test('privacy refresh removes existing detail and editor values from DOM', async () => {
    const f = fixture(); await f.ui.load();
    f.click({ financeDetail: 'loans', id: '2' });
    assert.ok(f.element('financeDetailsBody').innerHTML.includes('Sensitive Person'));
    f.click({ financeEdit: 'transfers', id: '1' }, true);
    assert.ok(f.element('financeFormFields').innerHTML.includes('Sensitive Person'));
    f.ui.setPrivate(true);
    assert.equal(f.element('financeDetailsBody').innerHTML, '');
    assert.equal(f.element('financeFormFields').innerHTML, '');
    assert.ok(!f.element('financeList').innerHTML.includes('Sensitive Person'));
    assert.ok(!f.element('financeOverview').innerHTML.includes('12,345.67'));
    assert.equal(f.element('financeSearch').disabled, true);
    assert.equal(f.element('financeAdd').disabled, true);
});

test('finance saves decimal input exactly without Number rounding', async () => {
    const f = fixture(); await f.ui.load();
    f.element('financeAdd').listeners.click();
    f.fields.get('amount').value = '9007199254740993.000001';
    await f.submit();
    assert.equal(JSON.parse(f.requests.at(-1).body).amount, '9007199254740993.000001');
});

test('a failed pending save cannot reveal server details after privacy is enabled', async () => {
    const f = fixture(); await f.ui.load();
    f.element('financeAdd').listeners.click(); f.fields.get('amount').value = '5';
    let release;
    f.setResponse(() => new Promise(resolve => { release = resolve; }));
    const pending = f.submit();
    f.ui.setPrivate(true);
    release({ ok: false, status: 422, json: async () => ({ detail: 'Sensitive Person private account failed' }) });
    await pending;
    assert.equal(f.element('financeFormError').textContent, '');
    assert.ok(!f.element('financeNotice').textContent.includes('Sensitive Person'));
    assert.equal(f.element('financeFormFields').innerHTML, '');
});
