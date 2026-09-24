// Lazy-loaded price references for clickable Top Movers rows.
window.TickerTechnicalsUI = (() => {
    let requestId = 0;
    let controller = null;
    let chart = null;
    let selectedSymbol = null;
    let closing = false;
    let queuedSymbol = null;
    const el = id => document.getElementById(id);

    function comparisonText(average, symbol) {
        if (average.value == null) return `Only ${average.observations} of ${average.window} daily closes available`;
        if (average.difference == null) return 'Latest quote unavailable';
        if (average.position === 'at') return 'At the moving average · 0.00%';
        const direction = average.position === 'above' ? 'Above' : 'Below';
        return `${direction} by ${formatPrice(symbol, Math.abs(average.difference))} (${Math.abs(average.difference_percent).toFixed(2)}%)`;
    }

    function render(data) {
        el('tickerTechnicalsPrice').textContent = data.current_price == null ? 'Unavailable' : formatPrice(data.symbol, data.current_price);
        el('tickerTechnicalsQuoteTime').textContent = data.quote_time
            ? `As of ${new Date(data.quote_time).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} ET · may be delayed; includes extended hours`
            : 'No current quote returned. Reopen to retry.';
        for (const average of data.averages) {
            el(`tickerSma${average.window}`).textContent = average.value == null ? 'Not enough history' : formatPrice(data.symbol, average.value);
            const comparison = el(`tickerSma${average.window}Comparison`);
            comparison.textContent = comparisonText(average, data.symbol);
            comparison.className = 'ticker-ma-comparison ' + (average.position === 'above' ? 'text-success' : average.position === 'below' ? 'text-danger' : 'text-muted');
        }
        el('tickerTechnicalsBasis').textContent = `Simple averages of the last 50 / 200 ${data.day_basis}, through ${data.history_as_of || 'unavailable'}. Today's daily bar is excluded. Prices are split-adjusted, without dividend adjustment.`;
        const positions = data.averages.map(a => a.position);
        el('tickerTechnicalsSummary').textContent = positions.every(p => p === 'above') ? 'Price is above both moving averages.'
            : positions.every(p => p === 'below') ? 'Price is below both moving averages.'
            : positions.every(p => p != null) ? 'Price is between or at the moving averages.'
            : 'Available averages are shown below.';
        el('tickerTechnicalsContent').classList.remove('d-none');
        if (chart) chart.destroy();
        chart = null;
        el('tickerTechnicalsChartWrap').classList.toggle('d-none', !data.series.length || anonymousMode);
        if (!data.series.length || anonymousMode) return;
        chart = new Chart(el('tickerTechnicalsChart').getContext('2d'), {
            type: 'line',
            data: {
                labels: data.series.map(p => p.date),
                datasets: [
                    {label: 'Daily close', key: 'close', borderColor: '#334155', borderWidth: 1.8},
                    {label: '50-day SMA', key: 'sma50', borderColor: '#07856c', borderWidth: 2},
                    {label: '200-day SMA', key: 'sma200', borderColor: '#b97518', borderWidth: 2},
                ].map(({key, ...options}) => ({...options, data: data.series.map(p => p[key]), pointRadius: 0, pointHoverRadius: 4, spanGaps: false})),
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                interaction: {mode: 'index', intersect: false},
                plugins: {legend: {position: 'bottom', labels: {usePointStyle: true, boxWidth: 8}}, tooltip: {
                    callbacks: {label: context => `${context.dataset.label}: ${formatPrice(data.symbol, context.parsed.y)}`},
                }},
                scales: {
                    x: {grid: {display: false}, ticks: {maxTicksLimit: 6, maxRotation: 0, callback: function(value) {return this.getLabelForValue(value).slice(5);}}},
                    y: {ticks: {callback: value => formatPrice(data.symbol, value)}},
                },
            },
        });
    }

    async function open(symbol) {
        // Bootstrap ignores show() while its previous close is animating.
        if (closing) { queuedSymbol = symbol; return; }
        selectedSymbol = symbol;
        const thisRequest = ++requestId;
        if (controller) controller.abort();
        controller = new AbortController();
        if (chart) chart.destroy();
        chart = null;
        el('tickerTechnicalsTitle').textContent = `${displaySymbol(symbol)} · Moving averages`;
        el('tickerTechnicalsContent').classList.add('d-none');
        el('tickerTechnicalsError').classList.add('d-none');
        el('tickerTechnicalsLoading').classList.remove('d-none');
        bootstrap.Modal.getOrCreateInstance(el('tickerTechnicalsModal')).show();
        try {
            const response = await fetch(`/api/ticker-technicals?${new URLSearchParams({symbol})}`, {signal: controller.signal});
            if (!response.ok) throw new Error('Unable to load price history. Please try again.');
            const data = await response.json();
            if (thisRequest !== requestId) return;
            render(data);
        } catch (error) {
            if (thisRequest !== requestId || error.name === 'AbortError') return;
            el('tickerTechnicalsErrorMessage').textContent = error.message;
            el('tickerTechnicalsError').classList.remove('d-none');
        } finally {
            if (thisRequest === requestId) el('tickerTechnicalsLoading').classList.add('d-none');
        }
    }

    function init() {
        for (const id of ['topGainersBody', 'topLosersBody']) {
            const body = el(id);
            if (!body) continue;
            body.addEventListener('click', event => {
                const row = event.target.closest('[data-mover-symbol]');
                if (row) open(row.dataset.moverSymbol);
            });
            body.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                const row = event.target.closest('[data-mover-symbol]');
                if (row) { event.preventDefault(); open(row.dataset.moverSymbol); }
            });
        }
        el('tickerTechnicalsRetry').addEventListener('click', () => open(selectedSymbol));
        el('tickerTechnicalsModal').addEventListener('shown.bs.modal', () => chart?.resize());
        el('tickerTechnicalsModal').addEventListener('hide.bs.modal', () => {
            closing = true;
            requestId++;
            controller?.abort();
            if (chart) chart.destroy();
            chart = null;
        });
        el('tickerTechnicalsModal').addEventListener('hidden.bs.modal', () => {
            closing = false;
            if (queuedSymbol) {
                const symbol = queuedSymbol;
                queuedSymbol = null;
                open(symbol);
                return;
            }
            const row = Array.from(document.querySelectorAll('[data-mover-symbol]')).find(row => row.dataset.moverSymbol === selectedSymbol);
            row?.focus({preventScroll: true});
        });
    }
    return {init, open, comparisonText};
})();
