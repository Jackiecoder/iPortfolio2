"""Financial balance and chronological inventory replay regression tests."""
from copy import deepcopy
from decimal import Decimal
import json
import unittest
from uuid import uuid4

from pydantic import ValidationError

from app.finance import (ExchangeCreate, FinanceError, InventoryPaymentCreate, LoanCreate, LoanUpdate, MovementCreate,
                         MovementUpdate,
                         ProductCreate, ProductUpdate, PaymentCreate, TransferCreate,
                         TransferUpdate, ExchangeUpdate,
                         ProjectCreate, ProjectUpdate,
                         empty_state, replay, request_data, validate_edit, validate_void)


def record(model, record_id=1, **values):
    return {**request_data(model(request_id=uuid4(), **values)),
            'id': record_id, 'version': 1, 'voided': False}


def product(record_id=1, **values):
    return record(ProductCreate, record_id, name='Tea', **values)


def movement(record_id=1, **values):
    defaults = dict(date='2026-01-02', product_id=1, kind='purchase', quantity=10,
                    unit_price=10, paid_amount=0)
    defaults.update(values)
    return {**record(MovementCreate, record_id, **defaults), 'payments': []}


def payment(record_id=1, **values):
    defaults = dict(date='2026-01-03', amount=20)
    defaults.update(values)
    return record(PaymentCreate, record_id, **defaults)


def inventory_payment(record_id=1, **values):
    defaults = dict(date='2026-01-03', amount=20)
    defaults.update(values)
    return record(InventoryPaymentCreate, record_id, **defaults)


def exchange(record_id=1, **values):
    defaults = dict(date='2026-01-01', from_currency='USD', to_currency='CNY',
                    from_amount=1000, to_amount=7200)
    defaults.update(values)
    return record(ExchangeCreate, record_id, **defaults)


def project(record_id=1, **values):
    defaults = dict(date='2026-01-01', name='Tea partnership', participants=[
        dict(name='Kevin', contribution_amount=100, dividend_percent=60),
        dict(name='Partner', contribution_amount=50, dividend_percent=30)])
    defaults.update(values)
    return record(ProjectCreate, record_id, **defaults)


class FinanceModelTests(unittest.TestCase):
    def test_decimal_precision_finite_positive_and_currency_guards(self):
        for amount in ('NaN', 'Infinity', '-1', '0', '0.0000001', True, '1000000000001'):
            with self.subTest(amount=amount), self.assertRaises(ValidationError):
                TransferCreate(request_id=uuid4(), date='2026-01-01', direction='in', amount=amount)
        for currency in ('US', 'HKD', 'EUR'):
            with self.subTest(currency=currency), self.assertRaises(ValidationError):
                TransferCreate(request_id=uuid4(), date='2026-01-01', direction='in', amount=1, currency=currency)

    def test_dates_and_due_dates_are_unambiguous(self):
        for value in ('2026-1-1', '2026-02-30', '2099-01-01', 1700000000):
            with self.subTest(date=value), self.assertRaises(ValidationError):
                LoanCreate(request_id=uuid4(), date=value, direction='lent', counterparty='K', principal=1)
        with self.assertRaises(ValidationError):
            LoanCreate(request_id=uuid4(), date='2026-01-01', due_date='2025-12-31', direction='lent', counterparty='K', principal=1)

    def test_idempotency_canonicalizes_decimal_spelling(self):
        request_id = uuid4()
        a = TransferCreate(request_id=request_id, date='2026-01-01', direction='in', amount='10.00')
        b = TransferCreate(request_id=request_id, date='2026-01-01', direction='in', amount=10)
        self.assertEqual(request_data(a), request_data(b))

    def test_initial_payment_limits_and_opening_inventory(self):
        for values in (dict(paid_amount=101), dict(kind='opening', paid_amount=1)):
            with self.assertRaises(ValidationError):
                movement(**values)
        self.assertEqual(movement(kind='opening', unit_price=0)['paid_amount'], '0')

    def test_exchange_rejects_same_currency_invalid_fees_and_invalid_amounts(self):
        for values in (dict(to_currency='usd'), dict(from_currency='ABC'),
                       dict(fee_currency='EUR'), dict(fee_amount=-1),
                       dict(fee_amount='NaN'), dict(fee_amount=True),
                       dict(fee_amount='0.0000001'), dict(from_amount=0),
                       dict(to_amount=0), dict(to_amount='Infinity'),
                       dict(from_amount='1000000000001'),
                       dict(fee_currency='CNY', fee_amount=7200),
                       dict(fee_currency='CNY', fee_amount=7201)):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                exchange(**values)

    def test_exchange_default_fee_currency_and_decimal_spelling_are_canonical(self):
        request_id = uuid4()
        defaults = dict(date='2026-01-01', from_currency='USD', to_currency='CNY',
                        from_amount=1000, to_amount=7200, request_id=request_id)
        implicit = ExchangeCreate(**defaults)
        explicit = ExchangeCreate(**dict(defaults, fee_currency='usd', from_amount='1000.000000'))
        null = ExchangeCreate(**dict(defaults, fee_currency=None))
        self.assertEqual(request_data(implicit), request_data(explicit))
        self.assertEqual(request_data(implicit), request_data(null))

    def test_inventory_rates_are_positive_finite_and_allow_twelve_places(self):
        for value in (0, -1, True, 'NaN', 'Infinity', '1000000000001', '0.0000000000001'):
            with self.subTest(rate=value), self.assertRaises(ValidationError):
                movement(currency='CNY', exchange_rate=value)
        self.assertEqual(movement(currency='CNY', exchange_rate='.142857142857')['exchange_rate'], '0.142857142857')

    def test_inventory_optional_fields_preserve_legacy_request_fingerprints(self):
        request_id = uuid4()
        values = dict(request_id=request_id, date='2026-01-01', product_id=1,
                      kind='purchase', quantity=2, unit_price=10)
        old = request_data(MovementCreate(**values))
        null = request_data(MovementCreate(**dict(values, currency=None, exchange_rate=None)))
        self.assertEqual(old, null)
        self.assertNotIn('currency', old)
        self.assertNotIn('exchange_rate', old)
        child = dict(request_id=request_id, date='2026-01-02', amount=10)
        self.assertEqual(request_data(PaymentCreate(**child)), request_data(InventoryPaymentCreate(**child)))
        self.assertIn('due_date', request_data(LoanCreate(request_id=request_id, date='2026-01-01', direction='lent', counterparty='K', principal=10)))

    def test_money_actors_are_trimmed_bounded_and_keep_old_create_fingerprints(self):
        requests = [TransferCreate(request_id=uuid4(), date='2026-01-01', direction='in', amount=10),
                    LoanCreate(request_id=uuid4(), date='2026-01-01', direction='lent', principal=10, counterparty='Separate counterparty'),
                    MovementCreate(request_id=uuid4(), date='2026-01-01', product_id=1, kind='purchase', quantity=1, unit_price=10),
                    ExchangeCreate(request_id=uuid4(), date='2026-01-01', from_currency='USD', to_currency='CNY', from_amount=10, to_amount=70),
                    PaymentCreate(request_id=uuid4(), date='2026-01-02', amount=1),
                    InventoryPaymentCreate(request_id=uuid4(), date='2026-01-02', amount=1)]
        for request in requests:
            with self.subTest(model=type(request).__name__):
                old = request_data(request)
                values = request.model_dump()
                self.assertNotIn('payer', old)
                self.assertNotIn('recipient', old)
                self.assertEqual(request_data(type(request)(**dict(values, payer='  ', recipient=''))), old)
                named = request_data(type(request)(**dict(values, payer='  Kevin  ', recipient=' Partner ')))
                self.assertEqual((named['payer'], named['recipient']), ('Kevin', 'Partner'))
                for field in ('payer', 'recipient'):
                    with self.assertRaises(ValidationError):
                        type(request)(**dict(values, **{field: 'A' * 201}))
        with self.assertRaises(ValidationError):
            ProductCreate(request_id=uuid4(), name='Tea', payer='Kevin')
        with self.assertRaises(ValidationError):
            project(payer='Kevin')

    def test_actor_updates_distinguish_omission_from_explicit_clear(self):
        requests = [TransferUpdate(date='2026-01-01', direction='in', amount=10, version=1),
                    LoanUpdate(date='2026-01-01', direction='lent', principal=10, counterparty='K', version=1),
                    MovementUpdate(date='2026-01-01', product_id=1, kind='purchase', quantity=1, unit_price=10, version=1),
                    ExchangeUpdate(date='2026-01-01', from_currency='USD', to_currency='CNY', from_amount=10, to_amount=70, version=1)]
        for request in requests:
            with self.subTest(model=type(request).__name__):
                self.assertNotIn('payer', request_data(request))
                self.assertNotIn('recipient', request_data(request))
                fields = request.model_dump(exclude={'payer', 'recipient'})
                clear = request_data(type(request)(**fields, payer='  '))
                self.assertEqual(clear['payer'], '')
                self.assertNotIn('recipient', clear)


