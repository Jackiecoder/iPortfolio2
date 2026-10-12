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
const exchange = { id: 5, version: 2, date: '2026-10-01', from_currency: 'USD', to_currency: 'CNY', from_amount: 1000, to_amount: 7200, fee_amount: 35, fee_currency: 'CNY', from_account: 'Private dollar account', to_account: 'Private yuan account', counterparty: 'Private exchange partner', method: 'Private exchange method', reference: 'Secret-exchange-reference', note: 'Private exchange note', exchange_rate: 7.2, inverse_rate: 1 / 7.2, debited_amount: 1000, received_amount: 7165, effective_rate: 7.165, voided: false };
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
    const sectionButtons = ['transfers', 'loans', 'movements', 'exchanges'].map(s => { const el = element(`section-${s}`); el.dataset.financeSection = s; return el; });
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
    const first = JSON.parse(f.requests.at(-1).body);
    f.setResponse(async () => ({ ok: true, json: async () => data })); await f.submit();
    const retry = JSON.parse(f.requests.at(-1).body);
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
