import asyncio
from datetime import datetime, timedelta
from decimal import Decimal
import unittest
from unittest.mock import MagicMock, patch

from fastapi import BackgroundTasks

from app import main
from app.cache_service import CacheService
from app.price_service import PriceService, cache_service


class ApiCacheTests(unittest.TestCase):
    def setUp(self):
        with main._api_cache_lock:
            main._api_cache.clear()
            main._api_refreshing.clear()

    def tearDown(self):
        with main._api_cache_lock:
            main._api_cache.clear()
            main._api_refreshing.clear()

    def test_expired_intraday_result_is_available_as_stale_fallback(self):
        cache_key = f"intraday_{main.market_today().isoformat()}_1m"
        payload = {"intraday": [{"time": "10:00"}], "date": "2026-07-31"}
        with main._api_cache_lock:
            main._api_cache[cache_key] = (
                payload,
                datetime.now() - timedelta(minutes=2),
            )

        self.assertIsNone(main._get_api_cache(cache_key))
        self.assertEqual(
            main._get_stale_api_cache(cache_key, timedelta(minutes=15)),
            payload,
        )

    def test_intraday_endpoint_returns_stale_and_queues_refresh(self):
        cache_key = f"intraday_{main.market_today().isoformat()}_1m"
        payload = {"intraday": [{"time": "10:00"}], "date": main.market_today().isoformat()}
        with main._api_cache_lock:
            main._api_cache[cache_key] = (
                payload,
                datetime.now() - timedelta(minutes=2),
            )
        background = BackgroundTasks()
        original_portfolio = main.portfolio
        main.portfolio = object()
        try:
            result = asyncio.run(main.get_intraday(background, "1m", None))
        finally:
            main.portfolio = original_portfolio

        self.assertEqual(result["cache_status"], "stale-refreshing")
        self.assertEqual(len(background.tasks), 1)

    def test_old_generation_cannot_overwrite_cache_after_transaction_reload(self):
        class FakePortfolio:
            def get_intraday_values(self, interval):
                return [{"time": "10:01", "daily_pnl": Decimal("1")}]

        original_portfolio = main.portfolio
        original_generation = main._portfolio_generation
        try:
            main.portfolio = FakePortfolio()
            main._portfolio_generation = 8
            cache_key = f"intraday_{main.market_today().isoformat()}_1m"
            main._refresh_intraday_cache(
                cache_key, main.market_today(), "1m", generation=7
            )
            self.assertIsNone(main._get_api_cache(cache_key))

            main._refresh_intraday_cache(
                cache_key, main.market_today(), "1m", generation=8
            )
            self.assertIsNotNone(main._get_api_cache(cache_key))
        finally:
            main.portfolio = original_portfolio
            main._portfolio_generation = original_generation

    def test_reload_preserves_market_cache_unless_forced(self):
        with (
            patch.object(main, "load_portfolio"),
            patch.object(main, "_clear_api_cache"),
            patch.object(main.price_service, "clear_cache") as clear_prices,
        ):
            asyncio.run(main.reload_portfolio(False, False))
            clear_prices.assert_not_called()

            asyncio.run(main.reload_portfolio(False, True))
            clear_prices.assert_called_once()

    def test_market_refresh_precomputes_default_dashboard_responses(self):
        class FakePortfolio:
            def get_daily_pnl_history(self, num_days):
                return [{"date": f"day-{i}", "daily_pnl": i} for i in range(num_days)]

            def get_intraday_values(self, interval):
                return [{"time": "10:00", "interval": interval}]

        fake = FakePortfolio()
        summary = {
            "holdings": [{"symbol": "AAPL"}],
            "total_dividends": 12.0,
            "dividend_summaries": [],
        }
        performance = {
            "performance": [
                {"date": "2025-08-14", "value": 90},
                {"date": "2026-08-14", "value": 100},
            ],
            "realized_by_year": {},
            "realized_details_by_year": {},
        }
        original_portfolio = main.portfolio
        original_generation = main._portfolio_generation
        try:
            main.portfolio = fake
            main._portfolio_generation = 21
            with (
                patch.object(main.price_service, "clear_live_cache") as clear_live,
                patch.object(main, "_build_summary_response", return_value=summary),
                patch.object(main, "_build_sold_response", return_value={"sold_assets": []}),
                patch.object(main, "_build_performance_response", return_value=performance),
                patch.object(main, "market_today", return_value=datetime(2026, 8, 14).date()),
            ):
                result = main._refresh_market_snapshot(force_prices=True)

            self.assertEqual(result["status"], "fresh")
            clear_live.assert_called_once()
            self.assertIsNotNone(main._get_api_cache("summary"))
            self.assertIsNotNone(main._get_api_cache("holdings"))
            self.assertIsNotNone(main._get_api_cache("performance_all_all"))
            self.assertEqual(
                len(main._get_api_cache("daily-pnl_42")["daily_pnl"]), 42
            )
            self.assertEqual(
                main._get_api_cache("intraday_2026-08-14_1m")["cache_status"],
                "fresh",
            )
        finally:
            main.portfolio = original_portfolio
            main._portfolio_generation = original_generation


