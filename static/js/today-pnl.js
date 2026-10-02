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
        const holdings = finite(point?.holdings_daily_pnl) ?? finite(point?.daily_pnl);
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
        const percent = complete
            ? (baseline > 0 && display !== null ? display / baseline * 100 : null)
            : finite(point?.daily_pnl_percent);
        return { holdings, options, complete, contribution, display, percent, hasOptions, details };
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
        const rows = (holdings || []).map(holding => {
            const change = changes.get(holding.symbol);
            changes.delete(holding.symbol);
            return {
                ...holding,
                trade_activity: change?.trade_activity ?? null,
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
                current_price: change.current_price,
                trade_activity: change.trade_activity ?? null,
                cost_basis: 0, market_value: 0, today_only: true,
                prices_pending: change.quantity > 0,
                daily_change_amount: change.pnl, daily_change_percent: change.pnl_percent,
            });
        }
        return rows;
    }

    const api = { latest, project, valuation, activity, displayPrice };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TodayPnl = api;
})(globalThis);