class ProductTransactionLedgerTests(unittest.TestCase):
    def setUp(self):
        self.state = empty_state()
        self.state['products'] = [product()]

    def transaction(self, record_id=1, **values):
        fields = dict(date='2026-01-02', product_id=1, kind='purchase', quantity=3, total_amount=100)
        fields.update(values)
        return {**record(MovementCreate, record_id, **fields), 'payments': []}

    def expense(self, record_id=1, **values):
        fields = dict(date='2026-01-01', product_id=1, kind='expense', total_amount=20, category='物流')
        fields.update(values)
        return {**record(MovementCreate, record_id, **fields), 'payments': []}

    def test_expense_and_total_price_validation_preserves_existing_number_guards(self):
        for fields in (dict(quantity=1), dict(unit_price=0), dict(total_amount=0),
                       dict(total_amount=-1), dict(total_amount=True), dict(total_amount='NaN'),
                       dict(total_amount='.0000001'), dict(category='  '), dict(category='a' * 101),
                       dict(handler='a' * 201)):
            with self.subTest(fields=fields), self.assertRaises(ValidationError):
                self.expense(**fields)
        for fields in (dict(quantity=None), dict(total_amount=None), dict(total_amount=99, unit_price=33),
                       dict(total_amount=100, unit_price=33), dict(paid_amount=101)):
            if fields == dict(total_amount=99, unit_price=33):
                self.assertNotIn('unit_price', self.transaction(**fields))
            else:
                with self.subTest(fields=fields), self.assertRaises(ValidationError):
                    self.transaction(**fields)
        self.assertEqual(self.transaction(kind='sale', total_amount=0)['total_amount'], '0')

    def test_total_amount_stays_exact_without_unit_price_round_trip(self):
        buy = self.transaction(total_amount=1, handler='  Kevin  ')
        self.state['movements'] = [buy]
        saved = replay(self.state)['movements'][0]
        self.assertEqual((saved['total'], saved['price_basis'], saved['handler']), (1, 'total', 'Kevin'))
        self.assertEqual(saved['request_fields']['total_amount'], '1')
        self.assertNotIn('unit_price', saved['request_fields'])
        update = request_data(MovementUpdate(**saved['request_fields'], version=1))
        self.assertEqual((update['quantity'], update['total_amount']), ('3', '1'))
        self.assertNotIn('unit_price', update)

    def test_freight_before_stock_is_visible_without_an_inventory_asset(self):
        self.state['movements'] = [self.expense(paid_amount=5, handler='Agent')]
        before = replay(self.state)
        item, entry = before['products'][0], before['movements'][0]
        self.assertEqual((item['quantity'], item['average_cost'], item['inventory_cost'], item['total_cost'], item['unallocated_cost']),
                         (0, 0, 0, 20, 20))
        self.assertEqual((entry['quantity'], entry['unit_price'], entry['price_basis'], entry['remaining_payment']), (0, 0, 'expense', 15))
        self.assertEqual((before['summary'][0]['expense_total'], before['summary'][0]['unallocated_cost'], before['summary'][0]['payable']),
                         (20, 20, 15))
        self.state['movements'].append(self.transaction())
        item = replay(self.state)['products'][0]
        self.assertEqual((item['acquired_quantity'], item['average_cost'], item['equivalent_cost'], item['inventory_cost'], item['unallocated_cost']),
                         (3, 40, 40, 120, 0))

    def test_late_expenses_recompute_sales_gifts_remaining_stock_and_sold_out_profit(self):
        self.state['movements'] = [self.transaction(), self.expense(2),
            self.transaction(3, date='2026-01-03', kind='sale', quantity=1, total_amount=60, handler='Seller'),
            self.transaction(4, date='2026-01-04', kind='sale', quantity=1, total_amount=0)]
        first = replay(self.state)
        self.assertEqual((first['products'][0]['inventory_cost'], first['products'][0]['realized_profit']), (40, -20))
        self.state['movements'].append(self.expense(5, date='2026-01-05', total_amount=15, category='包装'))
        late = replay(self.state)
        sales = {entry['id']: entry for entry in late['movements']}
        self.assertEqual((sales[3]['cost_of_goods'], sales[3]['realized_profit'], sales[4]['realized_profit']), (45, 15, -45))
        self.assertEqual((late['products'][0]['inventory_cost'], late['products'][0]['total_cost']), (45, 135))
        self.state['movements'].append(self.transaction(6, date='2026-01-06', kind='sale', quantity=1, total_amount=90))
        sold = replay(self.state)['products'][0]
        self.assertEqual((sold['inventory_cost'], sold['average_cost'], sold['sales_revenue'], sold['realized_profit']), (0, 45, 150, 15))
        fee = self.expense(7, date='2026-01-07', total_amount=6, category='自填费用')
        self.state['movements'].append(fee)
        after = replay(self.state)['products'][0]
        self.assertEqual((after['quantity'], after['inventory_cost'], after['unallocated_cost'], after['equivalent_cost'], after['realized_profit']),
                         (0, 0, 0, 47, 9))
        self.assertEqual(after['expense_categories'], [dict(category='包装', total=15), dict(category='物流', total=20), dict(category='自填费用', total=6)])
        fee['voided'] = True
        self.assertEqual(replay(self.state)['products'][0]['realized_profit'], 15)

    def test_pooled_cost_accounts_for_later_purchases_without_allowing_backdated_oversales(self):
        self.state['movements'] = [movement(quantity=2, unit_price=10),
            movement(2, date='2026-01-03', kind='sale', quantity=1, unit_price=30),
            movement(3, date='2026-01-04', quantity=2, unit_price=20)]
        result = replay(self.state)
        sale = next(entry for entry in result['movements'] if entry['kind'] == 'sale')
        self.assertEqual((sale['cost_of_goods'], sale['realized_profit']), (15, 15))
        self.assertEqual((result['products'][0]['quantity'], result['products'][0]['inventory_cost']), (3, 45))
        self.state['movements'][1]['quantity'] = '3'
        with self.assertRaisesRegex(FinanceError, 'Insufficient inventory'):
            replay(self.state)

    def test_fractional_sales_allocate_every_micro_unit_once_and_void_rebalances(self):
        self.state['movements'] = [self.transaction(quantity='.3'),
            self.transaction(2, date='2026-01-03', kind='sale', quantity='.1', total_amount=50),
            self.transaction(3, date='2026-01-04', kind='sale', quantity='.1', total_amount=50),
            self.transaction(4, date='2026-01-05', kind='sale', quantity='.1', total_amount=50)]
        result = replay(self.state)
        costs = [Decimal(entry['calculation_fields']['cost_of_goods']) for entry in result['movements'] if entry['kind'] == 'sale']
        self.assertEqual(sum(costs), Decimal(100))
        self.assertEqual(next(entry for entry in result['movements'] if entry['id'] == 2)['cost_of_goods'], 33.333334)
        self.assertEqual((result['products'][0]['inventory_cost'], result['products'][0]['realized_profit']), (0, 50))
        self.state['movements'][1]['voided'] = True
        result = replay(self.state)
        active_costs = sum(Decimal(entry['calculation_fields']['cost_of_goods']) for entry in result['movements'] if entry['kind'] == 'sale' and not entry['voided'])
        self.assertEqual(active_costs + Decimal(str(result['products'][0]['inventory_cost'])), Decimal(100))
        self.assertEqual(result['products'][0]['quantity'], .1)

    def test_native_expense_payments_and_handlers_stay_independent_of_pooled_cost(self):
        freight = self.expense(currency='CNY', exchange_rate='.125', total_amount=140,
                               paid_amount=20, handler='Invoice agent', payer='Kevin', recipient='Carrier')
        freight['payments'] = [inventory_payment(currency='USD', exchange_rate=8, amount=5,
            handler='Payment agent', payer='Partner', recipient='Other cashier')]
        self.state['movements'] = [freight, self.transaction()]
        original = deepcopy(self.state)
        result = replay(self.state)
        saved = next(entry for entry in result['movements'] if entry['kind'] == 'expense')
        self.assertEqual((saved['total'], saved['base_total'], saved['paid_amount'], saved['remaining_payment']), (140, 17.5, 60, 80))
        self.assertEqual((saved['handler'], saved['payments'][0]['handler'], saved['payments'][0]['invoice_amount']),
                         ('Invoice agent', 'Payment agent', 40))
        values = {entry['currency']: entry for entry in result['summary']}
        self.assertEqual((values['CNY']['expense_total'], values['CNY']['payable'], values['USD']['inventory_cost']), (140, 80, 117.5))
        self.assertEqual(self.state, original)

    def test_legacy_request_keys_and_handler_edit_omission_preserve_existing_history(self):
        old = movement()
        self.assertNotIn('handler', old)
        self.assertNotIn('category', old)
        self.assertNotIn('total_amount', old)
        fields = dict(date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=10, version=1)
        self.assertNotIn('handler', request_data(MovementUpdate(**fields)))
        self.assertEqual(request_data(MovementUpdate(**fields, handler=' '))['handler'], '')
        expense_fields = dict(date='2026-01-02', product_id=1, kind='expense', total_amount=20, version=1)
        self.assertNotIn('category', request_data(MovementUpdate(**expense_fields)))
        with self.assertRaises(ValidationError):
            MovementUpdate(**expense_fields, category='')
        self.state['products'][0]['currency'] = 'HKD'
        self.state['movements'] = [old]
        result = replay(self.state)
        self.assertEqual((result['products'][0]['inventory_cost'], result['movements'][0]['handler']), (100, ''))
        self.assertNotIn('handler', old)


