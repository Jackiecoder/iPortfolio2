"""Opt-in, disposable localhost PostgreSQL persistence/concurrency regressions."""
from concurrent.futures import ThreadPoolExecutor
import os
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg_pool import ConnectionPool

from app import db
from app import finance_repository as ledger
from app.finance import (FinanceError, LoanCreate, LoanUpdate, MovementCreate,
                         MovementUpdate, PaymentCreate, ProductCreate, ProductUpdate,
                         TransferCreate, TransferUpdate)


@unittest.skipUnless(os.environ.get('IPORTFOLIO_TEST_DATABASE_URL'), 'Requires disposable localhost Postgres')
class FinancePostgresTests(unittest.TestCase):
    def setUp(self):
        self.dsn = os.environ['IPORTFOLIO_TEST_DATABASE_URL']
        if conninfo_to_dict(self.dsn).get('host') not in ('127.0.0.1', 'localhost', '::1'):
            raise RuntimeError('Only explicit localhost test databases are allowed')
        self.schema = 'finance_test_' + uuid4().hex
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'CREATE SCHEMA {self.schema}')
        self.pool = ConnectionPool(self.dsn, min_size=1, max_size=4,
                                   kwargs={'options': f'-c search_path={self.schema}'})
        self.pool.wait()
        self.pool_patch = patch.object(db, '_pool', self.pool)
        self.pool_patch.start()
        db.init_schema()
        db.init_schema()

    def tearDown(self):
        self.pool_patch.stop()
        self.pool.close()
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA {self.schema} CASCADE')

    def transfer(self, **values):
        return TransferCreate(**dict(dict(request_id=uuid4(), date='2026-01-01', direction='in', amount=100), **values))

    def loan(self, **values):
        return LoanCreate(**dict(dict(request_id=uuid4(), date='2026-01-01', direction='lent', counterparty='K', principal=100), **values))

    def product(self, **values):
        return ProductCreate(**dict(dict(request_id=uuid4(), name='Tea', sku='TEA'), **values))

    def movement(self, **values):
        return MovementCreate(**dict(dict(request_id=uuid4(), date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=10), **values))

    def payment(self, **values):
        return PaymentCreate(**dict(dict(request_id=uuid4(), date='2026-01-03', amount=40), **values))

    def row_count(self, table):
        with self.pool.connection() as conn:
            return conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0]

    def test_persistence_versions_void_idempotency_and_audit(self):
        request = self.transfer()
        first = ledger.create_record('transfers', request)
        self.assertEqual(ledger.create_record('transfers', request), first)
        self.assertEqual(self.row_count('finance_audit'), 1)
        self.assertEqual(self.row_count('finance_requests'), 1)
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('transfers', self.transfer(request_id=request.request_id, amount=101))
        updated = ledger.update_record('transfers', 1, TransferUpdate(date='2026-01-01', direction='out', amount=30, version=1))
        self.assertEqual(updated['transfers'][0]['version'], 2)
        self.assertEqual(updated['summary'][0]['transfer_net'], -30)
        with self.pool.connection() as conn:
            before, after = conn.execute('SELECT before_data, after_data FROM finance_audit WHERE action = %s', ('update',)).fetchone()
        self.assertEqual((before['direction'], before['amount'], before['version']), ('in', '100', 1))
        self.assertEqual((after['direction'], after['amount'], after['version']), ('out', '30', 2))
        with self.assertRaisesRegex(FinanceError, 'changed'):
            ledger.void_record('transfers', 1, 1)
        final = ledger.void_record('transfers', 1, 2)
        self.assertTrue(final['transfers'][0]['voided'])
        self.assertEqual(final['summary'], [])
        self.assertEqual(ledger.list_finance(), final)
        self.assertEqual(self.row_count('finance_audit'), 3)
        self.assertEqual(self.row_count('transactions'), 0)
        # Retrying the original create after edits is successful and never recreates it.
        self.assertEqual(ledger.create_record('transfers', request), final)

    def test_global_request_key_rejects_reuse_for_different_entity(self):
        transfer = self.transfer()
        ledger.create_record('transfers', transfer)
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('loans', self.loan(request_id=transfer.request_id))
        self.assertEqual(self.row_count('finance_loans'), 0)

    def test_partial_repayments_retry_overpay_rollback_and_void(self):
        ledger.create_record('loans', self.loan())
        request = self.payment()
        first = ledger.create_payment('loans', 1, request)
        self.assertEqual(first['loans'][0]['outstanding'], 60)
        self.assertEqual(first['loans'][0]['version'], 2)
        self.assertEqual(ledger.create_payment('loans', 1, request), first)
        audit_count = self.row_count('finance_audit')
        with self.assertRaisesRegex(FinanceError, 'principal'):
            ledger.create_payment('loans', 1, self.payment(amount=61))
        self.assertEqual(ledger.list_finance(), first)
        self.assertEqual(self.row_count('finance_audit'), audit_count)
        with self.assertRaisesRegex(FinanceError, 'repayments'):
            ledger.void_record('loans', 1, 2)
        with self.assertRaisesRegex(FinanceError, 'principal'):
            ledger.update_record('loans', 1, LoanUpdate(date='2026-01-01', direction='lent', counterparty='K', principal=30, version=2))
        final = ledger.void_payment('loans', 1, 1, 1)
        self.assertEqual(final['loans'][0]['outstanding'], 100)
        self.assertTrue(final['loans'][0]['repayments'][0]['voided'])
        self.assertEqual(final['loans'][0]['version'], 3)
        final = ledger.void_record('loans', 1, 3)
        self.assertEqual(final['loans'][0]['status'], 'void')
        self.assertEqual(final['loans'][0]['outstanding'], 0)

    def test_stock_replay_edit_and_void_rollback(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.movement())
        sale = self.movement(date='2026-01-03', kind='sale', quantity=6, unit_price=20)
        first = ledger.create_record('movements', sale)
        self.assertEqual(first['products'][0]['quantity'], 4)
        self.assertEqual(first['products'][0]['realized_profit'], 60)
        with self.assertRaisesRegex(FinanceError, 'Insufficient inventory'):
            ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1, kind='purchase', quantity=5, unit_price=10, version=1))
        with self.assertRaisesRegex(FinanceError, 'Insufficient inventory'):
            ledger.void_record('movements', 1, 1)
        with self.assertRaisesRegex(FinanceError, 'Insufficient inventory'):
            ledger.create_record('movements', self.movement(date='2026-01-01', kind='sale', quantity=1))
        self.assertEqual(ledger.list_finance(), first)
        self.assertEqual(self.row_count('finance_movements'), 2)
        self.assertEqual(self.row_count('finance_audit'), 3)
        self.assertEqual(self.row_count('transactions'), 0)

    def test_purchase_payments_and_product_history_protection(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.movement(paid_amount=20))
        first = ledger.create_payment('movements', 1, self.payment(amount=30))
        movement = first['movements'][0]
        self.assertEqual((movement['paid_amount'], movement['remaining_payment'], movement['version']), (50, 50, 2))
        with self.assertRaisesRegex(FinanceError, 'total'):
            ledger.create_payment('movements', 1, self.payment(amount=51))
        with self.assertRaisesRegex(FinanceError, 'total'):
            ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1, kind='purchase', quantity=1, unit_price=30, paid_amount=20, version=2))
        with self.assertRaisesRegex(FinanceError, 'Currency'):
            ledger.update_record('products', 1, ProductUpdate(name='Tea', currency='CNY', version=1))
        with self.assertRaisesRegex(FinanceError, 'history'):
            ledger.void_record('products', 1, 1)
        with self.assertRaisesRegex(FinanceError, 'SKU'):
            ledger.create_record('products', self.product(name='Other Tea', sku='tea'))
        self.assertEqual(ledger.list_finance(), first)

    def test_competing_sales_cannot_oversell(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.movement())
        barrier = threading.Barrier(2)
        def sell():
            barrier.wait()
            try:
                return ledger.create_record('movements', self.movement(date='2026-01-03', kind='sale', quantity=7))
            except FinanceError:
                return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: sell(), range(2)))
        self.assertEqual(sum(r is not None for r in results), 1)
        self.assertEqual(ledger.list_finance()['products'][0]['quantity'], 3)

    def test_competing_duplicate_requests_commit_once(self):
        request = self.transfer()
        barrier = threading.Barrier(2)
        def save():
            barrier.wait()
            return ledger.create_record('transfers', request)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: save(), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.row_count('finance_transfers'), 1)
        self.assertEqual(self.row_count('finance_requests'), 1)
        self.assertEqual(self.row_count('finance_audit'), 1)


if __name__ == '__main__':
    unittest.main()
