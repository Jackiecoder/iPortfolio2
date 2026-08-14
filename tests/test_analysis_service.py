"""Tests for deterministic saved investment analysis reports."""

import unittest
import os
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from app.analysis_service import (
    AnalysisConfigurationError,
    GPTFinding,
    GPTInvestmentAnalysis,
    add_gpt_analysis,
    generate_analysis_report,
)
from app.models import ActionType, Transaction


class FakePortfolio:
    def __init__(self, history, holdings):
        self.history = history
        self.holdings = holdings
        self.requested_days = None
        self.requested_end_date = None

    def get_daily_pnl_history(self, num_days, end_date=None):
        self.requested_days = num_days
        self.requested_end_date = end_date
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
        self.assertEqual(self.portfolio.requested_end_date, self.as_of)
        self.assertEqual(report["start_date"], "2026-07-03")
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

    @patch("app.analysis_service.price_service.get_historical_prices_batch")
    def test_custom_range_includes_both_dates(self, get_prices):
        get_prices.return_value = {}

        report = generate_analysis_report(
            self.portfolio,
            self.transactions,
            start_date=date(2026, 7, 2),
            end_date=self.as_of,
            as_of=self.as_of,
        )

        self.assertEqual(self.portfolio.requested_days, 31)
        self.assertEqual(self.portfolio.requested_end_date, self.as_of)
        self.assertEqual(report["period"], "custom")
        self.assertEqual(report["period_label"], "31 Days")
        self.assertEqual(report["start_date"], "2026-07-02")
        self.assertEqual(report["end_date"], "2026-08-01")

    def test_rejects_invalid_custom_range(self):
        with self.assertRaisesRegex(ValueError, "start_date must be"):
            generate_analysis_report(
                self.portfolio,
                self.transactions,
                start_date=date(2026, 8, 1),
                end_date=date(2026, 7, 1),
                as_of=self.as_of,
            )

    @patch("app.analysis_service.price_service.get_historical_prices_batch", return_value={})
    def test_empty_history_returns_insufficient_data(self, _get_prices):
        empty_portfolio = FakePortfolio(history=[], holdings=[])
        report = generate_analysis_report(empty_portfolio, [], "1d", as_of=self.as_of)

        self.assertEqual(report["verdict"]["label"], "Insufficient Data")
        self.assertIsNone(report["verdict"]["score"])
        self.assertEqual(report["portfolio"]["data_points"], 0)
        self.assertIsNone(report["relative"]["spy_excess_pct"])

    def test_gpt_analysis_is_structured_and_merged(self):
        class FakeResponses:
            def __init__(self):
                self.kwargs = None

            def parse(self, **kwargs):
                self.kwargs = kwargs
                parsed = GPTInvestmentAnalysis(
                    verdict_label="Sound",
                    score=72,
                    executive_summary="The outcome was sound but concentration deserves attention.",
                    decision_quality="Returns exceeded the benchmark with controlled activity.",
                    market_context="The portfolio outpaced the supplied broad-market evidence.",
                    risk_assessment="AAPL concentration remains the main measured risk.",
                    key_findings=[
                        GPTFinding(tone="positive", title="Relative strength", body="The portfolio led SPY."),
                    ],
                    considerations=["Review whether the current AAPL weight still fits the intended risk budget."],
                )
                return SimpleNamespace(
                    output_parsed=parsed,
                    model="gpt-test",
                    id="resp_test",
                )

        fake_responses = FakeResponses()
        fake_client = SimpleNamespace(responses=fake_responses)
        report = {
            "start_date": "2026-07-01",
            "end_date": "2026-08-01",
            "portfolio": {"return_pct": 4.0},
            "market": {"benchmarks": []},
            "relative": {"spy_excess_pct": 1.0},
            "allocation": {"top_holdings": []},
            "activity": {"transaction_count": 1},
            "contributors": {"positive": [], "negative": []},
            "verdict": {"label": "Mixed", "score": 55, "summary": "Local result"},
            "observations": [],
            "methodology": [],
        }

        result = add_gpt_analysis(report, client=fake_client, model="gpt-test")

        self.assertEqual(result["verdict"]["label"], "Sound")
        self.assertEqual(result["verdict"]["score"], 72)
        self.assertEqual(result["quantitative_assessment"]["score"], 55)
        self.assertEqual(result["ai_analysis"]["response_id"], "resp_test")
        self.assertEqual(result["observations"][0]["title"], "Relative strength")
        self.assertFalse(fake_responses.kwargs["store"])
        self.assertEqual(fake_responses.kwargs["model"], "gpt-test")

    def test_gpt_requires_server_api_key(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(AnalysisConfigurationError):
                add_gpt_analysis({})


if __name__ == "__main__":
    unittest.main()
