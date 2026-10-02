"""No network or production database: exact lot accounting and API regressions."""
import asyncio
from datetime import date, datetime, time
from decimal import Decimal as D
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from app import main, repository
from app.models import CostBasisMethod as M, LotAllocation, MARKET_TZ, Transaction
from app.portfolio import LotInfo, Portfolio
from app.sale_service import prepare_sale, preview_sale, validate_frozen_sales
from app.tax_lots import is_long_term, select_lots


def buy(id, acquired, price, qty='10', broker='schwab', asset='TEST', at=None):
    return Transaction(id=id, date=date.fromisoformat(acquired), asset=asset, action='BUY',
                       quantity=D(qty), ave_price=D(price), broker=broker, executed_at=at)


def sell(qty='5', price='100', method=M.FIFO, allocations=(), **kwargs):
    return Transaction(date=kwargs.pop('date', date(2026, 9, 21)), asset=kwargs.pop('asset', 'TEST'),
                       action='SELL', quantity=D(qty), ave_price=D(price),
                       broker=kwargs.pop('broker', 'schwab'), cost_basis_method=method,
                       lot_allocations=list(allocations), **kwargs)


class LotSelectionTests(TestCase):
    def setUp(self):
        self.no_splits = patch('app.split_service.split_service.get_adjustment_factor', return_value=D(1))
        self.no_splits.start()
        self.addCleanup(self.no_splits.stop)
        self.ledger = [buy(1, '2025-01-01', '80'), buy(2, '2026-06-01', '95'),
                       buy(3, '2026-07-01', '120')]

    def replay(self, transactions):
        p = Portfolio()
        p.add_transactions(transactions)
        return p

    def test_all_automatic_methods_and_partial_final_lot(self):
        for method, expected in [(M.FIFO, [1, 2]), (M.LIFO, [3, 2]),
                                 (M.HIGH_COST, [3, 2]), (M.LOW_COST, [1, 2]),
                                 (M.TAX_OPTIMIZER, [3, 1])]:
            with self.subTest(method=method):
                sale = sell('12', method=method)
                prepare_sale(self.ledger, sale)
                self.assertEqual([a.lot_id for a in sale.lot_allocations], expected)
                self.assertEqual([a.quantity for a in sale.lot_allocations], [10, 2])

    def test_optimizer_all_six_groups_order_and_ties(self):
        specs = [(1, '2024-01-01', '150'), (2, '2026-01-01', '120'),
                 (3, '2024-01-02', '100'), (4, '2026-01-02', '100'),
                 (5, '2024-01-03', '70'), (6, '2026-01-03', '99'),
                 (7, '2026-01-04', '130'), (8, '2026-01-04', '130')]
        ledger = [buy(i, dt, cost, '1') for i, dt, cost in specs]
        sale = sell('8', method=M.TAX_OPTIMIZER)
        prepare_sale(ledger, sale)
        self.assertEqual([a.lot_id for a in sale.lot_allocations], [7, 8, 2, 1, 4, 3, 5, 6])

    def test_manual_partial_sale_replays_exact_ids_and_realized_terms(self):
        sale = sell('7', method=M.SPECIFIC, allocations=[
            {'lot_id': 1, 'quantity': '2'}, {'lot_id': 3, 'quantity': '5'}])
        prepare_sale(self.ledger, sale)
        # Persist/reload through the same JSON representation used by Postgres.
        loaded_sale = Transaction.model_validate_json(sale.model_dump_json())
        p = self.replay(self.ledger + [loaded_sale])
        recorded = p._sales['TEST'][0]
        self.assertEqual(recorded['cost_basis'], D('760'))
        self.assertEqual(recorded['lt_proceeds'] - recorded['lt_cost_basis'], D('40'))
        self.assertEqual(recorded['st_proceeds'] - recorded['st_cost_basis'], D('-100'))
        self.assertEqual([(l.lot_id, l.quantity) for l in p._lots['TEST']], [(1, 8), (2, 10), (3, 5)])
        self.assertEqual(sum(l.total_cost for l in p._lots['TEST']), D('2190'))

    def test_preview_matches_committed_sale_for_every_method(self):
        for method in M:
            allocations = [{'lot_id': 2, 'quantity': '2'}, {'lot_id': 3, 'quantity': '3'}] if method == M.SPECIFIC else []
            req = main.SalePreviewRequest(date='2026-09-21', asset='test', quantity='5',
                                         ave_price='100', cost_basis_method=method, lot_allocations=allocations)
            preview = preview_sale(self.ledger, req)
            self.assertTrue(preview['valid'], preview)
            sale = sell(method=method, allocations=preview['allocations'])
            prepare_sale(self.ledger, sale)
            p = self.replay(self.ledger + [sale])
            recorded = p._sales['TEST'][0]
            self.assertEqual(float(recorded['cost_basis']), preview['cost_basis'])
            self.assertEqual(float(recorded['proceeds'] - recorded['cost_basis']), preview['realized_pnl'])
            self.assertEqual(float(sum(l.total_cost for l in p._lots['TEST'])), preview['remaining_cost_basis'])

    def test_legacy_sales_remain_fifo_even_with_new_metadata(self):
        sale = sell(method=None, broker='different')
        p = self.replay(self.ledger + [sale])
        self.assertEqual(p._sales['TEST'][0]['cost_basis'], 400)
        self.assertEqual(p._lots['TEST'][0].quantity, 5)

    def test_freezing_high_cost_survives_backdated_higher_cost_buy(self):
        sale = sell(method=M.HIGH_COST)
        prepare_sale(self.ledger, sale)
        new_buy = buy(4, '2026-08-01', '200')
        p = self.replay(self.ledger + [sale, new_buy])
        self.assertEqual(p._sales['TEST'][0]['lot_slices'][0]['lot_id'], 3)

    def test_invalid_manual_choices_fail_instead_of_falling_back_to_fifo(self):
        choices = [[], [{'lot_id': 1, 'quantity': '4'}], [{'lot_id': 1, 'quantity': '11'}],
                   [{'lot_id': 999, 'quantity': '5'}]]
        for choice in choices:
            with self.subTest(choice=choice), self.assertRaises(ValueError):
                prepare_sale(self.ledger, sell(method=M.SPECIFIC, allocations=choice))
        with self.assertRaises(ValidationError):
            sell(allocations=[{'lot_id': 1, 'quantity': '2'}, {'lot_id': 1, 'quantity': '3'}])

    def test_overselling_and_exhausted_saved_lot_fail(self):
        with self.assertRaises(ValueError):
            prepare_sale(self.ledger, sell('31'))
        first = sell('10', method=M.HIGH_COST)
        prepare_sale(self.ledger, first)
        second = sell('1', allocations=[{'lot_id': 3, 'quantity': '1'}])
        with self.assertRaises(ValueError):
            prepare_sale(self.ledger + [first], second)

    def test_account_isolation_case_normalization_and_ambiguous_account(self):
        ledger = self.ledger + [buy(4, '2026-08-01', '500', broker='ira')]
        sale = sell(method=M.HIGH_COST, broker=' SCHWAB ')
        prepare_sale(ledger, sale)
        self.assertEqual(sale.lot_allocations[0].lot_id, 3)
        with self.assertRaisesRegex(ValueError, 'multiple accounts'):
            prepare_sale(ledger, sell(broker=None))
        with self.assertRaises(ValueError):
            prepare_sale(ledger, sell(method=M.SPECIFIC, allocations=[{'lot_id': 4, 'quantity': '5'}]))
        with self.assertRaises(ValueError):
            prepare_sale(ledger, sell(broker='unknown'))

    def test_unassigned_account_can_be_selected_explicitly(self):
        ledger = self.ledger + [buy(4, '2026-08-01', '500', broker=None)]
        sale = sell(broker='__unassigned__')
        prepare_sale(ledger, sale)
        self.assertIsNone(sale.broker)
        self.assertEqual(sale.lot_allocations[0].lot_id, 4)
        self.replay(ledger + [sale])

    def test_single_account_is_inferred_and_other_symbol_is_excluded(self):
        ledger = self.ledger + [buy(4, '2026-08-01', '500', asset='OTHER', broker='ira')]
        sale = sell(broker=None)
        prepare_sale(ledger, sale)
        self.assertEqual(sale.broker, 'schwab')

    def test_execution_time_excludes_future_lots_and_same_time_uses_id_order(self):
        ledger = [buy(1, '2026-09-21', '80', at=datetime(2026, 9, 21, 10, tzinfo=MARKET_TZ)),
                  buy(2, '2026-09-21', '200', at=datetime(2026, 9, 21, 11, tzinfo=MARKET_TZ))]
        sale = sell(method=M.HIGH_COST, executed_at=datetime(2026, 9, 21, 10, tzinfo=MARKET_TZ))
        prepare_sale(ledger, sale)
        self.assertEqual(sale.lot_allocations[0].lot_id, 1)
        with self.assertRaises(ValueError):
            prepare_sale(ledger, sell(date=date(2026, 9, 20)))

    def test_backdated_sale_cannot_invalidate_future_frozen_sale(self):
        future = sell('10', method=M.HIGH_COST)
        prepare_sale(self.ledger, future)
        earlier = sell('1', method=M.HIGH_COST, date=date(2026, 9, 1))
        prepare_sale(self.ledger, earlier)
        with self.assertRaises(ValueError):
            validate_frozen_sales(self.ledger + [earlier, future])

    def test_fractional_lot_selection_remains_exact(self):
        ledger = [buy(1, '2026-01-01', '100', '0.123456789123'),
                  buy(2, '2026-02-01', '200', '0.2')]
        sale = sell('0.234567891234', method=M.HIGH_COST)
        prepare_sale(ledger, sale)
        self.assertEqual(sum(a.quantity for a in sale.lot_allocations), sale.quantity)
        self.assertEqual(sale.lot_allocations[1].quantity, D('0.034567891234'))
        self.assertEqual(sum(l.quantity for l in self.replay(ledger + [sale])._lots['TEST']), D('0.088888897889'))

    def test_split_adjusted_inventory_and_sale_date_allocations(self):
        split_date = date(2026, 8, 1)
        def factor(symbol, start, end):
            return D(2) if start < split_date <= end else D(1)
        with patch('app.split_service.split_service.get_adjustment_factor', side_effect=factor):
            ledger = [buy(1, '2026-01-01', '100', '10')]
            before = sell('3', price='150', date=date(2026, 7, 1))
            prepare_sale(ledger, before)
            self.assertEqual(before.lot_allocations[0].quantity, 3)
            after = sell('4', price='75')
            prepare_sale(ledger + [before], after)
            p = self.replay(ledger + [before, after])
            self.assertEqual(p._lots['TEST'][0].quantity, 10)
            self.assertEqual(p._lots['TEST'][0].cost_per_share, 50)
            self.assertEqual([s['cost_basis'] for s in p._sales['TEST']], [300, 200])

    def test_irs_calendar_year_boundary_including_leap_year(self):
        for acquired, same_year_end, next_day in [
            (date(2025, 9, 21), date(2026, 9, 21), date(2026, 9, 22)),
            (date(2023, 3, 1), date(2024, 3, 1), date(2024, 3, 2)),
            (date(2024, 2, 29), date(2025, 2, 28), date(2025, 3, 1)),
        ]:
            self.assertFalse(is_long_term(acquired, same_year_end))
            self.assertTrue(is_long_term(acquired, next_day))

    def test_numeric_invalid_values_and_non_sell_metadata_rejected(self):
        for qty in ('0', '-1', 'NaN', 'Infinity'):
            with self.subTest(qty=qty), self.assertRaises(ValidationError):
                sell(qty)
        with self.assertRaises(ValidationError):
            LotAllocation(lot_id=1, quantity='-1')
        with self.assertRaises(ValidationError):
            Transaction(date='2026-01-01', asset='TEST', action='BUY', quantity=1,
                        ave_price=100, cost_basis_method=M.FIFO)

    def test_preview_never_mutates_ledger_and_reports_invalid_selection_with_inventory(self):
        before = [t.model_dump_json() for t in self.ledger]
        req = main.SalePreviewRequest(date='2026-09-21', asset='TEST', quantity='5',
                                     ave_price='100', cost_basis_method=M.SPECIFIC)
        preview = preview_sale(self.ledger, req)
        self.assertFalse(preview['valid'])
        self.assertEqual(len(preview['lots']), 3)
        self.assertEqual([t.model_dump_json() for t in self.ledger], before)

    def test_filtered_transaction_history_uses_saved_lots_before_limiting(self):
        sale = sell('5', method=M.HIGH_COST)
        prepare_sale(self.ledger, sale)
        gas = Transaction(date='2026-09-20', asset='TEST', action='GAS', quantity=1)
        p = self.replay(self.ledger + [gas, sale])
        rows = p.transaction_history('TEST', limit=1, actions={'BUY', 'SELL'})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['lot_allocations'][0]['lot_id'], 3)
        self.assertEqual(rows[0]['running_quantity'], 24)
        self.assertEqual(rows[0]['running_avg_cost'], float(D('2270') / 24))


