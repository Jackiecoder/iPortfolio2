from datetime import date
from decimal import Decimal
import unittest
from unittest.mock import patch

import pandas as pd

from app.price_service import PriceService


TODAY = date(2026, 8, 31)
PREVIOUS_SESSION = date(2026, 8, 28)


def grouped_closes(symbol_values: dict[str, list[float]], dates: list[str]):
    columns = pd.MultiIndex.from_product(
        [list(symbol_values), ["Close"]], names=["Ticker", "Price"]
    )
    rows = list(zip(*(symbol_values[symbol] for symbol in symbol_values)))
    return pd.DataFrame(rows, index=pd.to_datetime(dates), columns=columns)


class PreviousCloseTests(unittest.TestCase):
    def test_previous_market_session_comes_from_minute_bars(self):
        service = PriceService()
        index = pd.to_datetime(
            [
                "2026-08-27 15:59:00-04:00",
                "2026-08-28 15:59:00-04:00",
                "2026-08-31 09:30:00-04:00",
            ]
        )
        bars = pd.DataFrame({"Close": [100, 101, 102]}, index=index)

        with patch("app.price_service.yf.download", return_value=bars) as download:
            result = service._get_previous_market_session(TODAY)

        self.assertEqual(result, PREVIOUS_SESSION)
        download.assert_called_once_with(
            "SPY", period="5d", interval="1m", prepost=False, progress=False
        )

    def test_missing_daily_session_uses_minute_close_and_locks_baseline(self):
        service = PriceService()
        daily = grouped_closes(
            {
                # MRVL is missing the expected Friday row, reproducing the
                # yfinance gap seen in production on 2026-08-31.
                "MRVL": [241.45, float("nan"), 211.66],
                "MU": [935.39, 932.86, 955.80],
            },
            ["2026-08-27", "2026-08-28", "2026-08-31"],
        )

        with (
            patch("app.price_service._market_today", return_value=TODAY),
            patch.object(
                service,
                "_get_previous_market_session",
                return_value=PREVIOUS_SESSION,
            ),
            patch("app.price_service.yf.download", return_value=daily) as download,
            patch.object(
                service,
                "_get_regular_session_close_batch",
                return_value={"MRVL": Decimal("216.595")},
            ) as fallback,
        ):
            first = service.get_previous_close_batch(["MRVL", "MU"])
            second = service.get_previous_close_batch(["MRVL", "MU"])

        self.assertEqual(first["MRVL"], Decimal("216.595"))
        self.assertEqual(first["MU"], Decimal("932.86"))
        self.assertEqual(second, first)
        fallback.assert_called_once_with(["MRVL"], PREVIOUS_SESSION)
        # The second request is served from the market-day lock.
        self.assertEqual(download.call_count, 1)

    def test_missing_daily_and_minute_session_never_uses_older_close(self):
        service = PriceService()
        daily = grouped_closes(
            {"MRVL": [241.45, 211.66]},
            ["2026-08-27", "2026-08-31"],
        )

        with (
            patch("app.price_service._market_today", return_value=TODAY),
            patch.object(
                service,
                "_get_previous_market_session",
                return_value=PREVIOUS_SESSION,
            ),
            patch("app.price_service.yf.download", return_value=daily),
            patch.object(
                service,
                "_get_regular_session_close_batch",
                return_value={"MRVL": None},
            ),
        ):
            result = service.get_previous_close_batch(["MRVL"])

        self.assertIsNone(result["MRVL"])
        self.assertNotIn(str(["MRVL"]), service._locked_prev_close_cache)

    def test_unverified_market_session_never_uses_last_daily_row(self):
        service = PriceService()
        daily = grouped_closes(
            {"MRVL": [241.45, 211.66]},
            ["2026-08-27", "2026-08-31"],
        )

        with (
            patch("app.price_service._market_today", return_value=TODAY),
            patch.object(
                service,
                "_get_previous_market_session",
                return_value=None,
            ),
            patch("app.price_service.yf.download", return_value=daily),
        ):
            result = service.get_previous_close_batch(["MRVL"])

        self.assertIsNone(result["MRVL"])

    def test_minute_fallback_uses_final_regular_session_bar(self):
        service = PriceService()
        columns = pd.MultiIndex.from_product(
            [["MRVL"], ["Close"]], names=["Ticker", "Price"]
        )
        index = pd.to_datetime(
            ["2026-08-28 15:58:00-04:00", "2026-08-28 15:59:00-04:00"]
        )
        bars = pd.DataFrame([[217.245], [216.595]], index=index, columns=columns)

        with patch("app.price_service.yf.download", return_value=bars):
            result = service._get_regular_session_close_batch(
                ["MRVL"], PREVIOUS_SESSION
            )

        self.assertEqual(result["MRVL"], Decimal("216.595"))

    def test_short_ttl_cache_is_not_reused_after_market_date_changes(self):
        service = PriceService()
        cache_key = str(["MRVL"])
        service._prev_close_cache[cache_key] = (
            {"MRVL": Decimal("241.45")},
            pd.Timestamp.now().to_pydatetime(),
        )
        service._prev_close_cache_market_date[cache_key] = date(2026, 8, 28)
        daily = grouped_closes(
            {"MRVL": [216.62, 211.66]}, ["2026-08-28", "2026-08-31"]
        )

        with (
            patch("app.price_service._market_today", return_value=TODAY),
            patch.object(
                service,
                "_get_previous_market_session",
                return_value=PREVIOUS_SESSION,
            ),
            patch("app.price_service.yf.download", return_value=daily),
        ):
            result = service.get_previous_close_batch(["MRVL"])

        self.assertEqual(result["MRVL"], Decimal("216.62"))


