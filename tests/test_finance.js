const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const FinanceUI = require('../static/js/finance.js');

const transfer = { id: 1, version: 1, date: '2026-10-01', direction: 'out', amount: 12345.67, currency: 'USD', counterparty: 'Sensitive Person', from_account: 'Private bank', to_account: 'Secret account', reference: 'CONFIDENTIAL-REF', note: 'Private note', voided: false };
const loan = { id: 2, version: 3, date: '2026-10-01', direction: 'lent', principal: 500, repaid: 100, outstanding: 400, currency: 'USD', counterparty: 'Sensitive Person', due_date: '2026-11-01', status: 'partial', repayments: [{ id: 8, version: 1, date: '2026-10-02', amount: 100, note: 'Private repayment', voided: false }], voided: false };
const product = { id: 3, version: 1, name: 'Private product', sku: 'SKU-secret', unit: '箱', currency: 'USD', location: 'Private location', note: 'Private product note', quantity: 8, acquired_quantity: 10, sold_quantity: 2, purchase_cost: 200, expense_cost: 0, total_cost: 200, average_cost: 20, equivalent_cost: 20, inventory_cost: 160, sales_revenue: 60, realized_profit: 20, expense_categories: [], unallocated_cost: 0, voided: false };
const movement = { id: 4, version: 2, date: '2026-10-01', product_id: 3, kind: 'purchase', quantity: 10, unit_price: 20, currency: 'USD', total: 200, initial_paid_amount: 30, paid_amount: 80, remaining_payment: 120, status: 'partial', counterparty: 'Private supplier', note: 'Private shipment note', voided: false, payments: [{ id: 9, version: 1, date: '2026-10-02', amount: 50, note: 'Private payment', voided: false }] };
const exchange = { id: 5, version: 2, date: '2026-10-01', from_currency: 'USD', to_currency: 'CNY', from_amount: 1000, to_amount: 7200, fee_amount: 35, fee_currency: 'CNY', from_account: 'Private dollar account', to_account: 'Private yuan account', counterparty: 'Private exchange partner', method: 'Private exchange method', reference: 'Secret-exchange-reference', note: 'Private exchange note', exchange_rate: 7.2, inverse_rate: 1 / 7.2, debited_amount: 1000, received_amount: 7165, effective_rate: 7.165, voided: false };
const projectInput = { date: '2026-10-01', name: 'Private venture', currency: 'USD', expected_profit: '500', note: 'Private venture note', participants: [
    { name: 'Kevin', contribution_amount: '600', currency: 'USD', exchange_rate: '1', dividend_percent: '50', note: 'Private capital note' },
    { name: 'Private partner', contribution_amount: '2800', currency: 'CNY', exchange_rate: '0.142857142857', dividend_percent: '30', note: '' },
] };
const project = { ...projectInput, ...FinanceUI.projectPreview(projectInput), id: 6, version: 2, status: 'planned', voided: false, request_fields: projectInput, movement_ids: [], active_movement_ids: [] };
const data = { transfers: [transfer], loans: [loan], products: [product], movements: [movement], exchanges: [exchange], summary: [{ currency: 'USD', transfer_in: 0, transfer_out: 12345.67, transfer_net: -12345.67, lent_outstanding: 400, borrowed_outstanding: 0, inventory_cost: 160, payable: 120, receivable: 0, realized_profit: 0, exchange_out: 1000, exchange_in: 0, exchange_fees: 0, exchange_net: -1000 }, { currency: 'CNY', exchange_out: 0, exchange_in: 7200, exchange_fees: 35, exchange_net: 7165 }, { currency: 'HKD', transfer_in: 1, exchange_out: 0, exchange_in: 0, exchange_fees: 0, exchange_net: 0 }] };

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

test('zero-price sale is valid but cannot hide existing receipts or create a receivable', () => {
    const values = { date: '2026-10-01', kind: 'sale', product_id: 3, quantity: '2', unit_price: '0', paid_amount: '0', currency: 'USD', exchange_rate: '1', base_currency: 'USD' };
    assert.equal(FinanceUI.validatePayload('movements', values), '');
    assert.match(FinanceUI.validatePayload('movements', { ...values, quantity: '0' }), /数量/);
    assert.match(FinanceUI.validatePayload('movements', { ...values, unit_price: '-1' }), /单价/);
    assert.match(FinanceUI.validatePayload('movements', { ...values, paid_amount: '0.000001' }), /总金额/);
    assert.match(FinanceUI.validatePayload('movements', values, { ...movement, kind: 'sale' }), /后续收付款/);
    assert.match(FinanceUI.validatePayload('payments', { date: '2026-10-02', amount: '1', currency: 'USD', exchange_rate: '1' }, { ...movement, kind: 'sale', remaining_payment: 0 }), /余额/);
});

test('gift labels use zero unit price rather than a rounded invoice and do not reveal zero price in privacy mode', () => {
    const gift = { ...movement, kind: 'sale', unit_price: 0, total: 0, base_total: 0, paid_amount: 0, remaining_payment: 0, realized_profit: -40, status: 'paid' };
    const shown = FinanceUI.renderRows([gift], 'movements', [product]);
    assert.match(shown, /赠送 \/ 零价出货/); assert.match(shown, /无需收款/); assert.doesNotMatch(shown, /毛利/);
    for (const other of [{ ...gift, unit_price: 0.000001 }, { ...gift, kind: 'purchase' }, { ...gift, unit_price: undefined }]) {
        assert.doesNotMatch(FinanceUI.renderRows([other], 'movements', [product]), /赠送 \/ 零价出货/);
    }
    const hidden = FinanceUI.renderRows([gift], 'movements', [product], true);
    assert.doesNotMatch(hidden, /赠送|无需收款|-40.00|USD 0.00/);
    assert.match(FinanceUI.renderRows([{ ...gift, voided: true }], 'movements', [product]), /已作废/);
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
                if (!['financeFormFields', 'financeProjectParticipants'].includes(id)) return;
                if (id === 'financeFormFields') fields.clear();
                else for (const name of fields.keys()) if (name.startsWith('participant-')) fields.delete(name);
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
    const sectionButtons = ['transfers', 'loans', 'movements', 'exchanges', 'projects'].map(s => { const el = element(`section-${s}`); el.dataset.financeSection = s; return el; });
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
    const formClick = dataset => element('financeForm').listeners.click({ target: { dataset, disabled: false, closest() { return this; } } });
    return { ui, requests, fields, elements, element, click, submit, formClick, modals, setResponse(fn) { response = fn; } };
}

test('demo initialization never accesses finance data', async () => {
    const f = fixture({ demo: true });
    await f.ui.load(); f.ui.refreshPrivacy();
    assert.equal(f.requests.length, 0);
});

test('gift editor explains zero price, preserves explicit zero on save, and details offer no receipt action', async () => {
    const gift = { ...movement, kind: 'sale', unit_price: 0, total: 0, base_total: 0, paid_amount: 0, initial_paid_amount: 0, remaining_payment: 0, cost_of_goods: 40, realized_profit: -40, status: 'paid', payments: [] };
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [gift] }) }));
    await f.ui.load(); f.click({ financeDetail: 'movements', id: '4' });
    assert.match(f.element('financeDetailsBody').innerHTML, /赠送 \/ 零价出货/);
    assert.match(f.element('financeDetailsBody').innerHTML, /无需收款/);
    assert.doesNotMatch(f.element('financeDetailsActions').innerHTML, /data-finance-payment/);
    f.click({ financeEdit: 'movements', id: '4' }, true);
    assert.match(f.element('financeFormIntro').textContent, /单价和已收付金额都填 0/);
    assert.match(f.element('financeFormFields').innerHTML, /name="unit_price"[^>]*min="0"/);
    assert.match(f.element('financeMovementHint').textContent, /不产生待收款/);
    assert.equal(f.element('financeMovementTotal').textContent, 'USD 0.00');
    await f.submit();
    const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.unit_price, '0'); assert.equal(payload.paid_amount, '0');
    assert.equal(payload.kind, 'sale'); assert.equal(payload.version, 2);
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
    f.setResponse((_url, options) => options.method === 'GET' ? Promise.resolve({ ok: true, json: async () => data }) : new Promise(resolve => { release = resolve; }));
    const first = f.submit(); await f.submit();
    assert.equal(f.requests.length, 2);
    assert.equal(f.element('financeSave').disabled, true);
    release({ ok: false, status: 500, json: async () => ({ detail: 'Temporary failure' }) }); await first;
    assert.equal(f.element('financeSave').disabled, false);
    const firstId = JSON.parse(f.requests.findLast(request => request.method === 'POST').body).request_id;
    f.setResponse(async () => ({ ok: true, json: async () => data }));
    await f.submit();
    assert.equal(JSON.parse(f.requests.findLast(request => request.method === 'POST').body).request_id, firstId);
    assert.equal(f.element('financeFormFields').innerHTML, '');
});

test('exchange currency filter matches either leg and search finds counterparties and references', () => {
    for (const currency of ['USD', 'CNY']) assert.equal(FinanceUI.filterRecords([exchange], { currency }).length, 1);
    assert.equal(FinanceUI.filterRecords([exchange], { currency: 'HKD' }).length, 0);
    assert.equal(FinanceUI.filterRecords([exchange], { search: 'secret-exchange-reference' }).length, 1);
    assert.equal(FinanceUI.filterRecords([{ ...exchange, voided: true }]).length, 0);
    assert.equal(FinanceUI.filterRecords([{ ...exchange, voided: true }], { showVoided: true }).length, 1);
});

test('decimal rate autofill handles both directions, half-up rounding and large exact inputs', () => {
    assert.equal(FinanceUI.amountFromRate('1000', '7.2'), '7200');
    assert.equal(FinanceUI.amountFromRate('7200', '0.138888888888888889'), '1000');
    assert.equal(FinanceUI.amountFromRate('1.234567', '1.5'), '1.851851');
    assert.equal(FinanceUI.amountFromRate('9007199254740993.000001', '1'), '9007199254740993.000001');
    assert.equal(FinanceUI.amountFromRate('1e3', '7.2'), '7200');
    assert.equal(FinanceUI.amountFromRate('', '7.2'), null);
    assert.equal(FinanceUI.amountFromRate('100', '-7.2'), null);
    assert.equal(FinanceUI.formatRate(1e-18), '0.000000000000000001');
});