class InventoryCurrencyTests(unittest.TestCase):
    def setUp(self):
        self.state = empty_state()
        self.state['products'] = [product()]

    def test_mixed_invoice_currencies_share_base_cost_and_profit(self):
        first = movement(currency='CNY', exchange_rate='.142857142857', quantity=10, unit_price=70, paid_amount=50)
        first['payments'] = [inventory_payment(currency='USD', exchange_rate=7, amount=50)]
        self.state['movements'] = [first,
            movement(2, date='2026-01-03', quantity=5, unit_price=12),
            movement(3, date='2026-01-04', kind='sale', currency='CNY', exchange_rate='.125', quantity=6, unit_price=100, paid_amount=20)]
        result = replay(self.state)
        item = result['products'][0]
        self.assertEqual((item['quantity'], item['inventory_cost'], item['realized_profit']), (9, 96, 11))
        sale, purchase = result['movements'][0], result['movements'][2]
        self.assertEqual((sale['currency'], sale['base_currency'], sale['total'], sale['base_total'], sale['cost_of_goods'], sale['realized_profit']), ('CNY', 'USD', 600, 75, 64, 11))
        self.assertEqual((purchase['initial_paid_amount'], purchase['paid_amount'], purchase['remaining_payment']), (50, 400, 300))
        converted = purchase['payments'][0]
        self.assertEqual((converted['currency'], converted['amount'], converted['invoice_currency'], converted['invoice_amount']), ('USD', 50, 'CNY', 350))
        values = {r['currency']: r for r in result['summary']}
        self.assertEqual((values['CNY']['purchase_total'], values['CNY']['sales_total'], values['CNY']['payable'], values['CNY']['receivable'], values['CNY']['realized_profit']), (700, 600, 300, 580, 0))
        self.assertEqual((values['USD']['purchase_total'], values['USD']['payable'], values['USD']['inventory_cost'], values['USD']['realized_profit']), (60, 60, 96, 11))
        first['payments'][0]['voided'] = True
        voided = replay(self.state)
        self.assertEqual(voided['movements'][2]['remaining_payment'], 650)
        self.assertEqual(voided['products'][0]['inventory_cost'], 96)

    def test_reverse_base_and_opening_inventory_use_entered_rates(self):
        self.state['products'][0]['currency'] = 'CNY'
        sale = movement(2, date='2026-01-03', kind='sale', currency='USD', exchange_rate=7, quantity=1, unit_price=10)
        sale['payments'] = [inventory_payment(currency='CNY', exchange_rate='.142857142857', amount=35)]
        self.state['movements'] = [movement(kind='opening', currency='USD', exchange_rate=7, quantity=2, unit_price=5), sale]
        result = replay(self.state)
        item = result['products'][0]
        self.assertEqual((item['currency'], item['inventory_cost'], item['realized_profit']), ('CNY', 35, 35))
        values = {r['currency']: r for r in result['summary']}
        self.assertEqual((values['USD']['purchase_total'], values['USD']['sales_total'], values['USD']['receivable']), (0, 10, 5))
        self.assertEqual(values['CNY']['realized_profit'], 35)

    def test_missing_cross_rates_and_wrong_same_currency_rates_rejected(self):
        for values in (dict(currency='CNY'), dict(exchange_rate=2)):
            self.state['movements'] = [movement(**values)]
            with self.subTest(values=values), self.assertRaises(FinanceError):
                replay(self.state)
        for values in (dict(currency='CNY'), dict(currency='USD', exchange_rate=2)):
            self.state['movements'] = [movement()]
            self.state['movements'][0]['payments'] = [inventory_payment(**values)]
            with self.subTest(values=values), self.assertRaises(FinanceError):
                replay(self.state)

    def test_converted_payments_round_half_even_and_zero_is_rejected(self):
        purchase = movement(currency='CNY', exchange_rate='.1', quantity=1, unit_price='.000010')
        purchase['payments'] = [inventory_payment(currency='USD', exchange_rate='2.5', amount='.000001'),
                                inventory_payment(2, currency='USD', exchange_rate='2.5', amount='.000003')]
        self.state['movements'] = [purchase]
        result = replay(self.state)['movements'][0]
        self.assertEqual([p['invoice_amount'] for p in result['payments']], [.000002, .000008])
        self.assertEqual(result['status'], 'paid')
        purchase['payments'] = [inventory_payment(currency='USD', exchange_rate='.000000000001', amount='.000001')]
        with self.assertRaisesRegex(FinanceError, 'Converted payment'):
            replay(self.state)

    def test_legacy_payment_history_locks_invoice_currency_and_keeps_native_balances(self):
        legacy = movement()
        legacy['payments'] = [payment(amount=40)]
        self.state['movements'] = [legacy]
        values = request_data(MovementUpdate(date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=10, currency='CNY', exchange_rate='.1', version=1))
        for voided in (False, True):
            legacy['payments'][0]['voided'] = voided
            with self.assertRaisesRegex(FinanceError, 'Invoice currency'):
                validate_edit(self.state, 'movements', legacy, values)
        legacy['payments'][0]['voided'] = False
        result = replay(self.state)['movements'][0]
        self.assertEqual((result['currency'], result['exchange_rate'], result['base_total'], result['paid_amount']), ('USD', 1, 100, 40))
        self.assertNotIn('currency', legacy)
        self.assertNotIn('exchange_rate', legacy['payments'][0])


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.state = empty_state()

    def test_project_zero_or_absent_profit_and_incomplete_allocations_are_distinct(self):
        for profit in (None, 0):
            self.state['projects'] = [project(expected_profit=profit)]
            result = replay(self.state)
            saved = result['projects'][0]
            self.assertEqual(saved['total_contribution'], 150)
            self.assertEqual([p['contribution_percent'] for p in saved['participants']], [66.666667, 33.333333])
            self.assertEqual((saved['dividend_percent_total'], saved['unallocated_percent'], saved['allocation_complete']), (90, 10, False))
            self.assertEqual(saved['unallocated_profit'], None if profit is None else 0)
            self.assertEqual(saved['participants'][0]['expected_dividend'], None if profit is None else 0)
            exact = saved['calculation_fields']
            self.assertEqual(exact['unallocated_profit'], None if profit is None else '0')
            self.assertEqual(exact['participants'][0]['expected_dividend'], None if profit is None else '0')
            self.assertEqual(result['summary'], [])

    def test_project_contribution_fx_and_forecast_reconcile_with_unallocated_profit(self):
        self.state['projects'] = [project(expected_profit='123.456789', participants=[
            dict(name='Kevin', contribution_amount=100, dividend_percent=50),
            dict(name='Partner', contribution_amount=720, currency='CNY', exchange_rate='.138888888889', dividend_percent=40)])]
        saved = replay(self.state)['projects'][0]
        self.assertEqual(saved['total_contribution'], 200)
        self.assertEqual([p['contribution_percent'] for p in saved['participants']], [50, 50])
        self.assertEqual([p['expected_dividend'] for p in saved['participants']], [61.728394, 49.382716])
        self.assertEqual(saved['unallocated_profit'], 12.345679)
        total = sum((Decimal(str(p['expected_dividend'])) for p in saved['participants']), Decimal(str(saved['unallocated_profit'])))
        self.assertEqual(total, Decimal('123.456789'))

    def test_project_largest_remainders_have_stable_ties_and_funding_sums_to_100(self):
        self.state['projects'] = [project(expected_profit='.000001', participants=[
            dict(name='A', contribution_amount=1, dividend_percent=50),
            dict(name='B', contribution_amount=1, dividend_percent=50)])]
        saved = replay(self.state)['projects'][0]
        self.assertEqual([p['expected_dividend'] for p in saved['participants']], [.000001, 0])
        self.state['projects'] = [project(expected_profit=1, participants=[
            dict(name='A', contribution_amount=1, dividend_percent='33.333333'),
            dict(name='B', contribution_amount=1, dividend_percent='33.333333'),
            dict(name='C', contribution_amount=1, dividend_percent='33.333334')])]
        saved = replay(self.state)['projects'][0]
        self.assertEqual([p['contribution_percent'] for p in saved['participants']], [33.333334, 33.333333, 33.333333])
        self.assertEqual([p['expected_dividend'] for p in saved['participants']], [.333333, .333333, .333334])

    def test_zero_funding_allows_independent_labor_dividends(self):
        self.state['projects'] = [project(expected_profit=100, participants=[
            dict(name='Organizer', contribution_amount=0, dividend_percent=30),
            dict(name='Supplier', contribution_amount=0, dividend_percent=70)])]
        saved = replay(self.state)['projects'][0]
        self.assertEqual(saved['total_contribution'], 0)
        self.assertEqual([p['contribution_percent'] for p in saved['participants']], [0, 0])
        self.assertEqual([p['expected_dividend'] for p in saved['participants']], [30, 70])
        self.assertTrue(saved['allocation_complete'])

    def test_project_guards_duplicate_names_allocations_rates_and_positive_conversions(self):
        rows = [dict(name='Kevin', contribution_amount=100, dividend_percent=60),
                dict(name='Partner', contribution_amount=50, dividend_percent=30)]
        invalid = [dict(participants=[]), dict(participants=[rows[0]] * 51),
                   dict(participants=[rows[0], dict(rows[1], name=' kevin ')]),
                   dict(participants=[rows[0], dict(rows[1], dividend_percent=41)]),
                   dict(participants=[dict(rows[0], contribution_amount=-1)]),
                   dict(participants=[dict(rows[0], currency='CNY')]),
                   dict(participants=[dict(rows[0], exchange_rate=2)]),
                   dict(participants=[dict(rows[0], currency='CNY', contribution_amount='.000001', exchange_rate='.000000000001')]),
                   dict(expected_profit=-1)]
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                project(**values)

    def test_nested_canonical_requests_and_exact_edit_fields_preserve_precision(self):
        values = dict(date='2026-01-01', name='Project', expected_profit='999999999999.000001', request_id=uuid4(),
                      participants=[dict(name='A', contribution_amount='999999999999.000001', dividend_percent='33.333333')])
        request = ProjectCreate(**values)
        raw = request_data(request)
        changed_spelling = ProjectCreate(**dict(values, participants=[dict(values['participants'][0], contribution_amount='999999999999.0000010', exchange_rate='1.000000000000')]))
        self.assertEqual(request_data(changed_spelling), raw)
        self.state['projects'] = [dict(raw, id=1, version=1, voided=False)]
        saved = replay(self.state)['projects'][0]
        self.assertEqual(saved['request_fields']['expected_profit'], '999999999999.000001')
        self.assertEqual(saved['request_fields']['participants'][0]['contribution_amount'], '999999999999.000001')
        updated = request_data(ProjectUpdate(**saved['request_fields'], version=1))
        updated.pop('version')
        raw.pop('request_id')
        self.assertEqual(updated, raw)

    def test_exact_project_calculations_reconcile_after_json_near_input_cap(self):
        self.state['projects'] = [project(expected_profit='999999999999.000001', participants=[
            dict(name='A', contribution_amount='999999999999.000001', dividend_percent='33.333333'),
            dict(name='B', contribution_amount='999999999999.000001', dividend_percent='33.333333')])]
        saved = json.loads(json.dumps(replay(self.state)))['projects'][0]
        exact = saved['calculation_fields']
        self.assertEqual(exact['total_contribution'], '1999999999998.000002')
        self.assertEqual(exact['participants'][0]['base_amount'], '999999999999.000001')
        self.assertEqual((exact['dividend_percent_total'], exact['unallocated_percent']), ('66.666666', '33.333334'))
        self.assertEqual(sum(Decimal(p['contribution_percent']) for p in exact['participants']), Decimal(100))
        paid = sum((Decimal(p['expected_dividend']) for p in exact['participants']), Decimal(exact['unallocated_profit']))
        self.assertEqual(paid, Decimal(saved['request_fields']['expected_profit']))
        self.assertIsInstance(saved['total_contribution'], float)

    def test_project_links_keep_bases_separate_and_voided_history_readable(self):
        self.state['projects'] = [project(expected_profit=100)]
        self.state['products'] = [product(), product(2, sku='CNY', currency='CNY')]
        self.state['movements'] = [movement(project_id=1), movement(2, product_id=2, currency='USD', exchange_rate=7, project_id=1)]
        result = replay(self.state)
        saved = result['projects'][0]
        self.assertEqual((saved['movement_ids'], saved['active_movement_ids']), ([1, 2], [1, 2]))
        self.assertEqual(saved['expected_profit'], 100)
        values = {r['currency']: r for r in result['summary']}
        self.assertEqual((values['USD']['inventory_cost'], values['CNY']['inventory_cost']), (100, 700))
        with self.assertRaisesRegex(FinanceError, 'active movements'):
            validate_void(self.state, 'projects', self.state['projects'][0])
        self.state['projects'][0]['voided'] = True
        for item in self.state['movements']:
            item['voided'] = True
        saved = replay(self.state)['projects'][0]
        self.assertEqual(saved['status'], 'void')
        self.assertEqual((saved['movement_ids'], saved['active_movement_ids']), ([1, 2], []))

    def test_project_currency_is_fixed_and_link_clear_differs_from_omission(self):
        plan = project()
        self.state['projects'] = [plan]
        values = request_data(ProjectUpdate(date='2026-01-01', name='Tea', currency='CNY', participants=plan['participants'], version=1))
        with self.assertRaisesRegex(FinanceError, 'Project currency'):
            validate_edit(self.state, 'projects', plan, values)
        base = dict(date='2026-01-02', product_id=1, kind='purchase', quantity=10, unit_price=10)
        self.assertNotIn('project_id', request_data(MovementCreate(**base, request_id=uuid4())))
        self.assertNotIn('project_id', request_data(MovementUpdate(**base, version=1)))
        self.assertIsNone(request_data(MovementUpdate(**base, project_id=None, version=1))['project_id'])


