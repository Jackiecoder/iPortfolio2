const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const emptyLedger = () => ({ transfers: [], loans: [], products: [], movements: [], exchanges: [], projects: [], summary: [] });
const transfer = () => ({ id: 1, version: 1, date: '2026-10-01', direction: 'out', amount: 10, currency: 'USD', counterparty: '', from_account: '', to_account: '', method: '', reference: '', note: '', payer: '', recipient: '', voided: false });
const success = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });

function fixture(ledger = emptyLedger(), options = {}) {
    const requests = [], fields = new Map(), elements = new Map(), toasts = [], modals = [];
    let uuid = 0, renderFailure = false, respond = async () => success(ledger);
    function element(id) {
        if (elements.has(id)) return elements.get(id);
        const el = { id, value: '', checked: false, disabled: false, textContent: '', dataset: {}, listeners: {}, inner: '',
            classList: { toggle() {} }, setAttribute() {}, hasAttribute() { return false; },
            querySelector() { return element(id + '-child'); },
            querySelectorAll() { return id === 'financeForm' ? [...fields.values(), element('financeSave')] : []; },
            addEventListener(event, fn) { this.listeners[event] = fn; },
            get innerHTML() { return this.inner; },
            set innerHTML(html) {
                if (renderFailure && id === 'financeList') throw new Error('Rendering failed');
                this.inner = html;
                if (!['financeFormFields', 'financeProjectParticipants'].includes(id)) return;
                if (id === 'financeFormFields') fields.clear();
                for (const match of html.matchAll(/<input\b([^>]+)>/g)) {
                    const attrs = match[1], name = /name="([^"]+)"/.exec(attrs)?.[1];
                    if (name) fields.set(name, { name, value: /value="([^"]*)"/.exec(attrs)?.[1] || '', disabled: /\bdisabled\b/.test(attrs), hasAttribute() { return false; } });
                }
                for (const match of html.matchAll(/<select\b([^>]+)>([\s\S]*?)<\/select>/g)) {
                    const attrs = match[1], name = /name="([^"]+)"/.exec(attrs)?.[1];
                    const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
                    const option = options.find(item => item[2].includes('selected')) || options[0];
                    fields.set(name, { name, value: option?.[1] || '', disabled: /\bdisabled\b/.test(attrs), hasAttribute() { return false; } });
                }
                for (const match of html.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields.set(match[1], { name: match[1], value: match[2], disabled: false, hasAttribute() { return false; } });
            },
        };
        elements.set(id, el); return el;
    }
    element('financeForm').elements = { namedItem: name => fields.get(name) };
    const sections = ['transfers', 'loans', 'movements', 'exchanges', 'projects'].map(section => { const el = element(section); el.dataset.financeSection = section; return el; });
    const context = vm.createContext({ console, Intl, Date, Number, String, Boolean, Map, Set, JSON, Object, Array, ...options.timers,
        document: { getElementById: element, querySelector: () => element('finance-workspace'), querySelectorAll: () => sections },
        crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
        bootstrap: { Modal: { getOrCreateInstance: el => ({ show: () => modals.push(['show', el.id]), hide: () => modals.push(['hide', el.id]) }) } },
        fetch: async (url, options) => { requests.push({ url, ...options }); return respond(url, options); },
        FormData: class { get(name) { const field = fields.get(name); return field && !field.disabled ? field.value : null; } },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8'), context);
    const ui = context.FinanceUI.init({ today: '2026-10-12', toast: message => toasts.push(message) });
    const click = (dataset, detail = false) => element(detail ? 'financeDetailsModal' : 'finance-workspace').listeners.click({ target: { dataset, disabled: false, closest() { return this; } } });
    return { ui, fields, requests, toasts, modals, element, click, submit: () => element('financeForm').listeners.submit({ preventDefault() {} }),
        respond(fn) { respond = fn; }, failRender() { renderFailure = true; } };
}

async function createDraft(f) { await f.ui.load(); f.element('financeAdd').listeners.click(); f.fields.get('amount').value = '15.000000'; }

test('a lost create response is confirmed by persisted UUID without posting twice', async () => {
    const ledger = emptyLedger(), f = fixture(ledger); await createDraft(f);
    f.respond(async (url, options) => {
        if (options.method === 'POST') { ledger.transfers.push({ ...JSON.parse(options.body), id: 1, version: 1, voided: false }); throw new TypeError('Load failed'); }
        return success(ledger);
    });
    await f.submit();
    assert.deepEqual(f.requests.map(request => request.method), ['GET', 'POST', 'GET']);
    assert.equal(f.toasts[0], '记录已保存'); assert.equal(f.element('financeFormFields').innerHTML, '');
    assert.equal(ledger.transfers.length, 1);
});

test('an uncertain create freezes its original draft and retries its exact payload and UUID', async () => {
    const f = fixture(); await createDraft(f);
    f.respond(async () => { throw new TypeError('Load failed'); });
    await f.submit();
    assert.match(f.element('financeFormError').textContent, /保存结果暂未确认/);
    assert.equal(f.fields.get('amount').disabled, true); assert.equal(f.element('financeSave').textContent, '核对并重试');
    const original = JSON.parse(f.requests.find(request => request.method === 'POST').body);
    f.fields.get('amount').value = '999';
    f.respond(async (url, options) => { if (options.method === 'GET') throw new TypeError('Load failed'); return success(emptyLedger()); });
    await f.submit();
    const posts = f.requests.filter(request => request.method === 'POST').map(request => JSON.parse(request.body));
    assert.equal(posts.length, 2); assert.deepEqual(posts[1], original); assert.equal(posts[1].amount, '15.000000');
});

test('dismiss and privacy never discard an unresolved draft or permit a different create', async () => {
    const f = fixture(); await createDraft(f); f.fields.get('payer').value = 'Kevin';
    f.respond(async () => { throw new TypeError('Load failed'); }); await f.submit();
    f.element('financeEditModal').listeners['hidden.bs.modal']();
    f.element('financeAdd').listeners.click();
    assert.equal(f.fields.get('amount').value, '15.000000'); assert.equal(f.fields.get('amount').disabled, true);
    f.ui.setPrivate(true); assert.equal(f.element('financeFormFields').innerHTML, '');
    f.ui.setPrivate(false); f.element('financeAdd').listeners.click();
    assert.equal(f.fields.get('amount').value, '15.000000'); assert.equal(f.fields.get('payer').value, 'Kevin');
    assert.equal(f.fields.get('payer').disabled, true); assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('a genuine validation rejection stays editable and is never retried or read-confirmed', async () => {
    const f = fixture(); await createDraft(f);
    f.respond(async () => ({ ok: false, status: 422, json: async () => ({ detail: 'Insufficient inventory for Tea on 2026-10-01; check earlier stock records' }) }));
    await f.submit();
    assert.deepEqual(f.requests.map(request => request.method), ['GET', 'POST']);
    assert.match(f.element('financeFormError').textContent, /库存不足/); assert.equal(f.fields.get('amount').disabled, false);
    const original = JSON.parse(f.requests[1].body);
    f.fields.get('amount').value = '12'; f.respond(async () => success(emptyLedger())); await f.submit();
    assert.notEqual(JSON.parse(f.requests[2].body).request_id, original.request_id);
});

test('a successful response with an unreadable body is verified before reporting success', async () => {
    const ledger = emptyLedger(), f = fixture(ledger); await createDraft(f);
    f.respond(async (url, options) => {
        if (options.method === 'POST') { ledger.transfers.push({ ...JSON.parse(options.body), id: 1, version: 1, voided: false }); return { ok: true, status: 200, json: async () => { throw new Error('Truncated body'); } }; }
        return success(ledger);
    });
    await f.submit(); assert.equal(f.toasts[0], '记录已保存'); assert.equal(f.requests.length, 3);
});

test('a lost edit response requires exactly the next version and matching submitted fields', async () => {
    for (const [version, amount, confirmed] of [[2, '15', true], [3, '15', false], [2, '14', false]]) {
        const ledger = emptyLedger(); ledger.transfers.push(transfer()); const f = fixture(ledger);
        await f.ui.load(); f.click({ financeEdit: 'transfers', id: '1' }); f.fields.get('amount').value = '15.000000';
        f.respond(async (url, options) => { if (options.method === 'PUT') { ledger.transfers[0] = { ...ledger.transfers[0], ...JSON.parse(options.body), version, amount }; throw new TypeError('Load failed'); } return success(ledger); });
        await f.submit(); assert.equal(f.toasts.length, confirmed ? 1 : 0);
        assert.equal(f.element('financeFormFields').innerHTML === '', confirmed);
        if (!confirmed) assert.match(f.element('financeFormError').textContent, /保存结果暂未确认/);
    }
});

test('a lost void response is confirmed by the record version and void flag', async () => {
    const ledger = emptyLedger(); ledger.transfers.push(transfer()); const f = fixture(ledger);
    await f.ui.load(); f.click({ financeVoid: 'transfers', id: '1' });
    f.respond(async (url, options) => { if (options.method === 'DELETE') { ledger.transfers[0].voided = true; ledger.transfers[0].version = 2; throw new TypeError('Load failed'); } return success(ledger); });
    await f.element('financeVoidConfirm').listeners.click();
    assert.deepEqual(f.requests.map(request => request.method), ['GET', 'DELETE', 'GET']); assert.match(f.toasts[0], /已作废/);
});

test('rendering failure after an acknowledged save never reports an unsaved transaction', async () => {
    const f = fixture(); await createDraft(f); f.failRender(); await f.submit();
    assert.match(f.element('financeNotice').textContent, /记录已保存/);
    assert.equal(f.element('financeFormFields').innerHTML, ''); assert.equal(f.toasts[0], '记录已保存');
    assert.equal(f.element('financeFormError').textContent, ''); assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('read-only network failure has an actionable message without raw Safari error text', async () => {
    const f = fixture(); f.respond(async () => { throw new TypeError('Load failed'); }); await f.ui.load();
    assert.match(f.element('financeNotice').textContent, /网络连接中断/); assert.doesNotMatch(f.element('financeNotice').textContent, /Load failed/);
});

test('read confirmation bounds a stalled response body and keeps the uncertain draft', async () => {
    const delays = [], timers = { setTimeout(callback, delay) { delays.push(delay); return setTimeout(callback, 2); }, clearTimeout };
    const f = fixture(emptyLedger(), { timers }); await createDraft(f);
    f.respond(async (url, options) => {
        if (options.method === 'POST') throw new TypeError('Load failed');
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
    });
    await f.submit();
    assert.equal(delays.at(-1), 8000); assert.match(f.element('financeFormError').textContent, /保存结果暂未确认/);
    assert.equal(f.fields.get('amount').disabled, true);
});

test('a lost child payment edit is confirmed by its own raw fields and version', async () => {
    const ledger = emptyLedger();
    ledger.products.push({ id: 1, version: 1, name: 'Tea', sku: '', unit: '件', currency: 'USD', quantity: 10, voided: false });
    const child = { id: 2, version: 1, date: '2026-10-02', amount: 50, currency: 'CNY', exchange_rate: null, note: '', payer: '', recipient: '', handler: '', voided: false };
    ledger.movements.push({ id: 1, version: 1, product_id: 1, date: '2026-10-01', kind: 'purchase', quantity: 10, unit_price: 10, total: 100, currency: 'USD', base_currency: 'USD', exchange_rate: 1, paid_amount: 0, initial_paid_amount: 0, confirmed_remaining_payment: 100, remaining_payment: null, status: 'pending_conversion', payments: [child], voided: false });
    const f = fixture(ledger); await f.ui.load(); f.click({ financePaymentEdit: '', id: '2', parent: '1' }, true);
    f.fields.get('exchange_rate').value = '0.14';
    f.respond(async (url, options) => {
        if (options.method === 'PUT') {
            assert.equal(url, '/api/finance/movements/1/payments/2');
            const payload = JSON.parse(options.body); child.request_fields = { ...payload }; Object.assign(child, payload, { version: 2 });
            throw new TypeError('Load failed');
        }
        return success(ledger);
    });
    await f.submit();
    assert.equal(f.toasts[0], '修改已保存'); assert.equal(f.element('financeFormFields').innerHTML, '');
    assert.deepEqual(f.requests.map(request => request.method), ['GET', 'PUT', 'GET']);
});
