from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pandas as pd
import requests

from app.crypto_price_service import CryptoPriceService
from app.models import ActionType, Transaction
from app.portfolio import Portfolio
from app.price_service import PriceService, cache_service
from app.split_service import SplitService


ET = ZoneInfo("America/New_York")
UTC = timezone.utc


def exchange_candles(path, params):
    """Emulate descending Coinbase rows, including out-of-range extra rows."""
    start = int(datetime.fromisoformat(params["start"]).timestamp())
    end = int(datetime.fromisoformat(params["end"]).timestamp())
    granularity = params["granularity"]
    if (end - start) / granularity > 300:
        raise AssertionError("Coinbase rejects more than 300 candle buckets")
    return [
        [timestamp, 90, 200, 100, 110 + (timestamp // granularity) % 10, 1]
        for timestamp in reversed(range(start - granularity, end + granularity, granularity))
    ]


class CoinbaseCandleTests(unittest.TestCase):
    def test_summer_evening_candles_continue_after_utc_midnight(self):
        service = CryptoPriceService()
        now = datetime(2026, 8, 3, 22, 10, tzinfo=ET)
        with (
            patch("app.crypto_price_service._utc_now", return_value=now),
            patch.object(service, "_get_json", side_effect=exchange_candles) as fetch,
        ):
            bars = service.get_intraday_prices("BTC-USD", "1m", 1, now.date())

        self.assertEqual(len(bars), 22 * 60 + 10)
        self.assertEqual(bars[0]["time"], "00:00")
        self.assertEqual(bars[-1]["time"], "22:09")
        self.assertEqual({p["date"] for p in bars}, {"2026-08-03"})
        self.assertEqual(len({p["timestamp"] for p in bars}), len(bars))
        self.assertGreater(fetch.call_count, 1)
        last_end = datetime.fromisoformat(fetch.call_args.args[1]["end"])
        self.assertEqual(last_end.astimezone(UTC), datetime(2026, 8, 4, 2, 10, tzinfo=UTC))

    def test_winter_evening_candles_continue_after_utc_midnight(self):
        service = CryptoPriceService()
        now = datetime(2026, 12, 3, 21, 5, tzinfo=ET)
        with (
            patch("app.crypto_price_service._utc_now", return_value=now),
            patch.object(service, "_get_json", side_effect=exchange_candles),
        ):
            bars = service.get_intraday_prices("ETH-USD", "1m", 1, now.date())
        self.assertEqual(bars[-1]["time"], "21:04")
        self.assertEqual(len(bars), 21 * 60 + 5)

    def test_spring_dst_day_has_23_hours_and_no_fictitious_2am_bars(self):
        service = CryptoPriceService()
        with (
            patch("app.crypto_price_service._utc_now", return_value=datetime(2026, 3, 9, 1, tzinfo=ET)),
            patch.object(service, "_get_json", side_effect=exchange_candles),
        ):
            bars = service.get_intraday_prices("BTC-USD", "1m", 1, date(2026, 3, 8))
        self.assertEqual(len(bars), 23 * 60)
        self.assertFalse(any(p["time"].startswith("02:") for p in bars))
        self.assertEqual(bars[-1]["time"], "23:59")

    def test_fall_dst_fetch_covers_25_hours_and_matches_local_db_keys(self):
        service = CryptoPriceService()
        start = datetime(2026, 11, 1, tzinfo=ET)
        end = datetime(2026, 11, 2, tzinfo=ET)
        with (
            patch("app.crypto_price_service._utc_now", return_value=end + timedelta(hours=1)),
            patch.object(service, "_get_json", side_effect=exchange_candles),
        ):
            candles = service._candles("BTC-USD", start, end, 60)
            bars = service.get_intraday_prices("BTC-USD", "1m", 1, start.date())
        self.assertEqual(len(candles), 25 * 60)
        self.assertEqual(len(bars), 24 * 60)
        self.assertEqual(bars[-1]["time"], "23:59")

    def test_completed_pages_are_reused_when_only_latest_minute_changes(self):
        service = CryptoPriceService()
        now = datetime(2026, 8, 3, 22, 10, tzinfo=ET)
        with (
            patch("app.crypto_price_service._utc_now", return_value=now) as clock,
            patch.object(service, "_get_json", side_effect=exchange_candles) as fetch,
        ):
            service.get_intraday_prices("BTC-USD", "1m", 1, now.date())
            previous_calls = fetch.call_count
            clock.return_value = now + timedelta(minutes=1)
            bars = service.get_intraday_prices("BTC-USD", "1m", 1, now.date())
        self.assertEqual(fetch.call_count, previous_calls + 1)
        self.assertEqual(bars[-1]["time"], "22:10")

    def test_custom_interval_uses_final_close_in_each_bucket(self):
        service = CryptoPriceService()
        now = datetime(2026, 8, 3, 0, 4, tzinfo=ET)
        with (
            patch("app.crypto_price_service._utc_now", return_value=now),
            patch.object(service, "_get_json", side_effect=exchange_candles),
        ):
            minutes = service.get_intraday_prices("BTC-USD", "1m", 1, now.date())
            pairs = service.get_intraday_prices("BTC-USD", "2m", 1, now.date())
        self.assertEqual([p["time"] for p in pairs], ["00:00", "00:02"])
        self.assertEqual([p["price"] for p in pairs], [minutes[1]["price"], minutes[3]["price"]])

    def test_midnight_baseline_uses_open_not_future_hour_close(self):
        service = CryptoPriceService()
        today = date(2026, 8, 3)
        with (
            patch("app.crypto_price_service._utc_now", return_value=datetime(2026, 8, 3, 12, tzinfo=ET)),
            patch.object(service, "_get_json", side_effect=exchange_candles),
        ):
            baseline = service.get_midnight_prices("BTC-USD", today, today)
        self.assertEqual(baseline[today], Decimal("100"))

    def test_daily_history_preserves_utc_day_close_convention(self):
        service = CryptoPriceService()
        with (
            patch("app.crypto_price_service._utc_now", return_value=datetime(2026, 8, 5, tzinfo=UTC)),
            patch.object(service, "_get_json", side_effect=exchange_candles),
        ):
            prices = service.get_historical_prices("BTC-USD", date(2026, 8, 1), date(2026, 8, 3))
        self.assertEqual(set(prices), {date(2026, 8, day) for day in range(1, 4)})
        self.assertTrue(all(price >= 110 for price in prices.values()))

    def test_invalid_candle_response_does_not_poison_cache(self):
        service = CryptoPriceService()
        with (
            patch("app.crypto_price_service._utc_now", return_value=datetime(2026, 8, 3, 12, tzinfo=ET)),
            patch.object(service, "_get_json", return_value=[[1, 1, 1, 1, "NaN", 1]]),
        ):
            with self.assertRaises(ValueError):
                service.get_intraday_prices("BTC-USD", "1m", 1, date(2026, 8, 3))
        self.assertEqual(len(service._pages), 0)


class CoinbaseTransportTests(unittest.TestCase):
    def test_rate_limit_retries_and_public_requests_have_no_authentication(self):
        service = CryptoPriceService()
        limited = MagicMock(status_code=429)
        good = MagicMock(status_code=200)
        good.json.return_value = {"price": "65000.1234"}
        with (
            patch("app.crypto_price_service.requests.get", side_effect=[limited, good]) as get,
            patch("app.crypto_price_service.time.sleep"),
        ):
            price = service.get_current_price("BTC-USD")
        self.assertEqual(price, Decimal("65000.1234"))
        self.assertEqual(get.call_count, 2)
        self.assertEqual(get.call_args.args[0], "https://api.exchange.coinbase.com/products/BTC-USD/ticker")
        self.assertNotIn("Authorization", get.call_args.kwargs["headers"])
        self.assertEqual(get.call_args.kwargs["timeout"], (3.05, 10))

    def test_unsupported_product_fails_without_retrying_404(self):
        service = CryptoPriceService()
        missing = MagicMock(status_code=404)
        missing.raise_for_status.side_effect = requests.HTTPError("404")
        with patch("app.crypto_price_service.requests.get", return_value=missing) as get:
            with self.assertRaises(requests.HTTPError):
                service.get_current_price("UNKNOWN-USD")
        self.assertEqual(get.call_count, 1)


class CryptoRoutingTests(unittest.TestCase):
    def test_portfolio_chart_uses_evening_crypto_bars_and_latest_quote(self):
        service = PriceService()
        portfolio = Portfolio(adjust_splits=False)
        now = datetime(2026, 8, 3, 22, 10, tzinfo=ET)
        portfolio.add_transactions([Transaction(
            date=date(2026, 8, 2), asset="BTC-USD", action=ActionType.BUY,
            quantity=Decimal("1"), ave_price=Decimal("100"),
        )])

        def exchange(path, params=None):
            if path.endswith("/ticker"):
                return {"price": "120"}
            return exchange_candles(path, params)

        with (
            patch("app.crypto_price_service._utc_now", return_value=now),
            patch("app.price_service._market_today", return_value=now.date()),
            patch("app.portfolio._market_today", return_value=now.date()),
            patch("app.portfolio._market_now", return_value=now),
            patch("app.portfolio.price_service", service),
            patch.object(service.crypto, "_get_json", side_effect=exchange),
            patch.object(cache_service, "save_intraday_prices"),
            patch("app.price_service.yf.Ticker") as yahoo,
        ):
            points = portfolio.get_intraday_values("1m")

        by_time = {p["time"]: p for p in points}
        self.assertIn("22:00", by_time)
        self.assertEqual(points[-1]["time"], "22:10")
        self.assertEqual(points[-1]["value"], 120.0)
        self.assertEqual(points[-1]["daily_pnl"], 20.0)
        yahoo.assert_not_called()

    def test_overlapping_complete_db_days_use_fresh_bars_without_duplicates(self):
        service = PriceService()
        today = date(2026, 8, 3)
        cached = [{"date": "2026-08-02", "time": "23:59", "price": Decimal("100")}]
        fresh = [
            {"date": "2026-08-01", "time": "23:59", "price": Decimal("101")},
            {"date": "2026-08-02", "time": "23:59", "price": Decimal("102")},
        ]
        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(cache_service, "get_intraday_prices", side_effect=[cached, []]),
            patch.object(service.crypto, "get_intraday_prices", return_value=fresh),
            patch.object(service, "_save_intraday_if_valid"),
        ):
            result = service.get_intraday_prices("BTC-USD", "1m", 3)
        self.assertEqual(result, fresh)

    def test_mixed_live_batch_sends_only_stocks_to_yahoo(self):
        service = PriceService()
        with (
            patch.object(service.crypto, "get_current_price", side_effect=[Decimal("65000"), Decimal("3000")]),
            patch("app.price_service.yf.download", return_value=pd.DataFrame({"Close": [200]})) as download,
            patch("app.price_service.yf.Ticker") as ticker,
        ):
            prices = service.get_prices_batch(["BTC-USD", "AAPL", "ETH-USD"])
        self.assertEqual(prices, {"BTC-USD": Decimal("65000"), "ETH-USD": Decimal("3000"), "AAPL": Decimal("200")})
        self.assertEqual(download.call_args.args[0], ["AAPL"])
        ticker.assert_not_called()

    def test_failed_crypto_quote_keeps_stale_price_without_yahoo_fallback(self):
        service = PriceService()
        service._price_cache["BTC-USD"] = (Decimal("65000"), datetime.min)
        with (
            patch.object(service.crypto, "get_current_price", side_effect=requests.ConnectionError("offline")),
            patch("app.price_service.yf.Ticker") as ticker,
        ):
            price = service.get_current_price("BTC-USD")
        self.assertEqual(price, Decimal("65000"))
        ticker.assert_not_called()

    def test_mixed_daily_batch_sends_crypto_to_coinbase(self):
        service = PriceService()
        day = date(2026, 8, 3)
        with (
            patch.object(cache_service, "get_historical_prices", return_value={}),
            patch.object(cache_service, "get_historical_prices_batch", return_value={}),
            patch.object(cache_service, "save_historical_prices_batch"),
            patch.object(service.crypto, "get_historical_prices", return_value={day: Decimal("65000")}) as crypto,
            patch("app.price_service.yf.download", return_value=pd.DataFrame({"Close": [200]}, index=pd.to_datetime([day]))) as download,
        ):
            prices = service.get_historical_prices_batch(["BTC-USD", "AAPL"], day, day)
        crypto.assert_called_once_with("BTC-USD", day, day)
        self.assertEqual(download.call_args.args[0], ["AAPL"])
        self.assertEqual(prices["BTC-USD"][day], Decimal("65000"))
        self.assertEqual(prices["AAPL"][day], Decimal("200"))

    def test_midnight_baseline_is_stable_and_resets_on_eastern_date_change(self):
        service = PriceService()
        today = date(2026, 8, 3)
        tomorrow = today + timedelta(days=1)
        with (
            patch("app.price_service._market_today", side_effect=[today, today, tomorrow]),
            patch.object(service.crypto, "get_midnight_prices", side_effect=[{today: Decimal("100")}, {tomorrow: Decimal("102")}]) as midnight,
            patch("app.price_service.yf.Ticker") as ticker,
        ):
            first = service._get_crypto_est_midnight_price_batch(["BTC-USD"])
            repeated = service._get_crypto_est_midnight_price_batch(["BTC-USD"])
            following = service._get_crypto_est_midnight_price_batch(["BTC-USD"])
        self.assertEqual(first, repeated)
        self.assertEqual(following["BTC-USD"], Decimal("102"))
        self.assertEqual(midnight.call_count, 2)
        self.assertEqual(midnight.call_args.args, ("BTC-USD", tomorrow, tomorrow))
        self.assertEqual(service._crypto_midnight_cache_market_date[str(["BTC-USD"])], tomorrow)
        ticker.assert_not_called()

    def test_intraday_outage_can_recover_persisted_today_bars(self):
        service = PriceService()
        today = date(2026, 8, 3)
        cached = [{"date": today.isoformat(), "time": "21:00", "price": Decimal("65000")}]
        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(service.crypto, "get_intraday_prices", side_effect=requests.ConnectionError("offline")),
            patch.object(cache_service, "get_intraday_prices", return_value=cached),
            patch("app.price_service.yf.Ticker") as ticker,
        ):
            bars = service.get_intraday_prices("BTC-USD", "1m", 1)
        self.assertEqual(bars, cached)
        ticker.assert_not_called()

    def test_incomplete_crypto_history_is_repaired_beyond_yahoo_window(self):
        service = PriceService()
        today = date(2026, 8, 13)
        bars = [{"date": "2026-08-03", "time": "23:59", "price": Decimal("65000")}]
        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(cache_service, "get_intraday_prices", return_value=[]),
            patch.object(service.crypto, "get_intraday_prices", return_value=bars) as fetch,
            patch.object(service, "_save_intraday_if_valid"),
        ):
            result = service.get_intraday_prices("BTC-USD", "1m", 11)
        fetch.assert_called_once_with("BTC-USD", "1m", 11, today)
        self.assertEqual(result, bars)

    def test_failed_repair_preserves_incomplete_db_day(self):
        service = PriceService()
        today = date(2026, 8, 3)
        cached = [{"date": "2026-08-02", "time": "19:59", "price": Decimal("65000")}]
        with (
            patch("app.price_service._market_today", return_value=today),
            patch.object(cache_service, "get_intraday_prices", return_value=cached),
            patch.object(service.crypto, "get_intraday_prices", side_effect=requests.ConnectionError("offline")),
        ):
            result = service.get_intraday_prices("BTC-USD", "1m", 2)
        self.assertEqual(result, cached)

    def test_crypto_does_not_request_stock_splits(self):
        with patch("app.split_service.yf.Ticker") as ticker:
            self.assertEqual(SplitService().get_splits("BTC-USD"), {})
        ticker.assert_not_called()

    def test_yahoo_intraday_bounds_are_explicit_eastern_datetimes(self):
        service = PriceService()
        frame = pd.DataFrame({"Close": [100]}, index=pd.to_datetime(["2026-08-04T01:05:00Z"]))
        with patch("app.price_service.yf.Ticker") as ticker:
            ticker.return_value.history.return_value = frame
            bars = service._fetch_intraday_from_yfinance("BTC-USD", "1m", 1, date(2026, 8, 3), True)
        bounds = ticker.return_value.history.call_args.kwargs
        self.assertEqual(bounds["end"].astimezone(UTC), datetime(2026, 8, 4, 4, tzinfo=UTC))
        self.assertEqual(bars[0]["time"], "21:05")


if __name__ == "__main__":
    unittest.main()
