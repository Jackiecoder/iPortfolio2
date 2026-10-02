"""Opt-in real PostgreSQL tests using a fresh schema per test, never production."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal as D
import os
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg_pool import ConnectionPool

from app import db, repository
from app import covered_call_repository as calls
from app.covered_calls import CallOpen, CallEvent
from app.models import Transaction
from app.portfolio import Portfolio


@unittest.skipUnless(os.environ.get('IPORTFOLIO_TEST_DATABASE_URL'), 'Requires disposable localhost Postgres')
class CoveredCallPostgresTests(unittest.TestCase):
    def setUp(self):
        self.dsn = os.environ['IPORTFOLIO_TEST_DATABASE_URL']
        if conninfo_to_dict(self.dsn).get('host') not in ('127.0.0.1', 'localhost', '::1'):
            raise RuntimeError('Only explicit localhost test databases are allowed')
        self.schema = 'cc_test_' + uuid4().hex
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'CREATE SCHEMA {self.schema}')
        self.pool = ConnectionPool(self.dsn, min_size=1, max_size=4,
                                   kwargs={'options': f'-c search_path={self.schema}'})
        self.pool.wait()
        self.pool_patch = patch.object(db, '_pool', self.pool); self.pool_patch.start()
        self.split_patch = patch('app.split_service.split_service.get_adjustment_factor', return_value=D(1)); self.split_patch.start()
        db.init_schema(); db.init_schema()
        self.buy_id = repository.insert_transaction(Transaction(date='2026-01-02', asset='MRVL', action='BUY', quantity=150, ave_price=263, broker='Schwab'))

    def tearDown(self):
        self.split_patch.stop(); self.pool_patch.stop(); self.pool.close()
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA {self.schema} CASCADE')

    def opening(self, **kwargs):
        values = dict(request_id=uuid4(), asset='MRVL', broker='Schwab', date='2026-01-05', expiration='2026-02-20', strike=280, contracts=1, premium=13, fees='.65')
        values.update(kwargs)
        return CallOpen(**values)

    def event(self, **kwargs):
        values = dict(request_id=uuid4(), action='CLOSE', date='2026-01-20', transaction_time='15:00', contracts=1, premium=5, fees='.65')
        values.update(kwargs)
        return CallEvent(**values)

    def shares(self):
        p = Portfolio(); p.add_transactions(repository.get_all_transactions())
        return sum(l.quantity for l in p._lots['MRVL'])

    def test_open_survives_reload_and_idempotent_retry(self):
        request = self.opening()
        saved = calls.create_call(request)
        self.assertEqual(calls.create_call(request)['id'], saved['id'])
        data = calls.list_calls()
        self.assertEqual(len(data['calls']), 1)
        self.assertEqual(data['summary']['net_cash_flow'], 1299.35)
        self.assertEqual(data['summary']['realized_option_pnl'], 0)
        self.assertEqual(data['inventory'][0]['available_shares'], 50)
        self.assertEqual(self.shares(), 150)
        changed = request.model_copy(update={'premium': D(14)})
        with self.assertRaisesRegex(ValueError, 'already saved'):
            calls.create_call(changed)

    def test_competing_opens_cannot_double_reserve(self):
        barrier = threading.Barrier(2)
        def create():
            barrier.wait()
            try: return calls.create_call(self.opening())
            except ValueError: return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: create(), range(2)))
        self.assertEqual(sum(r is not None for r in results), 1)
        self.assertEqual(len(calls.list_calls()['calls']), 1)

    def test_stock_sale_delete_and_import_cannot_break_coverage(self):
        calls.create_call(self.opening())
        with self.assertRaises(ValueError):
            repository.insert_transaction(Transaction(date='2026-01-10', asset='MRVL', action='SELL', quantity=51, ave_price=280, broker='Schwab'))
        with self.assertRaises(ValueError): repository.delete_transaction(self.buy_id)
        with self.assertRaises(ValueError):
            repository.insert_transactions([Transaction(date='2026-01-10', asset='MRVL', action='FIX', quantity=50)])
        self.assertEqual(self.shares(), 150)
        self.assertEqual(len(repository.get_all_transactions()), 1)

    def test_assignment_creates_one_frozen_sale_and_protects_link(self):
        saved = calls.create_call(self.opening())
        request = self.event(action='ASSIGN', premium=0, cost_basis_method='SPECIFIC', lot_allocations=[{'lot_id': self.buy_id, 'quantity': 100}])
        first = calls.record_event(saved['id'], request)
        second = calls.record_event(saved['id'], request)
        self.assertEqual(len(second['events']), 1)
        self.assertEqual(self.shares(), 50)
        txns = repository.get_all_transactions()
        self.assertEqual(len(txns), 2)
        self.assertEqual(txns[-1].ave_price, 280)
        self.assertEqual(txns[-1].lot_allocations[0].lot_id, self.buy_id)
        with self.assertRaisesRegex(ValueError, 'linked'):
            repository.delete_transaction(first['events'][0]['stock_transaction_id'])

    def test_failed_assignment_rolls_back_both_ledgers(self):
        saved = calls.create_call(self.opening())
        with self.assertRaises(ValueError):
            calls.record_event(saved['id'], self.event(action='ASSIGN', premium=0, cost_basis_method='SPECIFIC', lot_allocations=[{'lot_id': 99999, 'quantity': 100}]))
        self.assertEqual(len(repository.get_all_transactions()), 1)
        self.assertEqual(calls.list_calls()['calls'][0]['remaining_contracts'], 1)

    def test_roll_is_atomic_idempotent_and_keeps_old_loss(self):
        saved = calls.create_call(self.opening())
        replacement = self.opening(date='2026-01-20', transaction_time='15:00', expiration='2026-03-20', strike=290, premium=22)
        request = self.event(action='ROLL', premium=20, replacement=replacement)
        result = calls.record_event(saved['id'], request)
        calls.record_event(saved['id'], request)
        data = calls.list_calls()
        self.assertEqual(len(data['calls']), 2)
        self.assertEqual(data['summary']['open_contracts'], 1)
        self.assertEqual(data['inventory'][0]['available_shares'], 50)
        self.assertAlmostEqual(result['realized_option_pnl'], -701.3)
        self.assertAlmostEqual(data['summary']['net_cash_flow'], 1498.05)

    def test_bad_roll_does_not_close_original(self):
        saved = calls.create_call(self.opening())
        replacement = self.opening(date='2026-01-20', transaction_time='15:00', broker='Fidelity', strike=290)
        with self.assertRaises(ValueError):
            calls.record_event(saved['id'], self.event(action='ROLL', replacement=replacement))
        data = calls.list_calls()
        self.assertEqual(len(data['calls']), 1)
        self.assertEqual(data['calls'][0]['remaining_contracts'], 1)

    def test_expire_then_new_call_and_delete_correction(self):
        saved = calls.create_call(self.opening())
        calls.record_event(saved['id'], self.event(action='EXPIRE', premium=0, fees=0, date='2026-02-20', transaction_time='16:00'))
        new = calls.create_call(self.opening(date='2026-02-23', expiration='2026-03-20'))
        self.assertEqual(calls.list_calls()['summary']['open_contracts'], 1)
        self.assertTrue(calls.delete_call(new['id']))
        with self.assertRaises(ValueError): calls.delete_call(saved['id'])
        self.assertEqual(calls.list_calls()['summary']['open_contracts'], 0)

    def test_unassigned_account_assignment_does_not_choose_another_account(self):
        repository.insert_transaction(Transaction(date='2026-01-02', asset='MRVL', action='BUY', quantity=100, ave_price=200))
        saved = calls.create_call(self.opening(broker=None))
        calls.record_event(saved['id'], self.event(action='ASSIGN', premium=0))
        sale = repository.get_all_transactions()[-1]
        self.assertIsNone(sale.broker)
        self.assertEqual(self.shares(), 150)


if __name__ == '__main__': unittest.main()