test('exchange fee affects the selected currency once and effective rate uses actual cash', () => {
    const targetFee = FinanceUI.exchangeAmounts(exchange);
    assert.equal(targetFee.debited_amount, 1000); assert.equal(targetFee.received_amount, 7165);
    assert.equal(targetFee.exchange_rate, 7.2); assert.equal(targetFee.effective_rate, 7.165);
    const sourceFee = FinanceUI.exchangeAmounts({ ...exchange, fee_currency: 'USD', fee_amount: 5 });
    assert.equal(sourceFee.debited_amount, 1005); assert.equal(sourceFee.received_amount, 7200);
    assert.equal(sourceFee.effective_rate, 7200 / 1005);
    const payload = { ...exchange, date: '2026-10-01' };
    assert.equal(FinanceUI.validatePayload('exchanges', payload), '');
    assert.match(FinanceUI.validatePayload('exchanges', { ...payload, to_currency: 'USD' }), /不同币种/);
    assert.match(FinanceUI.validatePayload('exchanges', { ...payload, fee_currency: 'HKD' }), /手续费币种/);
    assert.match(FinanceUI.validatePayload('exchanges', { ...payload, fee_amount: '7200' }), /必须小于/);
    assert.match(FinanceUI.validatePayload('exchanges', { ...payload, fee_amount: '-1' }), /不能为负数/);
});

test('exchange editor shows directional and reciprocal rates and autofills from source plus rate', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeSection: 'exchanges' });
    f.element('financeAdd').listeners.click();
    assert.equal(f.fields.get('from_currency').value, 'USD'); assert.equal(f.fields.get('to_currency').value, 'CNY');
    f.fields.get('from_amount').value = '1000'; f.fields.get('exchange_rate').value = '7.2';
    f.element('financeForm').listeners.input({ target: { name: 'exchange_rate' } });
    assert.equal(f.fields.get('to_amount').value, '7200');
    assert.match(f.element('financeExchangeRateLabel').textContent, /1 USD = 多少 CNY/);
    assert.match(f.element('financeExchangeRateHelp').textContent, /1 CNY =/);
    f.fields.get('from_amount').value = '2000';
    f.element('financeForm').listeners.input({ target: { name: 'from_amount' } });
    assert.equal(f.fields.get('to_amount').value, '14400');
    f.fields.get('to_amount').value = '14000';
    f.element('financeForm').listeners.input({ target: { name: 'to_amount' } });
    assert.equal(f.fields.get('exchange_rate').value, '7');
    assert.equal(f.element('financeExchangeReceipt').textContent, 'CNY 14,000.00');
    await f.submit();
    const request = f.requests.at(-1), payload = JSON.parse(request.body);
    assert.equal(request.url, '/api/finance/exchanges');
    assert.equal(payload.from_amount, '2000'); assert.equal(payload.to_amount, '14000');
    assert.equal(payload.fee_amount, '0'); assert.equal(payload.fee_currency, 'USD');
    assert.equal(payload.exchange_rate, undefined);
});

test('exchange edit preserves gross input and original fee and restricts fee currency options', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeEdit: 'exchanges', id: '5' }, true);
    assert.equal(f.fields.get('to_amount').value, '7200');
    assert.equal(f.fields.get('fee_amount').value, '35'); assert.equal(f.fields.get('fee_currency').value, 'CNY');
    assert.ok(!f.fields.get('fee_currency').innerHTML.includes('HKD'));
    assert.equal(f.element('financeExchangeReceipt').textContent, 'CNY 7,165.00');
    await f.submit();
    const request = f.requests.at(-1), payload = JSON.parse(request.body);
    assert.equal(request.method, 'PUT'); assert.equal(request.url, '/api/finance/exchanges/5');
    assert.equal(payload.version, 2); assert.equal(payload.to_amount, '7200'); assert.equal(payload.fee_amount, '35');
});

test('invalidated entered exchange rate cannot save a previously autofilled target', async () => {
    for (const invalidRate of ['0', '', '-1']) {
        const f = fixture(); await f.ui.load(); f.click({ financeSection: 'exchanges' }); f.element('financeAdd').listeners.click();
        f.fields.get('from_amount').value = '1000'; f.fields.get('exchange_rate').value = '7.2';
        f.element('financeForm').listeners.input({ target: { name: 'exchange_rate' } });
        assert.equal(f.fields.get('to_amount').value, '7200');
        f.fields.get('exchange_rate').value = invalidRate;
        f.element('financeForm').listeners.input({ target: { name: 'exchange_rate' } }); await f.submit();
        assert.equal(f.requests.length, 1); assert.match(f.element('financeFormError').textContent, /汇率必须大于 0/);
        f.fields.get('to_amount').value = '7100'; f.element('financeForm').listeners.input({ target: { name: 'to_amount' } }); await f.submit();
        assert.equal(f.requests.length, 2); assert.equal(JSON.parse(f.requests.at(-1).body).to_amount, '7100');
    }
});

test('exchange summary shows only exchange currencies and soft void retains version guard', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeSection: 'exchanges' });
    const summary = f.element('financeOverview').innerHTML;
    assert.ok(summary.includes('USD')); assert.ok(summary.includes('CNY')); assert.ok(!summary.includes('HKD'));
    assert.ok(summary.includes('换出本金（不含费）'));
    assert.ok(summary.includes('换汇净流动（含费）')); assert.ok(!summary.includes('记录的转出'));
    f.click({ financeVoid: 'exchanges', id: '5' }, true);
    assert.match(f.element('financeVoidMessage').textContent, /成交汇率.*历史/);
    await f.element('financeVoidConfirm').listeners.click();
    assert.equal(f.requests.at(-1).url, '/api/finance/exchanges/5?version=2');
    assert.equal(f.requests.at(-1).method, 'DELETE');
});

test('exchange details escape input and private refresh clears amounts, fees, rates and accounts', async () => {
    const hostile = { ...exchange, counterparty: '<script>unsafe()</script>', note: '<img src=x onerror=alert(1)>' };
    const html = FinanceUI.renderRows([hostile], 'exchanges'); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
    const privateHtml = FinanceUI.renderRows([exchange], 'exchanges', [], true);
    for (const value of ['Private dollar account', 'Private yuan account', 'Private exchange partner', 'Secret-exchange-reference', 'Private exchange note', '7,165', '1,000']) assert.ok(!privateHtml.includes(value));
    const f = fixture(); await f.ui.load(); f.click({ financeSection: 'exchanges' }); f.click({ financeDetail: 'exchanges', id: '5' });
    assert.ok(f.element('financeDetailsBody').innerHTML.includes('实际到账')); assert.ok(f.element('financeDetailsBody').innerHTML.includes('7.165'));
    f.click({ financeEdit: 'exchanges', id: '5' }, true); f.ui.setPrivate(true);
    assert.equal(f.element('financeDetailsBody').innerHTML, ''); assert.equal(f.element('financeFormFields').innerHTML, '');
    assert.ok(!f.element('financeOverview').innerHTML.includes('7,200')); assert.ok(!f.element('financeList').innerHTML.includes('Private'));
});

test('exchange create retry retains UUID and unchanged raw decimal amounts', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeSection: 'exchanges' }); f.element('financeAdd').listeners.click();
    f.fields.get('from_amount').value = '9007199254740993.000001'; f.fields.get('to_amount').value = '100.123456';
    f.setResponse(async () => { throw new Error('Connection interrupted'); }); await f.submit();
    const first = JSON.parse(f.requests.findLast(request => request.method === 'POST').body);
    f.setResponse(async () => ({ ok: true, json: async () => data })); await f.submit();
    const retry = JSON.parse(f.requests.findLast(request => request.method === 'POST').body);
    assert.equal(first.request_id, retry.request_id); assert.equal(retry.from_amount, '9007199254740993.000001'); assert.equal(retry.to_amount, '100.123456');
});

test('a pending refresh cannot overwrite the state of an acknowledged finance write', async () => {
    const f = fixture(); await f.ui.load();
    let release;
    const updated = { ...data, transfers: [{ ...transfer, amount: 999, version: 2 }] };
    f.setResponse((_url, options) => options.method === 'GET' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true, json: async () => updated }));
    const refreshing = f.ui.load(true);
    f.element('financeAdd').listeners.click(); f.fields.get('amount').value = '999'; await f.submit();
    assert.ok(f.element('financeList').innerHTML.includes('999.00'));
    release({ ok: true, json: async () => data }); await refreshing;
    assert.ok(f.element('financeList').innerHTML.includes('999.00'));
    assert.ok(!f.element('financeList').innerHTML.includes('12,345.67'));
});

test('voiding during a pending refresh retains void state and clears the loading notice', async () => {
    const f = fixture(); await f.ui.load();
    let release;
    const updated = { ...data, transfers: [{ ...transfer, voided: true, version: 2 }] };
    f.setResponse((_url, options) => options.method === 'GET' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true, json: async () => updated }));
    const refreshing = f.ui.load(true);
    assert.equal(f.element('financeNotice').textContent, '正在读取财务记录…');
    f.click({ financeVoid: 'transfers', id: '1' }, true);
    await f.element('financeVoidConfirm').listeners.click();
    assert.equal(f.element('financeNotice').textContent, '');
    assert.ok(f.element('financeNotice').classes.has('d-none'));
    assert.ok(!f.element('financeList').innerHTML.includes('12,345.67'));
    release({ ok: true, json: async () => data }); await refreshing;
    assert.ok(!f.element('financeList').innerHTML.includes('12,345.67'));
    assert.equal(f.element('financeNotice').textContent, '');
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

