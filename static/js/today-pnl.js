// Today amounts always come from the same completed point as the intraday chart.
// Summary prices and history may finish later and must never replace these amounts.
(function (root) {
    function latest(snapshot, date) {
        if (snapshot?.date !== date) return null;
        const point = snapshot.intraday?.at(-1);
        return point?.holdings_complete && Array.isArray(point.asset_changes) ? point : null;
    }

    // Option estimates are a separate contribution, never a synthetic holding.
    // Missing estimates leave the original holdings amount and return usable.
    function valuation(point) {
        const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
        // An explicitly unavailable holdings subtotal is authoritative. Only
        // older snapshots without the field use the combined legacy amount.
        const holdings = Object.prototype.hasOwnProperty.call(point || {}, 'holdings_daily_pnl')
            ? finite(point.holdings_daily_pnl) : finite(point?.daily_pnl);
        const missingSymbols = [...new Set(Array.isArray(point?.missing_baseline_symbols)
            ? point.missing_baseline_symbols : [])];
        const partial = missingSymbols.length > 0;
        const details = Array.isArray(point?.option_details) ? point.option_details : [];
        const hasOptions = !!point?.options_present || details.length > 0 || point?.options_complete === false;
        const options = hasOptions ? finite(point?.option_daily_pnl) : null;
        const complete = hasOptions && point?.options_complete === true && options !== null;
        const contribution = complete ? options : 0;
        const display = holdings === null ? null : complete
            ? Math.round((holdings + contribution) * 100) / 100 : holdings;
        const baseline = finite(point?.baseline_value);
        // Retain the existing return basis; this is contribution to the same
        // portfolio daily return, not return on option premium or net option NAV.
        const percent = holdings === null ? null : complete
            ? (baseline > 0 && display !== null ? display / baseline * 100 : null)
            : finite(point?.daily_pnl_percent);
        const available = display !== null;
        return { holdings, options, complete, contribution, display, percent, hasOptions, details,
            missingSymbols, partial, available };
    }

    function holdingsView(holdings) {
        const assets = (holdings || []).filter(row => row.symbol !== 'CASH');
        const known = assets.filter(row => row.daily_change_amount != null);
        const missing = assets.filter(row => row.daily_change_amount == null);
        const display = known.length || !assets.length
            ? known.reduce((sum, row) => sum + row.daily_change_amount, 0) : null;
        const marketValue = known.reduce((sum, row) => sum + (row.market_value || 0), 0);
        const basis = display == null ? null : marketValue - display;
        return {
            display,
            percent: basis > 0 ? display / basis * 100 : null,
            partial: missing.length > 0,
            missingSymbols: missing.filter(row => !row.today_pending).map(row => row.symbol),
            available: display !== null,
        };
    }

    function activity(row) {
        const trade = row?.trade_activity;
        if (!trade || !(trade.bought_quantity > 0 || trade.sold_quantity > 0)) return null;
        const pct = trade.change_percent;
        const percent = pct == null ? '' : `${Math.abs(pct).toFixed(1).replace(/\.0$/, '')}%`;
        if (trade.is_closed) return { kind: 'closed', label: 'Closed', trade };
        if (trade.net_quantity < 0) return {
            kind: pct != null && pct <= -50 ? 'reduced' : 'trimmed',
            label: `Reduced${percent ? ` −${percent}` : ''}`, trade,
        };
        if (trade.net_quantity > 0) return {
            kind: pct == null || pct >= 25 ? 'bought' : 'added',
            label: pct == null ? 'Opened' : `Added +${percent}`, trade,
        };
        return { kind: 'traded', label: 'Traded · net 0', trade };
    }

    function displayPrice(row) {
        return row?.trade_activity?.is_closed
            ? (row.trade_activity.last_sell_price ?? null) : (row?.current_price ?? null);
    }

    function project(holdings, snapshot, date) {
        const point = latest(snapshot, date);
        const changes = new Map((point?.asset_changes || []).map(item => [item.symbol, item]));
        const missingSymbols = new Set(point?.missing_baseline_symbols || []);
        const amounts = (symbol, change) => {
            if (!point || missingSymbols.has(symbol)) return { amount: null, percent: null };
            if (change) return { amount: change.pnl ?? null, percent: change.pnl_percent ?? null };
            // Cash is omitted from asset_changes because its daily gain is zero.
            return symbol === 'CASH' ? { amount: 0, percent: 0 } : { amount: null, percent: null };
        };
        const rows = (holdings || []).map(holding => {
            const change = changes.get(holding.symbol);
            const today = amounts(holding.symbol, change);
            changes.delete(holding.symbol);
            return {
                ...holding,
                trade_activity: change?.trade_activity ?? null,
                today_pending: !point,
                daily_change_amount: today.amount,
                daily_change_percent: today.percent,
            };
        });
        // Closed positions are absent from holdings but still earned/lost money
        // today. Give each its own row without adding to current value or cost.
        for (const change of changes.values()) {
            const today = amounts(change.symbol, change);
            rows.push({
                symbol: change.symbol, quantity: change.quantity,
                current_price: change.current_price,
                trade_activity: change.trade_activity ?? null,
                cost_basis: 0, market_value: 0, today_only: true,
                prices_pending: change.quantity > 0,
                daily_change_amount: today.amount, daily_change_percent: today.percent,
            });
        }
        return rows;
    }

    const api = { latest, project, valuation, holdingsView, activity, displayPrice };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TodayPnl = api;
})(globalThis);
