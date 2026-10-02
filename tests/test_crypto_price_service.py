from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest
from unittest.mock import patch

import pandas as pd

from app.crypto_price_service import CryptoPriceService, Candle, MARKET_TZ
from app.price_service import PriceService, cache_service
from app.split_service import SplitService


UTC = timezone.utc


def bar(day, time, price="100"):
    return {"date": day.isoformat(), "time": time, "price": Decimal(price)}


class CryptoProviderTests(unittest.TestCase):
    def test_paginated_candles_are_bounded_sorted_and_completed_pages_reused(self):
        service = CryptoPriceService()
        start = datetime(2026, 8, 1, 0, 7, tzinfo=UTC)
        end = start + timedelta(minutes=650)
        requests = []

        def fetch(path, params):
            page_start = int(datetime.fromisoformat(params["start"]).timestamp())
            page_end = int(datetime.fromisoformat(params["end"]).timestamp())
            self.assertLessEqual(page_end - page_start, 300 * 60)
            requests.append((page_start, page_end))
            # Include the earlier row Coinbase can return, and a duplicate.
            rows = [[ts, 1, 2, 100, 101, 1] for ts in range(page_start - 60, page_end, 60)]
            return list(reversed(rows + rows[-1:]))

        with (
            patch("app.crypto_price_service._utc_now", return_value=end + timedelta(days=1)),
            patch.object(service, "_get_json", side_effect=fetch),
        ):
            candles = service._candles("BTC-USD", start, end, 60)
            again = service._candles("BTC-USD", start, end, 60)
        self.assertEqual(len(candles), 650)
        self.assertEqual(candles, again)
        self.assertGreater(len(requests), 1)
        self.assertEqual(len(requests), len(set(requests)))
        self.assertEqual([c.timestamp for c in candles], sorted({c.timestamp for c in candles}))
        self.assertTrue(all(start.timestamp() <= c.timestamp < end.timestamp() for c in candles))

    def test_current_candle_page_expires(self):
        service = CryptoPriceService(live_ttl_seconds=60)
        now = datetime(2026, 8, 1, 10, 2, 30, tzinfo=UTC)
        start = now - timedelta(minutes=1)
        end = now + timedelta(minutes=1)
        row = [int(now.replace(second=0).timestamp()), 1, 2, 100, 101, 1]
        with (
            patch("app.crypto_price_service._utc_now", return_value=now),
            patch("app.crypto_price_service.time.monotonic", side_effect=[100, 101, 161, 161]),
            patch.object(service, "_get_json", return_value=[row]) as fetch,
        ):
            service._candles("BTC-USD", start, end, 60)
            service._candles("BTC-USD", start, end, 60)
            service._candles("BTC-USD", start, end, 60)
        self.assertEqual(fetch.call_count, 2)

    def test_two_minute_aggregation_uses_final_close_in_eastern_buckets(self):
        service = CryptoPriceService()
        day = date(2026, 8, 1)
        midnight = datetime.combine(day, datetime.min.time(), MARKET_TZ)
        candles = [Candle(int(midnight.timestamp()) + minute * 60, Decimal("90"), Decimal(str(100 + minute)))
                   for minute in range(4)]
        with patch.object(service, "_candles", return_value=candles):
            rows = service.get_intraday_prices("BTC-USD", "2m", 1, day)
        self.assertEqual([(row["time"], row["price"]) for row in rows],
                         [("00:00", Decimal("101")), ("00:02", Decimal("103"))])

    def test_invalid_ticker_prices_are_rejected(self):
        for value in ["NaN", "Infinity", "0", "-1"]:
            with self.subTest(value=value):
                with patch.object(CryptoPriceService, "_get_json", return_value={"price": value}):
                    with self.assertRaises(ValueError):
                        CryptoPriceService().get_current_price("BTC-USD")


