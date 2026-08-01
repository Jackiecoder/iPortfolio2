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


class PriceCacheTests(unittest.TestCase):
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