test('legacy currency edits cannot silently replace the original currency with USD', async () => {
    for (const [collection, record] of [
        ['transfers', { ...transfer, currency: 'HKD' }],
        ['loans', { ...loan, currency: 'HKD' }],
        ['products', { ...product, currency: 'EUR' }],
        ['movements', { ...movement, currency: 'GBP' }],
        ['exchanges', { ...exchange, from_currency: 'HKD' }],
        ['exchanges', { ...exchange, to_currency: 'HKD' }],
        ['exchanges', { ...exchange, fee_currency: 'HKD' }],
    ]) {
        const f = fixture();
        f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, [collection]: [record] }) }));
        await f.ui.load(); f.click({ financeEdit: collection, id: String(record.id) }, true);
        assert.match(f.element('financeNotice').textContent, /原币种与金额保留/);
        assert.equal(f.element('financeFormFields').innerHTML, '');
        assert.ok(!f.modals.some(([action, id]) => action === 'show' && id === 'financeEditModal'));
        await f.submit(); assert.equal(f.requests.length, 1);
    }
});

test('legacy currency details and voiding remain available without changing stored currency', async () => {
    const f = fixture();
    const legacy = { ...transfer, currency: 'HKD' };
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, transfers: [legacy] }) }));
    await f.ui.load(); f.click({ financeDetail: 'transfers', id: '1' });
    assert.ok(f.element('financeDetailsBody').innerHTML.includes('HKD 12,345.67'));
    f.click({ financeVoid: 'transfers', id: '1' }, true); await f.element('financeVoidConfirm').listeners.click();
    assert.equal(f.requests.at(-1).url, '/api/finance/transfers/1?version=1');
    assert.equal(f.requests.at(-1).method, 'DELETE');
});

test('repayment on a legacy loan preserves its original currency', async () => {
    const f = fixture();
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, loans: [{ ...loan, currency: 'HKD' }] }) }));
    await f.ui.load(); f.click({ financePayment: 'loans', id: '2' }, true);
    assert.match(f.element('financeFormIntro').textContent, /HKD 400.00/);
    await f.submit();
    assert.equal(f.requests.at(-1).url, '/api/finance/loans/2/repayments');
    assert.equal(JSON.parse(f.requests.at(-1).body).currency, undefined);
});

test('inventory decimal conversion matches HALF-EVEN rounding and 12-digit rate precision', () => {
    assert.equal(FinanceUI.inventoryAmount('1', '0.0000005'), '0');
    assert.equal(FinanceUI.inventoryAmount('1', '0.0000015'), '0.000002');
    assert.equal(FinanceUI.inventoryAmount('1.234565', '0.1'), '0.123456');
    assert.equal(FinanceUI.inventoryAmount('700', '0.142857142857'), '100');
    assert.equal(FinanceUI.inventoryAmount('0', '1'), '0');
    assert.equal(FinanceUI.decimalSum(['0.1', '0.2', '0.000001']), '0.300001');
    assert.equal(FinanceUI.decimalGreater('1000000000000.000001', '1000000000000'), true);
    assert.equal(FinanceUI.inventoryAmount('999999999999.000001', '1'), '999999999999.000001');
});

test('movement form keeps native amount and optional conversion separate', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeSection: 'movements' }); f.click({ financeProductTransaction: '', id: '3' }, true);
    assert.equal(f.fields.get('currency').value, 'USD'); assert.equal(f.fields.get('exchange_rate').value, '1');
    assert.equal(f.fields.get('exchange_rate').disabled, true);
    f.fields.get('quantity').value = '10'; f.fields.get('unit_price').value = '70'; f.fields.get('currency').value = 'CNY';
    f.element('financeForm').listeners.change({ target: { name: 'currency' } });
    assert.equal(f.fields.get('exchange_rate').value, ''); assert.equal(f.fields.get('exchange_rate').disabled, false);
    assert.equal(f.element('financeMovementTotal').textContent, 'CNY 700.00');
    assert.equal(f.element('financeMovementBaseTotal').textContent, '未折算（不影响保存）');
    assert.match(f.element('financeMovementRateLabel').textContent, /1 CNY = 多少 USD/);
    assert.equal(FinanceUI.validatePayload('movements', { date: '2026-10-01', product_id: 3, kind: 'purchase', quantity: '10', unit_price: '70', paid_amount: '0', currency: 'CNY', exchange_rate: null }, product), '');
    assert.doesNotMatch(f.element('financeFormFields').innerHTML.match(/<input[^>]*name="exchange_rate"[^>]*>/)[0], /required/);
    f.fields.get('exchange_rate').value = '0.142857142857';
    f.element('financeForm').listeners.input({ target: { name: 'exchange_rate' } });
    assert.equal(f.element('financeMovementBaseTotal').textContent, 'USD 100.00');
    await f.submit();
    const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.currency, 'CNY'); assert.equal(payload.exchange_rate, '0.142857142857');
    assert.equal(payload.paid_amount, '0'); assert.equal(payload.base_total, undefined);
});

test('a product transaction stays bound to its profile even if a disabled product input is tampered with', async () => {
    const f = fixture();
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, products: [product, { ...product, id: 6, currency: 'CNY' }] }) }));
    await f.ui.load(); f.click({ financeProductTransaction: '', id: '3' }, true);
    assert.equal(f.fields.get('product_id').disabled, true);
    f.fields.get('quantity').value = '10'; f.fields.get('unit_price').value = '70'; f.fields.get('currency').value = 'CNY';
    f.element('financeForm').listeners.change({ target: { name: 'currency' } }); f.fields.get('exchange_rate').value = '0.14';
    f.fields.get('product_id').value = '6'; f.element('financeForm').listeners.change({ target: { name: 'product_id' } });
    assert.equal(f.fields.get('exchange_rate').disabled, false); assert.equal(f.fields.get('exchange_rate').value, '0.14');
    await f.submit();
    const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.product_id, 3); assert.equal(payload.exchange_rate, '0.14');
});

test('movement edit locks invoice currency after payment history and never counts actual-currency payments twice', async () => {
    const record = { ...movement, currency: 'CNY', base_currency: 'USD', exchange_rate: 0.142857142857, total: 700, base_total: 100, unit_price: 70, initial_paid_amount: 30, paid_amount: 380, remaining_payment: 320, payments: [{ ...movement.payments[0], amount: 50, currency: 'USD', exchange_rate: 7, invoice_currency: 'CNY', invoice_amount: 350 }] };
    const f = fixture();
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [record] }) }));
    await f.ui.load(); f.click({ financeEdit: 'movements', id: '4' }, true);
    assert.equal(f.fields.get('currency').value, 'CNY'); assert.equal(f.fields.get('currency').disabled, true);
    assert.equal(f.fields.get('paid_amount').value, '30');
    assert.match(f.element('financeFormIntro').textContent, /货款币种不可修改/);
    assert.equal(f.fields.get('exchange_rate').disabled, false);
    f.fields.get('paid_amount').value = '351'; await f.submit(); assert.equal(f.requests.length, 1);
    assert.match(f.element('financeFormError').textContent, /后续收付款/);
    f.fields.get('paid_amount').value = '350'; await f.submit();
    const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.currency, 'CNY'); assert.equal(payload.paid_amount, '350'); assert.equal(payload.exchange_rate, '0.142857142857');
    const voided = fixture();
    voided.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [{ ...record, payments: record.payments.map(p => ({ ...p, voided: true })) }] }) }));
    await voided.ui.load(); voided.click({ financeEdit: 'movements', id: '4' }, true);
    assert.equal(voided.fields.get('currency').disabled, true);
});

test('actual payment currency converts into invoice currency and validates the converted balance exactly', async () => {
    const record = { ...movement, currency: 'CNY', base_currency: 'USD', exchange_rate: 0.125, total: 400, base_total: 50, remaining_payment: 400, paid_amount: 0, initial_paid_amount: 0, payments: [] };
    const f = fixture();
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [record] }) }));
    await f.ui.load(); f.click({ financePayment: 'movements', id: '4' }, true);
    assert.equal(f.fields.get('currency').value, 'CNY'); assert.equal(f.fields.get('exchange_rate').value, '1');
    f.fields.get('currency').value = 'USD'; f.element('financeForm').listeners.change({ target: { name: 'currency' } });
    assert.equal(f.fields.get('exchange_rate').value, '');
    f.fields.get('amount').value = '50'; f.fields.get('exchange_rate').value = '7';
    f.element('financeForm').listeners.input({ target: { name: 'exchange_rate' } });
    assert.equal(f.element('financePaymentInvoiceAmount').textContent, 'CNY 350.00');
    assert.match(f.element('financePaymentRateLabel').textContent, /1 USD = 多少 CNY/);
    f.fields.get('amount').value = '60'; await f.submit(); assert.equal(f.requests.length, 1);
    assert.match(f.element('financeFormError').textContent, /折算后的货款/);
    f.fields.get('amount').value = '50'; await f.submit();
    const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.amount, '50'); assert.equal(payload.currency, 'USD'); assert.equal(payload.exchange_rate, '7');
    assert.equal(payload.invoice_amount, undefined);
});

test('inventory rates reject precision overflow but accept exact trailing zeros; conversion uses HALF-EVEN balance', () => {
    const record = { ...movement, currency: 'CNY', remaining_payment: 0.000002 };
    assert.equal(FinanceUI.validatePayload('payments', { date: '2026-10-03', currency: 'USD', amount: '0.000001', exchange_rate: '1.5' }, record), '');
    assert.match(FinanceUI.validatePayload('payments', { date: '2026-10-03', currency: 'USD', amount: '0.000001', exchange_rate: '0.5' }, record), /必须大于 0/);
    assert.match(FinanceUI.validatePayload('payments', { date: '2026-10-03', currency: 'USD', amount: '1', exchange_rate: '0.1234567890123' }, record), /12 位小数/);
    assert.equal(FinanceUI.validatePayload('payments', { date: '2026-10-03', currency: 'CNY', amount: '0.000001', exchange_rate: '1.0000000000000' }, record), '');
    assert.match(FinanceUI.validatePayload('payments', { date: '2026-10-03', currency: 'CNY', amount: '0.000001', exchange_rate: '2' }, record), /同币种/);
    assert.match(FinanceUI.errorMessage('Use at most 12 decimal places for the exchange rate', 422), /12 位小数/);
});

