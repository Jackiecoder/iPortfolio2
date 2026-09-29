const test = require('node:test');
const assert = require('node:assert/strict');
const { cashFlow, escape } = require('../static/js/covered-calls.js');

test('one contract uses 100 shares and subtracts actual fees', () => {
    assert.equal(cashFlow('OPEN', 1, 13, .65), 1299.35);
    assert.equal(cashFlow('CLOSE', 1, 5, .65), -500.65);
});
test('roll reports the net of both fills and both fees, not total new premium', () => {
    assert.ok(Math.abs(cashFlow('ROLL', 1, 20, .65, 22, .65) - 198.7) < 1e-8);
    assert.ok(cashFlow('ROLL', 1, 20, .65, 18, .65) < 0);
});
test('assignment and expiry do not charge a fictitious buyback', () => {
    assert.equal(cashFlow('ASSIGN', 1, 13, .65), -.65);
    assert.equal(cashFlow('EXPIRE', 1, 13, 0), 0);
});
test('notes and account labels cannot insert markup', () => {
    assert.equal(escape('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
});

const { holdingCoverage, coverageBadgeHtml, coverageDetailsHtml } = require('../static/js/covered-calls.js');
const account = (shares, reserved = 0, broker = 'Account A') => ({ asset: 'MRVL', broker, shares, reserved_shares: reserved, available_shares: shares - reserved, available_contracts: Math.floor((shares - reserved) / 100) });
const call = (remaining = 1, extra = {}) => ({ asset: 'MRVL', broker: 'Account A', remaining_contracts: remaining, strike: 280, expiration: '2026-10-30', ...extra });

test('Holdings separates open calls, reserved shares and remaining capacity', () => {
    const c = holdingCoverage({ inventory: [account(150, 100)], calls: [call()] }, 'MRVL', 150);
    assert.equal(c.openContracts, 1);
    assert.equal(c.reservedShares, 100);
    assert.equal(c.availableShares, 50);
    assert.equal(c.availableContracts, 0);
    assert.match(coverageBadgeHtml(c, 'MRVL'), /CC 1 open<span>0 available/);
    assert.equal(holdingCoverage({ inventory: [account(250, 100)], calls: [call()] }, 'MRVL', 250).availableContracts, 1);
});
test('capacity cannot combine odd lots held in separate accounts', () => {
    const c = holdingCoverage({ inventory: [account(60), account(60, 0, 'Account B')], calls: [] }, 'MRVL', 120);
    assert.equal(c.availableShares, 120);
    assert.equal(c.availableContracts, 0);
    assert.match(coverageDetailsHtml(c), /Account B/);
});
test('partial close, confirmed expiry, roll and assignment use refreshed inventory', () => {
    assert.equal(holdingCoverage({ inventory: [account(250, 100)], calls: [call()] }, 'MRVL', 250).availableContracts, 1);
    assert.equal(holdingCoverage({ inventory: [account(250)], calls: [call(0)] }, 'MRVL', 250).availableContracts, 2);
    const rolled = holdingCoverage({ inventory: [account(250, 100)], calls: [call(0), call(1, { expiration: '2026-11-20' })] }, 'MRVL', 250);
    assert.equal(rolled.openContracts, 1);
    assert.equal(rolled.availableContracts, 1);
    const assigned = holdingCoverage({ inventory: [account(150)], calls: [call(0)] }, 'MRVL', 150);
    assert.equal(assigned.openContracts, 0);
    assert.equal(assigned.availableContracts, 1);
});
test('unconfirmed expiration stays reserved and adjusted deliverables suppress capacity', () => {
    const c = holdingCoverage({ inventory: [account(150, 100)], calls: [call(1, { outcome_pending: true })] }, 'MRVL', 150);
    assert.equal(c.availableContracts, 0);
    assert.match(coverageDetailsHtml(c), /Awaiting broker outcome/);
    const adjusted = holdingCoverage({ inventory: [account(300, 200)], calls: [call(1, { adjustment_required: true })] }, 'MRVL', 300);
    assert.equal(adjusted.state, 'verify');
    assert.equal(adjusted.availableContracts, undefined);
});
test('failed, loading, mismatched or missing inventory never advertises capacity', () => {
    const data = { inventory: [account(150)], calls: [] };
    for (const state of ['error', 'loading', 'updating']) {
        const c = holdingCoverage(data, 'MRVL', 150, state);
        assert.equal(c.state, state);
        assert.equal(c.availableContracts, undefined);
        assert.doesNotMatch(coverageBadgeHtml(c, 'MRVL'), /CC 1 available/);
    }
    assert.equal(holdingCoverage(data, 'MRVL', 250).state, 'updating');
    assert.equal(holdingCoverage({ inventory: [], calls: [] }, 'MRVL', 150).state, 'updating');
    assert.equal(holdingCoverage({ inventory: [account(NaN)], calls: [] }, 'MRVL', 150).state, 'updating');
    for (const symbol of ['CASH', 'BTC-USD', 'ETH-USD']) assert.equal(holdingCoverage(data, symbol, 150), null);
    assert.equal(holdingCoverage(data, 'MRVL', 0), null);
});
test('coverage masks all quantities, account names and strike in anonymous mode', () => {
    const c = holdingCoverage({ inventory: [account(150, 100, '<img src=x> Private')], calls: [call(1, { broker: '<img src=x> Private' })] }, 'MRVL', 150);
    const badge = coverageBadgeHtml(c, 'MRVL', true);
    assert.match(badge, /CC \*\*\*/);
    assert.doesNotMatch(badge, /100|150|1 open/);
    const details = coverageDetailsHtml(c, true);
    assert.doesNotMatch(details, /Private|100|150|280/);
    assert.doesNotMatch(coverageDetailsHtml(c), /<img/);
    assert.match(coverageDetailsHtml(c), /&lt;img/);
});
