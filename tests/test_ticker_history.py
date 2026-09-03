import asyncio
from datetime import date, datetime
from decimal import Decimal
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app import main
from app.models import ActionType, Transaction


class TickerHistoryTests(unittest.TestCase):
    def test_weekly_sampling_keeps_last_close_in_each_week(self):
        prices = {
            date(2026, 8, 3): Decimal("100"),
            date(2026, 8, 7): Decimal("105"),
            date(2026, 8, 10): Decimal("104"),
            date(2026, 8, 14): Decimal("108"),
        }

        sampled = main._sample_ticker_prices(prices, "weekly")

        self.assertEqual(sampled, [
            {"date": "2026-08-07", "close": 105.0},
            {"date": "2026-08-14", "close": 108.0},
        ])

    def test_endpoint_returns_prices_and_trade_markers(self):
        market_tz = ZoneInfo("America/New_York")
        transactions = [
            Transaction(
                date=date(2026, 5, 15),
                asset="AAPL",
                action=ActionType.BUY,
                quantity=Decimal("10"),
                ave_price=Decimal("100"),
                executed_at=datetime(2026, 5, 15, 10, 30, tzinfo=market_tz),
            ),
            Transaction(
                date=date(2026, 8, 15),
                asset="AAPL",
                action=ActionType.SELL,
                quantity=Decimal("2"),
                ave_price=Decimal("120"),
                executed_at=datetime(2026, 8, 15, 11, 0, tzinfo=market_tz),
            ),
        ]

        class FakePortfolio:
            _transactions = transactions

        original_portfolio = main.portfolio
        main.portfolio = FakePortfolio()
        try:
            with (
                patch.object(main, "market_today", return_value=date(2026, 9, 3)),
                patch.object(
                    main.price_service,
                    "get_historical_prices",
                    return_value={
                        date(2026, 5, 15): Decimal("101"),
                        date(2026, 9, 3): Decimal("125"),
                    },
                ),
                patch.object(
                    main.split_service,
                    "get_adjustment_factor",
                    return_value=Decimal("1"),
                ),
            ):
                result = asyncio.run(main.get_ticker_history("AAPL", "6M"))
        finally:
            main.portfolio = original_portfolio

        self.assertEqual(result["symbol"], "AAPL")
        self.assertEqual(result["granularity"], "daily")
        self.assertEqual(len(result["prices"]), 2)
        self.assertEqual([row["action"] for row in result["transactions"]], ["BUY", "SELL"])
        self.assertEqual(result["transactions"][0]["execution_price"], 100.0)


if __name__ == "__main__":
    unittest.main()