class CryptoRoutingTests(unittest.TestCase):
    def test_mixed_current_prices_keep_crypto_out_of_yahoo_batch(self):
        service = PriceService()
        stocks = pd.DataFrame({"Close": [101.0]}, index=pd.to_datetime(["2026-08-01"]))
        with (
            patch.object(service.crypto, "get_current_price", return_value=Decimal("60000")) as crypto,
            patch("app.price_service.yf.download", return_value=stocks) as yahoo,
        ):
            prices = service.get_prices_batch(["BTC-USD", "MU"])
        self.assertEqual(prices, {"BTC-USD": Decimal("60000"), "MU": Decimal("101.0")})
        crypto.assert_called_once_with("BTC-USD")
        self.assertEqual(yahoo.call_args.args[0], ["MU"])

    def test_crypto_history_uses_coinbase_while_stock_cache_remains_batched(self):
        service = PriceService()
        start, end = date(2026, 8, 1), date(2026, 8, 2)
        prices = {start: Decimal("60000")}
        with (
            patch.object(cache_service, "get_historical_prices", return_value={}),
            patch.object(cache_service, "_get_cache_cutoff_date", return_value=date(2026, 8, 4)),
            patch.object(cache_service, "get_historical_prices_batch", return_value={"MU": {start: Decimal("100")}}) as batch,
            patch.object(cache_service, "save_historical_prices_batch") as save,
            patch.object(service.crypto, "get_historical_prices", return_value=prices) as crypto,
            patch("app.price_service.yf.download", return_value=pd.DataFrame()) as yahoo,
            patch("app.price_service.yf.Ticker") as ticker,
        ):
            result = service.get_historical_prices_batch(["BTC-USD", "MU"], start, end)
        self.assertEqual(result["BTC-USD"], prices)
        crypto.assert_called_once_with("BTC-USD", start, end)
        batch.assert_called_once_with(["MU"], start, end)
        save.assert_called_once_with("BTC-USD", prices)
        ticker.assert_not_called()
        self.assertEqual(yahoo.call_args.args[0], ["MU"])

    def test_crypto_never_queries_stock_splits(self):
        with patch("app.split_service.yf.Ticker") as ticker:
            self.assertEqual(SplitService().get_splits("BTC-USD"), {})
        ticker.assert_not_called()

    def test_live_crypto_persists_yesterday_tail_and_first_today_bar(self):
        service = PriceService()
        today = date(2026, 8, 3)
        yesterday = today - timedelta(days=1)
        yesterday_rows = [bar(yesterday, "23:%02d" % minute) for minute in range(30, 60)]
        today_rows = [bar(today, "00:00", "102")]
        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(service.crypto, "get_intraday_prices", return_value=yesterday_rows + today_rows) as fetch,
            patch.object(cache_service, "save_intraday_prices") as save,
        ):
            result = service.get_intraday_prices("BTC-USD", "1m", 1)
        self.assertEqual(result, today_rows)
        fetch.assert_called_once_with("BTC-USD", "1m", 2, today)
        self.assertEqual(save.call_args_list[0].args, ("BTC-USD", yesterday.isoformat(), "1m", yesterday_rows))
        self.assertEqual(save.call_args_list[1].args, ("BTC-USD", today.isoformat(), "1m", today_rows))

    def test_failed_forced_live_fetch_keeps_stale_bars_and_partial_status(self):
        service = PriceService()
        today = date(2026, 8, 3)
        stale = [bar(today, "00:00")]
        service._intraday_cache["BTC-USD_2026-08-03_1m_1"] = (stale, datetime.now())
        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(service.crypto, "get_intraday_prices", side_effect=RuntimeError("provider unavailable")) as fetch,
        ):
            self.assertEqual(service.get_intraday_prices("BTC-USD", "1m", 1), stale)
            fetch.assert_not_called()
            self.assertEqual(service.get_intraday_prices("BTC-USD", "1m", 1, force_refresh=True), stale)
            self.assertEqual(service.stale_intraday_symbols(["BTC-USD"], "1m"), ["BTC-USD"])
        fetch.assert_called_once()

    def test_failed_cold_live_fetch_uses_db_bars_and_remains_partial(self):
        service = PriceService()
        today = date(2026, 8, 3)
        stale = [bar(today, "00:00")]
        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(service.crypto, "get_intraday_prices", side_effect=RuntimeError("provider unavailable")),
            patch.object(cache_service, "get_intraday_prices", return_value=stale),
        ):
            self.assertEqual(service.get_intraday_prices("BTC-USD", "1m", 1), stale)
            self.assertEqual(service.stale_intraday_symbols(["BTC-USD"], "1m"), ["BTC-USD"])

    def test_old_crypto_days_can_be_backfilled_beyond_yahoo_window_without_duplicates(self):
        service = PriceService()
        today = date(2026, 8, 10)
        old = today - timedelta(days=8)
        yesterday = today - timedelta(days=1)
        incomplete = [bar(old, "12:00", "90")]
        live = [bar(old, "23:59", "95"), bar(yesterday, "23:59", "101"), bar(today, "00:00", "102")]

        def db_prices(symbol, day, interval):
            return incomplete if day == old.isoformat() else [bar(date.fromisoformat(day), "23:59")]

        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(cache_service, "get_intraday_prices", side_effect=db_prices),
            patch.object(service.crypto, "get_intraday_prices", return_value=live) as fetch,
            patch.object(service, "_save_intraday_if_valid"),
            patch("app.price_service.yf.Ticker") as ticker,
        ):
            rows = service.get_intraday_prices("BTC-USD", "1m", 9)
        fetch.assert_called_once_with("BTC-USD", "1m", 9, today)
        by_day = {row["date"]: row["price"] for row in rows}
        self.assertEqual(by_day[old.isoformat()], Decimal("95"))
        self.assertEqual(by_day[yesterday.isoformat()], Decimal("101"))
        self.assertEqual(by_day[today.isoformat()], Decimal("102"))
        self.assertEqual(len(rows), 9)
        self.assertEqual(len(rows), len({(row["date"], row["time"]) for row in rows}))
        ticker.assert_not_called()

    def test_failed_historical_crypto_fetch_preserves_incomplete_db_rows(self):
        service = PriceService()
        today = date(2026, 8, 3)
        incomplete = [bar(today - timedelta(days=1), "12:00")]
        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(cache_service, "get_intraday_prices", return_value=incomplete),
            patch.object(service.crypto, "get_intraday_prices", side_effect=RuntimeError("provider unavailable")),
        ):
            self.assertEqual(service.get_intraday_prices("BTC-USD", "1m", 2), incomplete)


if __name__ == "__main__":
    unittest.main()
