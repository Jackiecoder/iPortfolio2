from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal as D
import unittest
from unittest.mock import patch
from uuid import uuid4

from pydantic import ValidationError
from app.covered_calls import CallOpen, CallEvent, inventory, replay_coverage, summarize, validate_event
from app.models import Transaction, MARKET_TZ


def buy(quantity=150, broker='Schwab', **kwargs):
    return Transaction(id=1, date='2026-01-02', asset='MRVL', action='BUY',
                       quantity=quantity, ave_price=263, broker=broker, **kwargs)


def call(**kwargs):
    values = dict(request_id=uuid4(), asset='MRVL', broker='Schwab', date='2026-01-05',
                  expiration='2026-02-20', strike=280, contracts=1, premium=13, fees='.65')
    values.update(kwargs)
    return {'id': 1, 'opening': CallOpen(**values).model_dump(mode='json'), 'events': []}


def event(**kwargs):
    values = dict(request_id=uuid4(), date='2026-01-20', transaction_time='15:00', action='CLOSE', contracts=1, premium=5, fees='.65')
    values.update(kwargs)
    return CallEvent(**values)


class CoveredCallRulesTests(unittest.TestCase):
    def setUp(self):
        self.split = patch('app.split_service.split_service.get_adjustment_factor', return_value=D(1))
        self.split.start()
        self.addCleanup(self.split.stop)

    def test_open_reserves_100_without_selling_shares_or_recognizing_profit(self):
        c = call()
        p, reserved = replay_coverage([buy()], [c])
        self.assertEqual(sum(l.quantity for l in p._lots['MRVL']), 150)
        self.assertEqual(reserved[('MRVL', 'schwab')], 100)
        s = summarize(c)
        self.assertEqual(s['net_cash_flow'], 1299.35)
        self.assertEqual(s['realized_option_pnl'], 0)
        self.assertIsNone(s['unrealized_option_pnl'])
        self.assertEqual(p._sales['MRVL'], [])
        self.assertEqual(p.get_cash_balance(), 0)

    def test_150_cannot_cover_two_calls(self):
        with self.assertRaisesRegex(ValueError, 'Insufficient unreserved'):
            replay_coverage([buy()], [call(contracts=2)])

    def test_exactly_100_is_enough(self):
        self.assertEqual(inventory([buy(100)], [call()])[0]['available_contracts'], 0)

    def test_multiple_calls_share_collateral(self):
        second = call(); second['id'] = 2
        with self.assertRaises(ValueError):
            replay_coverage([buy()], [call(), second])

    def test_accounts_do_not_share_collateral(self):
        with self.assertRaises(ValueError):
            replay_coverage([buy(broker='Fidelity')], [call()])
        with self.assertRaises(ValueError):
            replay_coverage([buy(broker='Schwab IRA')], [call()])

    def test_plain_stock_sale_cannot_remove_reserved_shares(self):
        sale = Transaction(id=2, date='2026-01-10', asset='MRVL', action='SELL', quantity=51, ave_price=270)
        with self.assertRaises(ValueError):
            replay_coverage([buy(), sale], [call()])
        sale.quantity = D(50)
        replay_coverage([buy(), sale], [call()])

    def test_backdated_call_checks_later_sale(self):
        sale = Transaction(id=2, date='2026-01-10', asset='MRVL', action='SELL', quantity=100, ave_price=270)
        with self.assertRaises(ValueError):
            replay_coverage([buy(), sale], [call()])

    def test_fix_and_deleted_purchase_cannot_break_coverage(self):
        fix = Transaction(id=2, date='2026-01-10', asset='MRVL', action='FIX', quantity=25)
        with self.assertRaises(ValueError):
            replay_coverage([buy(), fix], [call()])
        with self.assertRaises(ValueError):
            replay_coverage([], [call()])

    def test_expired_date_alone_never_releases_collateral(self):
        s = summarize(call())
        self.assertTrue(s['outcome_pending'])
        self.assertEqual(s['reserved_shares'], 100)

    def test_partial_close_releases_only_closed_contracts_and_allocates_fees(self):
        c = call(contracts=2, fees='1.30')
        e = event()
        validate_event(c, e)
        c['events'].append(e.model_dump(mode='json'))
        s = summarize(c)
        self.assertEqual(s['remaining_contracts'], 1)
        self.assertAlmostEqual(s['realized_option_pnl'], 798.7)
        self.assertAlmostEqual(s['net_cash_flow'], 2098.05)
        self.assertEqual(inventory([buy(250)], [c])[0]['available_shares'], 150)

    def test_expire_requires_date_after_expiration_close(self):
        with self.assertRaises(ValueError):
            validate_event(call(), event(action='EXPIRE', premium=0))
        validate_event(call(), event(action='EXPIRE', premium=0, date='2026-02-20', transaction_time='16:00'))

    def test_events_cannot_overclose_or_precede_opening(self):
        for e in [event(contracts=2), event(date='2026-01-03')]:
            with self.assertRaises(ValueError):
                validate_event(call(), e)

    def test_expiry_realizes_premium_and_releases_stock(self):
        c = call()
        c['events'].append(event(action='EXPIRE', premium=0, fees=0, date='2026-02-20', transaction_time='16:00').model_dump(mode='json'))
        self.assertEqual(summarize(c)['realized_option_pnl'], 1299.35)
        self.assertEqual(inventory([buy()], [c])[0]['available_shares'], 150)

    def test_assignment_releases_before_linked_stock_sale(self):
        c = call()
        e = event(action='ASSIGN', premium=0)
        c['events'].append(e.model_dump(mode='json'))
        sale = Transaction(id=2, date=e.date, executed_at=e.executed_at, asset='MRVL', action='SELL', quantity=100, ave_price=280)
        p, _ = replay_coverage([buy(), sale], [c])
        self.assertEqual(sum(l.quantity for l in p._lots['MRVL']), 50)

    def test_roll_reuses_collateral_and_realizes_old_loss(self):
        old = call()
        replacement = CallOpen(**call(date='2026-01-20', transaction_time='15:00', expiration='2026-03-20', strike=290, premium=22)['opening'])
        e = event(action='ROLL', premium=20, replacement=replacement)
        validate_event(old, e)
        old['events'].append(e.model_dump(mode='json'))
        new = {'id': 2, 'opening': replacement.model_dump(mode='json'), 'events': []}
        rows = inventory([buy()], [old, new])
        self.assertEqual(rows[0]['reserved_shares'], 100)
        self.assertAlmostEqual(summarize(old)['realized_option_pnl'], -701.3)
        self.assertEqual(summarize(new)['realized_option_pnl'], 0)

    def test_roll_account_and_quantity_must_match(self):
        replacement = CallOpen(**call(date='2026-01-20', transaction_time='15:00', broker='Fidelity', strike=290)['opening'])
        with self.assertRaises(ValueError):
            validate_event(call(), event(action='ROLL', replacement=replacement))

    def test_models_reject_invalid_or_future_trades(self):
        for values in [{'contracts': 1.5}, {'contracts': 0}, {'premium': 'NaN'}, {'fees': -1},
                       {'asset': 'BTC-USD'}, {'date': '2099-01-01', 'expiration': '2099-02-01'},
                       {'expiration': '2026-01-01'}]:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                call(**values)
        with self.assertRaises(ValidationError):
            event(action='ASSIGN', premium=3)

    def test_historical_inventory_uses_event_cutoff(self):
        c = call()
        before = inventory([buy()], [c], datetime(2026, 1, 4, tzinfo=MARKET_TZ))[0]
        after = inventory([buy()], [c], datetime(2026, 1, 6, tzinfo=MARKET_TZ))[0]
        self.assertEqual(before['available_shares'], 150)
        self.assertEqual(after['available_shares'], 50)

    def test_adjusted_contract_cannot_use_standard_close_or_assignment_math(self):
        c = call()
        for action in ['CLOSE', 'ASSIGN', 'EXPIRE']:
            with self.subTest(action=action), patch('app.split_service.split_service.get_adjustment_factor', return_value=D(2)):
                e = event(action=action, premium=5 if action == 'CLOSE' else 0,
                          date='2026-02-20', transaction_time='16:00')
                with self.assertRaisesRegex(ValueError, 'corporate action adjusted'):
                    validate_event(c, e)


if __name__ == '__main__':
    unittest.main()