test('inventory display separates base profit, native invoice, and original/converted payment history', async () => {
    const record = { ...movement, kind: 'sale', quantity: 4, unit_price: 100, currency: 'CNY', base_currency: 'USD', exchange_rate: 0.125, total: 400, base_total: 50, cost_of_goods: 40, realized_profit: 10, initial_paid_amount: 0, paid_amount: 350, remaining_payment: 50, payments: [{ ...movement.payments[0], amount: 50, currency: 'USD', exchange_rate: 7, invoice_currency: 'CNY', invoice_amount: 350 }] };
    assert.equal(FinanceUI.filterRecords([record], { currency: 'USD' }).length, 1);
    assert.equal(FinanceUI.filterRecords([record], { currency: 'CNY' }).length, 1);
    const row = FinanceUI.renderRows([record], 'movements', [product]);
    assert.ok(row.includes('CNY 400.00')); assert.ok(!row.includes('库存核算')); assert.ok(!row.includes('毛利'));
    const f = fixture();
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [record] }) }));
    await f.ui.load(); f.click({ financeDetail: 'movements', id: '4' });
    const detail = f.element('financeDetailsBody').innerHTML;
    assert.ok(detail.includes('USD 40.00')); assert.ok(detail.includes('USD 10.00'));
    assert.ok(detail.includes('折抵 CNY 350.00')); assert.ok(detail.includes('USD 50.00'));
    assert.ok(detail.includes('1 USD = 7 CNY')); assert.ok(detail.includes('不包含后续收付款产生的汇兑损益'));
    const hidden = FinanceUI.renderRows([record], 'movements', [product], true);
    for (const secret of ['CNY 400.00', 'USD 50.00', 'USD 10.00', 'Private product']) assert.ok(!hidden.includes(secret));
    f.click({ financeEdit: 'movements', id: '4' }, true); f.ui.setPrivate(true);
    assert.equal(f.element('financeFormFields').innerHTML, ''); assert.equal(f.element('financeDetailsBody').innerHTML, '');
});

test('legacy product bases cannot silently default a new USD movement to an invented rate', async () => {
    const legacy = { ...product, currency: 'HKD', name: 'Historical HKD product' };
    const f = fixture();
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, products: [legacy, { ...product, id: 6 }] }) }));
    await f.ui.load(); f.click({ financeSection: 'movements' }); f.click({ financeProductTransaction: '', id: '6' }, true);
    assert.equal(f.fields.get('product_id').value, '6'); assert.equal(f.fields.get('currency').value, 'USD');
    assert.ok(!f.element('financeFormFields').innerHTML.includes('Historical HKD product'));
    const onlyLegacy = fixture();
    onlyLegacy.setResponse(async () => ({ ok: true, json: async () => ({ ...data, products: [legacy], movements: [{ ...movement, currency: 'USD' }] }) }));
    await onlyLegacy.ui.load(); onlyLegacy.click({ financeSection: 'movements' }); onlyLegacy.element('financeAdd').listeners.click();
    assert.equal(onlyLegacy.element('financeEditTitle').textContent, '创建商品');
    assert.equal(onlyLegacy.fields.has('product_id'), false);
    onlyLegacy.click({ financeEdit: 'movements', id: '4' }, true);
    assert.match(onlyLegacy.element('financeNotice').textContent, /原币种与金额保留/);
    assert.equal(onlyLegacy.element('financeFormFields').innerHTML, '');
    onlyLegacy.click({ financeDetail: 'products', id: '3' });
    assert.ok(onlyLegacy.element('financeDetailsBody').innerHTML.includes('Historical HKD product'));
    assert.ok(onlyLegacy.element('financeDetailsBody').innerHTML.includes('不新增进出货'));
});

test('project preview separates converted funding, contribution ratio, planned dividend and forecast remainder', () => {
    const preview = FinanceUI.projectPreview(projectInput);
    assert.equal(preview.total_contribution, '1000');
    assert.deepEqual(preview.participants.map(p => p.base_amount), ['600', '400']);
    assert.deepEqual(preview.participants.map(p => p.contribution_percent), ['60', '40']);
    assert.deepEqual(preview.participants.map(p => p.expected_dividend), ['250', '150']);
    assert.equal(preview.unallocated_percent, '20'); assert.equal(preview.unallocated_profit, '100');
    assert.equal(preview.allocation_complete, false);
    const missing = FinanceUI.projectPreview({ ...projectInput, expected_profit: null });
    assert.equal(missing.unallocated_profit, null); assert.ok(missing.participants.every(p => p.expected_dividend === null));
    const zero = FinanceUI.projectPreview({ ...projectInput, expected_profit: '0' });
    assert.equal(zero.unallocated_profit, '0'); assert.ok(zero.participants.every(p => p.expected_dividend === '0'));
});

test('project largest-remainder allocation reconciles six-place shares and payouts with stable ties', () => {
    assert.deepEqual(FinanceUI.allocateDecimal('100', ['1', '1', '1']), ['33.333334', '33.333333', '33.333333']);
    assert.equal(FinanceUI.decimalSum(FinanceUI.allocateDecimal('100', ['1', '1', '1'])), '100');
    assert.deepEqual(FinanceUI.allocateDecimal('0.000001', ['25', '25', '25', '25']), ['0.000001', '0', '0', '0']);
    assert.deepEqual(FinanceUI.allocateDecimal('999999999999.000001', ['50', '50']), ['499999999999.500001', '499999999999.5']);
    const zeroFunding = FinanceUI.projectPreview({ ...projectInput, participants: projectInput.participants.map(p => ({ ...p, contribution_amount: '0' })) });
    assert.deepEqual(zeroFunding.participants.map(p => p.contribution_percent), ['0', '0']);
    const midpoint = FinanceUI.projectPreview({ currency: 'USD', expected_profit: null, participants: [{ currency: 'CNY', contribution_amount: '1', exchange_rate: '0.0000015', dividend_percent: '0' }] });
    assert.equal(midpoint.total_contribution, '0.000002');
});

test('project validation allows partial plans and unknown profits while rejecting invalid sums and names', () => {
    assert.equal(FinanceUI.validatePayload('projects', projectInput), '');
    assert.equal(FinanceUI.validatePayload('projects', { ...projectInput, expected_profit: null }), '');
    assert.equal(FinanceUI.validatePayload('projects', { ...projectInput, expected_profit: '0' }), '');
    const changed = patch => ({ ...projectInput, participants: projectInput.participants.map((p, i) => i ? { ...p, ...patch } : p) });
    assert.match(FinanceUI.validatePayload('projects', changed({ dividend_percent: '50.000001' })), /合计不能超过/);
    assert.match(FinanceUI.validatePayload('projects', changed({ name: 'KEVIN' })), /姓名不能重复/);
    assert.match(FinanceUI.validatePayload('projects', changed({ exchange_rate: '' })), /折算汇率/);
    assert.match(FinanceUI.validatePayload('projects', changed({ contribution_amount: '-1' })), /出资金额/);
    assert.match(FinanceUI.validatePayload('projects', changed({ contribution_amount: '0.000001', exchange_rate: '0.0000005' })), /折算后的出资金额/);
    assert.match(FinanceUI.validatePayload('projects', { ...projectInput, participants: [] }), /1 至 50/);
    assert.match(FinanceUI.validatePayload('projects', { ...projectInput, expected_profit: '-1' }), /预计可分配利润/);
});

test('project editor shows native-to-base rate, independent previews, optional forecast and raw retry payload', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeSection: 'projects' }); f.element('financeAdd').listeners.click();
    assert.equal(f.fields.get('expected_profit').value, '');
    assert.equal(f.element('financeProjectProfit').textContent, '未填写');
    assert.equal(f.fields.get('participant-0-exchange_rate').disabled, true);
    f.fields.get('name').value = 'New venture';
    for (const [index, participant] of projectInput.participants.entries()) for (const [key, value] of Object.entries(participant)) f.fields.get(`participant-${index}-${key}`).value = value;
    f.fields.get('expected_profit').value = '500';
    f.element('financeForm').listeners.input({ target: { name: 'participant-1-exchange_rate' } });
    assert.match(f.element('financeParticipantRateLabel-1').textContent, /1 CNY = 多少 USD/);
    assert.equal(f.element('financeProjectTotal').textContent, 'USD 1,000.00');
    assert.equal(f.element('financeProjectDividendTotal').textContent, '80%');
    assert.equal(f.element('financeProjectUnallocated').textContent, '20%');
    assert.equal(f.element('financeProjectUnallocatedProfit').textContent, 'USD 100.00');
    assert.ok(f.element('financeParticipantPreview-0').innerHTML.includes('60%'));
    assert.ok(f.element('financeParticipantPreview-1').innerHTML.includes('USD 150.00'));
    f.setResponse(async () => { throw new Error('Interrupted'); }); await f.submit();
    const firstRequest = f.requests.findLast(request => request.method === 'POST');
    const first = JSON.parse(firstRequest.body);
    assert.equal(firstRequest.url, '/api/finance/projects');
    assert.equal(first.expected_profit, '500'); assert.equal(first.participants[1].exchange_rate, '0.142857142857');
    assert.equal(first.participants[0].contribution_amount, '600'); assert.equal(first.participants[0].dividend_percent, '50');
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [project] }) })); await f.submit();
    assert.equal(JSON.parse(f.requests.findLast(request => request.method === 'POST').body).request_id, first.request_id);
});

test('project participant add/remove preserves inputs and proportional fill sums to exactly 100', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeSection: 'projects' }); f.element('financeAdd').listeners.click();
    f.fields.get('participant-0-name').value = 'First'; f.fields.get('participant-0-contribution_amount').value = '1';
    f.fields.get('participant-1-name').value = 'Second'; f.fields.get('participant-1-contribution_amount').value = '1';
    f.formClick({ projectAdd: '' });
    assert.equal(f.fields.get('participant-0-name').value, 'First');
    assert.equal(f.fields.get('participant-2-contribution_amount').value, '0');
    f.fields.get('participant-2-name').value = 'Third'; f.fields.get('participant-2-contribution_amount').value = '1';
    f.formClick({ projectProportional: '' });
    assert.deepEqual([0, 1, 2].map(i => f.fields.get(`participant-${i}-dividend_percent`).value), ['33.333334', '33.333333', '33.333333']);
    assert.equal(f.element('financeProjectDividendTotal').textContent, '100%');
    f.formClick({ projectRemove: '1' });
    assert.equal(f.fields.get('participant-1-name').value, 'Third'); assert.equal(f.fields.has('participant-2-name'), false);
    f.fields.get('participant-1-currency').value = 'CNY';
    f.element('financeForm').listeners.change({ target: { name: 'participant-1-currency' } });
    assert.equal(f.fields.get('participant-1-exchange_rate').value, ''); assert.equal(f.fields.get('participant-1-exchange_rate').disabled, false);
    f.fields.get('currency').value = 'CNY'; f.element('financeForm').listeners.change({ target: { name: 'currency' } });
    assert.equal(f.fields.get('participant-1-exchange_rate').value, '1'); assert.equal(f.fields.get('participant-1-exchange_rate').disabled, true);
    assert.equal(f.fields.get('participant-0-exchange_rate').value, '');
});