class ExchangeReplayTests(unittest.TestCase):
    def test_source_fee_adds_debit_once_and_leaves_transfer_totals_unchanged(self):
        state = empty_state()
        state['exchanges'] = [exchange(fee_amount=5)]
        state['transfers'] = [record(TransferCreate, date='2026-01-01', direction='in', amount=25)]
        result = replay(state)
        saved = result['exchanges'][0]
        self.assertEqual((saved['debited_amount'], saved['received_amount'], saved['exchange_rate']), (1005, 7200, 7.2))
        self.assertAlmostEqual(saved['inverse_rate'], 1 / 7.2)
        self.assertAlmostEqual(saved['effective_rate'], 7200 / 1005)
        values = {r['currency']: r for r in result['summary']}
        self.assertEqual((values['USD']['exchange_out'], values['USD']['exchange_fees'], values['USD']['exchange_net']), (1000, 5, -1005))
        self.assertEqual((values['CNY']['exchange_in'], values['CNY']['exchange_fees'], values['CNY']['exchange_net']), (7200, 0, 7200))
        self.assertEqual((values['USD']['transfer_in'], values['USD']['transfer_out'], values['USD']['transfer_net']), (25, 0, 25))
        self.assertEqual(state['exchanges'][0]['from_amount'], '1000')

    def test_target_fee_subtracts_receipt_once_without_source_debit_fee(self):
        state = empty_state()
        state['exchanges'] = [exchange(fee_currency='CNY', fee_amount=35)]
        result = replay(state)
        saved = result['exchanges'][0]
        self.assertEqual((saved['debited_amount'], saved['received_amount'], saved['exchange_rate']), (1000, 7165, 7.2))
        self.assertEqual(saved['effective_rate'], 7.165)
        values = {r['currency']: r for r in result['summary']}
        self.assertEqual((values['USD']['exchange_out'], values['USD']['exchange_fees'], values['USD']['exchange_net']), (1000, 0, -1000))
        self.assertEqual((values['CNY']['exchange_in'], values['CNY']['exchange_fees'], values['CNY']['exchange_net']), (7200, 35, 7165))

    def test_void_removes_both_legs_and_fee_but_keeps_exchange_history(self):
        state = empty_state()
        first = exchange(fee_amount=5)
        first['voided'] = True
        state['exchanges'] = [first]
        result = replay(state)
        self.assertEqual(result['summary'], [])
        self.assertTrue(result['exchanges'][0]['voided'])
        self.assertEqual(result['exchanges'][0]['debited_amount'], 1005)

    def test_tiny_nonzero_exchange_rate_does_not_round_to_zero(self):
        state = empty_state()
        state['exchanges'] = [exchange(from_amount='1000000000000', to_amount='0.000001')]
        saved = replay(state)['exchanges'][0]
        self.assertEqual(saved['exchange_rate'], 1e-18)
        self.assertEqual(saved['inverse_rate'], 1e18)
        self.assertGreater(saved['effective_rate'], 0)

    def test_exchange_summary_aggregates_currency_legs_without_converting(self):
        state = empty_state()
        state['exchanges'] = [exchange(fee_amount=5), exchange(2, from_currency='CNY', to_currency='USD', from_amount=3600, to_amount=500, fee_currency='USD', fee_amount=2)]
        values = {r['currency']: r for r in replay(state)['summary']}
        self.assertEqual((values['USD']['exchange_in'], values['USD']['exchange_out'], values['USD']['exchange_fees'], values['USD']['exchange_net']), (500, 1000, 7, -507))
        self.assertEqual((values['CNY']['exchange_in'], values['CNY']['exchange_out'], values['CNY']['exchange_fees'], values['CNY']['exchange_net']), (7200, 3600, 0, 3600))


