import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

import pandas as pd
from fastapi import HTTPException

from app import main
from app.ticker_technicals import build_technicals, TickerTechnicals


NOW = datetime(2026, 9, 24, 15, tzinfo=timezone.utc)


def daily(count=220):
    return pd.DataFrame({"Close": range(1, count + 1)},
                        index=pd.bdate_range(end="2026-09-23", periods=count, tz="America/New_York"))


def quote(price=250):
    return pd.DataFrame({"Close": [price]}, index=pd.DatetimeIndex([NOW]))


class MemoryDailyStore:
    def __init__(self):
        self.snapshots = {}

    def get_or_create(self, symbol, cache_date, create):
        key = (symbol, cache_date)
        if key not in self.snapshots:
            self.snapshots[key] = create()
        return self.snapshots[key]


class TechnicalCalculationTests(unittest.TestCase):
    def test_uses_last_50_and_200_sessions_excluding_todays_bar(self):
        history = pd.concat([daily(), pd.DataFrame({"Close": [9999]},
            index=pd.DatetimeIndex(["2026-09-24"], tz="America/New_York"))])
        result = build_technicals("AAPL", history, quote(), NOW)
        self.assertEqual(result["history_count"], 220)
        self.assertEqual(result["history_as_of"], "2026-09-23")
        self.assertEqual(result["averages"][0]["value"], 195.5)
        self.assertEqual(result["averages"][1]["value"], 120.5)
        self.assertEqual(result["averages"][0]["difference"], 54.5)
        self.assertAlmostEqual(result["averages"][0]["difference_percent"], 54.5 / 195.5 * 100)
        self.assertEqual(result["series"][-1]["sma200"], 120.5)

    def test_below_at_and_missing_quote_are_distinct(self):
        for price, position in [(100, "below"), (195.5, "at"), (250, "above")]:
            result = build_technicals("AAPL", daily(), quote(price), NOW)
            self.assertEqual(result["averages"][0]["position"], position)
        result = build_technicals("AAPL", daily(), pd.DataFrame(), NOW)
        self.assertIsNone(result["current_price"])
        self.assertIsNone(result["averages"][0]["difference"])
        self.assertIsNotNone(result["averages"][0]["value"])

    def test_insufficient_history_never_fabricates_a_full_window(self):
        for count in (0, 49, 50, 199, 200):
            result = build_technicals("IPO", daily(count), quote(), NOW)
            for average in result["averages"]:
                self.assertEqual(average["value"] is not None, count >= average["window"])
                self.assertEqual(average["observations"], min(count, average["window"]))

    def test_invalid_prices_are_not_quotes_or_daily_observations(self):
        history = daily(55).astype(float)
        history.iloc[-5:, 0] = [float("nan"), float("inf"), 0, -1, 0]
        result = build_technicals("AAPL", history, quote(float("nan")), NOW)
        self.assertEqual(result["history_count"], 50)
        self.assertEqual(result["averages"][0]["value"], 25.5)
        self.assertIsNone(result["quote_time"])

    def test_crypto_uses_completed_utc_calendar_days_including_weekends(self):
        now = datetime(2026, 9, 25, 1, tzinfo=timezone.utc)  # still Sep 24 in NY
        history = pd.DataFrame({"Close": range(1, 202)},
            index=pd.date_range(end="2026-09-25", periods=201, tz="UTC"))
        result = build_technicals("BTC-USD", history, quote(), now)
        self.assertEqual(result["history_count"], 200)
        self.assertEqual(result["history_as_of"], "2026-09-24")
        self.assertEqual(result["averages"][1]["value"], 100.5)
        self.assertEqual(result["day_basis"], "UTC calendar days")

    def test_fetch_is_price_only_cached_and_quote_failure_is_explicit(self):
        service = TickerTechnicals(store=MemoryDailyStore(), clock=lambda: NOW)
        ticker = MagicMock()
        ticker.history.side_effect = [daily(), RuntimeError("quote offline")]
        with patch("app.ticker_technicals.yf.Ticker", return_value=ticker):
            first = service.get("AAPL")
            self.assertEqual(service.get("AAPL"), first)
        self.assertIsNone(first["current_price"])
        self.assertEqual(ticker.history.call_count, 2)
        for call in ticker.history.call_args_list:
            self.assertFalse(call.kwargs["auto_adjust"])

    def test_empty_daily_provider_response_is_an_error(self):
        with patch("app.ticker_technicals.yf.Ticker") as ticker:
            ticker.return_value.history.return_value = pd.DataFrame()
            with self.assertRaises(ValueError):
                TickerTechnicals(store=MemoryDailyStore(), clock=lambda: NOW).get("AAPL")