test('project edits preserve exact canonical request fields and immutable currency instead of rounded GET numbers', async () => {
    const exact = { ...projectInput, expected_profit: '999999999999.000001', participants: projectInput.participants.map((p, i) => ({ ...p, contribution_amount: i ? p.contribution_amount : '999999999999.000001', dividend_percent: i ? '49.999999' : '50.000001' })) };
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [{ ...project, expected_profit: 999999999999, request_fields: exact, participants: project.participants.map(p => ({ ...p, contribution_amount: 999999999999 })) }] }) }));
    await f.ui.load(); f.click({ financeEdit: 'projects', id: '6' }, true);
    assert.equal(f.fields.get('currency').disabled, true);
    assert.equal(f.fields.get('expected_profit').value, '999999999999.000001');
    assert.equal(f.fields.get('participant-0-contribution_amount').value, '999999999999.000001');
    assert.equal(f.fields.get('participant-0-dividend_percent').value, '50.000001');
    await f.submit(); const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(f.requests.at(-1).method, 'PUT'); assert.equal(f.requests.at(-1).url, '/api/finance/projects/6');
    assert.equal(payload.currency, 'USD'); assert.equal(payload.version, 2); assert.equal(payload.expected_profit, '999999999999.000001');
    assert.equal(payload.participants[0].contribution_amount, '999999999999.000001'); assert.equal(payload.participants[1].dividend_percent, '49.999999');
});

test('project-only overview remains visible without realized summary and distinguishes missing forecasts from zero', async () => {
    const f = fixture(); const unknown = { ...project, expected_profit: null, request_fields: { ...projectInput, expected_profit: null } };
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [unknown], summary: [] }) }));
    await f.ui.load(); f.click({ financeSection: 'projects' });
    assert.ok(f.element('financeOverview').innerHTML.includes('USD 1,000.00'));
    assert.ok(f.element('financeOverview').innerHTML.includes('未填写'));
    assert.ok(!f.element('financeOverview').innerHTML.includes('USD 0.00'));
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [unknown, { ...project, id: 7, expected_profit: '0', request_fields: { ...projectInput, expected_profit: '0' } }], summary: [] }) }));
    await f.ui.load(true);
    assert.ok(f.element('financeOverview').innerHTML.includes('已填预计利润'));
    assert.ok(f.element('financeOverview').innerHTML.includes('USD 0.00'));
    assert.ok(f.element('financeOverview').innerHTML.includes('1 个项目未填写'));
    assert.ok(!f.element('financeOverview').innerHTML.includes('出货毛利'));
});

test('movement project linking supports create omission, explicit unlink and historical linked option', async () => {
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [project] }) }));
    await f.ui.load(); f.click({ financeSection: 'movements' }); f.click({ financeProductTransaction: '', id: '3' }, true);
    f.fields.get('quantity').value = '1'; f.fields.get('unit_price').value = '10'; await f.submit();
    assert.equal(JSON.parse(f.requests.at(-1).body).project_id, undefined);
    f.click({ financeProductTransaction: '', id: '3' }, true); f.fields.get('quantity').value = '1'; f.fields.get('unit_price').value = '10'; f.fields.get('project_id').value = '6'; await f.submit();
    assert.equal(JSON.parse(f.requests.at(-1).body).project_id, 6);
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [{ ...project, voided: true }], movements: [{ ...movement, project_id: 6, project_name: project.name }] }) }));
    await f.ui.load(true); f.click({ financeEdit: 'movements', id: '4' }, true);
    assert.equal(f.fields.get('project_id').value, '6');
    assert.ok(f.element('financeFormFields').innerHTML.includes('已作废，历史关联'));
    f.fields.get('project_id').value = ''; await f.submit();
    assert.equal(JSON.parse(f.requests.at(-1).body).project_id, null);
    assert.equal(JSON.parse(f.requests.at(-1).body).paid_amount, '30');
});

test('project details retain participant forecasts, linked movement history and versioned void constraints', async () => {
    const linked = { ...movement, project_id: 6, project_name: project.name };
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [{ ...project, movement_ids: [4] }], movements: [linked] }) }));
    await f.ui.load(); f.click({ financeDetail: 'projects', id: '6' });
    const details = f.element('financeDetailsBody').innerHTML;
    for (const text of ['出资比例（自动计算）', '计划分红比例（约定）', '预计分红（不含本金）', 'USD 250.00', 'USD 100.00', 'CNY 2,800.00', 'data-finance-detail="movements"']) assert.ok(details.includes(text), text);
    f.click({ financeDetail: 'movements', id: '4' }, true);
    assert.ok(f.element('financeDetailsBody').innerHTML.includes('data-finance-detail="projects"'));
    assert.equal(FinanceUI.filterRecords([linked], { search: 'private venture' }, [product], [project]).length, 1);
    f.click({ financeVoid: 'projects', id: '6' }, true);
    assert.match(f.element('financeVoidMessage').textContent, /先解除关联或作废/);
    f.setResponse(async () => ({ ok: false, status: 409, json: async () => ({ detail: 'Unlink or void the active movements before voiding this project' }) }));
    await f.element('financeVoidConfirm').listeners.click();
    assert.equal(f.requests.at(-1).url, '/api/finance/projects/6?version=2');
    assert.match(f.element('financeVoidError').textContent, /先解除关联或作废/);
});

test('projects search participant names, escape hostile names and mask funding, shares, forecasts and linked names', async () => {
    for (const currency of ['USD', 'CNY']) assert.equal(FinanceUI.filterRecords([project], { currency }).length, 1);
    assert.equal(FinanceUI.filterRecords([project], { search: 'private partner' }).length, 1);
    assert.equal(FinanceUI.filterRecords([{ ...project, voided: true }]).length, 0);
    const hostile = { ...project, name: '<img src=x onerror=alert(1)>', participants: [{ ...project.participants[0], name: '<script>unsafe()</script>' }] };
    const html = FinanceUI.renderRows([hostile], 'projects'); assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>'));
    const hidden = FinanceUI.renderRows([project], 'projects', [], true);
    for (const secret of ['Private venture', 'Private partner', 'Kevin', '1,000.00', '80%', '20%', '500.00']) assert.ok(!hidden.includes(secret), secret);
    const hiddenMovement = FinanceUI.renderRows([{ ...movement, project_id: 6 }], 'movements', [product], true, [project]);
    assert.ok(!hiddenMovement.includes('Private venture'));
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [project] }) }));
    await f.ui.load(); f.click({ financeSection: 'projects' }); f.click({ financeDetail: 'projects', id: '6' }); f.click({ financeEdit: 'projects', id: '6' }, true);
    assert.ok(f.fields.has('participant-0-name')); f.ui.setPrivate(true);
    assert.equal(f.element('financeFormFields').innerHTML, ''); assert.equal(f.element('financeDetailsBody').innerHTML, ''); assert.equal(f.fields.size, 0);
    for (const secret of ['Private venture', 'Private partner', 'Kevin', '1,000.00', '500.00', '80%', '20%']) {
        assert.ok(!f.element('financeList').innerHTML.includes(secret)); assert.ok(!f.element('financeOverview').innerHTML.includes(secret));
    }
});

test('saved and preview project money preserves high-value micro-units through exact calculation mapping and legacy fallback', async () => {
    assert.equal(FinanceUI.projectMoney('999999999999.000001', 'USD'), 'USD 999,999,999,999.000001');
    assert.equal(FinanceUI.projectMoney('0', 'USD'), 'USD 0.00');
    assert.equal(FinanceUI.projectMoney('0.000001', 'USD'), 'USD 0.000001');
    assert.equal(FinanceUI.projectMoney('999999999999.000001', 'USD', true), '***');
    const inputs = { ...projectInput, expected_profit: '999999999999.000001', participants: projectInput.participants.map((participant, index) => ({ ...participant, currency: 'USD', exchange_rate: '1', contribution_amount: index ? '400' : '999999999999.000001', dividend_percent: '33.333333' })) };
    const exact = FinanceUI.projectPreview(inputs);
    assert.deepEqual(exact.participants.map(p => p.expected_dividend), ['333333329999.666667', '333333329999.666667']);
    assert.equal(exact.unallocated_profit, '333333339999.666667');
    assert.equal(FinanceUI.decimalSum([...exact.participants.map(p => p.expected_dividend), exact.unallocated_profit]), inputs.expected_profit);
    const numeric = { ...exact, total_contribution: Number(exact.total_contribution), unallocated_profit: Number(exact.unallocated_profit), participants: exact.participants.map(p => ({ ...p, base_amount: Number(p.base_amount), expected_dividend: Number(p.expected_dividend) })) };
    for (const mapping of [undefined, exact]) {
        const saved = { ...project, ...numeric, id: 7, expected_profit: Number(inputs.expected_profit), request_fields: inputs, calculation_fields: mapping };
        const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, projects: [saved, project], summary: [] }) }));
        await f.ui.load(); f.click({ financeSection: 'projects' });
        assert.ok(f.element('financeOverview').innerHTML.includes('USD 1,000,000,001,399.000001'));
        assert.ok(f.element('financeOverview').innerHTML.includes('USD 1,000,000,000,499.000001'));
        assert.ok(f.element('financeList').innerHTML.includes('USD 1,000,000,000,399.000001'));
        f.click({ financeDetail: 'projects', id: '7' });
        const html = f.element('financeDetailsBody').innerHTML;
        assert.equal((html.match(/USD 333,333,329,999\.666667/g) || []).length, 2);
        assert.ok(html.includes('USD 333,333,339,999.666667')); assert.ok(html.includes('USD 999,999,999,999.000001'));
        f.click({ financeEdit: 'projects', id: '7' }, true);
        assert.equal(f.element('financeProjectProfit').textContent, 'USD 999,999,999,999.000001');
        assert.ok(f.element('financeParticipantPreview-0').innerHTML.includes('USD 333,333,329,999.666667'));
        f.ui.setPrivate(true);
        assert.ok(!f.element('financeOverview').innerHTML.includes('1,000,000,001,399'));
    }
});

