(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.SaleLots = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const labels = {
        FIFO: 'First In First Out (FIFO)', LIFO: 'Last In First Out (LIFO)',
        HIGH_COST: 'High Cost', LOW_COST: 'Low Cost',
        TAX_OPTIMIZER: 'Tax Optimizer', SPECIFIC: 'Specified Lots',
    };
    const help = {
        FIFO: 'Sell the earliest acquired shares first.',
        LIFO: 'Sell the most recently acquired shares first.',
        HIGH_COST: 'Sell the highest cost per share first, regardless of holding period.',
        LOW_COST: 'Sell the lowest cost per share first, regardless of holding period.',
        TAX_OPTIMIZER: 'Short-term losses → long-term losses → no gain/loss → long-term gains → short-term gains. Within each group, highest cost first.',
        SPECIFIC: 'Enter the quantity to sell from each purchase. The total must match your sell quantity.',
    };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
    const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(Number(value));
    const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
    const price = value => new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 8,
    }).format(Number(value));

    function selectedAllocations(manual) {
        return Object.entries(manual).filter(([, q]) => q !== '' && Number(q) !== 0)
            .map(([lot_id, quantity]) => ({ lot_id: Number(lot_id), quantity: String(quantity) }));
    }

    function create({ form, modal, assetSelect, assetOther, brokerSelect, brokerOther, isActive }) {
        const doc = form.ownerDocument;
        const panel = doc.getElementById('saleLotsPanel');
        const method = doc.getElementById('sellCostBasisMethod');
        const list = doc.getElementById('saleLotsList');
        const status = doc.getElementById('saleLotsStatus');
        const summary = doc.getElementById('saleLotsSummary');
        const customize = doc.getElementById('saleLotsCustomize');
        let manual = {}, inventoryKey = '', renderedKey = '', response = null, responseKey = '';
        let requestId = 0, timer = null, controller = null;

        function payload() {
            const value = name => form.elements[name].value || null;
            return {
                asset: (assetSelect.value === '__other__' ? assetOther.value : assetSelect.value).trim().toUpperCase(),
                date: value('date'), transaction_time: value('transaction_time'),
                broker: (brokerSelect.value === '__other__' ? brokerOther.value : brokerSelect.value).trim() || null,
                quantity: value('quantity'), ave_price: value('ave_price'), amount: value('amount'),
                cost_basis_method: method.value,
                lot_allocations: method.value === 'SPECIFIC' ? selectedAllocations(manual) : [],
            };
        }

        function render(data) {
            const specific = method.value === 'SPECIFIC';
            doc.getElementById('saleLotsAccount').textContent = `Available lots · ${data.broker || 'Unassigned account'}`;
            if (data.accounts.includes(null) && !brokerSelect.querySelector('option[value="__unassigned__"]')) {
                const option = doc.createElement('option');
                option.value = '__unassigned__'; option.textContent = 'Unassigned account';
                brokerSelect.appendChild(option);
            }
            const matches = Object.fromEntries(data.allocations.map(a => [a.lot_id, a.quantity]));
            const nextRenderedKey = JSON.stringify([data.lots, specific]);
            // Keep manual inputs alive during preview updates so typing retains focus.
            if (renderedKey !== nextRenderedKey || !specific) {
                list.innerHTML = data.lots.map(lot => `
                    <div class="sale-lot-row">
                      <div class="sale-lot-detail">
                        <strong>${escape(lot.purchase_date)}</strong>
                        <span class="badge ${lot.term === 'LT' ? 'text-bg-success' : 'text-bg-secondary'}">${lot.term === 'LT' ? 'Long term' : 'Short term'}</span>
                        <div class="small text-muted">Lot #${lot.lot_id} · ${number(lot.quantity)} available</div>
                        <div>${price(lot.cost_per_share)} / share <span class="small text-muted">· ${money(lot.cost_basis)} cost</span></div>
                      </div>
                      <div class="sale-lot-quantity">
                        ${specific ? `<label class="small" for="sell-lot-${lot.lot_id}">Sell quantity</label>
                          <button type="button" class="btn btn-link btn-sm p-0 ms-1" data-lot-all="${lot.lot_id}" data-quantity="${escape(lot.quantity_exact)}" aria-label="Select all shares from lot ${lot.lot_id}">All</button>
                          <input id="sell-lot-${lot.lot_id}" class="form-control form-control-sm" type="number" inputmode="decimal" min="0" max="${escape(lot.quantity_exact)}" step="any" data-lot-id="${lot.lot_id}" aria-label="Sell quantity for ${escape(lot.purchase_date)} lot ${lot.lot_id}" value="${escape(manual[lot.lot_id] || '')}" placeholder="0">`
                          : `<span class="small text-muted">Selected</span><strong>${number(matches[lot.lot_id] || 0)}</strong>`}
                      </div>
                    </div>`).join('');
                renderedKey = nextRenderedKey;
            }
            customize.disabled = !data.valid;
            customize.classList.toggle('d-none', specific);
            if (specific) {
                const matched = Object.values(manual).reduce((sum, q) => sum + (Number(q) || 0), 0);
                const values = payload();
                const target = Number(values.quantity) || (Number(values.amount) / Number(values.ave_price)) || 0;
                status.textContent = `Matched ${number(matched)} · Remaining ${number(target - matched)}${data.error ? ` · ${data.error}` : ''}`;
            } else {
                status.textContent = data.valid ? `Matched ${number(data.quantity)} · Remaining 0` : data.error;
            }
            status.classList.toggle('text-danger', !data.valid);
            summary.classList.toggle('d-none', !data.valid);
            if (data.valid) {
                const metrics = [
                    ['Estimated realized P&L', data.realized_pnl, true],
                    ['Short term', data.st_realized_pnl, true], ['Long term', data.lt_realized_pnl, true],
                    ['Sale proceeds', data.proceeds], ['Selected cost basis', data.cost_basis],
                    ['Remaining cost basis', data.remaining_cost_basis],
                ];
                summary.innerHTML = metrics.map(([label, value, gain]) => `<div><span>${label}</span><strong class="${gain ? (value < 0 ? 'text-danger' : value > 0 ? 'text-success' : '') : ''}">${money(value)}</strong></div>`).join('');
            }
        }

        async function load(id, values) {
            try {
                controller = new AbortController();
                const result = await fetch('/api/transactions/preview-sale', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(values), signal: controller.signal,
                });
                const data = await result.json();
                if (id !== requestId || !isActive()) return;
                if (!result.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Check the trade values and selected quantities.');
                response = data; responseKey = JSON.stringify(values);
                render(data);
            } catch (error) {
                if (id !== requestId || error.name === 'AbortError') return;
                response = null;
                status.textContent = `Lot preview unavailable: ${error.message}`;
                status.classList.add('text-danger');
            }
        }

        function refresh() {
            clearTimeout(timer); controller?.abort();
            const id = ++requestId;
            panel.classList.toggle('d-none', !isActive());
            summary.classList.add('d-none'); customize.disabled = true;
            response = null;
            if (!isActive()) {
                list.querySelectorAll('input').forEach(input => { input.disabled = true; });
                return;
            }
            list.querySelectorAll('input').forEach(input => { input.disabled = false; });
            const values = payload();
            const key = JSON.stringify([values.asset, values.date, values.transaction_time, values.broker]);
            if (inventoryKey !== key) {
                manual = {}; inventoryKey = key; renderedKey = ''; list.innerHTML = '';
                values.lot_allocations = [];
            }
            doc.getElementById('saleLotsMethodHelp').textContent = help[method.value];
            if (!values.asset || values.asset === '__OTHER__' || !values.date) {
                status.textContent = 'Select an asset and sale date to see available lots.';
                return;
            }
            status.classList.remove('text-danger');
            status.textContent = 'Updating lot preview…';
            timer = setTimeout(() => load(id, values), 250);
        }

        method.addEventListener('change', () => {
            if (method.value === 'SPECIFIC' && response?.valid) {
                manual = Object.fromEntries(response.allocations.map(a => [a.lot_id, a.quantity]));
            }
            refresh();
        });
        customize.addEventListener('click', () => {
            if (!response?.valid) return;
            manual = Object.fromEntries(response.allocations.map(a => [a.lot_id, a.quantity]));
            method.value = 'SPECIFIC'; refresh();
        });
        form.addEventListener('input', event => {
            if (event.target.dataset.lotId) {
                manual[event.target.dataset.lotId] = event.target.value; refresh();
            } else if (['quantity', 'ave_price', 'amount', 'date', 'transaction_time'].includes(event.target.name)
                || event.target === assetOther || event.target === brokerOther) refresh();
        });
        list.addEventListener('click', event => {
            const button = event.target.closest('[data-lot-all]');
            if (!button) return;
            manual[button.dataset.lotAll] = button.dataset.quantity;
            doc.getElementById(`sell-lot-${button.dataset.lotAll}`).value = button.dataset.quantity;
            refresh();
        });
        form.addEventListener('change', event => {
            if (['asset', 'broker', 'action', 'date', 'transaction_time'].includes(event.target.name)) refresh();
        });
        form.addEventListener('reset', () => {
            manual = {}; inventoryKey = ''; renderedKey = ''; response = null; method.value = 'FIFO';
            clearTimeout(timer); controller?.abort(); ++requestId;
        });
        modal.addEventListener('hidden.bs.modal', () => { clearTimeout(timer); controller?.abort(); ++requestId; response = null; });
        return {
            refresh,
            selection() {
                if (!response?.valid || responseKey !== JSON.stringify(payload())) {
                    throw new Error(response?.error || 'Wait for a valid lot preview before saving.');
                }
                return {
                    cost_basis_method: method.value, lot_allocations: response.allocations,
                    broker: response.broker || '__unassigned__',
                };
            },
        };
    }
    return { create, labels, selectedAllocations };
});
