"""Option estimates must preserve unavailable holding P&L and its coverage."""

from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal
import unittest

from app.option_pnl_service import OptionPnlService, decorate_option_points


DAY = date(2026, 9, 30)
NOW = datetime(2026, 9, 30, 14, 0, 23, tzinfo=timezone.utc)
SCHEDULE = {
    "previous": {
        "date": date(2026, 9, 29),
        "open": datetime(2026, 9, 29, 13, 30, tzinfo=timezone.utc),
        "close": datetime(2026, 9, 29, 20, tzinfo=timezone.utc),
    },
    "current": {
        "date": DAY,
        "open": datetime(2026, 9, 30, 13, 30, tzinfo=timezone.utc),
        "close": datetime(2026, 9, 30, 20, tzinfo=timezone.utc),
    },
}
CALL = {
    "id": 1,
    "opening": {
        "asset": "MRVL", "broker": "Fidelity", "date": "2026-09-25",
        "transaction_time": "10:00:00", "expiration": "2026-10-30",
        "strike": "280", "contracts": 1, "premium": "15", "fees": ".65",
    },
    "events": [],
}


def quotes():
    common = {
        "asset": "MRVL", "expiration": "2026-10-30", "strike": 280,
        "contract_symbol": "MRVL261030C00280000", "source": "Yahoo Finance",
    }
    return [
        {**common, "captured_at": "2026-09-29T20:35:00+00:00", "bid": 11.9, "ask": 12.1, "mid": 12},
        {**common, "captured_at": "2026-09-30T14:00:00+00:00", "bid": 13.4, "ask": 13.6, "mid": 13.5},
    ]


def holding_point(known=None):
    rows = [{
        "symbol": "NIGHT-USD", "quantity": 100, "current_price": .0444,
        "pnl": None, "pnl_percent": None, "prev_price": None,
    }]
    if known is not None:
        rows.append({"symbol": "MRVL", "quantity": 2, "pnl": known, "pnl_percent": 10})
    return {
        "time": "10:00", "value": 4.44 if known is None else 224.44,
        "baseline_value": 0 if known is None else 200,
        "daily_pnl": known, "daily_pnl_percent": None if known is None else 10,
        "holdings_complete": True, "asset_changes": rows,
        "missing_baseline_symbols": ["NIGHT-USD"],
    }


class MissingHoldingOptionPnlTests(unittest.TestCase):
    def assert_preserved(self, original, result):
        self.assertEqual(result["missing_baseline_symbols"], ["NIGHT-USD"])
        self.assertIs(result["asset_changes"], original["asset_changes"])
        self.assertIsNone(result["asset_changes"][0]["pnl"])
        self.assertIsNone(result["asset_changes"][0]["pnl_percent"])
        self.assertEqual(result["holdings_complete"], original["holdings_complete"])
        self.assertEqual(result["value"], original["value"])

    def test_known_options_do_not_turn_unknown_holdings_into_zero_or_a_total(self):
        original = holding_point()
        saved = deepcopy(original)
        result = decorate_option_points([original], DAY, [CALL], quotes(), SCHEDULE)[0]
        self.assertIsNone(result["daily_pnl"])
        self.assertIsNone(result["holdings_daily_pnl"])
        self.assertIsNone(result["combined_daily_pnl"])
        self.assertEqual(result["option_daily_pnl"], -150)
        self.assertTrue(result["options_complete"])
        self.assert_preserved(original, result)
        self.assertEqual(original, saved)

    def test_absent_options_do_not_turn_unknown_holdings_into_zero(self):
        original = holding_point()
        result = decorate_option_points([original], DAY, [], [], {})[0]
        self.assertIsNone(result["daily_pnl"])
        self.assertIsNone(result["holdings_daily_pnl"])
        self.assertIsNone(result["combined_daily_pnl"])
        self.assertEqual(result["option_daily_pnl"], 0)
        self.assertFalse(result["options_present"])
        self.assert_preserved(original, result)

    def test_known_holdings_and_options_add_once_while_missing_coverage_remains(self):
        original = holding_point(20)
        result = decorate_option_points([original], DAY, [CALL], quotes(), SCHEDULE)[0]
        self.assertEqual(result["daily_pnl"], 20)
        self.assertEqual(result["holdings_daily_pnl"], 20)
        self.assertEqual(result["option_daily_pnl"], -150)
        self.assertEqual(result["combined_daily_pnl"], -130)
        self.assert_preserved(original, result)

    def test_current_option_service_preserves_unknown_holdings_when_adding_asof(self):
        original = holding_point()
        service = OptionPnlService(
            clock=lambda: NOW, reader=lambda _: quotes(),
            check_reader=lambda _: {1: Decimal("1")},
            schedule_provider=lambda _: SCHEDULE,
        )
        result = service.decorate([original], DAY, [CALL], collect=False)[0]
        self.assertIsNone(result["holdings_daily_pnl"])
        self.assertIsNone(result["combined_daily_pnl"])
        self.assertEqual(result["option_daily_pnl"], -150)
        self.assertTrue(result["options_collection_complete"])
        self.assertIn("as_of", result)
        self.assert_preserved(original, result)

    def test_option_storage_failure_preserves_unknown_holdings_and_coverage(self):
        def unavailable(_):
            raise RuntimeError("quote storage unavailable")

        original = holding_point()
        service = OptionPnlService(
            clock=lambda: NOW, reader=unavailable,
            schedule_provider=lambda _: SCHEDULE,
        )
        result = service.decorate([original], DAY, [CALL], collect=False)[0]
        self.assertIsNone(result["holdings_daily_pnl"])
        self.assertIsNone(result["option_daily_pnl"])
        self.assertIsNone(result["combined_daily_pnl"])
        self.assertFalse(result["options_complete"])
        self.assert_preserved(original, result)


if __name__ == "__main__":
    unittest.main()
