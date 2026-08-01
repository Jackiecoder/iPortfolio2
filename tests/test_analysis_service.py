"""Tests for deterministic saved investment analysis reports."""

import unittest
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from app.analysis_service import generate_analysis_report
from app.models import ActionType, Transaction


class FakePortfolio:
    def __init__(self, history, holdings):
        self.history = history
        self.holdings = holdings
        self.requested_days = None

    def get_daily_pnl_history(self, num_days):
        self.requested_days = num_days
        return self.history

    def get_portfolio_summary(self, fetch_prices=True):
        return SimpleNamespace(holdings=self.holdings)


class AnalysisReportTests(unittest.TestCase):
    def setUp(self):
        self.as_of = date(2026, 8, 1)
        self.portfolio = FakePortfolio(
            history=[
                {
                    "date": "2026-07-30",
                    "daily_pnl": 100.0,
                    "daily_pnl_percent": 1.0,
                    "asset_changes": [{"symbol": "AAPL", "pnl": 80.0}, {"symbol": "VOO", "pnl": 20.0}],
                },
                {
                    "date": "2026-07-31",
                    "daily_pnl": -50.0,
                    "daily_pnl_percent": -0.5,
                    "asset_changes": [{"symbol": "AAPL", "pnl": -70.0}, {"symbol": "VOO", "pnl": 20.0}],
                },
                {
                    "date": "2026-08-01",
                    "daily_pnl": 200.0,
                    "daily_pnl_percent": 2.0,
                    "asset_changes": [{"symbol": "AAPL", "pnl": 150.0}, {"symbol": "VOO", "pnl": 50.0}],
                },
            ],
            holdings=[
                SimpleNamespace(symbol="AAPL", market_value=Decimal("6000")),
                SimpleNamespace(symbol="VOO", market_value=Decimal("4000")),
            ],
        )
        self.transactions = [
            Transaction(
                date=date(2026, 7, 20),
                asset="AAPL",
                action=ActionType.BUY,
                quantity=Decimal("10"),
                ave_price=Decimal("300"),
            ),
            Transaction(
                date=date(2026, 6, 1),
                asset="VOO",
                action=ActionType.BUY,
                quantity=Decimal("5"),
                ave_price=Decimal("600"),
            ),
        ]

    @patch("app.analysis_service.price_service.get_historical_prices_batch")
    def test_generates_transaction_aware_report(self, get_prices):
        get_prices.return_value = {
            "SPY": {date(2026, 7, 2): Decimal("100"), date(2026, 8, 1): Decimal("103")},
            "QQQ": {date(2026, 7, 2): Decimal("100"), date(2026, 8, 1): Decimal("101")},
        }

        report = generate_analysis_report(
            self.portfolio,
            self.transactions,
            "30d",
            as_of=self.as_of,
        )

        self.assertEqual(self.portfolio.requested_days, 30)
        self.assertEqual(report["start_date"], "2026-07-02")
        self.assertAlmostEqual(report["portfolio"]["return_pct"], 2.5, places=2)
        self.assertEqual(report["portfolio"]["pnl"], 250.0)
        self.assertEqual(report["market"]["benchmarks"][0]["return_pct"], 3.0)
        self.assertEqual(report["relative"]["spy_excess_pct"], -0.5)
        self.assertEqual(report["allocation"]["top_holding_symbol"], "AAPL")
        self.assertEqual(report["allocation"]["top_holding_pct"], 60.0)
        self.assertEqual(report["activity"]["transaction_count"], 1)
        self.assertEqual(report["activity"]["buy_amount"], 3000.0)
        self.assertEqual(report["contributors"]["positive"][0], {"symbol": "AAPL", "pnl": 160.0})
        self.assertIsInstance(report["verdict"]["score"], int)

    def test_rejects_unknown_period(self):
        with self.assertRaisesRegex(ValueError, "Unsupported analysis period"):
            generate_analysis_report(self.portfolio, self.transactions, "quarter")

    @patch("app.analysis_service.price_service.get_historical_prices_batch", return_value={})
    def test_empty_history_returns_insufficient_data(self, _get_prices):
        empty_portfolio = FakePortfolio(history=[], holdings=[])
        report = generate_analysis_report(empty_portfolio, [], "1d", as_of=self.as_of)

        self.assertEqual(report["verdict"]["label"], "Insufficient Data")
        self.assertIsNone(report["verdict"]["score"])
        self.assertEqual(report["portfolio"]["data_points"], 0)
        self.assertIsNone(report["relative"]["spy_excess_pct"])


if __name__ == "__main__":
    unittest.main()