test('project create keeps blank forecast null and known zero as a raw zero string', async () => {
    for (const value of ['', '0']) {
        const f = fixture(); await f.ui.load(); f.click({ financeSection: 'projects' }); f.element('financeAdd').listeners.click();
        f.fields.get('name').value = 'Forecast check'; f.fields.get('expected_profit').value = value;
        f.fields.get('participant-0-name').value = 'First'; f.fields.get('participant-1-name').value = 'Second';
        await f.submit();
        assert.equal(f.requests.at(-1).url, '/api/finance/projects');
        assert.equal(JSON.parse(f.requests.at(-1).body).expected_profit, value === '' ? null : '0');
    }
});

test('funding summary defaults closed, survives page renders and data reload, then collapses on privacy', async () => {
    const f = fixture();
    assert.equal(f.element('financeSummary').open, false);
    assert.equal(f.element('financeSummaryHint').textContent, '展开');
    await f.ui.load(); assert.equal(f.element('financeSummary').open, false);
    f.element('financeSummary').open = true; f.element('financeSummary').listeners.toggle();
    assert.equal(f.element('financeSummaryHint').textContent, '收起');
    f.click({ financeSection: 'loans' }); assert.equal(f.element('financeSummary').open, true);
    await f.ui.load(true); assert.equal(f.element('financeSummary').open, true);
    f.element('financeSearch').value = 'Sensitive'; f.element('financeSearch').listeners.input();
    assert.equal(f.element('financeSummary').open, true);
    f.ui.setPrivate(true);
    assert.equal(f.element('financeSummary').open, false); assert.equal(f.element('financeSummaryHint').textContent, '展开');
    assert.ok(!f.element('financeOverview').innerHTML.includes('400.00'));
    f.ui.setPrivate(false); assert.equal(f.element('financeSummary').open, false);
    const refreshedPage = fixture(); assert.equal(refreshedPage.element('financeSummary').open, false);
});

function openMonetaryEditor(f, type) {
    if (type === 'repayments' || type === 'payments') f.click({ financePayment: type === 'repayments' ? 'loans' : 'movements', id: type === 'repayments' ? '2' : '4' }, true);
    else { f.click({ financeSection: type }); if (type === 'movements') f.click({ financeProductTransaction: '', id: '3' }, true); else f.element('financeAdd').listeners.click(); }
    if (type === 'transfers') f.fields.get('amount').value = '5';
    if (type === 'loans') { f.fields.get('counterparty').value = 'Different counterparty'; f.fields.get('principal').value = '500'; }
    if (type === 'movements') { f.fields.get('quantity').value = '1'; f.fields.get('unit_price').value = '20'; }
    if (type === 'exchanges') { f.fields.get('from_amount').value = '100'; f.fields.get('to_amount').value = '720'; }
}

test('optional actors create trimmed names on all monetary records and omit blank names for retry compatibility', async () => {
    for (const type of ['transfers', 'loans', 'movements', 'exchanges', 'repayments', 'payments']) {
        const blank = fixture(); await blank.ui.load(); openMonetaryEditor(blank, type);
        assert.equal(blank.fields.get('payer').value, ''); assert.equal(blank.fields.get('recipient').value, '');
        assert.match(blank.element('financeFormFields').innerHTML, /name="payer"[^>]*maxlength="200"/);
        assert.match(blank.element('financeFormFields').innerHTML, /name="recipient"[^>]*maxlength="200"/);
        blank.fields.get('payer').value = '   '; blank.fields.get('recipient').value = '  '; await blank.submit();
        const blankPayload = JSON.parse(blank.requests.at(-1).body);
        assert.equal(blankPayload.payer, undefined, type); assert.equal(blankPayload.recipient, undefined, type);
        const filled = fixture(); await filled.ui.load(); openMonetaryEditor(filled, type);
        filled.fields.get('payer').value = '  Actual payer  '; filled.fields.get('recipient').value = '  Actual recipient  ';
        await filled.submit(); const payload = JSON.parse(filled.requests.at(-1).body);
        assert.equal(payload.payer, 'Actual payer', type); assert.equal(payload.recipient, 'Actual recipient', type);
        if (type === 'loans') assert.equal(payload.counterparty, 'Different counterparty');
    }
});

test('editing actors preserves recorded names and explicitly clears blank names without changing counterparties', async () => {
    for (const [type, source] of [['transfers', transfer], ['loans', loan], ['movements', movement], ['exchanges', exchange]]) {
        const record = { ...source, payer: 'Original payer', recipient: 'Original recipient' };
        const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, [type]: [record] }) }));
        await f.ui.load(); f.click({ financeEdit: type, id: String(source.id) }, true);
        assert.equal(f.fields.get('payer').value, 'Original payer'); assert.equal(f.fields.get('recipient').value, 'Original recipient');
        const counterparty = f.fields.get('counterparty').value;
        f.fields.get('payer').value = ''; f.fields.get('recipient').value = ' '; await f.submit();
        const payload = JSON.parse(f.requests.at(-1).body);
        assert.equal(payload.payer, '', type); assert.equal(payload.recipient, '', type);
        assert.equal(payload.counterparty, counterparty); assert.equal(payload.version, source.version);
        if (type === 'movements') assert.equal(payload.paid_amount, '30');
    }
});

test('actors never infer counterparty or parent names and nested history remains independently searchable', async () => {
    const parentLoan = { ...loan, payer: 'Principal payer', recipient: 'Principal recipient', repayments: [{ ...loan.repayments[0], payer: 'Repayment Alice', recipient: 'Repayment Bob', voided: true }] };
    const parentMovement = { ...movement, payer: 'Initial payer', recipient: 'Initial recipient', payments: [{ ...movement.payments[0], payer: 'Later Carol', recipient: 'Later David' }] };
    assert.equal(FinanceUI.filterRecords([parentLoan], { search: 'repayment ALICE' }).length, 1);
    assert.equal(FinanceUI.filterRecords([parentMovement], { search: 'later david' }).length, 1);
    assert.equal(FinanceUI.filterRecords([{ ...transfer, payer: 'Another payer' }], { search: 'another payer' }).length, 1);
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, loans: [parentLoan], movements: [parentMovement] }) }));
    await f.ui.load();
    for (const [type, id, scope, initial, later] of [['loans', '2', '本金付款人（谁付的）', 'Principal payer', 'Repayment Alice'], ['movements', '4', '最初收付的付款人（谁付的）', 'Initial payer', 'Later Carol']]) {
        f.click({ financeDetail: type, id }, true);
        const html = f.element('financeDetailsBody').innerHTML;
        assert.ok(html.includes(scope)); assert.ok(html.includes(initial)); assert.ok(html.includes(`本次付款人 ${later}`));
        f.click({ financePayment: type, id }, true);
        assert.equal(f.fields.get('payer').value, ''); assert.equal(f.fields.get('recipient').value, '');
    }
    assert.ok(FinanceUI.renderRows([parentLoan], 'loans').includes('本金：付款人 Principal payer'));
    assert.ok(FinanceUI.renderRows([parentMovement], 'movements', [product]).includes('最初收付：付款人 Initial payer'));
});

test('exchange actors clearly correspond to source payer and destination recipient after leg changes', async () => {
    const f = fixture(); await f.ui.load(); openMonetaryEditor(f, 'exchanges');
    assert.ok(f.element('financeFormFields').innerHTML.includes('付款人（换出币种）'));
    assert.ok(f.element('financeFormFields').innerHTML.includes('收款人（换入币种）'));
    assert.match(f.element('financeActorsIntro').textContent, /支付换出的 USD.*收到换入的 CNY/);
    f.fields.get('from_currency').value = 'CNY'; f.fields.get('to_currency').value = 'USD';
    f.element('financeForm').listeners.change({ target: { name: 'from_currency' } });
    assert.match(f.element('financeActorsIntro').textContent, /支付换出的 CNY.*收到换入的 USD/);
    f.click({ financeDetail: 'exchanges', id: '5' });
    assert.ok(f.element('financeDetailsBody').innerHTML.includes('付款人（换出 USD）'));
    assert.ok(f.element('financeDetailsBody').innerHTML.includes('收款人（换入 CNY）'));
});

test('actors escape hostile HTML, mask in lists and scrub open forms/history when privacy collapses summary', async () => {
    const actors = { payer: '<img src=x onerror=alert(1)>', recipient: '<script>unsafe()</script>' };
    for (const [type, record] of [['transfers', transfer], ['loans', loan], ['movements', movement], ['exchanges', exchange]]) {
        const row = FinanceUI.renderRows([{ ...record, ...actors }], type, [product]);
        assert.ok(row.includes('&lt;img')); assert.ok(row.includes('&lt;script&gt;')); assert.ok(!row.includes('<img')); assert.ok(!row.includes('<script>'));
        const masked = FinanceUI.renderRows([{ ...record, payer: 'Secret payer', recipient: 'Secret recipient' }], type, [product], true);
        assert.ok(!masked.includes('Secret payer')); assert.ok(!masked.includes('Secret recipient'));
    }
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, loans: [{ ...loan, ...actors, repayments: [{ ...loan.repayments[0], ...actors }] }] }) }));
    await f.ui.load(); f.click({ financeSection: 'loans' }); f.click({ financeDetail: 'loans', id: '2' });
    assert.ok(!f.element('financeDetailsBody').innerHTML.includes('<img')); assert.ok(f.element('financeDetailsBody').innerHTML.includes('&lt;img'));
    f.click({ financeEdit: 'loans', id: '2' }, true); f.element('financeSummary').open = true; f.ui.setPrivate(true);
    assert.equal(f.element('financeSummary').open, false); assert.equal(f.element('financeFormFields').innerHTML, ''); assert.equal(f.fields.size, 0);
    assert.equal(f.element('financeDetailsBody').innerHTML, ''); assert.ok(!f.element('financeList').innerHTML.includes('onerror')); assert.ok(!f.element('financeList').innerHTML.includes('unsafe'));
});

