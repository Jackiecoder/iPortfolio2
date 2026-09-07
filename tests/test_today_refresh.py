import asyncio
from datetime import date, datetime
from decimal import Decimal
import threading
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from app import main
from app.price_service import PriceService, cache_service


class TodayRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old_task = main._today_refresh_task
        main._today_refresh_task = None
        main._clear_api_cache()

    async def asyncTearDown(self):
        if main._today_refresh_task is not None:
            await asyncio.gather(main._today_refresh_task, return_exceptions=True)
        main._today_refresh_task = self.old_task
        main._clear_api_cache()

    async def test_manual_refresh_only_computes_today_and_preserves_history(self):
        fake = MagicMock()
        fake.get_intraday_values.return_value = [{"time": "10:01", "daily_pnl": 12}]
        main._set_api_cache('performance_all_all', {'historical': True})
        with (
            patch.object(main, 'portfolio', fake),
            patch.object(main, '_build_summary_response') as summary,
            patch.object(main, '_build_performance_response') as history,
            patch.object(main.price_service, 'clear_cache') as clear,
        ):
            result = await main.refresh_today_intraday()
        self.assertEqual(result['intraday'][0]['daily_pnl'], 12)
        kwargs = fake.get_intraday_values.call_args.kwargs
        self.assertTrue(kwargs['refresh_prices'])
        self.assertFalse(kwargs['use_live_quotes'])
        self.assertEqual(fake.get_intraday_values.call_args.args, ('1m',))
        summary.assert_not_called()
        history.assert_not_called()
        clear.assert_not_called()
        self.assertEqual(main._get_api_cache('performance_all_all'), {'historical': True})

    async def test_timer_and_manual_share_fetch_even_if_first_caller_disconnects(self):
        started, release = threading.Event(), threading.Event()
        payload = {'intraday': [{'time': '10:00'}]}
        def build():
            started.set()
            release.wait(3)
            return payload
        with patch.object(main, '_build_today_snapshot', side_effect=build) as collect:
            timer = asyncio.create_task(main._refresh_today_snapshot())
            await asyncio.to_thread(started.wait, 3)
            manual = asyncio.create_task(main.refresh_today_intraday())
            await asyncio.sleep(0)
            timer.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await timer
            release.set()
            self.assertEqual(await manual, payload)
        collect.assert_called_once()

    async def test_superseded_generation_retries_without_publishing_old_chart(self):
        current = MagicMock()
        current.get_intraday_values.return_value = [{'time': '10:01', 'daily_pnl': 20}]
        obsolete = MagicMock()
        def replace_portfolio(*args, **kwargs):
            main.portfolio = current
            return [{'time': '10:00', 'daily_pnl': 999}]
        obsolete.get_intraday_values.side_effect = replace_portfolio
        with patch.object(main, 'portfolio', obsolete):
            result = await main.refresh_today_intraday()
        self.assertEqual(result['intraday'][0]['daily_pnl'], 20)
        key = f'intraday_{main.market_today().isoformat()}_1m'
        self.assertEqual(main._get_api_cache(key), result)

    async def test_midnight_result_retries_for_new_date(self):
        fake = MagicMock()
        fake.get_intraday_values.return_value = [{'time': '00:00'}]
        with (
            patch.object(main, 'portfolio', fake),
            patch.object(main, 'market_today', side_effect=[date(2026, 9, 4), date(2026, 9, 5), date(2026, 9, 5), date(2026, 9, 5)]),
        ):
            result = await main.refresh_today_intraday()
        self.assertEqual(result['date'], '2026-09-05')
        self.assertIsNone(main._get_api_cache('intraday_2026-09-04_1m'))

    async def test_failed_collection_does_not_replace_visible_snapshot(self):
        key = f'intraday_{main.market_today().isoformat()}_1m'
        old = {'intraday': [{'time': '09:59'}]}
        main._set_api_cache(key, old)
        with patch.object(main, '_build_today_snapshot', side_effect=RuntimeError('provider down')):
            with self.assertRaises(HTTPException) as error:
                await main.refresh_today_intraday()
        self.assertEqual(error.exception.status_code, 503)
        self.assertEqual(main._get_api_cache(key), old)

    async def test_cached_price_fallback_is_identified(self):
        fake = MagicMock()
        def collect(*args, **kwargs):
            kwargs['refresh_metadata']['stale_symbols'] = ['AAPL']
            return [{'time': '10:00'}]
        fake.get_intraday_values.side_effect = collect
        with patch.object(main, 'portfolio', fake):
            result = await main.refresh_today_intraday()
        self.assertEqual(result['cache_status'], 'partial')
        self.assertEqual(result['stale_symbols'], ['AAPL'])


