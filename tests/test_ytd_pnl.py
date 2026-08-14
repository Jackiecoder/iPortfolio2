from datetime import date
from decimal import Decimal
import unittest
from unittest.mock import patch

from app.models import ActionType, Transaction
from app.portfolio import Portfolio
from app.price_service import price_service


TODAY = date(2026, 8, 14)


def trade(
    trade_date: date,
    action: ActionType,
    quantity: str,
    price: str,
) -> Transaction:
    return Transaction(
        date=trade_date,
        asset="AAPL",
        action=action,
        quantity=Decimal(quantity),
        ave_price=Decimal(price),
    )


class YtdPnlTests(unittest.TestCase):
    def _price_context(self, current: str = "120", year_start: str = "100"):
        return (
            patch("app.portfolio._market_today", return_value=TODAY),
            patch.object(
                price_service,
                "get_prices_batch",
                return_value={"AAPL": Decimal(current)},
            ),
            patch.object(
                price_service,
                "get_previous_close_batch",
                return_value={"AAPL": Decimal("119")},
            ),
            patch.object(
                price_service,
                "get_year_start_prices_batch",
                return_value={"AAPL": Decimal(year_start)},
            ),
        )

    def test_old_lot_ytd_includes_sale_rebased_to_year_start(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            trade(date(2024, 1, 2), ActionType.BUY, "10", "50"),
            trade(date(2026, 6, 1), ActionType.SELL, "4", "110"),
        ])

        contexts = self._price_context()
        with contexts[0], contexts[1], contexts[2], contexts[3]:
            holding = portfolio.get_holdings(fetch_prices=True)[0]

        # Open: 6 * (120 - 100) = 120. Sold: 4 * (110 - 100) = 40.
        # The all-time realized gain is 240 and must not be added to YTD.
        self.assertEqual(holding.ytd_pnl, Decimal("160"))
        self.assertEqual(holding.ytd_basis, Decimal("1000"))
        self.assertEqual(holding.ytd_pnl_percent, Decimal("16.00"))
        self.assertEqual(holding.lt_ytd_pnl, Decimal("160"))
        self.assertEqual(holding.st_ytd_pnl, Decimal("0"))
        self.assertEqual(holding.realized_pnl, Decimal("240"))

    def test_current_year_lot_uses_purchase_cost_for_open_and_sold_shares(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            trade(date(2026, 3, 1), ActionType.BUY, "10", "90"),
            trade(date(2026, 6, 1), ActionType.SELL, "4", "110"),
        ])

        contexts = self._price_context()
        with contexts[0], contexts[1], contexts[2], contexts[3]:
            holding = portfolio.get_holdings(fetch_prices=True)[0]

        # Open: 6 * (120 - 90) = 180. Sold: 4 * (110 - 90) = 80.
        self.assertEqual(holding.ytd_pnl, Decimal("260"))
        self.assertEqual(holding.ytd_basis, Decimal("900"))
        self.assertAlmostEqual(float(holding.ytd_pnl_percent), 28.8888889, places=6)
        self.assertEqual(holding.lt_ytd_pnl, Decimal("0"))
        self.assertEqual(holding.st_ytd_pnl, Decimal("260"))

    def test_sale_from_prior_year_is_not_included_in_ytd(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            trade(date(2024, 1, 2), ActionType.BUY, "10", "50"),
            trade(date(2025, 12, 1), ActionType.SELL, "4", "90"),
        ])

        contexts = self._price_context()
        with contexts[0], contexts[1], contexts[2], contexts[3]:
            holding = portfolio.get_holdings(fetch_prices=True)[0]

        self.assertEqual(holding.ytd_pnl, Decimal("120"))
        self.assertEqual(holding.ytd_basis, Decimal("600"))
        self.assertEqual(holding.ytd_pnl_percent, Decimal("20.0"))
        self.assertEqual(holding.realized_pnl, Decimal("160"))

    def test_summary_includes_symbol_fully_sold_this_year(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            trade(date(2024, 1, 2), ActionType.BUY, "10", "50"),
            trade(date(2026, 6, 1), ActionType.SELL, "10", "110"),
        ])

        contexts = self._price_context()
        with contexts[0], contexts[1], contexts[2], contexts[3]:
            summary = portfolio.get_portfolio_summary(fetch_prices=True)

        self.assertEqual(summary.holdings, [])
        self.assertEqual(summary.ytd_pnl, Decimal("100"))
        self.assertEqual(summary.ytd_basis, Decimal("1000"))
        self.assertEqual(summary.ytd_pnl_percent, Decimal("10.0"))
        self.assertEqual(summary.ytd_lt_pnl, Decimal("100"))
        self.assertEqual(summary.ytd_st_pnl, Decimal("0"))


if __name__ == "__main__":
    unittest.main()