test('actors enforce 200 characters and are absent from product and project editors', async () => {
    for (const type of ['transfers', 'loans', 'movements', 'exchanges', 'repayments', 'payments']) assert.match(FinanceUI.validatePayload(type, { date: '2026-10-01', payer: 'a'.repeat(201) }), /200 个字符/);
    const f = fixture(); await f.ui.load(); f.click({ financeProductNew: '' }, true);
    assert.equal(f.fields.has('payer'), false); assert.equal(f.fields.has('recipient'), false);
    f.click({ financeSection: 'projects' }); f.element('financeAdd').listeners.click();
    assert.equal(f.fields.has('payer'), false); assert.equal(f.fields.has('recipient'), false);
});

test('a rejected actor save keeps UUID for the same names and changes UUID when actors change', async () => {
    const f = fixture(); await f.ui.load(); openMonetaryEditor(f, 'transfers');
    f.fields.get('payer').value = 'Actual payer'; f.fields.get('recipient').value = 'Actual recipient';
    f.setResponse(async () => ({ ok: false, status: 422, json: async () => ({ detail: 'Amount must be positive' }) })); await f.submit();
    const first = JSON.parse(f.requests.at(-1).body); await f.submit();
    assert.equal(JSON.parse(f.requests.at(-1).body).request_id, first.request_id);
    f.fields.get('recipient').value = 'Different recipient'; await f.submit();
    assert.notEqual(JSON.parse(f.requests.at(-1).body).request_id, first.request_id);
});


test('inventory main creates profiles and profile timeline contains only the selected product transactions', async () => {
    const f = fixture();
    const other = { ...movement, id: 11, product_id: 8, note: 'Unrelated transaction' };
    f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [movement, other] }) }));
    await f.ui.load(); f.click({ financeSection: 'movements' });
    assert.match(f.element('financeList').innerHTML, /data-finance-detail="products"/);
    assert.doesNotMatch(f.element('financeList').innerHTML, /Private supplier/);
    f.element('financeAdd').listeners.click();
    assert.equal(f.element('financeEditTitle').textContent, '创建商品');
    f.element('financeEditModal').listeners['hidden.bs.modal']();
    f.click({ financeDetail: 'products', id: '3' });
    const body = f.element('financeDetailsBody').innerHTML;
    for (const text of ['累计成本', '等效单位成本', '累计销售数量', '累计销售额', '已售利润', 'Private shipment note', 'data-finance-product-transaction']) assert.ok(body.includes(text), text);
    assert.ok(!body.includes('Unrelated transaction'));
    f.click({ financeProductTransaction: '', id: '3' }, true);
    assert.equal(f.fields.get('product_id').value, '3'); assert.equal(f.fields.get('product_id').disabled, true);
});

test('expense transaction keeps a custom category and exact total without quantity or unit price', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeProductTransaction: '', id: '3' }, true);
    f.fields.get('kind').value = 'expense'; f.element('financeForm').listeners.change({ target: { name: 'kind' } });
    assert.equal(f.fields.get('quantity').disabled, true); assert.equal(f.fields.get('unit_price').disabled, true);
    assert.equal(f.fields.get('category').disabled, false); assert.equal(f.fields.get('category').required, true);
    assert.equal(f.fields.get('total_amount').disabled, false);
    assert.match(f.element('financeMovementHint').textContent, /费用计入商品累计成本，不改变数量/);
    f.fields.get('category').value = '  私人运输类别  '; f.fields.get('total_amount').value = '123.456789';
    f.fields.get('handler').value = '  Shipment handler  '; f.fields.get('payer').value = '  Actual payer  '; f.fields.get('recipient').value = 'Actual recipient';
    await f.submit(); const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.category, '私人运输类别'); assert.equal(payload.total_amount, '123.456789');
    assert.equal(payload.quantity, undefined); assert.equal(payload.unit_price, undefined);
    assert.equal(payload.handler, 'Shipment handler'); assert.equal(payload.payer, 'Actual payer'); assert.equal(payload.recipient, 'Actual recipient');
    assert.equal(payload.product_id, 3); assert.equal(payload.paid_amount, '0');
});

test('total price remains authoritative for indivisible averages and zero gifts', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeProductTransaction: '', id: '3' }, true);
    f.fields.get('quantity').value = '3'; f.fields.get('price_mode').value = 'total'; f.element('financeForm').listeners.change({ target: { name: 'price_mode' } });
    f.fields.get('total_amount').value = '100'; f.element('financeForm').listeners.input({ target: { name: 'total_amount' } });
    assert.equal(f.fields.get('unit_price').value, '33.333333'); assert.equal(f.fields.get('unit_price').disabled, true);
    assert.equal(f.element('financeMovementTotal').textContent, 'USD 100.00'); assert.match(f.element('financeMovementHint').textContent, /保存时以所填总价为准/);
    await f.submit(); let payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.total_amount, '100'); assert.equal(payload.quantity, '3'); assert.equal(payload.unit_price, undefined);
    f.click({ financeProductTransaction: '', id: '3' }, true); f.fields.get('kind').value = 'sale'; f.fields.get('quantity').value = '2';
    f.fields.get('price_mode').value = 'total'; f.element('financeForm').listeners.change({ target: { name: 'price_mode' } });
    f.fields.get('total_amount').value = '0'; f.element('financeForm').listeners.input({ target: { name: 'total_amount' } });
    assert.match(f.element('financeMovementHint').textContent, /赠送/);
    await f.submit(); payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.total_amount, '0'); assert.equal(payload.unit_price, undefined); assert.equal(payload.paid_amount, '0');
});

test('editing total-priced transactions restores exact request fields instead of rounded computed values', async () => {
    const raw = { date: '2026-10-01', kind: 'purchase', product_id: 3, quantity: '3.000001', total_amount: '999999999999.000001', paid_amount: '999999999999.000001', currency: 'CNY', exchange_rate: '0.142857142857', handler: 'Exact handler' };
    const saved = { ...movement, ...raw, total: 999999999999, quantity: 3.000001, unit_price: 333333222222.26, initial_paid_amount: 999999999999, payments: [], price_basis: 'total', request_fields: raw };
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [saved] }) }));
    await f.ui.load(); f.click({ financeEdit: 'movements', id: '4' }, true);
    assert.equal(f.fields.get('price_mode').value, 'total');
    assert.equal(f.fields.get('total_amount').value, raw.total_amount); assert.equal(f.fields.get('paid_amount').value, raw.paid_amount);
    await f.submit(); const payload = JSON.parse(f.requests.at(-1).body);
    for (const key of ['quantity', 'total_amount', 'paid_amount', 'exchange_rate', 'handler']) assert.equal(payload[key], raw[key], key);
    assert.equal(payload.unit_price, undefined); assert.equal(payload.version, 2);
});

test('a profile retains fees before any stock and exposes pooled cost and historical profit updates', async () => {
    const empty = { ...product, quantity: 0, acquired_quantity: 0, total_cost: 25, purchase_cost: 0, expense_cost: 25, inventory_cost: 0, average_cost: 0, unallocated_cost: 25, expense_categories: [{ category: '物流', total: 25 }] };
    const fee = { ...movement, kind: 'expense', quantity: 0, unit_price: 0, total: 25, category: '物流' };
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, products: [empty], movements: [fee] }) }));
    await f.ui.load(); f.click({ financeSection: 'movements' });
    assert.match(f.element('financeList').innerHTML, /0 箱/); assert.match(f.element('financeList').innerHTML, /USD 25.00/);
    f.click({ financeDetail: 'products', id: '3' }); const body = f.element('financeDetailsBody').innerHTML;
    assert.match(body, /尚未进货的费用已计入对应币种支出/);
    assert.match(body, /新增成本会更新此前销售的利润/); assert.match(body, /按类别查看费用/);
    assert.match(body, /物流/); assert.doesNotMatch(FinanceUI.renderRows([fee], 'movements', [empty]), /0 箱/); // Expenses have no artificial zero-quantity transaction.
});

test('product searches include custom categories, transaction handlers, payer and later payment handler', () => {
    const expense = { ...movement, kind: 'expense', category: 'Special logistics', handler: 'Warehouse handler', payer: 'Expense payer', payments: [{ handler: 'Later handler' }] };
    for (const search of ['Special logistics', 'Warehouse handler', 'Expense payer', 'Later handler', product.sku]) assert.deepEqual(FinanceUI.filterProducts([product], [expense], { search }).map(record => record.id), [3]);
    assert.deepEqual(FinanceUI.filterProducts([product], [expense], { status: 'expense' }).map(record => record.id), [3]);
    assert.equal(FinanceUI.filterProducts([product], [{ ...expense, voided: true }], { status: 'expense' }).length, 0);
    assert.equal(FinanceUI.filterProducts([product], [{ ...expense, currency: 'CNY' }], { currency: 'CNY' }).length, 1);
});

test('profile and handler displays escape input and private mode scrubs profile values and transaction names', async () => {
    const hostileProduct = { ...product, name: '<img src=x>', location: '<script>location</script>' };
    const hostileMovement = { ...movement, handler: '<script>handler</script>', category: '<img expense>', kind: 'expense', total_amount: 12, total: 12 };
    const cards = FinanceUI.renderProductCards([hostileProduct]); assert.match(cards, /&lt;img/); assert.doesNotMatch(cards, /<img/);
    const rows = FinanceUI.renderRows([hostileMovement], 'movements', [product]); assert.match(rows, /&lt;script&gt;handler/); assert.doesNotMatch(rows, /<script>/);
    const hidden = FinanceUI.renderProductCards([product], true); for (const secret of [product.name, product.sku, product.location, 'USD 200.00', '8 箱', 'USD 20.00']) assert.ok(!hidden.includes(secret), secret);
    const f = fixture(); await f.ui.load(); f.click({ financeDetail: 'products', id: '3' }); assert.match(f.element('financeDetailsBody').innerHTML, /Private product/);
    f.ui.setPrivate(true); assert.equal(f.element('financeDetailsBody').innerHTML, ''); assert.equal(f.element('financeDetailsActions').innerHTML, '');
});

