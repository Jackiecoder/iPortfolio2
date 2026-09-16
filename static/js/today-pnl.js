// Today amounts always come from the same completed point as the intraday chart.
// Summary prices and history may finish later and must never replace these amounts.
(function (root) {
    function latest(snapshot, date) {
        if (snapshot?.date !== date) return null;
        const point = snapshot.intraday?.at(-1);
        return point?.holdings_complete && Array.isArray(point.asset_changes) ? point : null;
    }

    function project(holdings, snapshot, date) {
        const point = latest(snapshot, date);
        const changes = new Map((point?.asset_changes || []).map(item => [item.symbol, item]));
        const rows = (holdings || []).map(holding => {
            const change = changes.get(holding.symbol);
            changes.delete(holding.symbol);
            return {
                ...holding,
                today_pending: !point,
                daily_change_amount: point ? (change?.pnl ?? 0) : null,
                daily_change_percent: point ? (change?.pnl_percent ?? 0) : null,
            };
        });
        // Closed positions are absent from holdings but still earned/lost money
        // today. Give each its own row without adding to current value or cost.
        for (const change of changes.values()) {
            rows.push({
                symbol: change.symbol, quantity: change.quantity,
                cost_basis: 0, market_value: 0, today_only: true,
                prices_pending: change.quantity > 0,
                daily_change_amount: change.pnl, daily_change_percent: change.pnl_percent,
            });
        }
        return rows;
    }

    const api = { latest, project };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TodayPnl = api;
})(globalThis);
