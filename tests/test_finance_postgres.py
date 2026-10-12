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
from app.finance import (ExchangeCreate, ExchangeUpdate, FinanceError, InventoryPaymentCreate,
                         LoanCreate, LoanUpdate, MovementCreate,
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

    def inventory_payment(self, **values):
        return InventoryPaymentCreate(**dict(dict(request_id=uuid4(), date='2026-01-03', amount=40), **values))

    def exchange(self, **values):
        return ExchangeCreate(**dict(dict(request_id=uuid4(), date='2026-01-01',
                                          from_currency='USD', to_currency='CNY',
                                          from_amount=1000, to_amount=7200, fee_amount=5), **values))

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

    def test_exchange_edit_void_idempotency_and_audit_preserve_other_finances(self):
        ledger.create_record('transfers', self.transfer())
        request = self.exchange()
        first = ledger.create_record('exchanges', request)
        self.assertEqual(ledger.create_record('exchanges', request), first)
        self.assertEqual(self.row_count('finance_exchanges'), 1)
        self.assertEqual(first['exchanges'][0]['debited_amount'], 1005)
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('exchanges', self.exchange(request_id=request.request_id, fee_amount=6))
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('transfers', self.transfer(request_id=request.request_id))
        updated = ledger.update_record('exchanges', 1, ExchangeUpdate(date='2026-01-01',
                                       from_currency='USD', to_currency='CNY', from_amount=1000,
                                       to_amount=7100, fee_currency='CNY', fee_amount=10, version=1))
        saved = updated['exchanges'][0]
        self.assertEqual((saved['version'], saved['debited_amount'], saved['received_amount'], saved['effective_rate']), (2, 1000, 7090, 7.09))
        values = {r['currency']: r for r in updated['summary']}
        self.assertEqual((values['USD']['transfer_in'], values['USD']['exchange_fees'], values['USD']['exchange_net']), (100, 0, -1000))
        self.assertEqual((values['CNY']['exchange_in'], values['CNY']['exchange_fees'], values['CNY']['exchange_net']), (7100, 10, 7090))
        with self.assertRaisesRegex(FinanceError, 'changed'):
            ledger.void_record('exchanges', 1, 1)
        final = ledger.void_record('exchanges', 1, 2)
        self.assertTrue(final['exchanges'][0]['voided'])
        self.assertEqual(len(final['summary']), 1)
        self.assertEqual(final['summary'][0]['currency'], 'USD')
        self.assertEqual((final['summary'][0]['transfer_net'], final['summary'][0]['exchange_in'], final['summary'][0]['exchange_out'], final['summary'][0]['exchange_fees'], final['summary'][0]['exchange_net']), (100, 0, 0, 0, 0))
        self.assertEqual(ledger.list_finance(), final)
        self.assertEqual(ledger.create_record('exchanges', request), final)
        self.assertEqual(self.row_count('transactions'), 0)
        with self.pool.connection() as conn:
            rows = conn.execute('SELECT action, before_data, after_data FROM finance_audit WHERE entity_kind = %s ORDER BY id', ('exchanges',)).fetchall()
        self.assertEqual([r[0] for r in rows], ['create', 'update', 'void'])
        self.assertEqual((rows[1][1]['fee_currency'], rows[1][2]['fee_currency']), ('USD', 'CNY'))
        self.assertTrue(rows[2][2]['voided'])

    def test_populated_old_finance_schema_upgrades_without_losing_request_history(self):
        request = self.transfer()
        original = ledger.create_record('transfers', request)
        with self.pool.connection() as conn:
            conn.execute('DROP TABLE finance_exchanges')
            conn.execute('ALTER TABLE finance_requests DROP CONSTRAINT finance_requests_entity_kind_check')
            conn.execute("ALTER TABLE finance_requests ADD CONSTRAINT finance_requests_entity_kind_check CHECK (entity_kind IN ('transfers','loans','products','movements','repayments','payments'))")
        db.init_schema()
        db.init_schema()
        self.assertEqual(ledger.list_finance(), original)
        self.assertEqual(ledger.create_record('transfers', request), original)
        self.assertEqual(self.row_count('finance_requests'), 1)
        self.assertEqual(self.row_count('finance_audit'), 1)
        exchanged = ledger.create_record('exchanges', self.exchange())
        self.assertEqual(len(exchanged['exchanges']), 1)
        self.assertEqual(len(exchanged['transfers']), 1)
        self.assertEqual(self.row_count('finance_requests'), 2)

    def test_competing_exchange_retries_commit_both_legs_and_fee_once(self):
        request = self.exchange(fee_currency='CNY', fee_amount=35)
        barrier = threading.Barrier(2)
        def save():
            barrier.wait()
            return ledger.create_record('exchanges', request)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: save(), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.row_count('finance_exchanges'), 1)
        self.assertEqual(self.row_count('finance_requests'), 1)
        self.assertEqual(self.row_count('finance_audit'), 1)
        values = {r['currency']: r for r in ledger.list_finance()['summary']}
        self.assertEqual((values['USD']['exchange_out'], values['USD']['exchange_net']), (1000, -1000))
        self.assertEqual((values['CNY']['exchange_in'], values['CNY']['exchange_fees'], values['CNY']['exchange_net']), (7200, 35, 7165))

    def test_inventory_fx_payments_rate_edit_and_void_replay_atomically(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.movement(currency='CNY', exchange_rate='.142857142857', unit_price=70, paid_amount=50))
        ledger.create_record('movements', self.movement(date='2026-01-04', kind='sale', quantity=4, currency='CNY', exchange_rate='.125', unit_price=100))
        saved = ledger.create_payment('movements', 1, self.inventory_payment(currency='USD', exchange_rate=7, amount=50))
        self.assertEqual((saved['products'][0]['quantity'], saved['products'][0]['inventory_cost'], saved['products'][0]['realized_profit']), (6, 60, 10))
        self.assertEqual((saved['movements'][1]['paid_amount'], saved['movements'][1]['remaining_payment']), (400, 300))
        updated = ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1,
                         kind='purchase', quantity=10, unit_price=70, paid_amount=50, exchange_rate='.2', version=2))
        self.assertEqual((updated['products'][0]['inventory_cost'], updated['products'][0]['realized_profit']), (84, -6))
        self.assertEqual((updated['movements'][1]['currency'], updated['movements'][1]['paid_amount'], updated['movements'][1]['remaining_payment']), ('CNY', 400, 300))
        with self.assertRaisesRegex(FinanceError, 'Invoice currency'):
            ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=70, paid_amount=50, currency='USD', exchange_rate=1, version=3))
        with self.assertRaisesRegex(FinanceError, 'Payment date'):
            ledger.update_record('movements', 1, MovementUpdate(date='2026-01-04', product_id=1, kind='purchase', quantity=10, unit_price=70, paid_amount=50, version=3))
        self.assertEqual(ledger.list_finance(), updated)
        voided = ledger.void_payment('movements', 1, 1, 1)
        self.assertEqual((voided['movements'][1]['paid_amount'], voided['movements'][1]['remaining_payment']), (50, 650))
        self.assertEqual(voided['products'][0]['realized_profit'], -6)
        with self.assertRaisesRegex(FinanceError, 'Insufficient inventory'):
            ledger.void_record('movements', 1, 4)
        self.assertEqual(ledger.list_finance(), voided)
        ledger.void_record('movements', 2, 1)
        final = ledger.void_record('movements', 1, 4)
        self.assertEqual((final['products'][0]['quantity'], final['products'][0]['inventory_cost'], final['products'][0]['realized_profit']), (0, 0, 0))
        self.assertEqual(self.row_count('transactions'), 0)

    def test_legacy_inventory_request_retries_and_reads_do_not_rewrite_payloads(self):
        ledger.create_record('products', self.product())
        request = self.movement()
        ledger.create_record('movements', request)
        child = self.payment()
        before = ledger.create_payment('movements', 1, child)
        with self.pool.connection() as conn:
            movement_payload = conn.execute('SELECT payload FROM finance_movements WHERE id=1').fetchone()[0]
            child_payload = conn.execute('SELECT payload FROM finance_payments WHERE id=1').fetchone()[0]
            fingerprints = conn.execute('SELECT request_payload FROM finance_requests ORDER BY entity_kind').fetchall()
        self.assertNotIn('currency', movement_payload)
        self.assertNotIn('exchange_rate', child_payload)
        self.assertEqual(ledger.create_record('movements', request.model_copy(update={'currency': None, 'exchange_rate': None})), before)
        retry = InventoryPaymentCreate(**child.model_dump(), currency=None, exchange_rate=None)
        self.assertEqual(ledger.create_payment('movements', 1, retry), before)
        self.assertEqual(ledger.list_finance(), before)
        with self.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT payload FROM finance_movements WHERE id=1').fetchone()[0], movement_payload)
            self.assertEqual(conn.execute('SELECT payload FROM finance_payments WHERE id=1').fetchone()[0], child_payload)
            self.assertEqual(conn.execute('SELECT request_payload FROM finance_requests ORDER BY entity_kind').fetchall(), fingerprints)
        with self.assertRaisesRegex(FinanceError, 'Invoice currency'):
            ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=10, currency='CNY', exchange_rate='.1', version=2))
        self.assertEqual(ledger.list_finance(), before)

    def test_inventory_currency_or_product_base_edit_cannot_reuse_wrong_rate(self):
        ledger.create_record('products', self.product())
        ledger.create_record('products', self.product(name='CNY Tea', sku='CNY', currency='CNY'))
        first = ledger.create_record('movements', self.movement(currency='USD', exchange_rate=1))
        with self.assertRaisesRegex(FinanceError, 'Enter the exchange rate'):
            ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=70, currency='CNY', version=1))
        self.assertEqual(ledger.list_finance(), first)
        ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=70, currency='CNY', exchange_rate='.142857142857', version=1))
        changed = ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=2, kind='purchase', quantity=10, unit_price=70, version=2))
        self.assertEqual((changed['movements'][0]['currency'], changed['movements'][0]['base_currency'], changed['movements'][0]['exchange_rate'], changed['movements'][0]['base_total']), ('CNY', 'CNY', 1, 700))
        ledger.create_record('movements', self.movement())  # Legacy absent currency/rate.
        with self.assertRaisesRegex(FinanceError, 'Enter the exchange rate'):
            ledger.update_record('movements', 2, MovementUpdate(date='2026-01-02', product_id=2, kind='purchase', quantity=10, unit_price=10, version=1))
        corrected = ledger.update_record('movements', 2, MovementUpdate(date='2026-01-02', product_id=2, kind='purchase', quantity=10, unit_price=10, exchange_rate=7, version=1))
        movement = next(m for m in corrected['movements'] if m['id'] == 2)
        self.assertEqual((movement['currency'], movement['base_currency'], movement['exchange_rate'], movement['base_total']), ('USD', 'CNY', 7, 700))

    def test_competing_converted_inventory_payments_cannot_overpay(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.movement(currency='CNY', exchange_rate='.142857142857', unit_price=70))
        barrier = threading.Barrier(2)
        def pay():
            barrier.wait()
            try:
                return ledger.create_payment('movements', 1, self.inventory_payment(currency='USD', exchange_rate=7, amount=60))
            except FinanceError:
                return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: pay(), range(2)))
        self.assertEqual(sum(r is not None for r in results), 1)
        final = ledger.list_finance()['movements'][0]
        self.assertEqual((final['paid_amount'], final['remaining_payment']), (420, 280))
        self.assertEqual(self.row_count('finance_payments'), 1)
        self.assertEqual(self.row_count('finance_requests'), 3)
        self.assertEqual(self.row_count('finance_audit'), 4)


if __name__ == '__main__':
    unittest.main()
