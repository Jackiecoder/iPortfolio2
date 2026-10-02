import asyncio
from datetime import date, datetime, timedelta
from decimal import Decimal
import threading
import unittest
from unittest.mock import MagicMock, patch

from app import main
from app.models import ActionType, Transaction
from app.portfolio import Portfolio
from app.cache_service import cache_service
from app.price_service import PriceService


class DashboardCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original = main.portfolio
        main.portfolio = Portfolio(adjust_splits=False)
        main._clear_api_cache()
        self.release = threading.Event()

    async def asyncTearDown(self):
        self.release.set()
        if main._dashboard_tasks:
            await asyncio.gather(*list(main._dashboard_tasks.values()), return_exceptions=True)
        main.portfolio = self.original
        main._clear_api_cache()

    async def test_positions_do_not_wait_for_any_market_data(self):
        main.portfolio.add_transactions([Transaction(
            date=date(2025, 1, 2), asset='AAPL', action=ActionType.BUY,
            quantity=Decimal('5'), ave_price=Decimal('123.45'),
        )])
        with patch.object(main.price_service, 'get_prices_batch', side_effect=AssertionError('Quote request')), \
             patch.object(main.price_service, 'get_year_start_prices_batch', side_effect=AssertionError('History request')):
            response = await main.get_positions()
        holding = response['holdings'][0]
        self.assertEqual(holding['quantity'], 5)
        self.assertEqual(holding['cost_basis'], 617.25)
        self.assertEqual(holding['avg_cost'], 123.45)
        self.assertTrue(holding['prices_pending'])
        self.assertIsNone(holding['current_price'])
        self.assertIsNone(holding['total_pnl'])

    async def test_concurrent_performance_ranges_share_one_build(self):
        started = threading.Event()
        def build(active):
            started.set()
            self.release.wait(3)
            return {'performance': [{'date':'2025-01-01'}, {'date':'2026-01-01'}]}
        with patch.object(main, '_build_performance_response', side_effect=build) as builder:
            all_task = asyncio.create_task(main.get_performance(None, None))
            await asyncio.to_thread(started.wait, 3)
            ytd_task = asyncio.create_task(main.get_performance('2026-01-01', '2026-12-31'))
            self.release.set()
            all_data, ytd = await asyncio.gather(all_task, ytd_task)
        self.assertEqual(builder.call_count, 1)
        self.assertEqual(len(all_data['performance']), 2)
        self.assertEqual(ytd['performance'], [{'date':'2026-01-01'}])

    async def test_expired_snapshot_returns_immediately_and_refresh_is_shared(self):
        old = {'holdings': [{'symbol':'AAPL'}], 'computed_at':'2026-09-07T09:00:00-04:00'}
        main._api_cache['summary'] = (old, datetime.now()-timedelta(minutes=3))
        started = threading.Event()
        def build(active):
            started.set()
            self.release.wait(3)
            return {'holdings': [{'symbol':'MSFT'}]}
        with patch.object(main, '_build_summary_response', side_effect=build) as builder:
            stale = await asyncio.wait_for(main.get_summary(), .5)
            self.assertEqual(stale['cache_status'], 'stale')
            self.assertEqual(stale['computed_at'], old['computed_at'])
            await asyncio.to_thread(started.wait, 3)
            fresh_task = asyncio.create_task(main.get_summary(wait_for_fresh=True))
            self.release.set()
            fresh = await fresh_task
        self.assertEqual(builder.call_count, 1)
        self.assertEqual(fresh['cache_status'], 'fresh')
        self.assertEqual(fresh['holdings'][0]['symbol'], 'MSFT')

    async def test_ledger_reload_cannot_publish_or_return_old_calculation(self):
        old_portfolio = main.portfolio
        started = threading.Event()
        def build(active):
            if active is old_portfolio:
                started.set()
                self.release.wait(3)
                return {'holdings': [{'symbol':'OLD'}]}
            return {'holdings': [{'symbol':'NEW'}]}
        with patch.object(main, '_build_summary_response', side_effect=build):
            request = asyncio.create_task(main.get_summary())
            await asyncio.to_thread(started.wait, 3)
            main.portfolio = Portfolio(adjust_splits=False)
            main._clear_api_cache()
            self.release.set()
            result = await request
        self.assertEqual(result['holdings'][0]['symbol'], 'NEW')
        self.assertEqual(main._get_api_cache('summary')['holdings'][0]['symbol'], 'NEW')

    async def test_failed_refresh_retains_snapshot_and_allows_retry(self):
        main._api_cache['summary'] = ({'holdings':[]}, datetime.now()-timedelta(minutes=3))
        with patch.object(main, '_build_summary_response', side_effect=RuntimeError('provider down')):
            stale = await main.get_summary()
            await asyncio.gather(*list(main._dashboard_tasks.values()), return_exceptions=True)
        self.assertEqual(stale['cache_status'], 'stale')
        self.assertIsNotNone(main._get_stale_api_cache('summary', timedelta(days=1)))
        with patch.object(main, '_build_summary_response', return_value={'holdings':[{'symbol':'AAPL'}]}):
            fresh = await main.get_summary(wait_for_fresh=True)
        self.assertEqual(fresh['holdings'][0]['symbol'], 'AAPL')

    async def test_daily_and_monthly_share_history(self):
        with patch.object(main.portfolio, 'get_daily_pnl_history', return_value=[{'date': str(i)} for i in range(400)]) as history:
            daily, monthly = await asyncio.gather(main.get_daily_pnl(42), main.get_daily_pnl(400))
        self.assertEqual(history.call_count, 1)
        self.assertEqual(len(daily['daily_pnl']), 42)
        self.assertEqual(len(monthly['daily_pnl']), 400)


class HistoricalBatchCacheTests(unittest.TestCase):
    def test_one_query_returns_per_symbol_prices_and_respects_cutoff(self):
        pool = MagicMock()
        conn = pool.connection.return_value.__enter__.return_value
        conn.execute.return_value.fetchall.return_value = [('AAPL',date(2026,1,2),Decimal('150'))]
        with patch('app.cache_service.get_pool', return_value=pool), \
             patch.object(cache_service, '_get_cache_cutoff_date', return_value=date(2026,1,5)):
            result = cache_service.get_historical_prices_batch(['AAPL','MSFT'],date(2026,1,1),date(2026,1,9))
        conn.execute.assert_called_once()
        self.assertEqual(conn.execute.call_args.args[1], (['AAPL','MSFT'],date(2026,1,1),date(2026,1,4)))
        self.assertEqual(result, {'AAPL': {date(2026,1,2): Decimal('150')}, 'MSFT': {}})

    def test_cached_symbol_batch_never_falls_back_to_individual_db_reads(self):
        service = PriceService()
        prices = {'AAPL':{date(2025,1,1):Decimal('100')}, 'MSFT':{date(2025,1,1):Decimal('200')}}
        with patch.object(cache_service, 'get_historical_prices_batch', return_value=prices) as batch, \
             patch.object(cache_service, 'get_historical_prices', side_effect=AssertionError('Individual DB read')), \
             patch('app.price_service.yf.download', side_effect=AssertionError('No remote data needed')):
            result = service.get_historical_prices_batch(['AAPL','MSFT'],datetime(2025,1,1),datetime(2025,1,1))
        batch.assert_called_once()
        self.assertEqual(result, prices)
