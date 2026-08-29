from datetime import date
from decimal import Decimal
import unittest
from unittest.mock import patch

from app.models import ActionType, Transaction
from app.portfolio import Portfolio
from app.price_service import price_service


def buy(symbol: str, trade_date: date, quantity: str, price: str) -> Transaction:
    return Transaction(
        date=trade_date,
        asset=symbol,
        action=ActionType.BUY,
        quantity=Decimal(quantity),
        ave_price=Decimal(price),
    )


class AnnualAssetPnlTests(unittest.TestCase):
    def test_asset_rows_reconcile_to_annual_pnl_formula(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            buy("AAPL", date(2025, 1, 2), "10", "100"),
            buy("MSFT", date(2025, 7, 1), "5", "50"),
        ])

        def prices_for_checkpoint(symbols, _start, end):
            checkpoint = end.date()
            if checkpoint == date(2025, 1, 2):
                return {
                    "AAPL": {date(2025, 1, 2): Decimal("100")},
                    "MSFT": {date(2025, 1, 2): Decimal("45")},
                }
            return {
                "AAPL": {date(2025, 12, 31): Decimal("120")},
                "MSFT": {date(2025, 12, 31): Decimal("60")},
            }

        with patch.object(
            price_service,
            "get_historical_prices_batch",
            side_effect=prices_for_checkpoint,
        ):
            result = portfolio.get_annual_asset_pnl_by_year(
                end_date=date(2025, 12, 31)
            )

        by_symbol = {row["symbol"]: row for row in result["2025"]}
        self.assertEqual(by_symbol["AAPL"]["start_value"], 1000.0)
        self.assertEqual(by_symbol["AAPL"]["end_value"], 1200.0)
        self.assertEqual(by_symbol["AAPL"]["net_invested"], 0.0)
        self.assertEqual(by_symbol["AAPL"]["pnl"], 200.0)

        self.assertEqual(by_symbol["MSFT"]["start_value"], 0.0)
        self.assertEqual(by_symbol["MSFT"]["end_value"], 300.0)
        self.assertEqual(by_symbol["MSFT"]["net_invested"], 250.0)
        self.assertEqual(by_symbol["MSFT"]["pnl"], 50.0)
        self.assertEqual(sum(row["pnl"] for row in result["2025"]), 250.0)
        self.assertEqual([row["symbol"] for row in result["2025"]], ["AAPL", "MSFT"])

    def test_fully_sold_asset_remains_in_following_year_breakdown(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            buy("AAPL", date(2025, 1, 2), "10", "100"),
            Transaction(
                date=date(2026, 6, 1),
                asset="AAPL",
                action=ActionType.SELL,
                quantity=Decimal("10"),
                ave_price=Decimal("150"),
            ),
        ])

        def prices_for_checkpoint(symbols, _start, end):
            checkpoint = end.date()
            price = Decimal("100") if checkpoint == date(2025, 1, 2) else Decimal("120")
            return {"AAPL": {checkpoint: price}}

        with patch.object(
            price_service,
            "get_historical_prices_batch",
            side_effect=prices_for_checkpoint,
        ):
            result = portfolio.get_annual_asset_pnl_by_year(
                end_date=date(2026, 12, 31)
            )

        sold_row = result["2026"][0]
        self.assertEqual(sold_row["symbol"], "AAPL")
        self.assertEqual(sold_row["start_value"], 1200.0)
        self.assertEqual(sold_row["end_value"], 0.0)
        self.assertEqual(sold_row["net_invested"], -1000.0)
        self.assertEqual(sold_row["pnl"], -200.0)


if __name__ == "__main__":
    unittest.main()
