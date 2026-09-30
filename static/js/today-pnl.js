// Today amounts always come from the same completed point as the intraday chart.
// Summary prices and history may finish later and must never replace these amounts.
(function (root) {
    function latest(snapshot, date) {
        if (snapshot?.date !== date) return null;
        const point = snapshot.intraday?.at(-1);
        return point?.holdings_complete && Array.isArray(point.asset_changes) ? point : null;
    }

    // Keep the existing stock/crypto amounts intact. Unknown option marks are
    // never a zero contribution and are never backfilled from a later quote.
    function valuation(point) {
        const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
        const holdings = finite(point?.holdings_daily_pnl) ?? finite(point?.daily_pnl);
        const details = Array.isArray(point?.option_details) ? point.option_details : [];
        const hasOptions = !!point?.options_present || details.length > 0 || point?.options_complete === false;
        const options = hasOptions ? finite(point?.option_daily_pnl) : 0;
        const complete = !hasOptions || (point?.options_complete === true && options !== null);
        const combined = hasOptions ? (complete ? finite(point?.combined_daily_pnl) : null) : holdings;
        // A combined return needs its own liability-adjusted denominator. Never
        // reuse the stock-only percent for a combined dollar amount.
        const percent = hasOptions ? finite(point?.combined_daily_pnl_percent) : finite(point?.daily_pnl_percent);
        return { holdings, options, combined, complete: complete && combined !== null, hasOptions, details,
            cashFlow: finite(point?.option_cash_flow), display: combined ?? holdings,
            percent: combined !== null ? percent : (!hasOptions ? finite(point?.daily_pnl_percent) : null) };
    }

    function breakdownHtml(point, money, privateMode = false) {
        const v = valuation(point);
        if (!v.hasOptions) return '';
        const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const amount = value => value === null ? 'Unavailable' : privateMode ? '***' : safe(money(value));
        const metric = (label, value) => `<div><span>${label}</span><strong class="${value === null ? 'text-muted' : value >= 0 ? 'text-success' : 'text-danger'}">${amount(value)}</strong></div>`;
        const reasons = [...new Set(v.details.filter(d => d.pnl == null).map(d => d.reason).filter(Boolean))];
        const reasonLabels = {
            adjusted_contract: 'Contract adjustment needs verification.',
            contract_adjustment_unverified: 'Standard contract details have not been verified for this date.',
            assignment_timing_unaligned: 'Assignment timing cannot be matched to this chart point.',
            invalid_contract_quantity: 'Contract quantity needs reconciliation.',
            assignment_stock_sale_unconfirmed: 'Assignment stock sale is not confirmed.',
            expired_outcome_pending: 'Awaiting the broker-confirmed expiration outcome.',
            missing_previous_session_reference: 'No prior-session reference has been collected yet.',
            missing_recent_reference_quote: 'A recent reference quote is unavailable.',
            option_data_unavailable: 'Option records or reference prices are unavailable.'
        };
        if (!reasons.length && Array.isArray(point?.options_reasons)) reasons.push(...point.options_reasons);
        const reasonText = reasons.length ? ' ' + reasons.map(reason => safe(reasonLabels[reason] || 'Reference data is unavailable.')).join(' ') : '';
        const asofs = v.details.map(d => d.asof || d.quote_asof || d.fetched_at).filter(Boolean).sort();
        const quoteTime = asofs.length && Number.isFinite(new Date(asofs[0]).getTime()) ? ` Quote retrieved ${safe(new Date(asofs[0]).toLocaleString('en-US', {timeZone:'America/New_York', month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))} ET.` : '';
        const baselines = v.details.map(d => d.baseline_asof).filter(value => value && Number.isFinite(new Date(value).getTime())).sort();
        const baselineTime = baselines.length ? ` Prior-session reference collected ${safe(new Date(baselines[0]).toLocaleString('en-US', {timeZone:'America/New_York', month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))} ET.` : '';
        return `<div class="pnl-breakdown-grid">${metric('Holdings day P&L', v.holdings)}${metric('Covered Call day P&L · est.', v.options)}${metric('Combined day P&L · est.', v.combined)}</div>` +
            `<p class="pnl-breakdown-note">${v.complete ? 'Uses prior-session reference midpoints or actual same-day fills. Yahoo option quotes are delayed by 15 minutes. Collected midpoints are carried for up to 6 minutes; estimates are not execution prices.' : 'Combined total unavailable: option prices or the prior-session reference are missing.' + reasonText}${quoteTime}${baselineTime}</p>` +
            `<p class="pnl-cashflow">Option net cash flow <strong>${amount(v.cashFlow)}</strong><span>Cash flow, not profit. Through this point in the selected day. Included once in option P&amp;L; account cash is tracked separately.</span></p>`;
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

    const api = { latest, project, valuation, breakdownHtml, activity, displayPrice };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TodayPnl = api;
})(globalThis);