class MinutePersistenceTests(unittest.TestCase):
    def test_force_refresh_bypasses_fresh_memory_and_retains_previous_day_tail(self):
        service = PriceService()
        today = date(2026, 9, 5)
        old = [{'date': today.isoformat(), 'time': '00:00', 'price': Decimal('10')}]
        tail = {'date': '2026-09-04', 'time': '23:59', 'price': Decimal('11')}
        new = {'date': today.isoformat(), 'time': '00:01', 'price': Decimal('12')}
        service._intraday_cache['BTC-USD_2026-09-05_1m_1'] = (old, datetime.now())
        with (
            patch('app.price_service._market_today', return_value=today),
            patch.object(service, '_fetch_intraday_from_yfinance', return_value=[tail, *old, new]) as fetch,
            patch.object(service, '_save_intraday_if_valid') as save,
        ):
            self.assertEqual(service.get_intraday_prices('BTC-USD', '1m'), old)
            fetch.assert_not_called()
            result = service.get_intraday_prices('BTC-USD', '1m', force_refresh=True)
        self.assertEqual(result, [*old, new])
        self.assertEqual(save.call_count, 2)
        save.assert_any_call('BTC-USD', '2026-09-04', '1m', [tail], overwrite=True)
        save.assert_any_call('BTC-USD', today.isoformat(), '1m', [*old, new], overwrite=True)

    def test_first_minute_of_live_day_is_persisted(self):
        service = PriceService()
        bars = [{'time': '09:30', 'price': Decimal('100')}]
        with (
            patch('app.price_service._market_today', return_value=date(2026, 9, 4)),
            patch.object(cache_service, 'save_intraday_prices') as save,
        ):
            self.assertTrue(service._save_intraday_if_valid('AAPL', '2026-09-04', '1m', bars, overwrite=True))
            self.assertFalse(service._save_intraday_if_valid('AAPL', '2026-09-03', '1m', bars, overwrite=True))
        save.assert_called_once()

    def test_fallback_status_clears_only_after_successful_fetch(self):
        service = PriceService()
        bars = [{'date': '2026-09-04', 'time': '09:30', 'price': Decimal('100')}]
        service._intraday_cache['AAPL_2026-09-04_1m_1'] = (bars, datetime.now())
        with (
            patch('app.price_service._market_today', return_value=date(2026, 9, 4)),
            patch.object(service, '_fetch_intraday_from_yfinance', side_effect=[[], bars]),
            patch.object(service, '_save_intraday_if_valid'),
        ):
            service.get_intraday_prices('AAPL', '1m', force_refresh=True)
            self.assertEqual(service.stale_intraday_symbols(['AAPL'], '1m'), ['AAPL'])
            service.get_intraday_prices('AAPL', '1m', force_refresh=True)
            self.assertEqual(service.stale_intraday_symbols(['AAPL'], '1m'), [])

    def test_provider_window_preserves_previous_day_and_serves_only_today(self):
        import pandas as pd
        service = PriceService()
        yesterday_bars = 30
        timestamps = pd.date_range('2026-09-04 23:30', periods=yesterday_bars + 2, freq='min', tz='America/New_York')
        history = pd.DataFrame({'Close': [100.0] * len(timestamps)}, index=timestamps)
        ticker = MagicMock()
        ticker.history.return_value = history
        with (
            patch('app.price_service._market_today', return_value=date(2026, 9, 5)),
            patch('app.price_service.yf.Ticker', return_value=ticker),
            patch.object(cache_service, 'save_intraday_prices') as save,
        ):
            bars = service.get_intraday_prices('BTC-USD', '1m', force_refresh=True)
        self.assertEqual([b['time'] for b in bars], ['00:00', '00:01'])
        self.assertEqual(save.call_count, 2)
        calls = {c.args[1]: c.args[3] for c in save.call_args_list}
        self.assertEqual(len(calls['2026-09-04']), 30)
        self.assertEqual(calls['2026-09-04'][-1]['time'], '23:59')
        self.assertEqual(len(calls['2026-09-05']), 2)