class DailyTechnicalCacheTests(unittest.TestCase):
    def setUp(self):
        self.now = NOW
        self.store = MemoryDailyStore()
        self.service = self.new_service()
        self.price = 250
        self.ticker = MagicMock()
        self.ticker.history.side_effect = lambda **kwargs: daily() if kwargs['interval'] == '1d' else quote(self.price)
        self.provider = patch('app.ticker_technicals.yf.Ticker', return_value=self.ticker)
        self.provider.start()
        self.addCleanup(self.provider.stop)

    def new_service(self):
        return TickerTechnicals(store=self.store, clock=lambda: self.now)

    def call_count(self, interval):
        return sum(call.kwargs['interval'] == interval for call in self.ticker.history.call_args_list)

    def test_quote_refresh_reuses_daily_snapshot_and_updates_distances(self):
        first = self.service.get('AAPL')
        for minutes, price in [(2, 150), (60, 200), (300, 300)]:
            self.now = NOW + timedelta(minutes=minutes)
            self.price = price
            current = self.service.get('AAPL')
            self.assertEqual(current['averages'][0]['value'], first['averages'][0]['value'])
            self.assertEqual(current['averages'][0]['difference'], price - 195.5)
        self.assertEqual(self.call_count('1d'), 1)
        self.assertEqual(self.call_count('1m'), 4)
        snapshot = next(iter(self.store.snapshots.values()))
        self.assertNotIn('current_price', snapshot)
        self.assertNotIn('difference', snapshot['averages'][0])
        self.assertEqual(current['history_fetched_at'], first['history_fetched_at'])

    def test_quote_ttl_does_not_expire_the_daily_cache(self):
        self.service.get('AAPL')
        self.now += timedelta(seconds=59)
        self.service.get('AAPL')
        self.assertEqual(self.call_count('1m'), 1)
        self.now += timedelta(seconds=1)
        self.service.get('AAPL')
        self.assertEqual(self.call_count('1m'), 2)
        self.assertEqual(self.call_count('1d'), 1)

    def test_new_service_reuses_saved_daily_history_and_refreshes_quote(self):
        self.service.get('AAPL')
        self.price = 150
        result = self.new_service().get('AAPL')
        self.assertEqual(self.call_count('1d'), 1)
        self.assertEqual(self.call_count('1m'), 2)
        self.assertEqual(result['averages'][0]['position'], 'below')

    def test_stock_cache_rolls_at_new_york_midnight_not_utc_midnight(self):
        self.now = datetime(2026, 9, 24, 23, 59, tzinfo=timezone.utc)
        self.service.get('AAPL')
        self.now += timedelta(minutes=2)
        self.service.get('AAPL')
        self.assertEqual(self.call_count('1d'), 1)
        self.now = datetime(2026, 9, 25, 4, 0, tzinfo=timezone.utc)
        result = self.service.get('AAPL')
        self.assertEqual(self.call_count('1d'), 2)
        self.assertEqual(result['cache_date'], '2026-09-25')

    def test_crypto_rolls_once_at_utc_midnight_not_again_at_new_york_midnight(self):
        self.now = datetime(2026, 9, 24, 23, 59, tzinfo=timezone.utc)
        self.service.get('BTC-USD')
        self.now += timedelta(minutes=2)
        self.service.get('BTC-USD')
        self.assertEqual(self.call_count('1d'), 2)
        self.now = datetime(2026, 9, 25, 4, 0, tzinfo=timezone.utc)
        self.service.get('BTC-USD')
        self.assertEqual(self.call_count('1d'), 2)

    def test_failed_daily_fetch_does_not_poison_the_day_and_can_retry(self):
        self.ticker.history.side_effect = [pd.DataFrame(), daily(), quote()]
        with self.assertRaises(ValueError):
            self.service.get('AAPL')
        self.assertFalse(self.store.snapshots)
        self.assertEqual(self.service.get('AAPL')['history_count'], 220)
        self.assertEqual(self.call_count('1d'), 2)

    def test_quote_failure_keeps_saved_daily_snapshot_and_only_retries_quote(self):
        self.ticker.history.side_effect = [daily(), RuntimeError('offline'), quote()]
        first = self.service.get('AAPL')
        self.assertIsNone(first['current_price'])
        self.now += timedelta(seconds=60)
        second = self.service.get('AAPL')
        self.assertEqual(second['current_price'], 250)
        self.assertEqual(second['averages'][0]['value'], 195.5)
        self.assertEqual(self.call_count('1d'), 1)

    def test_a_short_but_valid_history_is_cached_for_the_day(self):
        self.ticker.history.side_effect = [daily(49), quote(), quote()]
        first = self.service.get('IPO')
        self.assertIsNone(first['averages'][0]['value'])
        self.now += timedelta(hours=2)
        self.service.get('IPO')
        self.assertEqual(self.call_count('1d'), 1)


class TechnicalEndpointTests(unittest.TestCase):
    def test_sold_tickers_are_allowed_and_market_quote_service_is_used(self):
        ledger = SimpleNamespace(_transactions=[SimpleNamespace(asset="SOLD")])
        with patch.object(main, "portfolio", ledger), patch.object(main.ticker_technicals, "get", return_value={"current_price": 321}) as get:
            result = asyncio.run(main.get_ticker_technicals(" sold "))
        self.assertEqual(result["current_price"], 321)
        get.assert_called_once_with("SOLD")

    def test_unknown_and_cash_are_rejected_before_provider_call(self):
        ledger = SimpleNamespace(_transactions=[SimpleNamespace(asset="CASH")])
        with patch.object(main, "portfolio", ledger), patch.object(main.ticker_technicals, "get") as get:
            for symbol in ("UNKNOWN", "CASH"):
                with self.assertRaises(HTTPException) as error:
                    asyncio.run(main.get_ticker_technicals(symbol))
                self.assertEqual(error.exception.status_code, 404)
            get.assert_not_called()

    def test_provider_failure_is_retryable_503(self):
        ledger = SimpleNamespace(_transactions=[SimpleNamespace(asset="AAPL")])
        with patch.object(main, "portfolio", ledger), patch.object(main.ticker_technicals, "get", side_effect=RuntimeError("offline")):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(main.get_ticker_technicals("AAPL"))
        self.assertEqual(error.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
