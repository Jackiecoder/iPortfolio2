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
