"""Regressions for Midnight's explicit market-data alias and fallback behavior."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pandas as pd
import requests

from app.crypto_price_service import Candle, CryptoPriceService
from app.price_service import PriceService, cache_service


UTC = timezone.utc
ET = ZoneInfo("America/New_York")
NIGHT = "NIGHT-USD"
ALIAS = "NIGHT39064-USD"


def history(rows):
    """Build source OHLC rows, preserving their actual timezone-aware index."""
    return pd.DataFrame(
        {"Open": [row[1] for row in rows], "Close": [row[2] for row in rows]},
        index=pd.DatetimeIndex([row[0] for row in rows]),
    )


class MidnightProviderRoutingTests(unittest.TestCase):
    def test_current_quote_uses_explicit_midnight_alias_and_latest_close(self):
        service = CryptoPriceService()
        frame = history([
            (datetime(2026, 8, 3, 15, 0, tzinfo=UTC), ".04", ".041"),
            (datetime(2026, 8, 3, 15, 1, tzinfo=UTC), ".041", ".042"),
        ])
        with (
            patch("app.crypto_price_service.yf.Ticker") as ticker,
            patch.object(service, "_get_json", side_effect=AssertionError("Unsupported Coinbase product")),
        ):
            ticker.return_value.history.return_value = frame
            self.assertEqual(service.get_current_price(NIGHT), Decimal(".042"))

        ticker.assert_called_once_with(ALIAS)
        kwargs = ticker.return_value.history.call_args.kwargs
        self.assertEqual(kwargs["interval"], "1m")
        self.assertTrue(kwargs["raise_errors"])

    def test_minute_hour_and_daily_candles_use_same_correct_asset(self):
        day = date(2026, 8, 3)
        midnight = datetime.combine(day, datetime.min.time(), ET)
        frame = history([(midnight.astimezone(UTC), ".04", ".045")])
        for method, expected_interval in (
            (lambda service: service.get_intraday_prices(NIGHT, "1m", 1, day), "1m"),
            (lambda service: service.get_midnight_prices(NIGHT, day, day), "1h"),
            (lambda service: service.get_historical_prices(NIGHT, day, day), "1d"),
        ):
            with self.subTest(interval=expected_interval):
                service = CryptoPriceService()
                with (
                    patch("app.crypto_price_service._utc_now", return_value=midnight + timedelta(hours=12)),
                    patch("app.crypto_price_service.yf.Ticker") as ticker,
                    patch.object(service, "_get_json", side_effect=AssertionError("Unexpected Coinbase request")),
                ):
                    ticker.return_value.history.return_value = frame
                    self.assertTrue(method(service))
                ticker.assert_called_with(ALIAS)
                kwargs = ticker.return_value.history.call_args.kwargs
                self.assertEqual(kwargs["interval"], expected_interval)
                self.assertIs(kwargs["auto_adjust"], False)
                self.assertIs(kwargs["raise_errors"], True)
                self.assertEqual(kwargs["start"].utcoffset(), timedelta(0))
                self.assertEqual(kwargs["end"].utcoffset(), timedelta(0))

    def test_supported_coinbase_product_does_not_switch_provider(self):
        service = CryptoPriceService()
        with (
            patch("app.crypto_price_service.yf.Ticker") as ticker,
            patch.object(service, "_get_json", return_value={"price": "65000.25"}) as coinbase,
        ):
            self.assertEqual(service.get_current_price("BTC-USD"), Decimal("65000.25"))
        coinbase.assert_called_once_with("/products/BTC-USD/ticker")
        ticker.assert_not_called()

    def test_unknown_coinbase_product_has_no_guessed_yahoo_alias(self):
        service = CryptoPriceService()
        with (
            patch("app.crypto_price_service.yf.Ticker") as ticker,
            patch.object(service, "_get_json", side_effect=requests.HTTPError("404")) as coinbase,
        ):
            with self.assertRaises(requests.HTTPError):
                service.get_current_price("UNKNOWN-USD")
        coinbase.assert_called_once()
        ticker.assert_not_called()


class MidnightCandleSemanticsTests(unittest.TestCase):
    def test_actual_utc_timestamps_are_sorted_deduplicated_and_bounded(self):
        service = CryptoPriceService()
        start = datetime(2026, 8, 3, 4, 1, tzinfo=UTC)
        end = start + timedelta(minutes=3)
        frame = history([
            (end, ".09", ".09"),
            (start + timedelta(minutes=2), ".05", ".052"),
            (start - timedelta(minutes=1), ".01", ".01"),
            (start, ".04", ".041"),
            (start + timedelta(minutes=2), ".05", ".052"),
        ])
        with (
            patch("app.crypto_price_service._utc_now", return_value=end + timedelta(hours=1)),
            patch("app.crypto_price_service.yf.Ticker") as ticker,
        ):
            ticker.return_value.history.return_value = frame
            candles = service._candles(NIGHT, start, end, 60)
        self.assertEqual(candles, [
            Candle(int(start.timestamp()), Decimal(".04"), Decimal(".041")),
            Candle(int((start + timedelta(minutes=2)).timestamp()), Decimal(".05"), Decimal(".052")),
        ])

    def test_missing_ohlc_rows_do_not_invent_prices_or_minute_slots(self):
        service = CryptoPriceService()
        day = date(2026, 8, 3)
        midnight = datetime.combine(day, datetime.min.time(), ET)
        frame = history([
            (midnight, ".04", ".041"),
            (midnight + timedelta(minutes=1), float("nan"), ".05"),
            (midnight + timedelta(minutes=2), ".05", float("nan")),
            (midnight + timedelta(minutes=4), ".06", ".061"),
        ])
        with (
            patch("app.crypto_price_service._utc_now", return_value=midnight + timedelta(minutes=6)),
            patch("app.crypto_price_service.yf.Ticker") as ticker,
        ):
            ticker.return_value.history.return_value = frame
            bars = service.get_intraday_prices(NIGHT, "1m", 1, day)
        self.assertEqual([(bar["time"], bar["price"]) for bar in bars], [
            ("00:00", Decimal(".041")), ("00:04", Decimal(".061")),
        ])
        self.assertEqual([bar["timestamp"] for bar in bars], [
            "2026-08-03T00:00:00", "2026-08-03T00:04:00",
        ])

    def test_midnight_uses_open_and_tracks_eastern_dst_offset(self):
        for day, expected_utc_hour in (
            (date(2026, 8, 3), 4),
            (date(2026, 12, 3), 5),
            (date(2026, 3, 8), 5),
            (date(2026, 3, 9), 4),
            (date(2026, 11, 1), 4),
            (date(2026, 11, 2), 5),
        ):
            with self.subTest(day=day):
                service = CryptoPriceService()
                midnight = datetime.combine(day, datetime.min.time(), ET).astimezone(UTC)
                self.assertEqual(midnight.hour, expected_utc_hour)
                frame = history([
                    (midnight - timedelta(hours=1), ".03", ".039"),
                    (midnight, ".04", ".08"),
                    (midnight + timedelta(hours=1), ".09", ".10"),
                ])
                with (
                    patch("app.crypto_price_service._utc_now", return_value=midnight + timedelta(hours=12)),
                    patch("app.crypto_price_service.yf.Ticker") as ticker,
                ):
                    ticker.return_value.history.return_value = frame
                    self.assertEqual(service.get_midnight_prices(NIGHT, day, day), {day: Decimal(".04")})

    def test_midnight_only_falls_back_to_exact_completed_previous_hour(self):
        day = date(2026, 8, 3)
        midnight = datetime.combine(day, datetime.min.time(), ET).astimezone(UTC)
        for frame, expected in (
            (history([(midnight - timedelta(hours=1), ".03", ".039")]), {day: Decimal(".039")}),
            (history([(midnight - timedelta(hours=2), ".02", ".029")]), {}),
        ):
            with self.subTest(expected=expected):
                service = CryptoPriceService()
                with (
                    patch("app.crypto_price_service._utc_now", return_value=midnight + timedelta(hours=12)),
                    patch("app.crypto_price_service.yf.Ticker") as ticker,
                ):
                    ticker.return_value.history.return_value = frame
                    if expected:
                        self.assertEqual(service.get_midnight_prices(NIGHT, day, day), expected)
                    else:
                        with self.assertRaises(ValueError):
                            service.get_midnight_prices(NIGHT, day, day)

    def test_non_aligned_hour_is_not_invented_as_a_midnight_open(self):
        service = CryptoPriceService()
        day = date(2026, 8, 3)
        midnight = datetime.combine(day, datetime.min.time(), ET).astimezone(UTC)
        frame = history([(midnight + timedelta(minutes=30), ".05", ".055")])
        with (
            patch("app.crypto_price_service._utc_now", return_value=midnight + timedelta(hours=12)),
            patch("app.crypto_price_service.yf.Ticker") as ticker,
        ):
            ticker.return_value.history.return_value = frame
            self.assertEqual(service.get_midnight_prices(NIGHT, day, day), {})

    def test_empty_completed_history_can_be_retried_with_later_good_data(self):
        service = CryptoPriceService()
        start = datetime(2026, 8, 3, 4, 0, tzinfo=UTC)
        end = start + timedelta(minutes=1)
        frame = history([(start, ".04", ".041")])
        with (
            patch("app.crypto_price_service._utc_now", return_value=end + timedelta(days=1)),
            patch("app.crypto_price_service.yf.Ticker") as ticker,
        ):
            ticker.return_value.history.side_effect = [pd.DataFrame(), frame]
            try:
                empty = service._candles(NIGHT, start, end, 60)
            except (ValueError, RuntimeError):
                empty = None
            self.assertIn(empty, (None, []))
            candles = service._candles(NIGHT, start, end, 60)
        self.assertEqual(candles, [Candle(int(start.timestamp()), Decimal(".04"), Decimal(".041"))])
        self.assertEqual(ticker.return_value.history.call_count, 2)

    def test_empty_or_nonfinite_current_quote_does_not_become_a_price(self):
        for frame in (
            pd.DataFrame(),
            history([(datetime(2026, 8, 3, tzinfo=UTC), ".04", float("nan"))]),
            history([(datetime(2026, 8, 3, tzinfo=UTC), ".04", float("inf"))]),
            history([(datetime(2026, 8, 3, tzinfo=UTC), ".04", 0)]),
        ):
            with self.subTest(frame=frame):
                service = CryptoPriceService()
                with patch("app.crypto_price_service.yf.Ticker") as ticker:
                    ticker.return_value.history.return_value = frame
                    with self.assertRaises((ValueError, RuntimeError)):
                        service.get_current_price(NIGHT)


class MidnightPriceServiceRecoveryTests(unittest.TestCase):
    def test_yesterday_only_minutes_are_partial_and_retry_without_waiting_for_ttl(self):
        service = PriceService()
        day = date(2026, 8, 3)
        yesterday = day - timedelta(days=1)
        old_rows = [{"date": yesterday.isoformat(), "time": "23:59", "price": Decimal(".04")}]
        fresh = [{"date": day.isoformat(), "time": "00:01", "price": Decimal(".045")}]
        key = f"{NIGHT}_{day.isoformat()}_1m_1"
        with (
            patch("app.price_service._market_today", return_value=day),
            patch.object(service.crypto, "get_intraday_prices", side_effect=[old_rows, fresh]) as fetch,
            patch.object(cache_service, "get_intraday_prices", return_value=[]),
            patch.object(cache_service, "save_intraday_prices"),
        ):
            self.assertEqual(service.get_intraday_prices(NIGHT, "1m"), [])
            self.assertEqual(service.stale_intraday_symbols([NIGHT], "1m"), [NIGHT])
            self.assertNotIn(key, service._intraday_cache)
            self.assertEqual(service.get_intraday_prices(NIGHT, "1m"), fresh)
            self.assertEqual(service.stale_intraday_symbols([NIGHT], "1m"), [])
        self.assertEqual(fetch.call_count, 2)

    def test_failed_minute_fetch_stays_partial_and_success_clears_stale_marker(self):
        service = PriceService()
        day = date(2026, 8, 3)
        stale = [{"date": day.isoformat(), "time": "00:00", "price": Decimal(".04")}]
        fresh = [{"date": day.isoformat(), "time": "00:01", "price": Decimal(".045")}]
        key = f"{NIGHT}_{day.isoformat()}_1m_1"
        service._intraday_cache[key] = (stale, datetime.min)
        with (
            patch("app.price_service._market_today", return_value=day),
            patch.object(service.crypto, "get_intraday_prices", side_effect=[
                requests.ConnectionError("offline"), fresh, requests.ConnectionError("offline again"),
            ]) as fetch,
            patch.object(cache_service, "save_intraday_prices") as save,
        ):
            self.assertEqual(service.get_intraday_prices(NIGHT, "1m", force_refresh=True), stale)
            self.assertEqual(service.stale_intraday_symbols([NIGHT], "1m"), [NIGHT])
            self.assertEqual(service.get_intraday_prices(NIGHT, "1m", force_refresh=True), fresh)
            self.assertEqual(service.stale_intraday_symbols([NIGHT], "1m"), [])
            self.assertEqual(service.get_intraday_prices(NIGHT, "1m", force_refresh=True), fresh)
            self.assertEqual(service.stale_intraday_symbols([NIGHT], "1m"), [NIGHT])
        self.assertEqual(fetch.call_count, 3)
        save.assert_called_once()

    def test_missing_midnight_baseline_is_pending_and_retried(self):
        service = PriceService()
        day = date(2026, 8, 3)
        with patch.object(service.crypto, "get_midnight_prices", side_effect=[{}, {day: Decimal(".04")}]) as fetch:
            first = service._get_crypto_est_midnight_price_batch([NIGHT], day)
            second = service._get_crypto_est_midnight_price_batch([NIGHT], day)
        self.assertEqual(first, {NIGHT: None})
        self.assertEqual(second, {NIGHT: Decimal(".04")})
        self.assertEqual(fetch.call_count, 2)


class MidnightPersistentCacheIsolationTests(unittest.TestCase):
    def test_daily_cache_uses_alias_while_results_and_memory_keep_ledger_symbol(self):
        service = PriceService()
        day = date(2026, 8, 3)
        previous_day = day - timedelta(days=1)
        cached = {previous_day: Decimal(".04")}
        fetched = {day: Decimal(".045")}
        with (
            patch.object(cache_service, "_get_cache_cutoff_date", return_value=previous_day),
            patch.object(cache_service, "get_historical_prices", return_value=cached) as read,
            patch.object(cache_service, "get_historical_prices_batch", return_value={}),
            patch.object(cache_service, "save_historical_prices_batch") as save,
            patch.object(service.crypto, "get_historical_prices", return_value=fetched) as fetch,
        ):
            result = service.get_historical_prices_batch([NIGHT], previous_day, day)
        read.assert_called_once_with(ALIAS, previous_day, day)
        save.assert_called_once_with(ALIAS, fetched)
        fetch.assert_called_once_with(NIGHT, previous_day, day)
        self.assertEqual(result, {NIGHT: {**cached, **fetched}})
        self.assertIn(f"{NIGHT}_{previous_day}_{day}", service._history_cache)
        self.assertNotIn(f"{ALIAS}_{previous_day}_{day}", service._history_cache)

    def test_startup_warming_reads_alias_but_exposes_original_symbol(self):
        service = PriceService()
        day = date(2026, 8, 3)
        rows = [{"date": day.isoformat(), "time": "00:01", "price": Decimal(".045")}]
        with (
            patch("app.price_service._market_today", return_value=day),
            patch.object(cache_service, "get_intraday_prices", return_value=rows) as read,
            patch.object(service.crypto, "get_current_price") as fetch,
        ):
            self.assertEqual(service.prime_intraday_cache_from_db([NIGHT]), 1)
            self.assertEqual(service.get_prices_batch([NIGHT]), {NIGHT: Decimal(".045")})
        read.assert_called_once_with(ALIAS, day.isoformat(), "1m")
        fetch.assert_not_called()
        self.assertIn(f"{NIGHT}_{day.isoformat()}_1m_1", service._intraday_cache)
        self.assertIn(NIGHT, service._price_cache)
        self.assertNotIn(ALIAS, service._price_cache)

    def test_live_minutes_save_alias_without_renaming_internal_cache(self):
        service = PriceService()
        day = date(2026, 8, 3)
        rows = [{"date": day.isoformat(), "time": "00:01", "price": Decimal(".045")}]
        with (
            patch("app.price_service._market_today", return_value=day),
            patch.object(service.crypto, "get_intraday_prices", return_value=rows) as fetch,
            patch.object(cache_service, "save_intraday_prices") as save,
        ):
            self.assertEqual(service.get_intraday_prices(NIGHT, "1m", force_refresh=True), rows)
        fetch.assert_called_once_with(NIGHT, "1m", 2, day)
        save.assert_called_once_with(ALIAS, day.isoformat(), "1m", rows)
        self.assertIn(f"{NIGHT}_{day.isoformat()}_1m_1", service._intraday_cache)
        self.assertNotIn(f"{ALIAS}_{day.isoformat()}_1m_1", service._intraday_cache)

    def test_failed_cold_minutes_read_only_alias_cache_and_remain_partial(self):
        service = PriceService()
        day = date(2026, 8, 3)
        rows = [{"date": day.isoformat(), "time": "00:01", "price": Decimal(".045")}]
        with (
            patch("app.price_service._market_today", return_value=day),
            patch.object(service.crypto, "get_intraday_prices", side_effect=requests.ConnectionError("offline")),
            patch.object(cache_service, "get_intraday_prices", return_value=rows) as read,
        ):
            self.assertEqual(service.get_intraday_prices(NIGHT, "1m", force_refresh=True), rows)
            self.assertEqual(service.stale_intraday_symbols([NIGHT], "1m"), [NIGHT])
        read.assert_called_once_with(ALIAS, day.isoformat(), "1m")


if __name__ == "__main__":
    unittest.main()