class PriceCacheTests(unittest.TestCase):
    def test_clear_live_cache_preserves_historical_data(self):
        service = PriceService()
        now = datetime.now()
        service._price_cache["AAPL"] = (Decimal("100"), now)
        service._intraday_cache["AAPL_today_1m_1"] = ([], now)
        service._history_cache["AAPL_history"] = ({}, now)
        service._prev_close_cache["AAPL_previous"] = ({}, now)

        service.clear_live_cache()

        self.assertEqual(service._price_cache["AAPL"][0], Decimal("100"))
        self.assertEqual(service._price_cache["AAPL"][1], datetime.min)
        self.assertEqual(service._intraday_cache["AAPL_today_1m_1"][1], datetime.min)
        self.assertIn("AAPL_history", service._history_cache)
        self.assertIn("AAPL_previous", service._prev_close_cache)

    def test_intraday_refresh_uses_stale_bars_when_yfinance_fails(self):
        service = PriceService()
        today = datetime(2026, 8, 14).date()
        stale = [{"date": today.isoformat(), "time": "10:00", "price": Decimal("100")}]
        cache_key = f"AAPL_{today.isoformat()}_1m_1"
        service._intraday_cache[cache_key] = (stale, datetime.min)

        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(service, "_fetch_intraday_from_yfinance", return_value=[]),
        ):
            result = service.get_intraday_prices("AAPL", "1m", 1)

        self.assertEqual(result, stale)

    def test_today_intraday_fetch_uses_persistent_incremental_save_path(self):
        service = PriceService()
        bars = [
            {
                "time": f"10:{minute:02d}",
                "date": "2026-07-31",
                "price": Decimal("100"),
            }
            for minute in range(30)
        ]
        with (
            patch.object(service, "_fetch_intraday_from_yfinance", return_value=bars),
            patch.object(service, "_save_intraday_if_valid") as save,
            patch("app.price_service._market_today", return_value=datetime(2026, 7, 31).date()),
        ):
            result = service.get_intraday_prices("AAPL", "1m", 1)

        self.assertEqual(result, bars)
        save.assert_called_once_with(
            "AAPL", "2026-07-31", "1m", bars, overwrite=True
        )

    def test_batch_fetch_returns_every_symbol(self):
        service = PriceService()

        def fake_fetch(symbol, interval, days):
            return [{"time": "10:00", "price": Decimal(str(len(symbol)))}]

        with patch.object(service, "get_intraday_prices", side_effect=fake_fetch):
            result = service.get_intraday_prices_batch(
                ["AAPL", "MSFT", "BTC-USD"], "1m", 1
            )

        self.assertEqual(set(result), {"AAPL", "MSFT", "BTC-USD"})

    def test_incomplete_cached_crypto_day_is_refetched_and_saved(self):
        service = PriceService()
        today = datetime(2026, 8, 3).date()
        incomplete = [
            {"time": "00:00", "date": "2026-08-02", "price": Decimal("100")},
            {"time": "19:59", "date": "2026-08-02", "price": Decimal("101")},
        ]
        completed = [
            {"time": "00:00", "date": "2026-08-02", "price": Decimal("100")},
            {"time": "23:59", "date": "2026-08-02", "price": Decimal("102")},
        ]

        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(cache_service, "get_intraday_prices", return_value=incomplete),
            patch.object(
                service, "_fetch_intraday_from_yfinance", return_value=completed
            ) as fetch,
            patch.object(service, "_save_intraday_if_valid") as save,
        ):
            result = service.get_intraday_prices("BTC-USD", "1m", 2)

        self.assertEqual(result, completed)
        fetch.assert_called_once_with("BTC-USD", "1m", 2, today, True)
        save.assert_called_once_with(
            "BTC-USD", "2026-08-02", "1m", completed, overwrite=True
        )

    def test_complete_cached_crypto_day_does_not_expand_yfinance_range(self):
        service = PriceService()
        today = datetime(2026, 8, 3).date()
        completed = [
            {"time": "00:00", "date": "2026-08-02", "price": Decimal("100")},
            {"time": "23:59", "date": "2026-08-02", "price": Decimal("102")},
        ]

        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(cache_service, "get_intraday_prices", return_value=completed),
            patch.object(
                service, "_fetch_intraday_from_yfinance", return_value=[]
            ) as fetch,
        ):
            result = service.get_intraday_prices("BTC-USD", "1m", 2)

        self.assertEqual(result, completed)
        fetch.assert_called_once_with("BTC-USD", "1m", 1, today, True)

    def test_prime_cache_uses_shared_postgres_bars(self):
        service = PriceService()
        rows = [
            {"time": "09:30", "date": "2026-07-31", "price": Decimal("303")},
            {"time": "09:31", "date": "2026-07-31", "price": Decimal("304")},
        ]
        with (
            patch("app.price_service._market_today", return_value=datetime(2026, 7, 31).date()),
            patch.object(cache_service, "get_intraday_prices", return_value=rows),
        ):
            warmed = service.prime_intraday_cache_from_db(["AAPL"], "1m")

        self.assertEqual(warmed, 1)
        self.assertEqual(service._price_cache["AAPL"][0], Decimal("304"))
        self.assertEqual(
            service._intraday_cache["AAPL_2026-07-31_1m_1"][0], rows
        )


class PersistentCacheTests(unittest.TestCase):
    def test_intraday_save_writes_only_new_or_changed_bars(self):
        service = CacheService()
        conn = MagicMock()
        conn.execute.return_value.fetchall.return_value = [
            ("09:30", Decimal("303"))
        ]
        cursor = MagicMock()
        cursor_context = MagicMock()
        cursor_context.__enter__.return_value = cursor
        conn.cursor.return_value = cursor_context
        connection_context = MagicMock()
        connection_context.__enter__.return_value = conn
        pool = MagicMock()
        pool.connection.return_value = connection_context
        bars = [
            {"time": "09:30", "price": Decimal("303")},
            {"time": "09:31", "price": Decimal("304")},
        ]

        with patch("app.cache_service.get_pool", return_value=pool):
            written = service.save_intraday_prices(
                "AAPL", "2026-07-31", "1m", bars
            )

        self.assertEqual(written, 1)
        written_rows = cursor.executemany.call_args.args[1]
        self.assertEqual(len(written_rows), 1)
        self.assertEqual(written_rows[0][2:], ("09:31", "1m", Decimal("304")))
        conn.commit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
