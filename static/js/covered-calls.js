(function (root) {
    'use strict';
    const labels = { OPEN: 'Open', CLOSE: 'Bought back', EXPIRE: 'Expired', ASSIGN: 'Assigned', ROLL: 'Rolled', COMPLETED: 'Completed' };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    function cashFlow(action, contracts, premium, fees, newPremium = 0, newFees = 0) {
        const gross = Number(contracts) * 100 * Number(premium);
        if (action === 'OPEN') return gross - Number(fees);
        if (action === 'ROLL') return Number(contracts) * 100 * Number(newPremium) - Number(newFees) - gross - Number(fees);
        return (action === 'CLOSE' ? -gross : 0) - Number(fees);
    }
    // Inventory is account-scoped: never combine odd lots across accounts.
    function holdingCoverage(data, symbol, quantity, state = 'ready') {
        if (symbol === 'CASH' || symbol.endsWith('-USD') || Number(quantity) <= 0) return null;
        if (state !== 'ready') return { state };
        const accounts = data.inventory.filter(p => p.asset === symbol);
        const calls = data.calls.filter(c => c.asset === symbol && c.remaining_contracts > 0);
        const sum = key => accounts.reduce((n, p) => n + Number(p[key]), 0);
        const shares = sum('shares');
        if (!accounts.length || !Number.isFinite(Number(quantity)) || Math.abs(shares - Number(quantity)) > 0.0001 ||
            accounts.some(p => ['shares', 'reserved_shares', 'available_shares', 'available_contracts'].some(k => !Number.isFinite(Number(p[k])) || Number(p[k]) < 0))) {
            return { state: 'updating' };
        }
        const openContracts = calls.reduce((n, c) => n + c.remaining_contracts, 0);
        if (calls.some(c => c.adjustment_required)) return { state: 'verify', openContracts };
        return { state: 'ready', accounts, calls, shares, openContracts,
            reservedShares: sum('reserved_shares'), availableShares: sum('available_shares'),
            availableContracts: sum('available_contracts') };
    }
    function coverageBadgeHtml(coverage, symbol, privateMode = false) {
        if (!coverage) return '';
        const messages = { loading: 'CC …', error: 'CC unavailable', updating: 'CC updating', verify: 'CC verify' };
        const descriptions = { loading: 'Loading covered-call coverage', error: 'Coverage unavailable. Open details to retry.',
            updating: 'Holdings and option inventory are updating. Refresh details before using capacity.',
            verify: 'Verify the adjusted contract with your broker before selling another covered call.' };
        let text, title, style = 'muted';
        if (coverage.state !== 'ready') {
            text = messages[coverage.state]; title = descriptions[coverage.state];
        } else if (privateMode) {
            text = 'CC ***'; title = 'Covered-call coverage hidden';
        } else {
            const c = coverage;
            text = c.openContracts ? `CC ${c.openContracts} open<span>${c.availableContracts} available</span>` : `CC ${c.availableContracts} available`;
            title = `${c.openContracts} covered-call contracts open; ${c.reservedShares} shares reserved; ${c.availableShares} shares free; ${c.availableContracts} additional contracts available across separate accounts.`;
            style = c.openContracts ? 'open' : c.availableContracts > 0 ? 'available' : 'muted';
        }
        return `<button type="button" class="holding-cc-badge holding-cc-${style}" data-cc-coverage="${escape(symbol)}" title="${escape(title)}" aria-label="${escape(symbol + ': ' + title)}">${text}</button>`;
    }
    function coverageDetailsHtml(c, privateMode = false) {
        if (!c || c.state !== 'ready') {
            const messages = { loading: 'Loading coverage…', error: 'Coverage could not be loaded. Refresh to try again.',
                updating: 'Holdings and option inventory do not yet match. Refresh the portfolio to update both before using capacity.',
                verify: 'An open call requires a contract adjustment. Confirm its deliverable with your broker; available capacity is not shown until the record is reconciled.' };
            return `<p role="status">${messages[c?.state] || 'No current stock holding.'}</p>`;
        }
        const n = value => privateMode ? '***' : escape(Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 }));
        return c.accounts.map(p => `<section class="holding-cc-account"><h6>${privateMode ? '***' : escape(p.broker || 'Unassigned account')}</h6>
            <dl><div><dt>Shares held</dt><dd>${n(p.shares)}</dd></div><div><dt>Shares reserved</dt><dd>${n(p.reserved_shares)}</dd></div>
            <div><dt>Shares free</dt><dd>${n(p.available_shares)}</dd></div><div><dt>Additional calls available</dt><dd>${n(p.available_contracts)}</dd></div></dl></section>`).join('') +
            (c.calls.length ? `<h6 class="mt-3">Open covered calls</h6><ul class="holding-cc-contracts">${c.calls.map(call => `<li>${privateMode ? '***' : escape(call.broker || 'Unassigned account')} · ${n(call.remaining_contracts)} contract(s) · $${n(call.strike)} · ${escape(call.expiration)}${call.outcome_pending ? '<br><span>Awaiting broker outcome; shares remain reserved.</span>' : ''}</li>`).join('')}</ul>` : '<p class="small text-muted">No open covered calls recorded.</p>');
    }
    function init(config) {
        const $ = id => document.getElementById(id);
        const form = $('ccForm');
        if (!form) return;
        const modal = $('coveredCallModal');
        let data = { calls: [], inventory: [], summary: {} };
        let selectedCall = null, requestId, replacementId, busy = false;
        let coverageState = 'loading', coverageSymbol = null;
        let loadVersion = 0, previewVersion = 0, timer, allocations = [], lotContext = '';
        const number = value => config.private() ? '***' : String(value);
        const money = value => config.money(Number(value));
        const value = id => $(id).value;
        const numeric = id => Number(value(id));
        const action = () => selectedCall ? value('ccEventAction') : 'OPEN';
        const currentLotContext = () => [selectedCall?.id, value('ccDate'), value('ccTime'), value('ccContracts'), value('ccLotMethod')].join('|');
        const error = message => { $('ccError').textContent = message; $('ccError').classList.toggle('d-none', !message); };
        async function api(path, body, method = 'POST') {
            const resp = await fetch(path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
            const result = await resp.json();
            if (!resp.ok) throw new Error(typeof result.detail === 'string' ? result.detail : (result.detail || []).map(e => e.msg).join('; ') || 'Unable to save');
            return result;
        }
        function coverageForSlot(slot) {
            return holdingCoverage(data, slot.dataset.ccSymbol, slot.dataset.ccQuantity,
                slot.dataset.ccPending === 'true' ? 'updating' : coverageState);
        }
        function renderHoldings() {
            document.querySelectorAll('[data-cc-symbol]').forEach(slot => {
                slot.innerHTML = coverageBadgeHtml(coverageForSlot(slot), slot.dataset.ccSymbol, config.private());
            });
            if (coverageSymbol) {
                const slot = Array.from(document.querySelectorAll('[data-cc-symbol]')).find(el => el.dataset.ccSymbol === coverageSymbol);
                $('ccHoldingDetails').innerHTML = coverageDetailsHtml(slot ? coverageForSlot(slot) : null, config.private());
            }
        }
        function render() {
            renderHoldings();
            const summary = data.summary;
            $('ccMetrics').innerHTML = [
                ['Open contracts', number(summary.open_contracts || 0)],
                ['Net option cash flow', money(summary.net_cash_flow || 0)],
                ['Realized option P&L', money(summary.realized_option_pnl || 0)],
            ].map(([label, val]) => `<div><span>${label}</span><strong>${val}</strong></div>`).join('');
            $('ccScopeNote').classList.toggle('d-none', !data.calls.length);
            const filter = value('ccFilter');
            const rows = data.calls.filter(c => filter === 'all' || (filter === 'open' ? c.remaining_contracts > 0 : c.remaining_contracts === 0));
            $('ccList').innerHTML = rows.length ? rows.map(c => {
                const status = c.adjustment_required ? 'Contract adjustment required' : c.outcome_pending ? 'Awaiting broker outcome' : labels[c.status];
                const events = c.events.map(e => `<li><span>${escape(e.date)} · ${escape(labels[e.action])} · ${number(e.contracts)} contract(s)</span><strong>${money(e.option_pnl)}</strong>${e.stock_transaction_id ? `<small>Linked stock sale #${e.stock_transaction_id}</small>` : ''}${e.replacement_call_id ? `<small>Replacement call #${e.replacement_call_id}</small>` : ''}</li>`).join('');
                return `<article class="cc-card"><div class="cc-card-head"><div><h3>${escape(c.asset)} <span>${config.private() ? '***' : '$' + Number(c.strike).toFixed(2)} Call</span></h3><p>${escape(c.expiration)} · ${config.private() ? '***' : escape(c.broker || 'Unassigned account')}</p></div><span class="cc-status">${escape(status)}</span></div>
                    <dl class="cc-details"><div><dt>Contracts open / original</dt><dd>${number(c.remaining_contracts)} / ${number(c.contracts)}</dd></div><div><dt>Shares reserved</dt><dd>${c.adjustment_required ? 'Verify adjusted deliverable' : number(c.reserved_shares)}</dd></div><div><dt>Opening premium, net</dt><dd>${money(c.net_opening_premium)}</dd></div><div><dt>Realized option P&L</dt><dd>${money(c.realized_option_pnl)}</dd></div></dl>
                    <p class="small text-muted mb-2">Opened ${escape(c.date)} ${escape(c.transaction_time.slice(0, 5))} ET · Fill ${money(c.premium)}/share · Fees ${money(c.fees)}</p>
                    ${c.comment && !config.private() ? `<p class="small">${escape(c.comment)}</p>` : ''}
                    ${events ? `<details><summary>Recorded events (${c.events.length})</summary><ul class="cc-events">${events}</ul></details>` : ''}
                    ${!config.demo ? `<div class="cc-actions">${c.remaining_contracts > 0 ? `<button type="button" class="btn btn-sm btn-outline-primary" data-cc-manage="${c.id}">Record outcome / roll</button>` : ''}${!c.events.length ? `<button type="button" class="btn btn-sm btn-link text-muted" data-cc-delete="${c.id}">Remove record</button>` : ''}</div>` : ''}</article>`;
            }).join('') : '<div class="cc-empty">No covered calls recorded.<br><span>Record an actual sell-to-open fill to start tracking collateral and option income.</span></div>';
        }
        async function load() {
            const version = ++loadVersion;
            $('ccStatus').textContent = 'Loading covered calls…';
            coverageState = 'loading'; renderHoldings();
            try {
                const result = await api('/api/covered-calls', null, 'GET');
                if (version !== loadVersion) return;
                data = result; coverageState = 'ready';
                render();
                $('ccStatus').textContent = config.demo ? 'Demo is read-only. No personal option records are loaded.' : '';
            } catch (err) {
                if (version === loadVersion) {
                    $('ccStatus').textContent = `Could not refresh covered calls: ${err.message}`;
                    coverageState = 'error'; renderHoldings();
                }
                throw err;
            }
        }
        function refreshAfterSave() {
            Promise.resolve().then(() => config.onSaved()).catch(() => {
                config.toast('Saved. Dashboard refresh failed; refresh the page to update totals.', 'warning');
            });
            load().catch(() => {});
        }
        function section(selector, show) {
            modal.querySelectorAll(selector).forEach(el => {
                el.hidden = !show;
                el.querySelectorAll('input,select').forEach(input => { input.disabled = !show; });
            });
        }
        function updateFields() {
            const mode = action();
            section('[data-cc-opening]', mode === 'OPEN');
            section('[data-cc-event]', mode !== 'OPEN');
            section('#ccReplacement', mode === 'ROLL');
            section('#ccAssignment', mode === 'ASSIGN');
            $('ccPremium').disabled = mode === 'ASSIGN' || mode === 'EXPIRE';
            $('ccPremiumLabel').textContent = mode === 'OPEN' ? 'Fill ($ / share)' : 'Buyback ($ / share)';
            $('ccConfirmLabel').textContent = mode === 'EXPIRE'
                ? 'My broker confirms these contracts expired worthless without assignment.'
                : mode === 'ASSIGN' ? 'My broker confirms assignment; this stock sale has not already been recorded.'
                : 'This trade has filled at my broker; these are the actual execution details.';
            $('ccSaveBtn').textContent = mode === 'OPEN' ? 'Save filled call' : 'Save confirmed event';
            updateEstimate();
        }
        function updateEstimate() {
            const mode = action();
            const flow = cashFlow(mode, numeric('ccContracts'), numeric('ccPremium'), numeric('ccFees'), numeric('ccNewPremium'), numeric('ccNewFees'));
            $('ccEstimate').textContent = `${mode === 'ROLL' ? 'Roll ' : ''}${flow < 0 ? 'Net debit' : 'Net credit'}: ${money(Math.abs(flow))} · ${number(numeric('ccContracts') * 100)} shares${mode === 'OPEN' ? ' reserved; share count stays unchanged' : mode === 'ASSIGN' ? ` sold at ${money(selectedCall.strike)}` : ''}`;
            if (mode === 'OPEN') {
                const holding = value('ccHolding') === '' ? null : data.inventory[Number(value('ccHolding'))];
                $('ccCoverage').textContent = holding ? `${number(holding.shares)} shares held · ${number(holding.reserved_shares)} reserved · ${number(holding.available_shares)} currently available in this account. Historical coverage is checked on save.` : 'Choose a holding and account.';
            } else {
                $('ccCoverage').textContent = `${number(selectedCall.remaining_contracts)} contract(s) remain. ${mode === 'ROLL' ? 'A roll can realize a loss on the old call even when it has a net credit.' : ''}`;
            }
        }
        function openingPayload(replacement = false) {
            const holding = replacement ? selectedCall : value('ccHolding') === '' ? null : data.inventory[Number(value('ccHolding'))];
            if (!holding) throw new Error('Select the account holding the underlying stock');
            return { request_id: replacement ? replacementId : requestId,
                asset: holding.asset, broker: holding.broker, date: value('ccDate'), transaction_time: value('ccTime'),
                expiration: value(replacement ? 'ccNewExpiry' : 'ccExpiration'), strike: value(replacement ? 'ccNewStrike' : 'ccStrike'),
                contracts: numeric('ccContracts'), premium: value(replacement ? 'ccNewPremium' : 'ccPremium'),
                fees: value(replacement ? 'ccNewFees' : 'ccFees'), comment: value('ccComment') };
        }
        async function previewLots() {
            if (action() !== 'ASSIGN' || busy) return;
            const version = ++previewVersion;
            const context = currentLotContext();
            if (context !== lotContext) { allocations = []; lotContext = context; }
            $('ccSalePreview').textContent = 'Checking stock lots…';
            try {
                const result = await api('/api/transactions/preview-sale', {
                    asset: selectedCall.asset, broker: selectedCall.broker || '__unassigned__', date: value('ccDate'), transaction_time: value('ccTime'),
                    quantity: numeric('ccContracts') * 100, ave_price: selectedCall.strike,
                    cost_basis_method: value('ccLotMethod'), lot_allocations: allocations,
                });
                if (version !== previewVersion || action() !== 'ASSIGN') return;
                const manual = value('ccLotMethod') === 'SPECIFIC';
                $('ccLotRows').innerHTML = result.lots.map(l => `<label class="cc-lot"><span>${escape(l.purchase_date)} · ${number(l.quantity)} shares @ ${money(l.cost_per_share)} <small>${l.term}</small></span>${manual ? `<input aria-label="Shares from lot ${l.lot_id}" class="form-control form-control-sm" type="number" min="0" max="${escape(l.quantity_exact)}" step="any" data-cc-lot="${l.lot_id}" value="${escape(allocations.find(a => a.lot_id === l.lot_id)?.quantity || '')}">` : `<span>Use ${number(result.allocations.find(a => a.lot_id === l.lot_id)?.quantity || 0)}</span>`}</label>`).join('');
                $('ccSalePreview').textContent = result.valid ? `Stock proceeds ${money(result.proceeds)} · Stock cost ${money(result.cost_basis)} · Stock P&L ${money(result.realized_pnl)} (option premium separate)` : result.error;
                if (result.valid) allocations = result.allocations;
            } catch (err) { if (version === previewVersion) $('ccSalePreview').textContent = err.message; }
        }
        function open(call = null) {
            selectedCall = call;
            requestId = crypto.randomUUID(); replacementId = crypto.randomUUID();
            previewVersion++; allocations = []; lotContext = ''; form.reset(); error('');
            $('ccLotRows').innerHTML = ''; $('ccSalePreview').textContent = '';
            $('ccDate').value = config.today();
            $('ccTime').value = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
            $('ccHolding').innerHTML = '<option value="" disabled selected>Select stock &amp; account…</option>' + data.inventory.map((p, i) => `<option value="${i}">${escape(p.asset)} · ${config.private() ? '***' : escape(p.broker || 'Unassigned')} · ${number(p.available_shares)} shares available</option>`).join('');
            $('ccModalTitle').textContent = call ? `${call.asset} ${money(call.strike)} Call · Record outcome` : 'Record sell to open';
            $('ccContracts').value = call ? call.remaining_contracts : 1;
            $('ccContracts').max = call ? call.remaining_contracts : 100000;
            updateFields(); bootstrap.Modal.getOrCreateInstance(modal).show();
        }
        $('ccOpenBtn').disabled = config.demo;
        $('ccOpenBtn').addEventListener('click', async () => {
            try { await load(); open(); }
            catch (err) { $('ccStatus').textContent = `Could not open the form: ${err.message}`; }
        });
        $('ccReloadBtn').addEventListener('click', () => load().catch(() => {}));
        $('ccFilter').addEventListener('change', render);
        $('covered-calls-tab').addEventListener('shown.bs.tab', () => load().catch(() => {}));
        $('holdings-tab').addEventListener('shown.bs.tab', () => load().catch(() => {}));
        $('holdingsBody').addEventListener('click', event => {
            const button = event.target.closest('[data-cc-coverage]');
            if (!button) return;
            event.stopPropagation();
            coverageSymbol = button.dataset.ccCoverage;
            $('ccHoldingTitle').textContent = `${coverageSymbol} · Covered Call`;
            renderHoldings();
            bootstrap.Modal.getOrCreateInstance($('holdingCoverageModal')).show();
        });
        $('ccHoldingReload').addEventListener('click', () => load().catch(() => {}));
        $('holdingCoverageModal').addEventListener('hidden.bs.modal', () => { coverageSymbol = null; });
        $('ccList').addEventListener('click', async event => {
            const manage = event.target.closest('[data-cc-manage]');
            if (manage) { open(data.calls.find(c => c.id === Number(manage.dataset.ccManage))); return; }
            const remove = event.target.closest('[data-cc-delete]');
            if (!remove || !confirm('Remove this portfolio record? This does not close a position at your broker. Only remove an incorrectly entered trade.')) return;
            remove.disabled = true;
            try {
                await api(`/api/covered-calls/${remove.dataset.ccDelete}`, null, 'DELETE');
                config.toast('Covered call record removed', 'success');
                refreshAfterSave();
            } catch (err) { $('ccStatus').textContent = err.message; remove.disabled = false; }
        });
        form.addEventListener('input', event => {
            if (event.target.id === 'ccConfirmed' || busy) return;
            previewVersion++;
            requestId = crypto.randomUUID(); replacementId = crypto.randomUUID();
            $('ccConfirmed').checked = false; updateEstimate();
            if (action() === 'ASSIGN' && currentLotContext() !== lotContext) {
                allocations = []; lotContext = currentLotContext(); $('ccLotRows').innerHTML = '';
                $('ccSalePreview').textContent = 'Checking stock lots…';
            }
            if (event.target.dataset.ccLot) {
                allocations = Array.from(form.querySelectorAll('[data-cc-lot]')).filter(i => Number(i.value) > 0).map(i => ({ lot_id: Number(i.dataset.ccLot), quantity: i.value }));
            }
            clearTimeout(timer); timer = setTimeout(previewLots, 350);
        });
        form.addEventListener('change', event => {
            if (event.target.id === 'ccEventAction') { previewVersion++; allocations = []; lotContext = ''; $('ccConfirmed').checked = false; updateFields(); }
            if (event.target.id === 'ccEventAction' || event.target.id === 'ccLotMethod') previewLots();
        });
        modal.addEventListener('hidden.bs.modal', () => { previewVersion++; clearTimeout(timer); });
        modal.addEventListener('hide.bs.modal', event => { if (busy) event.preventDefault(); });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (busy || config.demo || !form.reportValidity()) return;
            error('');
            let payload, path;
            try {
                if (action() === 'OPEN') { payload = openingPayload(); path = '/api/covered-calls'; }
                else {
                    payload = { request_id: requestId, action: action(), date: value('ccDate'), transaction_time: value('ccTime'), contracts: numeric('ccContracts'),
                        premium: ['CLOSE', 'ROLL'].includes(action()) ? value('ccPremium') : '0', fees: value('ccFees'), comment: value('ccComment'),
                        cost_basis_method: action() === 'ASSIGN' ? value('ccLotMethod') : 'FIFO',
                        lot_allocations: action() === 'ASSIGN' && value('ccLotMethod') === 'SPECIFIC' && currentLotContext() === lotContext ? allocations : [] };
                    if (action() === 'ROLL') payload.replacement = openingPayload(true);
                    path = `/api/covered-calls/${selectedCall.id}/events`;
                }
            } catch (err) { error(err.message); return; }
            busy = true; $('ccSaveBtn').disabled = true; $('ccSaveBtn').textContent = 'Saving…';
            let result;
            try { result = await api(path, payload); }
            catch (err) { error(err.message); }
            finally { busy = false; $('ccSaveBtn').disabled = false; updateFields(); }
            if (!result) return;
            bootstrap.Modal.getInstance(modal).hide();
            config.toast(result.message, 'success');
            // Committed data must never be re-submitted because a refresh failed.
            refreshAfterSave();
        });
        load().catch(() => {});
        return { load, render, renderHoldings };
    }
    const api = { init, cashFlow, escape, holdingCoverage, coverageBadgeHtml, coverageDetailsHtml };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.CoveredCalls = api;
})(globalThis);
