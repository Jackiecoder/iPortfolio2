const assert = require('node:assert/strict');
const {
    completeTrade,
    calculatePositionImpact,
} = require('../static/js/trade-preview.js');

const tradeFromAmountAndPrice = completeTrade(
    { amount: 1000, price: 80, quantity: null },
    'quantity',
);
assert.deepEqual(tradeFromAmountAndPrice, {
    amount: 1000,
    price: 80,
    quantity: 12.5,
});

const tradeFromQuantityAndAmount = completeTrade(
    { amount: 1000, price: null, quantity: 5 },
    'price',
);
assert.deepEqual(tradeFromQuantityAndAmount, {
    amount: 1000,
    price: 200,
    quantity: 5,
});

const tradeFromQuantityAndPrice = completeTrade(
    { amount: null, price: 25, quantity: 8 },
    'amount',
);
assert.deepEqual(tradeFromQuantityAndPrice, {
    amount: 200,
    price: 25,
    quantity: 8,
});

const impact = calculatePositionImpact(
    {
        quantity: 100,
        cost_basis: 6000,
        current_price: 100,
        market_value: 10000,
    },
    tradeFromAmountAndPrice,
);

assert.equal(impact.before.avgCost, 60);
assert.equal(impact.before.marketValue, 10000);
assert.equal(impact.before.unrealizedPnl, 4000);
assert.equal(impact.after.quantity, 112.5);
assert.equal(impact.after.costBasis, 7000);
assert.equal(impact.after.avgCost, 7000 / 112.5);
assert.equal(impact.after.marketValue, 11250);
assert.equal(impact.after.unrealizedPnl, 4250);
assert.equal(impact.change.unrealizedPnl, 250);

const missingQuoteImpact = calculatePositionImpact(
    { quantity: 0, cost_basis: 0, current_price: null },
    tradeFromQuantityAndAmount,
);
assert.equal(missingQuoteImpact.currentPrice, null);
assert.equal(missingQuoteImpact.after.marketValue, null);
assert.equal(missingQuoteImpact.after.unrealizedPnl, null);

console.log('Trade preview calculations passed');
