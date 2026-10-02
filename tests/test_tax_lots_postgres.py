"""Opt-in real Postgres tests. Use ONLY a disposable localhost database.

IPORTFOLIO_TEST_DATABASE_URL='postgresql://test@127.0.0.1:55479/postgres' \
    venv/bin/python -m unittest discover -s tests -p test_tax_lots_postgres.py
Each test creates and removes its own schema; production data is never read.
"""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal as D
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
import uuid

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg_pool import ConnectionPool

from app import db, repository
from app.models import Transaction
from app.portfolio import Portfolio


@unittest.skipUnless(os.environ.get('IPORTFOLIO_TEST_DATABASE_URL'), 'Requires disposable localhost Postgres')
class PostgresLotTests(unittest.TestCase):
    def setUp(self):
        self.dsn = os.environ['IPORTFOLIO_TEST_DATABASE_URL']
        if conninfo_to_dict(self.dsn).get('host') not in ('127.0.0.1', 'localhost', '::1'):
            raise RuntimeError('These tests are limited to an explicit localhost database')
        self.schema = 'lot_test_' + uuid.uuid4().hex
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'CREATE SCHEMA {self.schema}')
        self.pool = ConnectionPool(self.dsn, min_size=1, max_size=4,
                                   kwargs={'options': f'-c search_path={self.schema}'})
        self.pool.wait()
        self.pool_patch = patch.object(db, '_pool', self.pool)
        self.pool_patch.start()
        self.split_patch = patch('app.split_service.split_service.get_adjustment_factor', return_value=D(1))
        self.split_patch.start()
        db.init_schema()
        db.init_schema()  # Migration must be idempotent.

    def tearDown(self):
        self.split_patch.stop()
        self.pool_patch.stop()
        self.pool.close()
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA {self.schema} CASCADE')

    def buy(self, qty=10, price=80, date='2026-01-01', broker='test'):
        return repository.insert_transaction(Transaction(date=date, asset='DEMO', action='BUY',
                                             quantity=qty, ave_price=price), broker=broker)

    def sale(self, qty=5, date='2026-09-21', allocations=(), method='HIGH_COST'):
        return Transaction(date=date, asset='DEMO', action='SELL', quantity=qty,
                           ave_price=100, broker='test', cost_basis_method=method,
                           lot_allocations=list(allocations))

    def test_save_reload_and_browser_metadata_preserve_lots(self):
        low = self.buy(price=80)
        high = self.buy(price=120, date='2026-02-01')
        sale = self.sale()
        sale_id = repository.insert_transaction(sale)
        saved = repository.get_all_transactions()
        self.assertEqual(saved[-1].lot_allocations[0].lot_id, high)
        self.assertEqual(saved[-1].broker, 'test')
        p = Portfolio(); p.add_transactions(saved)
        self.assertEqual(p._sales['DEMO'][0]['cost_basis'], 600)
        self.assertEqual([(l.lot_id, l.quantity) for l in p._lots['DEMO']], [(low, 10), (high, 5)])
        meta = repository.get_all_transactions_with_meta()[0]
        self.assertEqual(meta['id'], sale_id)
        self.assertEqual(meta['lot_allocations'], [{'lot_id': high, 'quantity': '5'}])
        self.assertEqual(meta['cost_basis_method'], 'HIGH_COST')

    def test_competing_sales_are_serialized_and_cannot_double_consume(self):
        self.buy()
        barrier = threading.Barrier(2)
        def insert():
            barrier.wait()
            try:
                return repository.insert_transaction(self.sale(qty=8))
            except ValueError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: insert(), range(2)))
        self.assertEqual(sum(value is not None for value in results), 1)
        p = Portfolio(); p.add_transactions(repository.get_all_transactions())
        self.assertEqual(p._lots['DEMO'][0].quantity, 2)
        self.assertEqual(len(repository.get_all_transactions()), 2)

    def test_backdated_sale_rolls_back_when_future_allocation_would_break(self):
        self.buy()
        repository.insert_transaction(self.sale(qty=10))
        with self.assertRaises(ValueError):
            repository.insert_transaction(self.sale(qty=1, date='2026-09-01'))
        self.assertEqual(len(repository.get_all_transactions()), 2)

    def test_deleting_referenced_buy_is_blocked_but_deleting_sale_releases_it(self):
        buy_id = self.buy()
        sale_id = repository.insert_transaction(self.sale())
        with self.assertRaisesRegex(ValueError, 'used by a saved sale'):
            repository.delete_transaction(buy_id)
        self.assertEqual(len(repository.get_all_transactions()), 2)
        self.assertTrue(repository.delete_transaction(sale_id))
        self.assertTrue(repository.delete_transaction(buy_id))
        self.assertEqual(repository.get_all_transactions(), [])

    def test_legacy_import_remains_legacy_and_preserves_prior_records(self):
        self.buy()
        repository.insert_transactions([Transaction(date='2026-03-01', asset='DEMO', action='SELL',
                                                    quantity=2, ave_price=100)], broker='test')
        ledger = repository.get_all_transactions()
        self.assertIsNone(ledger[-1].cost_basis_method)
        self.assertEqual(ledger[-1].lot_allocations, [])
        sale = self.sale()
        repository.insert_transaction(sale)
        self.assertEqual(sale.lot_allocations[0].quantity, 5)

    def test_import_rolls_back_whole_batch_if_it_invalidates_saved_lots(self):
        self.buy()
        repository.insert_transaction(self.sale(qty=10))
        batch = [Transaction(date='2026-08-01', asset='OTHER', action='BUY', quantity=2, ave_price=50),
                 Transaction(date='2026-08-01', asset='DEMO', action='SELL', quantity=2, ave_price=50)]
        with self.assertRaises(ValueError):
            repository.insert_transactions(batch)
        self.assertEqual(len(repository.get_all_transactions()), 2)

    def test_invalid_manual_selection_cannot_create_database_row(self):
        self.buy()
        with self.assertRaises(ValueError):
            repository.insert_transaction(self.sale(method='SPECIFIC', allocations=[{'lot_id': 999, 'quantity': 5}]))
        self.assertEqual(len(repository.get_all_transactions()), 1)