class CryptoPreviousCloseTests(unittest.TestCase):
    def setUp(self):
        self.service = PriceService()
        self.today = date(2026, 9, 19)
        self.bars = pd.DataFrame(
            {"Open": [81276.06, 81105.05], "Close": [81105.03, 81001.68]},
            index=pd.to_datetime(["2026-09-19 03:00Z", "2026-09-19 04:00Z"]),
        )

    def fetch(self, bars, target_date=None):
        with (
            patch("app.price_service._market_today", return_value=target_date or self.today),
            patch("app.price_service.yf.Ticker") as ticker,
        ):
            ticker.return_value.history.return_value = bars
            return self.service.get_previous_close_batch(["BTC-USD"])["BTC-USD"]

    def test_midnight_uses_completed_hour_not_first_hour_of_new_day(self):
        self.assertEqual(self.fetch(self.bars), Decimal("81105.03"))

    def test_fresh_yesterday_cache_cannot_be_locked_as_todays_baseline(self):
        yesterday = self.bars.copy()
        yesterday.index -= pd.Timedelta(days=1)
        yesterday["Close"] = [77496.26, 77520.0]
        self.assertEqual(self.fetch(yesterday, date(2026, 9, 18)), Decimal("77496.26"))
        stocks = grouped_closes({"MU": [1015.8]}, ["2026-09-18"])
        with (
            patch("app.price_service._market_today", return_value=self.today),
            patch("app.price_service.yf.Ticker") as ticker,
            patch("app.price_service.yf.download", return_value=stocks),
            patch.object(self.service, "_get_previous_market_session", return_value=date(2026, 9, 18)),
        ):
            ticker.return_value.history.return_value = self.bars
            first = self.service.get_previous_close_batch(["BTC-USD", "MU"])
            # A later fetch in the same day must retain the verified baseline.
            ticker.return_value.history.return_value = pd.DataFrame()
            second = self.service.get_previous_close_batch(["MU", "BTC-USD"])
        self.assertEqual(first["BTC-USD"], Decimal("81105.03"))
        self.assertEqual(first, second)
        self.assertEqual(ticker.return_value.history.call_count, 1)

    def test_midnight_open_is_allowed_if_completed_hour_is_missing(self):
        self.assertEqual(self.fetch(self.bars.iloc[1:]), Decimal("81105.05"))

    def test_missing_boundary_never_uses_older_or_future_close(self):
        for timestamp in ["2026-09-18 04:00Z", "2026-09-19 02:00Z", "2026-09-19 05:00Z"]:
            with self.subTest(timestamp=timestamp):
                self.service = PriceService()
                bars = pd.DataFrame({"Close": [77496.26]}, index=pd.to_datetime([timestamp]))
                self.assertIsNone(self.fetch(bars))

    def test_invalid_boundary_prices_are_unavailable(self):
        for value in [float("nan"), float("inf"), 0, -1]:
            with self.subTest(value=value):
                self.service = PriceService()
                bars = self.bars.iloc[:1].copy()
                bars["Close"] = value
                self.assertIsNone(self.fetch(bars))

    def test_midnight_follows_new_york_offset_including_dst_changes(self):
        for day, utc_hour in [
            (date(2026, 1, 19), 4),
            (date(2026, 3, 8), 4),
            (date(2026, 3, 9), 3),
            (date(2026, 11, 1), 3),
            (date(2026, 11, 2), 4),
        ]:
            with self.subTest(day=day):
                self.service = PriceService()
                bars = pd.DataFrame(
                    {"Close": [81105.03, 81001.68]},
                    index=pd.date_range(f"{day} {utc_hour:02d}:00", periods=2, freq="h", tz="UTC"),
                )
                self.assertEqual(self.fetch(bars, day), Decimal("81105.03"))

    def test_clear_cache_removes_crypto_day_metadata(self):
        self.fetch(self.bars)
        self.service.clear_cache()
        with patch("app.price_service.yf.Ticker") as ticker:
            ticker.return_value.history.return_value = pd.DataFrame()
            with patch("app.price_service._market_today", return_value=self.today):
                self.assertIsNone(self.service.get_previous_close("BTC-USD"))
        ticker.return_value.history.assert_called_once()


if __name__ == "__main__":
    unittest.main()