test('handler metadata is independent on transactions and actual payments with explicit edit clearing', async () => {
    const saved = { ...movement, handler: 'Original handler', payer: 'Initial payer', recipient: 'Initial recipient', payments: [{ ...movement.payments[0], handler: 'Later handler', payer: 'Later payer' }] };
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [saved] }) }));
    await f.ui.load(); f.click({ financeDetail: 'movements', id: '4' }); assert.match(f.element('financeDetailsBody').innerHTML, /Original handler/); assert.match(f.element('financeDetailsBody').innerHTML, /本次经手人 Later handler/);
    f.click({ financeEdit: 'movements', id: '4' }, true); assert.equal(f.fields.get('handler').value, 'Original handler'); f.fields.get('handler').value = ''; await f.submit();
    const edited = JSON.parse(f.requests.at(-1).body); assert.equal(edited.handler, ''); assert.equal(edited.payer, 'Initial payer');
    f.click({ financePayment: 'movements', id: '4' }, true); assert.equal(f.fields.get('handler').value, '');
    f.fields.get('amount').value = '10'; f.fields.get('handler').value = '  New payment handler  '; await f.submit();
    const payment = JSON.parse(f.requests.at(-1).body); assert.equal(payment.handler, 'New payment handler'); assert.equal(payment.payer, undefined);
});

test('save, cancellation and void return to the associated product profile after modal transitions', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeProductTransaction: '', id: '3' }, true);
    f.fields.get('quantity').value = '1'; f.fields.get('unit_price').value = '10'; await f.submit();
    f.element('financeEditModal').listeners['hidden.bs.modal'](); assert.equal(f.element('financeDetailsTitle').textContent, product.name);
    f.click({ financeProductTransaction: '', id: '3' }, true); f.element('financeEditModal').listeners['hidden.bs.modal']();
    assert.equal(f.element('financeDetailsTitle').textContent, product.name); assert.equal(f.element('financeFormFields').innerHTML, '');
    f.click({ financeVoid: 'movements', id: '4' }, true); await f.element('financeVoidConfirm').listeners.click();
    f.element('financeVoidModal').listeners['hidden.bs.modal'](); assert.equal(f.element('financeDetailsTitle').textContent, product.name);
    f.click({ financeProductTransaction: '', id: '3' }, true); f.ui.setPrivate(true); f.element('financeEditModal').listeners['hidden.bs.modal']();
    assert.equal(f.element('financeDetailsBody').innerHTML, '');
});

test('expense and total-price validation use exact authoritative amount and length limits', () => {
    const expense = { date: '2026-10-01', product_id: 3, kind: 'expense', total_amount: '10', category: '物流', paid_amount: '10' };
    assert.equal(FinanceUI.validatePayload('movements', expense), '');
    assert.match(FinanceUI.validatePayload('movements', { ...expense, category: '' }), /费用类别/);
    assert.match(FinanceUI.validatePayload('movements', { ...expense, category: 'x'.repeat(101) }), /100/);
    assert.match(FinanceUI.validatePayload('movements', { ...expense, total_amount: '0' }), /大于 0/);
    assert.match(FinanceUI.validatePayload('movements', { ...expense, handler: 'x'.repeat(201) }), /200/);
    assert.match(FinanceUI.validatePayload('payments', { date: '2026-10-01', handler: 'x'.repeat(201) }), /200/);
    const sale = { ...expense, kind: 'sale', quantity: '3', total_amount: '100', paid_amount: '100' };
    assert.equal(FinanceUI.validatePayload('movements', sale), '');
    assert.match(FinanceUI.validatePayload('movements', { ...sale, paid_amount: '100.000001' }), /总金额/);
    assert.equal(FinanceUI.inventoryUnitPrice('100', '3'), '33.333333');
});

test('product summaries keep native expense and sales totals separate and optional null conversion unavailable', async () => {
    const native = { ...product, total_cost: null, average_cost: null, realized_profit: null, sales_revenue: null, inventory_cost: null, conversion_pending: true,
        currency_totals: [{ currency: 'CNY', purchase_cost: '700', expense_cost: '35', total_cost: '735', sales_revenue: '0' }, { currency: 'USD', purchase_cost: '0', expense_cost: '0', total_cost: '0', sales_revenue: '1200' }],
        expense_categories: [{ category: '<Local logistics>', currency: 'CNY', total: '35' }] };
    const cards = FinanceUI.renderProductCards([native]);
    assert.match(cards, /累计支出/); assert.match(cards, /累计收入/);
    for (const text of ['CNY 735.00', 'USD 1,200.00']) assert.ok(cards.includes(text), text);
    assert.doesNotMatch(cards, /已售利润|等效单位成本|USD 735.00|USD 1,935.00/);
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, products: [native] }) }));
    await f.ui.load(); f.click({ financeDetail: 'products', id: '3' });
    const body = f.element('financeDetailsBody').innerHTML;
    assert.match(body, /各币种不会自动相加或折算/); assert.match(body, /<summary>查看可选折算成本与利润/); assert.match(body, /未折算/);
    assert.match(body, /&lt;Local logistics&gt;/); assert.match(body, /CNY 35.00/);
    const hidden = FinanceUI.renderProductCards([native], true);
    for (const text of ['735', '1,200', product.name, product.sku]) assert.ok(!hidden.includes(text), text);
});

test('cross-currency sale saves its exact native amount without a required or invented exchange rate', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financeProductTransaction: '', id: '3' }, true);
    f.fields.get('kind').value = 'sale'; f.fields.get('quantity').value = '2'; f.fields.get('unit_price').value = '600'; f.fields.get('currency').value = 'CNY';
    f.element('financeForm').listeners.change({ target: { name: 'currency' } });
    assert.equal(f.element('financeMovementTotal').textContent, 'CNY 1,200.00');
    assert.match(f.element('financeFormFields').innerHTML, /id="financeMovementConversion"><summary>汇率与折算（可选/);
    await f.submit(); const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.exchange_rate, null); assert.equal(payload.currency, 'CNY'); assert.equal(payload.unit_price, '600'); assert.equal(payload.quantity, '2');
    assert.equal(payload.base_total, undefined);
});

test('later movement edit can add or clear an optional quote without changing original native amounts', async () => {
    const record = { ...movement, payments: [], currency: 'CNY', base_currency: 'USD', exchange_rate: null, base_total: null, conversion_pending: true, request_fields: { date: '2026-10-01', product_id: 3, kind: 'purchase', quantity: '10', unit_price: '70', currency: 'CNY', exchange_rate: null, paid_amount: '30' } };
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [record] }) }));
    await f.ui.load(); f.click({ financeEdit: 'movements', id: '4' }, true);
    assert.equal(f.fields.get('exchange_rate').value, '');
    f.fields.get('exchange_rate').value = '0.142857142857'; await f.submit();
    let payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(payload.exchange_rate, '0.142857142857'); assert.equal(payload.version, 2); assert.equal(payload.unit_price, '70');
    f.click({ financeEdit: 'movements', id: '4' }, true); await f.submit();
    payload = JSON.parse(f.requests.at(-1).body); assert.equal(payload.exchange_rate, null);
});

test('pending native payments never masquerade as settled or converted and can receive rates through child editing', async () => {
    const child = { ...movement.payments[0], amount: '50', currency: 'CNY', exchange_rate: null, invoice_currency: 'USD', invoice_amount: null, conversion_pending: true, payer: 'Actual child payer', recipient: 'Actual child recipient', handler: 'Child handler' };
    const parent = { ...movement, payments: [child], paid_amount: 30, remaining_payment: null, confirmed_remaining_payment: 170, status: 'pending_conversion' };
    const f = fixture(); f.setResponse(async () => ({ ok: true, json: async () => ({ ...data, movements: [parent] }) }));
    await f.ui.load(); f.click({ financeDetail: 'movements', id: '4' });
    const detail = f.element('financeDetailsBody').innerHTML;
    assert.match(detail, /有收付待折抵/); assert.match(detail, /CNY 50.00/); assert.match(detail, /可编辑补填折抵汇率/); assert.doesNotMatch(detail, /折抵 USD 50.00/);
    assert.match(detail, /data-finance-payment-edit/);
    const row = FinanceUI.renderRows([parent], 'movements', [product]); assert.match(row, /有收付待折抵/); assert.doesNotMatch(row, /已结清|已付清/);
    f.click({ financePaymentEdit: '', id: '9', parent: '4' }, true);
    assert.equal(f.element('financeEditTitle').textContent, '编辑收付款'); assert.equal(f.fields.get('amount').value, '50');
    assert.equal(f.fields.get('payer').value, 'Actual child payer'); assert.equal(f.fields.get('handler').value, 'Child handler');
    f.fields.get('exchange_rate').value = '0.14'; await f.submit(); const payload = JSON.parse(f.requests.at(-1).body);
    assert.equal(f.requests.at(-1).url, '/api/finance/movements/4/payments/9'); assert.equal(f.requests.at(-1).method, 'PUT');
    assert.equal(payload.version, 1); assert.equal(payload.amount, '50'); assert.equal(payload.currency, 'CNY'); assert.equal(payload.exchange_rate, '0.14');
    assert.equal(payload.request_id, undefined); assert.equal(payload.payer, 'Actual child payer');
});

test('new cross-currency payment accepts no quote, while explicit bad quotes retain validation', async () => {
    const f = fixture(); await f.ui.load(); f.click({ financePayment: 'movements', id: '4' }, true);
    f.fields.get('currency').value = 'CNY'; f.element('financeForm').listeners.change({ target: { name: 'currency' } }); f.fields.get('amount').value = '700';
    assert.equal(f.element('financePaymentInvoiceAmount').textContent, '未折抵（不影响保存）');
    await f.submit(); const payload = JSON.parse(f.requests.at(-1).body); assert.equal(payload.exchange_rate, null); assert.equal(payload.amount, '700');
    assert.equal(FinanceUI.validatePayload('payments', { date: '2026-10-02', currency: 'CNY', amount: '700', exchange_rate: null }, movement), '');
    assert.match(FinanceUI.validatePayload('payments', { date: '2026-10-02', currency: 'CNY', amount: '700', exchange_rate: '0' }, movement), /大于 0/);
});
