from datetime import date, datetime
from decimal import Decimal
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app.models import ActionType, Transaction
from app.portfolio import Portfolio
from app.price_service import price_service


MARKET_TZ = ZoneInfo("America/New_York")
TODAY = date(2026, 7, 31)


def trade(action: ActionType, quantity: str, price: str, hour: int) -> Transaction:
    return Transaction(
        date=TODAY,
        asset="AAPL",
        action=action,
        quantity=Decimal(quantity),
        ave_price=Decimal(price),
        executed_at=datetime(2026, 7, 31, hour, 0, tzinfo=MARKET_TZ),
    )


class TransactionTimeTests(unittest.TestCase):
    def test_default_execution_times_are_asset_aware(self):
        stock = Transaction(
            date=TODAY,
            asset="AAPL",
            action=ActionType.BUY,
            quantity=Decimal("1"),
            ave_price=Decimal("100"),
        )
        crypto = Transaction(
            date=TODAY,
            asset="BTC-USD",
            action=ActionType.BUY,
            quantity=Decimal("1"),
            ave_price=Decimal("100"),
        )

        self.assertEqual(stock.effective_executed_at.strftime("%H:%M"), "09:30")
        self.assertEqual(crypto.effective_executed_at.strftime("%H:%M"), "00:00")


class DailyPnlTests(unittest.TestCase):
    def _priced_holdings(self, portfolio: Portfolio):
        with (
            patch("app.portfolio._market_today", return_value=TODAY),
            patch.object(
                price_service, "get_prices_batch",
                return_value={"AAPL": Decimal("307.50")},
            ),
            patch.object(
                price_service, "get_previous_close_batch",
                return_value={"AAPL": Decimal("333.428")},
            ),
            patch.object(
                price_service, "get_year_start_prices_batch",
                return_value={"AAPL": Decimal("300")},
            ),
        ):
            return portfolio.get_holdings(fetch_prices=True)

    def test_same_day_buy_uses_execution_price_not_previous_close(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([trade(ActionType.BUY, "10", "303", 10)])

        holding = self._priced_holdings(portfolio)[0]

        self.assertEqual(holding.daily_change_amount, Decimal("45.00"))
        self.assertAlmostEqual(float(holding.daily_change_percent), 1.4851485, places=6)

    def test_opening_shares_use_previous_close_and_new_shares_use_trade_price(self):
        portfolio = Portfolio(adjust_splits=False)
        opening_trade = Transaction(
            date=date(2026, 7, 30),
            asset="AAPL",
            action=ActionType.BUY,
            quantity=Decimal("5"),
            ave_price=Decimal("200"),
        )
        portfolio.add_transactions([
            opening_trade,
            trade(ActionType.BUY, "10", "303", 10),
        ])

        holding = self._priced_holdings(portfolio)[0]

        expected = (
            Decimal("5") * (Decimal("307.50") - Decimal("333.428"))
            + Decimal("10") * (Decimal("307.50") - Decimal("303"))
        )
        self.assertEqual(holding.daily_change_amount, expected)

    def test_same_day_sell_combines_realized_and_open_position_pnl(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            trade(ActionType.BUY, "10", "303", 10),
            trade(ActionType.SELL, "4", "305", 11),
        ])

        holding = self._priced_holdings(portfolio)[0]

        # 4 sold shares earned $8 and 6 open shares earned $27.
        self.assertEqual(holding.quantity, Decimal("6"))
        self.assertEqual(holding.daily_change_amount, Decimal("35.00"))

    def test_intraday_buy_is_not_applied_before_execution_time(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([trade(ActionType.BUY, "10", "303", 10)])
        prices = {
            "AAPL": [
                {"time": "09:30", "price": Decimal("330")},
                {"time": "10:00", "price": Decimal("303")},
                {"time": "11:00", "price": Decimal("307.50")},
            ]
        }

        with (
            patch("app.portfolio._market_today", return_value=TODAY),
            patch(
                "app.portfolio._market_now",
                return_value=datetime(2026, 7, 31, 12, 0, tzinfo=MARKET_TZ),
            ),
            patch.object(
                price_service, "get_previous_close_batch",
                return_value={"AAPL": Decimal("333.428")},
            ),
            patch.object(price_service, "get_intraday_prices_batch", return_value=prices),
            patch.object(
                price_service, "get_prices_batch",
                return_value={"AAPL": Decimal("307.50")},
            ),
        ):
            points = portfolio.get_intraday_values("30m")

        by_time = {point["time"]: point for point in points}
        self.assertEqual(by_time["09:30"]["daily_pnl"], 0.0)
        self.assertEqual(by_time["10:00"]["daily_pnl"], 0.0)
        self.assertEqual(by_time["12:00"]["daily_pnl"], 45.0)
        self.assertEqual(by_time["12:00"]["asset_changes"][0]["pnl"], 45.0)


if __name__ == "__main__":
    unittest.main()
