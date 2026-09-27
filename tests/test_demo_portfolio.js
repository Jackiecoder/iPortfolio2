const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const demo = require('../static/js/demo-portfolio.js');
const now = () => new Date('2026-09-25T16:00:00Z');
const client = () => demo.create({ now });
const json = async (api, url, options) => (await api.fetch(url, options)).json();

test('the public demo contains only the six requested positions, with reconciled totals', async () => {
    const api = client();
    const data = await json(api, '/api/summary');
    assert.deepEqual(Object.fromEntries(data.holdings.map(h => [h.symbol, h.quantity])), {
        TSLA: 1, VOO: 3, QQQM: 3, SOXX: 3, MU: 1, 'ETH-USD': 1,
    });
    assert.equal(data.total_market_value, 6150);
    assert.equal(data.total_cost_basis, 5490);
    assert.equal(data.total_pnl, 660);
    const snapshot = await json(api, '/api/intraday');
    const last = snapshot.intraday.at(-1);
    assert.equal(last.value, data.total_market_value);
    assert.equal(last.daily_pnl, Math.round(data.holdings.reduce((sum, h) => sum + h.daily_change_amount, 0) * 100) / 100);
    for (const point of snapshot.intraday) {
        assert.equal(point.daily_pnl, Math.round(point.asset_changes.reduce((sum, h) => sum + h.pnl, 0) * 100) / 100);
    }
    assert.equal((await json(api, '/api/transactions')).transactions.length, 6);
    assert.equal((await json(api, '/api/performance')).performance.at(-1).value, data.total_market_value);
});

test('demo API blocks imports, transaction writes, unknown paths and never calls native fetch', async () => {
    const original = global.fetch;
    global.fetch = () => { throw new Error('Private network accessed'); };
    try {
        const api = client();
        for (const [url, method] of [['/api/transactions', 'POST'], ['/api/transactions/1', 'DELETE'], ['/api/reload', 'POST'], ['/api/unknown', 'GET'], ['https://example.com/secret', 'GET']]) {
            assert.equal((await api.fetch(url, { method })).ok, false);
        }
        assert.equal((await api.fetch('/api/upload', { method: 'POST', body: new FormData() })).status, 400);
        assert.equal((await json(api, '/api/summary')).total_market_value, 6150);
    } finally { global.fetch = original; }
});

test('demo settings reset across sessions, and aborted requests stay aborted', async () => {
    const api = client();
    await api.fetch('/api/targets', { method: 'POST', body: JSON.stringify({ symbol: 'VOO', target_pct: 25 }) });
    assert.equal((await json(api, '/api/targets')).VOO, 25);
    assert.equal((await json(client(), '/api/targets')).VOO, 30);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.fetch('/api/summary', { signal: controller.signal }), { name: 'AbortError' });
});

test('illustrative simulation honors capital, contributions and date range', async () => {
    const api = client();
    const config = { allocations: [{ symbol: 'VOO', weight: 60 }, { symbol: 'QQQM', weight: 40 }], start_date: '2026-01-01', end_date: '2026-07-01', initial_capital: 1000, dca_frequency: 'monthly', dca_amount: 100, benchmark: 'SPY', data_interval_days: 7 };
    const data = await json(api, '/api/simulator/run', { method: 'POST', body: JSON.stringify(config) });
    assert.equal(data.config.dca_count, 6);
    assert.equal(data.metrics.total_invested, 1600);
    assert.equal(data.data_points[0].date, config.start_date);
    assert.equal(data.data_points.at(-1).date, config.end_date);
    assert.equal(data.metrics.final_value, data.data_points.at(-1).value);
    assert.equal(data.benchmark_metrics.total_invested, 1600);
    assert.ok(Number.isFinite(data.metrics.cagr));
    assert.equal((await json(api, '/api/summary')).total_market_value, 6150);
});

const source = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');
const authSource = source.slice(0, source.indexOf('// Shared chart typography'));
for (const scriptAvailable of [true, false]) {
    test(`demo auth never reads a personal token or falls back to native fetch (script present: ${scriptAvailable})`, async () => {
        const window = { location: { pathname: '/demo' },
            fetch: () => { throw new Error('Native fetch accessed'); },
            get localStorage() { throw new Error('Personal storage accessed'); },
            DemoPortfolio: scriptAvailable ? demo : undefined,
        };
        const context = vm.createContext({ window, document: { body: { dataset: { portfolioMode: 'personal' } } }, console });
        vm.runInContext(authSource, context);
        assert.equal(window.getAccessToken(), '');
        if (scriptAvailable) assert.equal((await (await window.fetch('/api/summary')).json()).total_market_value, 6150);
        else await assert.rejects(window.fetch('/api/summary'), /Demo unavailable/);
    });
}

test('offline /demo navigation cannot fall back to the personal shell', async () => {
    const handlers = {}, matched = [];
    const context = vm.createContext({ URL, self: { location: { origin: 'https://example.com' }, addEventListener: (event, callback) => handlers[event] = callback },
        fetch: async () => { throw new Error('offline'); }, caches: { match: async key => { matched.push(key); return 'demo shell'; } } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/sw.js'), 'utf8'), context);
    let result;
    handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://example.com/demo' }, respondWith: promise => result = promise });
    assert.equal(await result, 'demo shell');
    assert.deepEqual(matched, ['/demo']);
});
