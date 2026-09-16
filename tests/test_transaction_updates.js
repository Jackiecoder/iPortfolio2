const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TransactionUpdates = require('../static/js/transaction-updates.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');
const today = '2026-09-11';

test('consecutive saved buys accumulate shares while costs await server confirmation', () => {
    const original = [{symbol: 'AAPL', quantity: 5, cost_basis: 500}];
    const receipt = {asset: 'AAPL', action: 'BUY', quantity: 1, date: today};
    const once = TransactionUpdates.project(original, receipt, today);
    const twice = TransactionUpdates.project(once, receipt, today);
    assert.equal(original[0].quantity, 5);
    assert.equal(once[0].quantity, 6);
    assert.equal(twice[0].quantity, 7);
    assert.equal(twice[0].quantity_pending, false);
    assert.equal(twice[0].ledger_pending, true);
    assert.equal(twice[0].prices_pending, true);
});

test('historical and unknown-ledger quantities wait for split-aware server values', () => {
    const receipt = {asset: 'AAPL', action: 'BUY', quantity: 1, date: '2025-01-01'};
    const historical = TransactionUpdates.project([{symbol: 'AAPL', quantity: 5}], receipt, today);
    assert.equal(historical[0].quantity_pending, true);
    assert.equal(historical[0].quantity, 5);
    const unknown = TransactionUpdates.project([], {...receipt, date: today}, today, false);
    assert.equal(unknown[0].quantity_pending, true);
    assert.equal(unknown[0].quantity, null);
});

test('a pre-save response cannot refill the browser cache after a committed transaction', async () => {
    let release;
    const context = vm.createContext({Date, console, showToast() {},
        fetch: () => new Promise(resolve => {release = resolve;})});
    vm.runInContext(source.slice(source.indexOf('const apiCache ='), source.indexOf('function getAssetIconHtml')), context);
    vm.runInContext(source.slice(source.indexOf('async function fetchSummary('), source.indexOf('function getDateRangeForPeriod')), context);
    const pending = context.fetchSummary();
    vm.runInContext('apiCache.clear({invalidatePending: true})', context);
    release({ok: true, json: async () => ({holdings: [{symbol: 'AAPL', quantity: 5}]})});
    assert.equal(await pending, null);
    assert.equal(vm.runInContext("apiCache.get('summary')", context), null);
});

function modalContext() {
    const events = [];
    let save, reject;
    const pending = new Promise((resolve, no) => {save = resolve; reject = no;});
    const form = {addEventListener(_event, fn) {this.submit = fn;}, reset() {events.push('reset');}};
    const errBox = {textContent: '', classList: {add() {}, remove() {events.push('save-error');}}};
    const payload = {date: today, asset: 'AAPL', action: 'BUY', quantity: '1', ave_price: '120'};
    const context = vm.createContext({
        form, errBox, submitBtn: {disabled: false, textContent: 'Add'}, modalEl: {},
        transactionMode: 'record', assetOther: {value: ''}, brokerOther: {value: ''},
        FormData: class {get(key) {return payload[key] ?? ''; }},
        addTransaction() {events.push('save'); return pending;},
        bootstrap: {Modal: {getInstance() {return {hide() {events.push('hide');}};}}},
        showToast() {events.push('saved-toast');}, console,
        applySavedTransaction() {events.push('project');},
        refreshAfterTransaction() {events.push('background'); return new Promise(() => {});},
        setTransactionUpdateState(state) {events.push('update-' + state);},
    });
    const start = source.indexOf("    form.addEventListener('submit', async (e)");
    vm.runInContext(source.slice(start, source.indexOf('\n})();', start)), context);
    return {context, events, save, reject, submit: () => form.submit({preventDefault() {}})};
}

test('modal closes on acknowledgement and remains usable while calculations are pending', async () => {
    const modal = modalContext();
    const submit = modal.submit();
    await modal.submit();
    assert.deepEqual(modal.events, ['save']);
    assert.equal(modal.context.submitBtn.disabled, true);
    modal.save({id: 42, message: 'Saved'});
    await submit;
    assert.deepEqual(modal.events, ['save', 'hide', 'reset', 'saved-toast', 'project', 'background']);
    assert.equal(modal.context.submitBtn.disabled, false);
});

test('save failure keeps the modal open and never projects an uncommitted trade', async () => {
    const modal = modalContext();
    const submit = modal.submit();
    modal.reject(new Error('Database unavailable'));
    await submit;
    assert.deepEqual(modal.events, ['save', 'save-error']);
    assert.equal(modal.context.errBox.textContent, 'Database unavailable');
    assert.equal(modal.context.submitBtn.disabled, false);
});

test('post-save rendering failure cannot be reported as a failed transaction save', async () => {
    const modal = modalContext();
    modal.context.console = {error() {}};
    modal.context.applySavedTransaction = () => {throw new Error('Rendering failed');};
    const submit = modal.submit();
    modal.save({id: 42});
    await submit;
    assert.ok(modal.events.includes('hide'));
    assert.ok(modal.events.includes('update-error'));
    assert.ok(!modal.events.includes('save-error'));
});