class FinanceReplayTests(unittest.TestCase):
    def setUp(self):
        self.state = empty_state()
        self.state['products'] = [product()]

    def test_legacy_actor_blanks_and_each_payment_history_keep_independent_names(self):
        self.state['transfers'] = [record(TransferCreate, date='2026-01-01', direction='in', amount=10, counterparty='Do not infer me')]
        self.state['exchanges'] = [exchange(counterparty='Do not infer me')]
        loan = record(LoanCreate, date='2026-01-01', direction='lent', counterparty='Borrower', principal=100)
        loan['repayments'] = [payment(amount=10, payer='  Repayment sender ', recipient=' Repayment receiver ')]
        self.state['loans'] = [loan]
        purchase = movement(paid_amount=20, payer='Initial payer', recipient='Initial recipient')
        purchase['payments'] = [inventory_payment(amount=5),
            dict(inventory_payment(2, amount=15, payer='Later payer', recipient='Later recipient'), voided=True)]
        self.state['movements'] = [purchase]
        original = deepcopy(self.state)
        result = replay(self.state)
        for kind in ('transfers', 'loans', 'exchanges'):
            self.assertEqual((result[kind][0]['payer'], result[kind][0]['recipient']), ('', ''))
        saved_loan = result['loans'][0]
        self.assertEqual((saved_loan['repayments'][0]['payer'], saved_loan['repayments'][0]['recipient']),
                         ('Repayment sender', 'Repayment receiver'))
        self.assertEqual(saved_loan['outstanding'], 90)
        saved = result['movements'][0]
        self.assertEqual((saved['payer'], saved['recipient'], saved['paid_amount']), ('Initial payer', 'Initial recipient', 25))
        self.assertEqual((saved['payments'][0]['payer'], saved['payments'][0]['recipient']), ('', ''))
        self.assertEqual((saved['payments'][1]['payer'], saved['payments'][1]['recipient']), ('Later payer', 'Later recipient'))
        self.assertEqual(self.state, original)

    def test_moving_average_partial_payments_and_profit(self):
        a = movement(quantity=10, unit_price=10, paid_amount=50)
        a['payments'] = [payment(amount=25)]
        b = movement(2, date='2026-01-03', quantity=10, unit_price=20)
        sale = movement(3, date='2026-01-04', kind='sale', quantity=4, unit_price=30, paid_amount=20)
        self.state['movements'] = [sale, b, a]  # Input order cannot determine costing.
        result = replay(self.state)
        p = result['products'][0]
        self.assertEqual((p['quantity'], p['average_cost'], p['inventory_cost'], p['realized_profit']), (16, 15, 240, 60))
        sale = result['movements'][0]
        self.assertEqual((sale['cost_of_goods'], sale['realized_profit'], sale['remaining_payment']), (60, 60, 100))
        purchase = result['movements'][2]
        self.assertEqual((purchase['initial_paid_amount'], purchase['paid_amount'], purchase['remaining_payment'], purchase['status']), (50, 75, 25, 'partial'))
        self.assertEqual(purchase['payments'][0]['amount'], 25)
        values = result['summary'][0]
        self.assertEqual((values['purchase_total'], values['sales_total'], values['payable'], values['receivable']), (300, 120, 225, 100))
        self.assertEqual(self.state['movements'][2]['paid_amount'], '50')

    def test_zero_price_gift_deducts_moving_average_cost_without_payment_balance(self):
        for currency, rate in (('USD', 1), ('CNY', '.125')):
            with self.subTest(currency=currency):
                gift = movement(3, date='2026-01-04', kind='sale', quantity=4, unit_price=0,
                                currency=currency, exchange_rate=rate, note='Gifted merchandise')
                self.state['movements'] = [gift,
                    movement(2, date='2026-01-03', quantity=10, unit_price=20, paid_amount=200),
                    movement(quantity=10, unit_price=10, paid_amount=100)]
                result = replay(self.state)
                saved = result['movements'][0]
                self.assertEqual((saved['total'], saved['base_total'], saved['paid_amount'],
                                  saved['remaining_payment'], saved['status']), (0, 0, 0, 0, 'paid'))
                self.assertEqual((saved['cost_of_goods'], saved['realized_profit']), (60, -60))
                stock = result['products'][0]
                self.assertEqual((stock['quantity'], stock['average_cost'], stock['inventory_cost'],
                                  stock['realized_profit']), (16, 15, 240, -60))
                for values in result['summary']:
                    self.assertEqual((values['sales_total'], values['payable'], values['receivable']), (0, 0, 0))
                gift['voided'] = True
                stock = replay(self.state)['products'][0]
                self.assertEqual((stock['quantity'], stock['inventory_cost'], stock['realized_profit']), (20, 300, 0))

    def test_zero_price_last_gift_clears_cost_and_rejects_receipts(self):
        gift = movement(2, date='2026-01-03', kind='sale', quantity=3, unit_price='0.000000')
        self.state['movements'] = [movement(quantity=3, unit_price='.333333', paid_amount='.999999'), gift]
        result = replay(self.state)
        saved = result['movements'][0]
        self.assertEqual((saved['cost_of_goods'], saved['realized_profit']), (.999999, -.999999))
        self.assertEqual((result['products'][0]['quantity'], result['products'][0]['inventory_cost']), (0, 0))
        self.assertEqual((result['summary'][0]['payable'], result['summary'][0]['receivable']), (0, 0))
        with self.assertRaisesRegex(ValidationError, 'Paid amount cannot exceed'):
            movement(kind='sale', unit_price=0, paid_amount='.000001')
        gift['payments'] = [inventory_payment(amount='.000001')]
        with self.assertRaisesRegex(FinanceError, 'Payments cannot exceed'):
            replay(self.state)

    def test_backdated_sale_or_voided_purchase_cannot_create_negative_stock(self):
        self.state['movements'] = [movement(), movement(2, date='2026-01-01', kind='sale', quantity=1)]
        with self.assertRaisesRegex(FinanceError, 'Insufficient inventory'):
            replay(self.state)
        self.state['movements'][1]['date'] = '2026-01-03'
        self.state['movements'][0]['voided'] = True
        with self.assertRaisesRegex(FinanceError, 'Insufficient inventory'):
            replay(self.state)

    def test_same_date_respects_stable_creation_order(self):
        self.state['movements'] = [movement(2, kind='sale', quantity=10), movement(1)]
        self.assertEqual(replay(self.state)['products'][0]['quantity'], 0)
        self.state['movements'][0]['id'] = 0
        with self.assertRaises(FinanceError):
            replay(self.state)

    def test_last_sale_clears_rounding_residue(self):
        self.state['movements'] = [movement(quantity=3, unit_price='0.333333'),
                                   movement(2, date='2026-01-03', kind='sale', quantity=1, unit_price=1),
                                   movement(3, date='2026-01-04', kind='sale', quantity=2, unit_price=1)]
        p = replay(self.state)['products'][0]
        self.assertEqual(p['quantity'], 0)
        self.assertEqual(p['inventory_cost'], 0)
        self.assertEqual(p['realized_profit'], 2.000001)

    def test_repayment_balance_voiding_and_edit_integrity(self):
        loan = record(LoanCreate, date='2026-01-01', direction='lent', counterparty='K', principal=100)
        loan['repayments'] = [payment(amount=40), payment(2, amount=10)]
        self.state['loans'] = [loan]
        result = replay(self.state)['loans'][0]
        self.assertEqual((result['repaid'], result['outstanding'], result['status']), (50, 50, 'partial'))
        loan['repayments'][1]['voided'] = True
        self.assertEqual(replay(self.state)['loans'][0]['outstanding'], 60)
        loan['principal'] = '30'
        with self.assertRaisesRegex(FinanceError, 'principal'):
            replay(self.state)
        loan['principal'] = '100'
        loan['date'] = '2026-01-04'
        with self.assertRaisesRegex(FinanceError, 'date'):
            replay(self.state)

    def test_currencies_are_separate_and_internal_transfer_is_neutral(self):
        for index, (currency, direction, amount) in enumerate((('USD', 'in', 100), ('CNY', 'out', 300), ('USD', 'internal', 999))):
            self.state['transfers'].append(record(TransferCreate, index+1, date='2026-01-01', direction=direction, amount=amount, currency=currency))
        legacy = record(TransferCreate, 4, date='2026-01-01', direction='in', amount=50)
        legacy['currency'] = 'HKD'  # Previously persisted record, not a new request.
        self.state['transfers'].append(legacy)
        values = {r['currency']: r for r in replay(self.state)['summary']}
        self.assertEqual(values['USD']['transfer_net'], 100)
        self.assertEqual(values['CNY']['transfer_net'], -300)
        self.assertEqual(values['HKD']['transfer_net'], 50)
        self.assertEqual(self.state['transfers'][3]['currency'], 'HKD')

    def test_payment_history_restricts_void_and_historical_meaning(self):
        loan = record(LoanCreate, date='2026-01-01', direction='borrowed', counterparty='K', principal=100)
        loan['repayments'] = [payment()]
        self.state['loans'] = [loan]
        with self.assertRaisesRegex(FinanceError, 'repayments'):
            validate_void(self.state, 'loans', loan)
        values = request_data(LoanUpdate(date='2026-01-01', direction='lent', counterparty='K', principal=100, version=1))
        with self.assertRaisesRegex(FinanceError, 'direction'):
            validate_edit(self.state, 'loans', loan, values)
        loan['repayments'][0]['voided'] = True
        validate_void(self.state, 'loans', loan)

    def test_product_currency_unit_sku_and_history_are_protected(self):
        self.state['movements'] = [movement()]
        p = self.state['products'][0]
        values = request_data(ProductUpdate(name='Tea', currency='CNY', version=1))
        with self.assertRaisesRegex(FinanceError, 'Currency'):
            validate_edit(self.state, 'products', p, values)
        with self.assertRaisesRegex(FinanceError, 'history'):
            validate_void(self.state, 'products', p)
        self.state['products'] = [product(sku='TEA'), product(2, sku='tea')]
        with self.assertRaisesRegex(FinanceError, 'SKU'):
            replay(self.state)

    def test_opening_inventory_has_cost_but_no_payables(self):
        self.state['movements'] = [movement(kind='opening', quantity=5, unit_price=4)]
        result = replay(self.state)
        self.assertEqual(result['products'][0]['inventory_cost'], 20)
        self.assertEqual(result['summary'][0]['purchase_total'], 0)
        self.assertEqual(result['summary'][0]['payable'], 0)
        self.assertEqual(result['movements'][0]['status'], 'paid')


if __name__ == '__main__':
    unittest.main()
