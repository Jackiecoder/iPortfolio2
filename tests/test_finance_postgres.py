"""Opt-in, disposable localhost PostgreSQL persistence/concurrency regressions."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import os
from pathlib import Path
import subprocess
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
from app.finance import ProjectCreate, ProjectUpdate


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

    def product_transaction(self, **values):
        return MovementCreate(**dict(dict(request_id=uuid4(), date='2026-01-02', product_id=1,
                                          kind='purchase', quantity=3, total_amount=100), **values))

    def product_expense(self, **values):
        return MovementCreate(**dict(dict(request_id=uuid4(), date='2026-01-01', product_id=1,
                                          kind='expense', category='物流', total_amount=20), **values))

    def payment(self, **values):
        return PaymentCreate(**dict(dict(request_id=uuid4(), date='2026-01-03', amount=40), **values))

    def inventory_payment(self, **values):
        return InventoryPaymentCreate(**dict(dict(request_id=uuid4(), date='2026-01-03', amount=40), **values))

    def exchange(self, **values):
        return ExchangeCreate(**dict(dict(request_id=uuid4(), date='2026-01-01',
                                          from_currency='USD', to_currency='CNY',
                                          from_amount=1000, to_amount=7200, fee_amount=5), **values))

    def project(self, **values):
        defaults = dict(request_id=uuid4(), date='2026-01-01', name='Tea partnership', expected_profit=250,
                        participants=[dict(name='Kevin', contribution_amount=600, dividend_percent=60),
                                      dict(name='Partner', contribution_amount=2800, currency='CNY', exchange_rate='.142857142857', dividend_percent=40)])
        defaults.update(values)
        return ProjectCreate(**defaults)

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

    def test_money_actors_persist_independent_payment_history_and_guard_request_reuse(self):
        transfer = self.transfer(payer='  Transfer sender  ', recipient='Transfer receiver')
        ledger.create_record('transfers', transfer)
        ledger.create_record('loans', self.loan(payer='Principal sender', recipient='Principal receiver'))
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.movement(paid_amount=20, payer='Initial buyer', recipient='Initial seller'))
        ledger.create_record('exchanges', self.exchange(payer='Exchange sender', recipient='Exchange receiver'))
        repayment = self.payment(payer='Repayment sender', recipient='Repayment receiver')
        ledger.create_payment('loans', 1, repayment)
        payment = self.inventory_payment(amount=30, payer='  Later buyer ', recipient='Later seller')
        saved = ledger.create_payment('movements', 1, payment)
        self.assertEqual(ledger.list_finance(), saved)
        expected = {'transfers': ('Transfer sender', 'Transfer receiver'),
                    'loans': ('Principal sender', 'Principal receiver'),
                    'movements': ('Initial buyer', 'Initial seller'),
                    'exchanges': ('Exchange sender', 'Exchange receiver')}
        for kind, names in expected.items():
            self.assertEqual((saved[kind][0]['payer'], saved[kind][0]['recipient']), names)
            with self.pool.connection() as conn:
                payload = conn.execute(f'SELECT payload FROM finance_{kind} WHERE id=1').fetchone()[0]
                self.assertEqual((payload['payer'], payload['recipient']), names)
        self.assertEqual((saved['loans'][0]['outstanding'], saved['loans'][0]['version']), (60, 2))
        self.assertEqual((saved['movements'][0]['paid_amount'], saved['movements'][0]['version']), (50, 2))
        history = saved['movements'][0]['payments'][0]
        self.assertEqual((history['payer'], history['recipient']), ('Later buyer', 'Later seller'))
        self.assertEqual((saved['loans'][0]['repayments'][0]['payer'], saved['loans'][0]['repayments'][0]['recipient']),
                         ('Repayment sender', 'Repayment receiver'))
        self.assertEqual(ledger.create_payment('movements', 1, self.inventory_payment(request_id=payment.request_id,
                         amount='30.000000', payer='Later buyer', recipient=' Later seller ')), saved)
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('transfers', self.transfer(request_id=transfer.request_id, payer='Other sender', recipient='Transfer receiver'))
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_payment('movements', 1, self.inventory_payment(request_id=payment.request_id, amount=30, payer='Other buyer', recipient='Later seller'))
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_payment('movements', 1, self.inventory_payment(request_id=repayment.request_id, payer='Repayment sender', recipient='Repayment receiver'))
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('projects', self.project(request_id=transfer.request_id))
        self.assertEqual(ledger.list_finance(), saved)
        voided = ledger.void_payment('movements', 1, 1, 1)
        self.assertEqual((voided['movements'][0]['payments'][0]['payer'], voided['movements'][0]['payments'][0]['recipient']),
                         ('Later buyer', 'Later seller'))
        with self.pool.connection() as conn:
            before, after = conn.execute("SELECT before_data, after_data FROM finance_audit WHERE entity_kind='payments' AND action='void'").fetchone()
            self.assertEqual((before['payer'], after['payer']), ('Later buyer', 'Later buyer'))
        self.assertEqual(self.row_count('transactions'), 0)

    def test_legacy_money_payloads_retries_and_actorless_edits_do_not_gain_actor_keys(self):
        requests = [('transfers', self.transfer(), TransferUpdate), ('loans', self.loan(), LoanUpdate),
                    ('movements', self.movement(), MovementUpdate), ('exchanges', self.exchange(), ExchangeUpdate)]
        ledger.create_record('products', self.product())
        for kind, request, _ in requests:
            ledger.create_record(kind, request)
        repayments = self.payment(amount=10)
        payments = self.inventory_payment(amount=10)
        ledger.create_payment('loans', 1, repayments)
        original = ledger.create_payment('movements', 1, payments)
        with self.pool.connection() as conn:
            journal = conn.execute('SELECT request_id, request_payload FROM finance_requests ORDER BY request_id').fetchall()
            raw = {kind: conn.execute(f'SELECT payload FROM finance_{kind} WHERE id=1').fetchone()[0]
                   for kind in ('transfers', 'loans', 'movements', 'exchanges', 'repayments', 'payments')}
        for payload in raw.values():
            self.assertNotIn('payer', payload)
            self.assertNotIn('recipient', payload)
        for kind, request, _ in requests:
            retry = type(request)(**dict(request.model_dump(), payer='  ', recipient=''))
            self.assertEqual(ledger.create_record(kind, retry), original)
            self.assertEqual((original[kind][0]['payer'], original[kind][0]['recipient']), ('', ''))
        self.assertEqual(ledger.create_payment('loans', 1, type(repayments)(**dict(repayments.model_dump(), payer='', recipient=' '))), original)
        self.assertEqual(ledger.create_payment('movements', 1, type(payments)(**dict(payments.model_dump(), payer=' ', recipient=''))), original)
        with self.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT request_id, request_payload FROM finance_requests ORDER BY request_id').fetchall(), journal)
            for kind, payload in raw.items():
                self.assertEqual(conn.execute(f'SELECT payload FROM finance_{kind} WHERE id=1').fetchone()[0], payload)
        for kind, request, update_model in requests:
            fields = request.model_dump(exclude={'request_id', 'payer', 'recipient', 'project_id'})
            version = 2 if kind in ('loans', 'movements') else 1
            ledger.update_record(kind, 1, update_model(**fields, version=version))
            with self.pool.connection() as conn:
                payload = conn.execute(f'SELECT payload FROM finance_{kind} WHERE id=1').fetchone()[0]
                self.assertNotIn('payer', payload)
                self.assertNotIn('recipient', payload)

    def test_actor_edit_omission_preserves_names_and_explicit_blank_clears_only_that_name(self):
        ledger.create_record('products', self.product())
        requests = [('transfers', self.transfer(payer='Alice', recipient='Bob'), TransferUpdate),
                    ('loans', self.loan(payer='Alice', recipient='Bob'), LoanUpdate),
                    ('movements', self.movement(payer='Alice', recipient='Bob'), MovementUpdate),
                    ('exchanges', self.exchange(payer='Alice', recipient='Bob'), ExchangeUpdate)]
        for kind, request, update_model in requests:
            ledger.create_record(kind, request)
            fields = request.model_dump(exclude={'request_id', 'payer', 'recipient', 'project_id'})
            omitted = ledger.update_record(kind, 1, update_model(**fields, version=1))[kind][0]
            self.assertEqual((omitted['payer'], omitted['recipient']), ('Alice', 'Bob'))
            cleared = ledger.update_record(kind, 1, update_model(**fields, payer='  ', version=2))[kind][0]
            self.assertEqual((cleared['payer'], cleared['recipient']), ('', 'Bob'))
            changed = ledger.update_record(kind, 1, update_model(**fields, payer=' Carol ', recipient='', version=3))[kind][0]
            self.assertEqual((changed['payer'], changed['recipient']), ('Carol', ''))
            self.assertEqual(ledger.list_finance()[kind][0], changed)
            with self.pool.connection() as conn:
                before, after = conn.execute('SELECT before_data, after_data FROM finance_audit WHERE entity_kind=%s AND action=%s AND after_data->>\'version\'=%s',
                                            (kind, 'update', '3')).fetchone()
                self.assertEqual((before['payer'], after['payer'], after['recipient']), ('Alice', '', 'Bob'))

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

    def test_zero_price_gift_persists_retries_edits_and_void_restores_stock(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.movement(paid_amount=100))
        ledger.create_record('movements', self.movement(date='2026-01-03', unit_price=20, paid_amount=200))
        gift = self.movement(date='2026-01-04', kind='sale', quantity=4, unit_price=0,
                             paid_amount=0, note='Gifted merchandise')
        first = ledger.create_record('movements', gift)
        saved = first['movements'][0]
        self.assertEqual((saved['total'], saved['paid_amount'], saved['remaining_payment'], saved['status']), (0, 0, 0, 'paid'))
        self.assertEqual((saved['cost_of_goods'], saved['realized_profit']), (60, -60))
        self.assertEqual((first['products'][0]['quantity'], first['products'][0]['inventory_cost']), (16, 240))
        self.assertEqual((first['summary'][0]['sales_total'], first['summary'][0]['payable'], first['summary'][0]['receivable']), (0, 0, 0))
        with self.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT payload FROM finance_movements WHERE id=3').fetchone()[0]['unit_price'], '0')
        retry = self.movement(request_id=gift.request_id, date='2026-01-04', kind='sale', quantity='4.000000',
                              unit_price='0.000000', paid_amount='0.000000', note='Gifted merchandise')
        self.assertEqual(ledger.create_record('movements', retry), first)
        with self.assertRaisesRegex(FinanceError, 'Payments cannot exceed'):
            ledger.create_payment('movements', 3, self.inventory_payment(date='2026-01-04', amount='.000001'))
        self.assertEqual(ledger.list_finance(), first)
        self.assertEqual((self.row_count('finance_payments'), self.row_count('finance_audit')), (0, 4))
        changed = ledger.update_record('movements', 3, MovementUpdate(date='2026-01-04', product_id=1,
                      kind='sale', quantity=6, unit_price=0, paid_amount=0, note='Gifted merchandise', version=1))
        self.assertEqual((changed['movements'][0]['cost_of_goods'], changed['movements'][0]['realized_profit']), (90, -90))
        self.assertEqual((changed['products'][0]['quantity'], changed['products'][0]['inventory_cost']), (14, 210))
        self.assertEqual(ledger.list_finance(), changed)
        final = ledger.void_record('movements', 3, 2)
        self.assertEqual((final['products'][0]['quantity'], final['products'][0]['inventory_cost'], final['products'][0]['realized_profit']), (20, 300, 0))
        self.assertEqual(final['movements'][0]['status'], 'void')
        self.assertEqual((self.row_count('finance_movements'), self.row_count('finance_audit'), self.row_count('transactions')), (3, 6, 0))

    def test_edit_to_zero_price_preserves_receipts_and_requires_them_voided_first(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.movement(paid_amount=100))
        ledger.create_record('movements', self.movement(date='2026-01-03', kind='sale', quantity=4, unit_price=20))
        paid = ledger.create_payment('movements', 2, self.inventory_payment(date='2026-01-03', amount=10))
        zero_fields = dict(date='2026-01-03', product_id=1, kind='sale', quantity=4, unit_price=0, paid_amount=0)
        with self.assertRaisesRegex(FinanceError, 'Payments cannot exceed'):
            ledger.update_record('movements', 2, MovementUpdate(**zero_fields, version=2))
        self.assertEqual(ledger.list_finance(), paid)
        self.assertEqual((self.row_count('finance_payments'), self.row_count('finance_audit')), (1, 5))
        ledger.void_payment('movements', 2, 1, 1)
        changed = ledger.update_record('movements', 2, MovementUpdate(**zero_fields, version=3))
        saved = changed['movements'][0]
        self.assertEqual((saved['total'], saved['paid_amount'], saved['remaining_payment'], saved['status']), (0, 0, 0, 'paid'))
        self.assertEqual((saved['cost_of_goods'], saved['realized_profit']), (40, -40))
        self.assertTrue(saved['payments'][0]['voided'])
        self.assertEqual(changed['summary'][0]['receivable'], 0)
        with self.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT payload FROM finance_payments WHERE id=1').fetchone()[0]['amount'], '10')
        initial_paid = ledger.create_record('movements', self.movement(date='2026-01-04', kind='sale',
                                            quantity=1, unit_price=20, paid_amount=5))
        with self.assertRaisesRegex(ValueError, 'Paid amount cannot exceed'):
            ledger.update_record('movements', 3, MovementUpdate(date='2026-01-04', product_id=1,
                                 kind='sale', quantity=1, unit_price=0, paid_amount=5, version=1))
        self.assertEqual(ledger.list_finance(), initial_paid)

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

    def test_product_cost_entries_persist_before_stock_and_recalculate_after_sold_out(self):
        ledger.create_record('products', self.product())
        fee = self.product_expense(handler='Carrier agent', payer='Kevin', recipient='Carrier')
        pending = ledger.create_record('movements', fee)
        self.assertEqual((pending['products'][0]['inventory_cost'], pending['products'][0]['unallocated_cost']), (0, 20))
        ledger.create_record('movements', self.product_transaction())
        ledger.create_record('movements', self.product_transaction(date='2026-01-03', kind='sale',
                             quantity=3, total_amount=150, handler='Sales agent'))
        sold = ledger.list_finance()
        self.assertEqual((sold['products'][0]['inventory_cost'], sold['products'][0]['realized_profit']), (0, 30))
        late = ledger.create_record('movements', self.product_expense(date='2026-01-04', total_amount=6, category='包装'))
        self.assertEqual((late['products'][0]['total_cost'], late['products'][0]['realized_profit']), (126, 24))
        saved = next(entry for entry in late['movements'] if entry['kind'] == 'sale')
        self.assertEqual((saved['cost_of_goods'], saved['realized_profit'], saved['handler']), (126, 24, 'Sales agent'))
        changed = ledger.update_record('movements', 4, MovementUpdate(date='2026-01-04', product_id=1,
                     kind='expense', total_amount=9, version=1))
        self.assertEqual(changed['products'][0]['realized_profit'], 21)
        self.assertEqual(changed['movements'][0]['category'], '包装')
        final = ledger.void_record('movements', 4, 2)
        self.assertEqual(final['products'][0]['realized_profit'], 30)
        self.assertEqual(ledger.list_finance(), final)
        self.assertEqual(ledger.create_record('movements', fee), final)
        self.assertEqual(self.row_count('transactions'), 0)

    def test_total_input_round_trip_and_switching_price_modes_remove_stale_fields(self):
        ledger.create_record('products', self.product())
        request = self.product_transaction(total_amount='1.000000', handler='Kevin')
        first = ledger.create_record('movements', request)
        saved = first['movements'][0]
        self.assertEqual(saved['request_fields']['total_amount'], '1')
        self.assertNotIn('unit_price', saved['request_fields'])
        repeated = self.product_transaction(request_id=request.request_id, total_amount='1.0', handler=' Kevin ')
        self.assertEqual(ledger.create_record('movements', repeated), first)
        exact_edit = ledger.update_record('movements', 1, MovementUpdate(**saved['request_fields'], version=1))
        self.assertEqual(exact_edit['movements'][0]['total'], 1)
        unit_edit = ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1,
                    kind='purchase', quantity=3, unit_price=2, version=2))
        self.assertEqual((unit_edit['movements'][0]['total'], unit_edit['movements'][0]['price_basis']), (6, 'unit'))
        total_edit = ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1,
                     kind='purchase', quantity=3, total_amount=100, version=3))
        self.assertEqual((total_edit['movements'][0]['total'], total_edit['movements'][0]['handler']), (100, 'Kevin'))
        with self.pool.connection() as conn:
            payload = conn.execute('SELECT payload FROM finance_movements WHERE id=1').fetchone()[0]
        self.assertEqual(payload['total_amount'], '100')
        self.assertNotIn('unit_price', payload)
        self.assertNotIn('request_fields', payload)
        cleared = ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1,
                  kind='purchase', quantity=3, total_amount=100, handler='', version=4))
        self.assertEqual(cleared['movements'][0]['handler'], '')
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('movements', self.product_transaction(request_id=request.request_id,
                                 total_amount=1, handler='Someone else'))

    def test_expense_kind_conversion_requires_category_and_settled_history_stays_locked(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.product_transaction())
        with self.assertRaisesRegex(FinanceError, 'expense category'):
            ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1,
                                 kind='expense', total_amount=20, version=1))
        self.assertEqual(ledger.list_finance()['products'][0]['quantity'], 3)
        converted = ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1,
                    kind='expense', total_amount=20, category='Custom', version=1))
        self.assertEqual((converted['products'][0]['quantity'], converted['products'][0]['unallocated_cost']), (0, 20))
        paid = ledger.create_payment('movements', 1, self.inventory_payment(amount=5, handler='Pay agent'))
        self.assertEqual(paid['movements'][0]['payments'][0]['handler'], 'Pay agent')
        ledger.void_payment('movements', 1, 1, 1)
        with self.assertRaisesRegex(FinanceError, 'Product and kind'):
            ledger.update_record('movements', 1, MovementUpdate(date='2026-01-02', product_id=1,
                    kind='purchase', quantity=3, total_amount=100, version=4))
        self.assertEqual(ledger.list_finance()['movements'][0]['kind'], 'expense')

    def test_cost_entry_native_partial_payments_preserve_totals_rates_and_each_handler(self):
        ledger.create_record('products', self.product())
        fee = self.product_expense(currency='CNY', exchange_rate='.125', total_amount=140,
                                  paid_amount=20, handler='Invoice agent')
        ledger.create_record('movements', fee)
        ledger.create_record('movements', self.product_transaction())
        paid = ledger.create_payment('movements', 1, self.inventory_payment(amount=5, currency='USD',
                                     exchange_rate=8, handler='Cashier', payer='Partner', recipient='Carrier'))
        entry = next(item for item in paid['movements'] if item['kind'] == 'expense')
        self.assertEqual((entry['paid_amount'], entry['remaining_payment'], entry['base_total']), (60, 80, 17.5))
        self.assertEqual((entry['handler'], entry['payments'][0]['handler']), ('Invoice agent', 'Cashier'))
        self.assertEqual(paid['products'][0]['inventory_cost'], 117.5)
        with self.assertRaisesRegex(FinanceError, 'Payments cannot exceed'):
            ledger.create_payment('movements', 1, self.inventory_payment(amount=11, currency='USD', exchange_rate=8))
        self.assertEqual(ledger.list_finance(), paid)
        with self.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT payload FROM finance_movements WHERE id=1').fetchone()[0]['total_amount'], '140')
            self.assertEqual(conn.execute('SELECT payload FROM finance_payments WHERE id=1').fetchone()[0]['handler'], 'Cashier')

    def test_reassigning_cost_between_profiles_rebalances_both_stock_and_sale_profit(self):
        ledger.create_record('products', self.product())
        ledger.create_record('products', self.product(name='Other Tea', sku='OTHER'))
        ledger.create_record('movements', self.product_transaction(quantity=2))
        ledger.create_record('movements', self.product_transaction(product_id=2, quantity=2))
        ledger.create_record('movements', self.product_transaction(date='2026-01-03', kind='sale', quantity=1, total_amount=75))
        before = ledger.create_record('movements', self.product_expense(date='2026-01-04', handler='Cost agent'))
        profiles = {item['id']: item for item in before['products']}
        self.assertEqual((profiles[1]['inventory_cost'], profiles[1]['realized_profit'], profiles[2]['inventory_cost']), (60, 15, 100))
        changed = ledger.update_record('movements', 4, MovementUpdate(date='2026-01-04', product_id=2,
                      kind='expense', total_amount=20, version=1))
        profiles = {item['id']: item for item in changed['products']}
        self.assertEqual((profiles[1]['inventory_cost'], profiles[1]['realized_profit'], profiles[2]['inventory_cost']), (50, 25, 120))
        moved = next(item for item in changed['movements'] if item['id'] == 4)
        self.assertEqual((moved['handler'], moved['category']), ('Cost agent', '物流'))
        final = ledger.void_record('movements', 4, 2)
        profiles = {item['id']: item for item in final['products']}
        self.assertEqual((profiles[1]['inventory_cost'], profiles[1]['realized_profit'], profiles[2]['inventory_cost']), (50, 25, 100))
        self.assertEqual(ledger.list_finance(), final)

    def test_concurrent_cost_create_retry_edit_and_void_preserve_pool_and_versions(self):
        ledger.create_record('products', self.product())
        ledger.create_record('movements', self.product_transaction())
        request = self.product_expense(date='2026-01-03', total_amount=10, handler='Agent')
        barrier = threading.Barrier(2)
        def create():
            barrier.wait()
            return ledger.create_record('movements', request)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: create(), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.row_count('finance_movements'), 2)
        self.assertEqual(self.row_count('finance_audit'), 3)
        self.assertEqual(results[0]['products'][0]['total_cost'], 110)
        barrier = threading.Barrier(2)
        def change(action):
            barrier.wait()
            try:
                if action == 'edit':
                    return ledger.update_record('movements', 2, MovementUpdate(date='2026-01-03',
                        product_id=1, kind='expense', total_amount=20, version=1))
                return ledger.void_record('movements', 2, 1)
            except FinanceError as error:
                self.assertEqual(error.status_code, 409)
                return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(change, ('edit', 'void')))
        self.assertEqual(sum(result is not None for result in results), 1)
        final = ledger.list_finance()
        self.assertIn(final['products'][0]['total_cost'], (100, 120))
        self.assertEqual(next(entry for entry in final['movements'] if entry['id'] == 2)['version'], 2)
        self.assertEqual(self.row_count('finance_audit'), 4)
        self.assertEqual(self.row_count('transactions'), 0)

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

    def test_project_crud_versions_nested_retry_and_global_uuid_guards(self):
        request = self.project()
        first = ledger.create_record('projects', request)
        saved = first['projects'][0]
        self.assertEqual((saved['total_contribution'], saved['dividend_percent_total'], saved['allocation_complete']), (1000, 100, True))
        self.assertEqual([p['expected_dividend'] for p in saved['participants']], [150, 100])
        self.assertEqual(first['summary'], [])
        data = request.model_dump()
        data['participants'][0]['contribution_amount'] = '600.00'
        self.assertEqual(ledger.create_record('projects', ProjectCreate(**data)), first)
        self.assertEqual(self.row_count('finance_project_requests'), 1)
        self.assertEqual(self.row_count('finance_requests'), 0)
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('transfers', self.transfer(request_id=request.request_id))
        normal = self.transfer()
        ledger.create_record('transfers', normal)
        with self.assertRaisesRegex(FinanceError, 'different values'):
            ledger.create_record('projects', self.project(request_id=normal.request_id))
        updated = ledger.update_record('projects', 1, ProjectUpdate(**dict(saved['request_fields'], expected_profit=0), version=1))
        self.assertEqual(updated['projects'][0]['expected_profit'], 0)
        self.assertEqual(updated['projects'][0]['version'], 2)
        with self.assertRaisesRegex(FinanceError, 'changed'):
            ledger.void_record('projects', 1, 1)
        with self.assertRaisesRegex(FinanceError, 'Project currency'):
            fields = dict(updated['projects'][0]['request_fields'], currency='CNY')
            fields['participants'] = [dict(p, currency='CNY', exchange_rate=1) for p in fields['participants']]
            ledger.update_record('projects', 1, ProjectUpdate(**fields, version=2))
        final = ledger.void_record('projects', 1, 2)
        self.assertEqual(final['projects'][0]['status'], 'void')
        self.assertEqual(ledger.create_record('projects', request), final)
        with self.pool.connection() as conn:
            rows = conn.execute('SELECT action, before_data, after_data FROM finance_audit WHERE entity_kind=%s ORDER BY id', ('projects',)).fetchall()
        self.assertEqual([row[0] for row in rows], ['create', 'update', 'void'])
        self.assertEqual((rows[1][1]['expected_profit'], rows[1][2]['expected_profit']), ('250', '0'))
        self.assertEqual(self.row_count('transactions'), 0)

    def test_exact_project_edit_inputs_retain_near_cap_micro_units(self):
        request = self.project(expected_profit='999999999999.000001', participants=[
            dict(name='Kevin', contribution_amount='999999999999.000001', dividend_percent='33.333333')])
        saved = ledger.create_record('projects', request)['projects'][0]
        with self.pool.connection() as conn:
            original = conn.execute('SELECT payload FROM finance_projects WHERE id=1').fetchone()[0]
        updated = ledger.update_record('projects', 1, ProjectUpdate(**saved['request_fields'], version=1))['projects'][0]
        self.assertEqual(updated['request_fields']['expected_profit'], '999999999999.000001')
        self.assertEqual(updated['request_fields']['participants'][0]['contribution_amount'], '999999999999.000001')
        exact = updated['calculation_fields']
        self.assertEqual(exact['total_contribution'], '999999999999.000001')
        self.assertEqual(exact['participants'][0]['base_amount'], '999999999999.000001')
        self.assertEqual(Decimal(exact['participants'][0]['expected_dividend']) + Decimal(exact['unallocated_profit']),
                         Decimal(updated['request_fields']['expected_profit']))
        self.assertEqual(ledger.list_finance()['projects'][0]['calculation_fields'], exact)
        with self.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT payload FROM finance_projects WHERE id=1').fetchone()[0], original)

    def test_project_movement_link_omit_clear_and_voided_history_are_atomic(self):
        ledger.create_record('projects', self.project())
        ledger.create_record('products', self.product())
        old_request = self.movement()
        legacy = ledger.create_record('movements', old_request)
        self.assertEqual(ledger.create_record('movements', old_request), legacy)
        fields = dict(date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=10)
        linked = ledger.update_record('movements', 1, MovementUpdate(**fields, project_id=1, version=1))
        self.assertEqual(linked['projects'][0]['active_movement_ids'], [1])
        with self.assertRaisesRegex(FinanceError, 'active movements'):
            ledger.void_record('projects', 1, 1)
        preserved = ledger.update_record('movements', 1, MovementUpdate(**fields, version=2))
        self.assertEqual(preserved['movements'][0]['project_id'], 1)
        cleared = ledger.update_record('movements', 1, MovementUpdate(**fields, project_id=None, version=3))
        self.assertIsNone(cleared['movements'][0]['project_id'])
        self.assertEqual(cleared['projects'][0]['movement_ids'], [])
        voided = ledger.void_record('projects', 1, 1)
        with self.assertRaisesRegex(FinanceError, 'active project'):
            ledger.update_record('movements', 1, MovementUpdate(**fields, project_id=1, version=4))
        with self.assertRaisesRegex(FinanceError, 'active project'):
            ledger.create_record('movements', self.movement(project_id=99))
        self.assertEqual(ledger.list_finance(), voided)
        ledger.create_record('projects', self.project(name='Second plan'))
        ledger.update_record('movements', 1, MovementUpdate(**fields, project_id=2, version=4))
        ledger.void_record('movements', 1, 5)
        final = ledger.void_record('projects', 2, 1)
        archived = next(p for p in final['projects'] if p['id'] == 2)
        self.assertEqual((archived['status'], archived['movement_ids'], archived['active_movement_ids']), ('void', [1], []))
        self.assertEqual(final['movements'][0]['project_name'], 'Second plan')

    def test_project_schema_upgrade_and_old_image_boot_preserve_all_journals(self):
        transfer = self.transfer()
        ledger.create_record('transfers', transfer)
        with self.pool.connection() as conn:
            conn.execute('DROP TABLE finance_project_requests')
            conn.execute('DROP TABLE finance_projects')
        db.init_schema()
        db.init_schema()
        request = self.project(expected_profit=1, participants=[
            dict(name='A', contribution_amount=1, dividend_percent='33.333333'),
            dict(name='B', contribution_amount=1, dividend_percent='33.333333'),
            dict(name='C', contribution_amount=1, dividend_percent='33.333334')])
        saved = ledger.create_record('projects', request)
        def snapshot():
            with self.pool.connection() as conn:
                return {table: conn.execute(f'SELECT * FROM {table} ORDER BY 1').fetchall()
                        for table in ('finance_projects', 'finance_project_requests', 'finance_requests', 'finance_audit')}
        before = snapshot()
        old_schema = subprocess.check_output(['git', 'show', 'c78fda3:schema.sql'], cwd=Path(__file__).resolve().parents[1], text=True)
        with self.pool.connection() as conn:
            conn.execute(old_schema)  # Actual retained rollback image's schema bootstrap.
        self.assertEqual(snapshot(), before)
        db.init_schema()
        db.init_schema()
        self.assertEqual(snapshot(), before)
        self.assertEqual(ledger.list_finance(), saved)
        self.assertEqual(ledger.create_record('projects', request), saved)
        self.assertEqual(ledger.create_record('transfers', transfer), saved)

    def test_competing_project_request_saves_once_and_link_void_cannot_race(self):
        request = self.project()
        barrier = threading.Barrier(2)
        def save():
            barrier.wait()
            return ledger.create_record('projects', request)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: save(), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.row_count('finance_projects'), 1)
        self.assertEqual(self.row_count('finance_project_requests'), 1)
        self.assertEqual(self.row_count('finance_audit'), 1)
        ledger.create_record('products', self.product())
        barrier = threading.Barrier(2)
        def mutate(operation):
            barrier.wait()
            try:
                return ledger.create_record('movements', self.movement(project_id=1)) if operation == 'link' else ledger.void_record('projects', 1, 1)
            except FinanceError:
                return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(mutate, ('link', 'void')))
        self.assertEqual(sum(r is not None for r in results), 1)
        final = ledger.list_finance()
        plan = final['projects'][0]
        if plan['voided']:
            self.assertEqual(plan['active_movement_ids'], [])
            self.assertEqual(final['movements'], [])
        else:
            self.assertEqual(plan['active_movement_ids'], [1])
            self.assertEqual(final['movements'][0]['project_id'], 1)


if __name__ == '__main__':
    unittest.main()
