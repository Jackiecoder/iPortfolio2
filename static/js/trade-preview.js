(function exposeTradePreview(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.TradePreview = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function createTradePreview() {
    const FIELD_NAMES = ['quantity', 'price', 'amount'];

    function positiveNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : null;
    }

    function completeTrade(values, derivedField) {
        if (!FIELD_NAMES.includes(derivedField)) return null;

        const trade = {
            quantity: positiveNumber(values.quantity),
            price: positiveNumber(values.price),
            amount: positiveNumber(values.amount),
        };

        if (derivedField === 'amount' && trade.quantity && trade.price) {
            trade.amount = trade.quantity * trade.price;
        } else if (derivedField === 'quantity' && trade.amount && trade.price) {
            trade.quantity = trade.amount / trade.price;
        } else if (derivedField === 'price' && trade.amount && trade.quantity) {
            trade.price = trade.amount / trade.quantity;
        } else {
            return null;
        }

        return trade;
    }

    function positionMetrics(quantity, costBasis, currentPrice) {
        const avgCost = quantity > 0 ? costBasis / quantity : 0;
        const marketValue = currentPrice == null ? null : quantity * currentPrice;
        const unrealizedPnl = marketValue == null ? null : marketValue - costBasis;
        let pnlPercent = null;
        if (unrealizedPnl != null) {
            pnlPercent = costBasis > 0
                ? (unrealizedPnl / costBasis) * 100
                : (marketValue > 0 ? 100 : 0);
        }
        return { quantity, costBasis, avgCost, marketValue, unrealizedPnl, pnlPercent };
    }

    function calculatePositionImpact(holding, trade) {
        const quantity = Math.max(0, Number(holding && holding.quantity) || 0);
        const costBasis = Math.max(0, Number(holding && holding.cost_basis) || 0);
        let currentPrice = positiveNumber(holding && holding.current_price);
        const storedMarketValue = positiveNumber(holding && holding.market_value);
        if (currentPrice == null && quantity > 0 && storedMarketValue != null) {
            currentPrice = storedMarketValue / quantity;
        }

        const before = positionMetrics(quantity, costBasis, currentPrice);
        const after = positionMetrics(
            quantity + trade.quantity,
            costBasis + trade.amount,
            currentPrice,
        );

        return {
            currentPrice,
            before,
            trade,
            after,
            change: {
                quantity: after.quantity - before.quantity,
                costBasis: after.costBasis - before.costBasis,
                avgCost: after.avgCost - before.avgCost,
                marketValue: after.marketValue == null ? null : after.marketValue - before.marketValue,
                unrealizedPnl: after.unrealizedPnl == null ? null : after.unrealizedPnl - before.unrealizedPnl,
                pnlPercent: after.pnlPercent == null ? null : after.pnlPercent - before.pnlPercent,
            },
        };
    }

    return { FIELD_NAMES, completeTrade, calculatePositionImpact };
});
