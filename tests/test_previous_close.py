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


if __name__ == "__main__":
    unittest.main()
