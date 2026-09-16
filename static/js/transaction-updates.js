// A saved receipt can update today's share count before the ledger is replayed.
// Historical quantities and FIFO costs stay pending until the server confirms them.
(function (root) {
    function project(holdings, transaction, today, ledgerKnown = true) {
        const rows = (holdings || []).filter(h => !h.today_only).map(h => ({ ...h, prices_pending: true }));
        if (!transaction) return rows.map(h => ({ ...h, ledger_pending: true, quantity_pending: true }));
        const { asset, action, date } = transaction;
        const changesQuantity = ['BUY', 'SELL', 'GIFT', 'GAS', 'FIX', 'CASH'].includes(action);
        if (!changesQuantity) return rows;
        let holding = rows.find(h => h.symbol === asset);
        if (!holding) {
            holding = { symbol: asset, quantity: ledgerKnown ? 0 : null, cost_basis: null, avg_cost: null, prices_pending: true };
            rows.push(holding);
        }
        const known = ledgerKnown && !holding.quantity_pending && holding.quantity != null && date === today;
        const quantity = Number(transaction.quantity);
        holding.ledger_pending = true;
        holding.quantity_pending = !known;
        holding.long_term_quantity = holding.short_term_quantity = null;
        if (known) {
            if (action === 'BUY' || action === 'GIFT') holding.quantity += quantity;
            else if (action === 'SELL' || action === 'GAS') holding.quantity = Math.max(0, holding.quantity - quantity);
            else if (action === 'FIX') holding.quantity = quantity;
            else if (action === 'CASH') holding.quantity = 1;
        }
        return rows;
    }

    const api = { project };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TransactionUpdates = api;
})(globalThis);
