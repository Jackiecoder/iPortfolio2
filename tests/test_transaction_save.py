import asyncio
from datetime import date
from decimal import Decimal
import threading
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from app import main
from app.models import ActionType, Transaction
from app.portfolio import Portfolio


class TransactionSaveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original = main.portfolio
        self.generation = main._portfolio_generation
        main._ledger_reload_task = None
        self.ledger = [Transaction(date=date(2026, 9, 10), asset='AAPL', action=ActionType.BUY,
                                   quantity=Decimal('5'), ave_price=Decimal('100'))]
        self.releases = []
        main.portfolio = self.build()
        main._clear_api_cache()

    async def asyncTearDown(self):
        for event in self.releases:
            event.set()
        if main._ledger_write_tasks:
            await asyncio.gather(*list(main._ledger_write_tasks), return_exceptions=True)
        if main._ledger_reload_task:
            await asyncio.gather(main._ledger_reload_task, return_exceptions=True)
        if main._dashboard_tasks:
            await asyncio.gather(*list(main._dashboard_tasks.values()), return_exceptions=True)
        main._ledger_reload_task = None
        main.portfolio = self.original
        main._portfolio_generation = self.generation
        main._clear_api_cache()

    def build(self):
        loaded = Portfolio(adjust_splits=False)
        loaded.add_transactions(list(self.ledger))
        return loaded

    def insert(self, txn, broker=None):
        self.ledger.append(txn)
        return len(self.ledger)

    def request(self):
        return main.TransactionCreate(date=date(2026, 9, 11), asset='aapl', action='BUY',
                                      quantity=Decimal('1'), ave_price=Decimal('120'), broker='test')

    def block(self):
        event = threading.Event()
        self.releases.append(event)
        return event

    async def test_save_returns_after_commit_without_waiting_for_ledger_or_market_data(self):
        release = self.block()
        started = threading.Event()
        def rebuild():
            started.set()
            release.wait(3)
            return self.build()
        with patch.object(main.repository, 'insert_transaction', side_effect=self.insert), \
             patch.object(main, '_read_portfolio', side_effect=rebuild), \
             patch.object(main, '_refresh_market_snapshot', side_effect=AssertionError('Full recomputation')):
            receipt = await asyncio.wait_for(main.create_transaction(self.request()), .5)
            self.assertEqual(len(self.ledger), 2)
            self.assertEqual(receipt['transaction']['asset'], 'AAPL')
            self.assertEqual(receipt['transaction']['amount'], 120)
            self.assertTrue(receipt['refresh_pending'])
            await asyncio.to_thread(started.wait, 1)
            self.assertFalse(main._ledger_reload_task.done())
            positions = asyncio.create_task(main.get_positions())
            await asyncio.sleep(.01)
            self.assertFalse(positions.done())
            release.set()
            holding = (await positions)['holdings'][0]
            self.assertEqual(holding['quantity'], 6)
            self.assertEqual(holding['cost_basis'], 620)
            self.assertTrue(holding['prices_pending'])

    async def test_slow_commit_keeps_request_pending_but_does_not_block_health(self):
        release = self.block()
        started = threading.Event()
        def insert(txn, broker=None):
            started.set()
            release.wait(3)
            return self.insert(txn, broker)
        with patch.object(main.repository, 'insert_transaction', side_effect=insert), \
             patch.object(main, '_read_portfolio', side_effect=self.build):
            request = asyncio.create_task(main.create_transaction(self.request()))
            await asyncio.to_thread(started.wait, 1)
            self.assertFalse(request.done())
            self.assertEqual(await asyncio.wait_for(main.healthz(), .2), {'status': 'ok'})
            release.set()
            await request
            await main._ensure_portfolio_ready()

    async def test_two_saves_during_reload_publish_only_the_latest_ledger(self):
        release = self.block()
        started = threading.Event()
        calls = 0
        def rebuild():
            nonlocal calls
            calls += 1
            loaded = self.build()
            if calls == 1:
                started.set()
                release.wait(3)
            return loaded
        with patch.object(main.repository, 'insert_transaction', side_effect=self.insert), \
             patch.object(main, '_read_portfolio', side_effect=rebuild):
            first = await main.create_transaction(self.request())
            await asyncio.to_thread(started.wait, 1)
            second = await main.create_transaction(self.request())
            self.assertNotEqual(first['id'], second['id'])
            release.set()
            holding = (await main.get_positions())['holdings'][0]
            self.assertEqual(holding['quantity'], 7)
            self.assertEqual(holding['cost_basis'], 740)
            self.assertEqual(calls, 2)

    async def test_rebuild_failure_does_not_turn_a_committed_save_into_a_save_error(self):
        with patch.object(main.repository, 'insert_transaction', side_effect=self.insert), \
             patch.object(main, '_read_portfolio', side_effect=RuntimeError('split provider unavailable')):
            receipt = await main.create_transaction(self.request())
            self.assertEqual(receipt['id'], 2)
            with self.assertRaises(HTTPException) as error:
                await main.get_positions()
            self.assertEqual(error.exception.status_code, 503)
        with patch.object(main, '_read_portfolio', side_effect=self.build):
            self.assertEqual((await main.get_positions())['holdings'][0]['quantity'], 6)
        self.assertEqual(len(self.ledger), 2)

    async def test_failed_insert_preserves_the_existing_portfolio_and_does_not_queue_reload(self):
        original = main.portfolio
        with patch.object(main.repository, 'insert_transaction', side_effect=RuntimeError('write failed')):
            with self.assertRaises(HTTPException):
                await main.create_transaction(self.request())
        self.assertIs(main.portfolio, original)
        self.assertIsNone(main._ledger_reload_task)
        self.assertEqual(len(self.ledger), 1)

    async def test_disconnect_during_commit_still_invalidates_and_reloads_the_saved_ledger(self):
        release = self.block()
        started = threading.Event()
        def insert(txn, broker=None):
            started.set()
            release.wait(3)
            return self.insert(txn, broker)
        with patch.object(main.repository, 'insert_transaction', side_effect=insert), \
             patch.object(main, '_read_portfolio', side_effect=self.build):
            request = asyncio.create_task(main.create_transaction(self.request()))
            await asyncio.to_thread(started.wait, 1)
            request.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await request
            release.set()
            await asyncio.gather(*list(main._ledger_write_tasks))
            self.assertEqual((await main.get_positions())['holdings'][0]['quantity'], 6)

    async def test_pre_save_summary_cannot_overwrite_the_confirmed_new_position(self):
        release = self.block()
        started = threading.Event()
        original = main.portfolio
        def summary(active):
            if active is original:
                started.set()
                release.wait(3)
            return main._build_positions_response(active)
        with patch.object(main, '_build_summary_response', side_effect=summary), \
             patch.object(main.repository, 'insert_transaction', side_effect=self.insert), \
             patch.object(main, '_read_portfolio', side_effect=self.build):
            old_request = asyncio.create_task(main.get_summary())
            await asyncio.to_thread(started.wait, 1)
            await main.create_transaction(self.request())
            release.set()
            result = await old_request
            self.assertEqual(result['holdings'][0]['quantity'], 6)


class SameDaySplitTests(unittest.TestCase):
    def test_today_trade_never_fetches_split_history(self):
        with patch.object(main.split_service, 'get_splits', side_effect=AssertionError('Remote split request')):
            self.assertEqual(main.split_service.get_adjustment_factor('NEW', date(2026, 9, 11), date(2026, 9, 11)), 1)