class SaleApiTests(IsolatedAsyncioTestCase):
    async def test_preview_endpoint_is_read_only(self):
        with patch.object(repository, 'get_all_transactions', return_value=[buy(1, '2026-01-01', '90')]), \
             patch('app.split_service.split_service.get_adjustment_factor', return_value=D(1)), \
             patch.object(repository, 'insert_transaction', side_effect=AssertionError('Preview wrote')):
            result = await main.preview_sale_transaction(main.SalePreviewRequest(
                date='2026-09-21', asset='TEST', quantity=5, ave_price=100, cost_basis_method=M.HIGH_COST))
            self.assertEqual(result['realized_pnl'], 50)

    async def test_new_sell_defaults_to_explicit_fifo_and_returns_saved_lots(self):
        def writer(txn, broker=None):
            self.assertEqual(txn.cost_basis_method, M.FIFO)
            txn.broker = 'schwab'
            txn.lot_allocations = [LotAllocation(lot_id=17, quantity=5)]
            return 18
        with patch.object(repository, 'insert_transaction', side_effect=writer), \
             patch.object(main, '_queue_ledger_reload'):
            result = await main.create_transaction(main.TransactionCreate(
                date='2026-09-21', asset='TEST', action='SELL', quantity=5, ave_price=100))
        self.assertEqual(result['transaction']['lot_allocations'], [{'lot_id': 17, 'quantity': '5'}])
        self.assertEqual(result['transaction']['broker'], 'schwab')

    async def test_rejected_sale_does_not_invalidate_existing_portfolio(self):
        with patch.object(repository, 'insert_transaction', side_effect=ValueError('Lot no longer available')), \
             patch.object(main, '_queue_ledger_reload') as invalidate:
            with self.assertRaises(HTTPException) as error:
                await main.create_transaction(main.TransactionCreate(
                    date='2026-09-21', asset='TEST', action='SELL', quantity=5, ave_price=100))
            self.assertEqual(error.exception.status_code, 400)
            invalidate.assert_not_called()
