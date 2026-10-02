// Synthetic, public data only. This adapter intentionally has no network transport.
(function (root) {
    'use strict';
    const ASSETS = [
        { symbol: 'TSLA', quantity: 1, cost: 305, price: 360, change: 1.8 },
        { symbol: 'VOO', quantity: 3, cost: 510, price: 560, change: 0.45 },
        { symbol: 'QQQM', quantity: 3, cost: 190, price: 220, change: 0.72 },
        { symbol: 'SOXX', quantity: 3, cost: 210, price: 240, change: -0.65 },
        { symbol: 'MU', quantity: 1, cost: 105, price: 130, change: 2.1 },
        { symbol: 'ETH-USD', quantity: 1, cost: 2350, price: 2600, change: -0.38 },
    ];
    const cents = n => Math.round(n * 100) / 100;
    const sum = (rows, key) => cents(rows.reduce((total, row) => total + (row[key] || 0), 0));
    const day = date => date.toISOString().slice(0, 10);
    const shift = (date, count) => day(new Date(new Date(date + 'T12:00:00Z').getTime() + count * 86400000));

    function create({ now = () => new Date() } = {}) {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now());
        const start = shift(today, -180);
        let targets = { TSLA: 6, VOO: 30, QQQM: 12, SOXX: 12, MU: 5, 'ETH-USD': 35 };
        const stamp = () => ({ computed_at: now().toISOString(), cache_status: 'fresh', demo: true });
        const response = (body, status = 200) => new Response(JSON.stringify(body), {
            status, headers: { 'Content-Type': 'application/json', 'X-Portfolio-Mode': 'demo' },
        });
        const holdings = ASSETS.map(asset => {
            const cost = cents(asset.cost * asset.quantity);
            const value = cents(asset.price * asset.quantity);
            const pnl = cents(value - cost);
            const previous = asset.price / (1 + asset.change / 100);
            return {
                symbol: asset.symbol, quantity: asset.quantity, avg_cost: asset.cost,
                cost_basis: cost, current_price: asset.price, market_value: value,
                unrealized_pnl: pnl, pnl_percent: pnl / cost * 100,
                daily_change_percent: asset.change,
                daily_change_amount: cents((asset.price - previous) * asset.quantity),
                holding_days: 180, annualized_return: pnl / cost * 100,
                weighted_annualized_return: pnl / cost * 100,
                long_term_quantity: 0, short_term_quantity: asset.quantity,
                lt_unrealized_pnl: 0, st_unrealized_pnl: pnl,
                realized_pnl: 0, lt_realized_pnl: 0, st_realized_pnl: 0,
                total_pnl: pnl, total_pnl_percent: pnl / cost * 100,
                ytd_pnl: pnl, ytd_pnl_percent: pnl / cost * 100, ytd_basis: cost,
                lt_ytd_pnl: 0, st_ytd_pnl: pnl,
            };
        });
        const total = sum(holdings, 'market_value');
        const cost = sum(holdings, 'cost_basis');
        const gain = cents(total - cost);
        const transactions = ASSETS.map((asset, index) => ({
            id: index + 1, date: start, asset: asset.symbol, action: 'BUY',
            quantity: asset.quantity, ave_price: asset.cost, amount: cents(asset.cost * asset.quantity),
            broker: 'Demo Account', source: 'Demo', comment: 'Sample opening position',
            executed_at: start + 'T13:30:00Z', transaction_time: '09:30', running_quantity: asset.quantity,
            running_avg_cost: asset.cost, execution_price: asset.cost,
        }));

        function priceAt(asset, fraction, index) {
            // The endpoints are exact. Intermediate values are illustrative, not market history.
            return cents(asset.cost + (asset.price - asset.cost) * fraction
                + asset.price * 0.025 * Math.sin(fraction * Math.PI) * Math.sin(fraction * 25 + index));
        }
        const history = Array.from({ length: 181 }, (_, index) => {
            const value = cents(ASSETS.reduce((n, asset, i) => n + priceAt(asset, index / 180, i) * asset.quantity, 0));
            return { date: shift(start, index), value, investment_value: value, cost_basis: cost };
        });
        const summary = () => ({
            ...stamp(), holdings, total_cost_basis: cost, total_market_value: total,
            investment_market_value: total, total_unrealized_pnl: gain,
            lt_unrealized_pnl: 0, st_unrealized_pnl: gain, total_realized_pnl: 0,
            total_pnl: gain, total_pnl_percent: gain / cost * 100, total_dividends: 0, total_fees: 0,
            all_time_cost_basis: cost, weighted_annualized_return: gain / cost * 100,
            ytd_pnl: gain, ytd_pnl_percent: gain / cost * 100, ytd_basis: cost,
            ytd_lt_pnl: 0, ytd_st_pnl: gain, dividend_summaries: [],
        });
        function intraday(date = today, interval = '1m') {
            const currentMinute = date === today
                ? new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now()).split(':').reduce((h, m) => h * 60 + Number(m), 0)
                : 1439;
            const step = Math.max(1, parseInt(interval, 10) || 1);
            const minutes = Array.from({ length: Math.floor(currentMinute / step) + 1 }, (_, i) => i * step);
            if (minutes.at(-1) !== currentMinute) minutes.push(currentMinute);
            return { ...stamp(), date, intraday: minutes.map(minute => {
                const fraction = currentMinute ? minute / currentMinute : 1;
                const changes = holdings.map((holding, index) => {
                    const progress = fraction + Math.sin(fraction * Math.PI) * Math.sin(fraction * 16 + index) * 0.3;
                    const pnl = cents(holding.daily_change_amount * progress);
                    const baseline = holding.market_value - holding.daily_change_amount;
                    return { symbol: holding.symbol, quantity: holding.quantity, pnl,
                        pnl_percent: baseline ? pnl / baseline * 100 : 0,
                        current_price: cents((baseline + pnl) / holding.quantity) };
                });
                const pnl = sum(changes, 'pnl');
                const baseline = total - sum(holdings, 'daily_change_amount');
                return { time: String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'),
                    value: cents(baseline + pnl), daily_pnl: pnl, daily_pnl_percent: pnl / baseline * 100,
                    holdings_complete: true, asset_changes: changes };
            }) };
        }

        function report() {
            return { id: 1, created_at: now().toISOString(), period_label: 'Sample review',
                start_date: start, end_date: today, score: null, verdict: 'Illustrative',
                report_data: {
                    title: 'Inside the demo portfolio', period_label: 'Sample review', start_date: start, end_date: today,
                    verdict: { score: null, label: 'SAMPLE DATA', summary: 'An example of the portfolio review layout, using only the six demo holdings. No AI review or live market analysis was run.' },
                    portfolio: { pnl: gain, return_pct: gain / cost * 100 },
                    allocation: { top_holding_symbol: 'ETH-USD', top_holding_pct: 2600 / total * 100 },
                    relative: {}, market: { regime: 'Simulated prices', benchmarks: [] },
                    activity: { transaction_count: 6, buy_amount: cost, sell_amount: 0, dividends: 0, fees: 0 },
                    contributors: { positive: holdings.map(h => ({ symbol: h.symbol, pnl: h.unrealized_pnl })).sort((a, b) => b.pnl - a.pnl), negative: [] },
                    observations: [
                        { tone: 'neutral', title: 'Allocation at a glance', body: 'This sample combines broad-market ETFs, technology and semiconductor exposure, and one ETH.' },
                        { tone: 'neutral', title: 'Explore the details', body: 'Open a holding to review its sample transactions, or click a daily mover to explore price averages.' },
                    ],
                    methodology: ['Every price, transaction and return in this demo is synthetic.', 'The sample report illustrates the layout. It is not an investment recommendation.'],
                } };
        }

        function simulate(config) {
            const days = Math.round((Date.parse(config.end_date) - Date.parse(config.start_date)) / 86400000);
            const allocations = config.allocations || [];
            const weight = allocations.reduce((n, a) => n + a.weight, 0);
            if (!(days > 0 && days <= 365 * 30) || !allocations.length || Math.abs(weight - 100) > 0.5) {
                return response({ detail: 'Choose a range of up to 30 years and allocations totaling 100%.' }, 400);
            }
            const capital = Math.max(0, Number(config.initial_capital) || 0);
            const dcaAmount = Math.max(0, Number(config.dca_amount) || 0);
            const frequency = { weekly: 7, biweekly: 14, monthly: 30 }[config.dca_frequency] || 0;
            const rebalanceDays = { monthly: 30, quarterly: 91, annually: 365 }[config.rebalance_frequency] || 0;
            const interval = Math.max(1, Number(config.data_interval_days) || 7);
            let values = allocations.map(a => capital * a.weight / weight);
            let invested = capital, dcaCount = 0, benchmark = capital;
            let peak = capital, maxDrawdown = 0, benchPeak = capital, benchDrawdown = 0;
            const dataPoints = [], benchData = [];
            const changes = [], benchChanges = [];
            for (let i = 0; i <= days; i++) {
                let rebalance = false;
                if (i) {
                    const before = values.reduce((n, v) => n + v, 0);
                    values = values.map((value, index) => {
                        const seed = [...allocations[index].symbol].reduce((n, c) => n + c.charCodeAt(0), 0);
                        return value * (1 + 0.0003 + Math.sin(i * 0.12 + seed) * 0.004);
                    });
                    const after = values.reduce((n, v) => n + v, 0);
                    if (before) changes.push(after / before - 1);
                    const benchChange = 0.00022 + Math.sin(i * 0.12) * 0.0028;
                    benchmark *= 1 + benchChange;
                    benchChanges.push(benchChange);
                    peak = Math.max(peak, after);
                    benchPeak = Math.max(benchPeak, benchmark);
                    if (peak) maxDrawdown = Math.max(maxDrawdown, (peak - after) / peak * 100);
                    if (benchPeak) benchDrawdown = Math.max(benchDrawdown, (benchPeak - benchmark) / benchPeak * 100);
                    if (frequency && i % frequency === 0 && dcaAmount > 0) {
                        invested += dcaAmount; dcaCount++;
                        values = values.map((value, index) => value + dcaAmount * allocations[index].weight / weight);
                        benchmark += dcaAmount;
                        peak += dcaAmount; benchPeak += dcaAmount;
                    }
                    if (rebalanceDays && i % rebalanceDays === 0) {
                        const value = values.reduce((n, v) => n + v, 0);
                        values = allocations.map(a => value * a.weight / weight);
                        rebalance = true;
                    }
                }
                if (i % interval === 0 || i === days || rebalance) {
                    const value = values.reduce((n, v) => n + v, 0);
                    const date = shift(config.start_date, i);
                    dataPoints.push({ date, value: cents(value), invested: cents(invested), rebalanced: rebalance,
                        allocations: Object.fromEntries(allocations.map((a, j) => [a.symbol, value ? values[j] / value * 100 : a.weight])) });
                    benchData.push({ date, value: cents(benchmark) });
                }
            }
            const metrics = (value, returns, drawdown) => {
                const mean = returns.reduce((n, r) => n + r, 0) / (returns.length || 1);
                const variance = returns.reduce((n, r) => n + (r - mean) ** 2, 0) / (returns.length || 1);
                // Solve an annualized money-weighted return for illustrative DCA flows.
                const terminal = rate => capital * (1 + rate) ** (days / 365)
                    + Array.from({ length: dcaCount }, (_, j) => dcaAmount * (1 + rate) ** ((days - (j + 1) * frequency) / 365)).reduce((n, v) => n + v, 0);
                let low = -0.999, high = 100;
                for (let i = 0; i < 80; i++) {
                    const mid = (low + high) / 2;
                    if (terminal(mid) < value) low = mid; else high = mid;
                }
                return { final_value: cents(value), total_invested: cents(invested), total_return: invested ? (value / invested - 1) * 100 : 0,
                    cagr: invested ? (low + high) / 2 * 100 : 0, max_drawdown: drawdown,
                    annualised_volatility: Math.sqrt(variance * 365) * 100,
                    sharpe_ratio: variance ? mean / Math.sqrt(variance) * Math.sqrt(365) : 0 };
            };
            return response({ demo: true, config: { ...config, dca_count: dcaCount }, data_points: dataPoints,
                metrics: metrics(dataPoints.at(-1).value, changes, maxDrawdown),
                benchmark_data: config.benchmark ? benchData : [],
                benchmark_metrics: config.benchmark ? { ...metrics(benchmark, benchChanges, benchDrawdown), symbol: config.benchmark } : null });
        }

        async function fetchDemo(input, options = {}) {
            if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const url = new URL(typeof input === 'string' ? input : input.url, 'https://demo.invalid');
            const method = (options.method || input?.method || 'GET').toUpperCase();
            const path = url.pathname;
            const query = url.searchParams;
            let body = {};
            try { if (options.body) body = JSON.parse(options.body); }
            catch { return response({ detail: 'File imports are unavailable in this sample portfolio.' }, 400); }
            if (method === 'POST' && path === '/api/intraday/refresh') return response(intraday());
            if (method === 'POST' && path === '/api/simulator/run') return simulate(body);
            if (method === 'POST' && path === '/api/targets') {
                if (!ASSETS.some(a => a.symbol === body.symbol) || !Number.isFinite(body.target_pct) || body.target_pct < 0 || body.target_pct > 100) {
                    return response({ detail: 'Choose a demo holding and a target from 0 to 100%.' }, 400);
                }
                targets = { ...targets, [body.symbol]: body.target_pct };
                return response({ ...targets });
            }
            if (method !== 'GET') return response({ detail: 'Demo is read-only. Use Preview in Add Transaction to explore a trade without saving.' }, 405);
            if (path === '/api/summary') return response(summary());
            if (path === '/api/holdings' || path === '/api/positions') return response({ ...stamp(), holdings });
            if (path === '/api/targets') return response({ ...targets });
            if (path === '/api/transactions') return response({ transactions });
            if (path === '/api/covered-calls') return response({ calls: [], inventory: [], summary: { open_contracts: 0, net_cash_flow: 0, realized_option_pnl: 0, unrealized_option_pnl: null } });
            if (path.startsWith('/api/transactions/')) {
                return response({ transactions: transactions.filter(t => t.asset === decodeURIComponent(path.split('/').at(-1))) });
            }
            if (path === '/api/intraday') return response(intraday(query.get('date') || today, query.get('interval') || '1m'));
            if (path === '/api/intraday-multiday') return response({ ...stamp(), data: history.slice(-7).map(p => ({ ...p, datetime: p.date + 'T16:00:00' })) });
            if (path === '/api/performance') return response({ ...stamp(), performance: history.filter(p => (!query.get('start_date') || p.date >= query.get('start_date')) && (!query.get('end_date') || p.date <= query.get('end_date'))),
                annual_asset_pnl_by_year: { [today.slice(0, 4)]: holdings.map(h => ({ symbol: h.symbol, start_value: h.cost_basis, end_value: h.market_value, net_invested: 0, pnl: h.unrealized_pnl })) }, realized_by_year: {}, realized_details_by_year: {} });
            if (path === '/api/daily-pnl') return response({ ...stamp(), daily_pnl: history.slice(1).map((p, i) => {
                const pnl = p.date === today ? sum(holdings, 'daily_change_amount') : cents(p.value - history[i].value);
                return { date: p.date, value: p.value, daily_pnl: pnl, daily_pnl_percent: pnl / history[i].value * 100 };
            }).slice(-Math.min(400, Number(query.get('num_days')) || 30)) });
            if (path === '/api/dividends') return response({ total_dividends: 0, by_asset: [] });
            if (path === '/api/sold') return response({ sold_assets: [], total_pnl: 0, total_proceeds: 0, total_cost_basis: 0 });
            if (path === '/api/files') return response({ files: [] });
            if (path === '/api/investments') return response({ investments: [{ month: start.slice(0, 7), total: cost, by_category: { 'Individual Stocks': 410, Index: 2730, Crypto: 2350 } }] });
            if (path === '/api/analysis/reports') return response({ reports: [report()] });
            if (path === '/api/analysis/reports/1') return response({ report: report() });
            if (path === '/api/ticker-history' || path === '/api/ticker-technicals') {
                const asset = ASSETS.find(a => a.symbol === query.get('symbol')) || ASSETS[0];
                const index = ASSETS.indexOf(asset);
                const prices = history.map((p, i) => ({ date: p.date, close: priceAt(asset, i / 180, index) }));
                if (path === '/api/ticker-history') return response({ symbol: asset.symbol, period: query.get('period') || '6M', start_date: start, end_date: today, granularity: 'daily',
                    available_symbols: ASSETS.map(a => a.symbol), active_symbols: ASSETS.map(a => a.symbol), archived_symbols: [], prices,
                    transactions: transactions.filter(t => t.asset === asset.symbol) });
                return response({ ...stamp(), symbol: asset.symbol, current_price: asset.price, quote_time: now().toISOString(), day_basis: 'sample daily closes', history_as_of: today,
                    averages: [50, 200].map(window => {
                        const value = prices.length >= window ? cents(sum(prices.slice(-window), 'close') / window) : null;
                        return { window, value, observations: Math.min(prices.length, window), difference: value == null ? null : cents(asset.price - value),
                            difference_percent: value == null ? null : (asset.price / value - 1) * 100, position: value == null ? null : asset.price >= value ? 'above' : 'below' };
                    }), series: prices.map((p, i) => ({ ...p, sma50: i >= 49 ? sum(prices.slice(i - 49, i + 1), 'close') / 50 : null, sma200: null })) });
            }
            return response({ detail: 'This endpoint is unavailable in the demo. No personal account request was made.' }, 404);
        }
        return { fetch: fetchDemo };
    }
    const api = { create };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DemoPortfolio = api;
})(globalThis);
