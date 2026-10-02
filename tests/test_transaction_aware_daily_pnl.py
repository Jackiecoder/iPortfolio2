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
            with patch.object(price_service, "get_prices_batch") as quotes:
                fast_points = portfolio.get_intraday_values(
                    "30m", refresh_prices=True, use_live_quotes=False
                )
                quotes.assert_not_called()

        self.assertEqual(fast_points, points)

        by_time = {point["time"]: point for point in points}
        self.assertEqual(by_time["09:30"]["daily_pnl"], 0.0)
        self.assertEqual(by_time["10:00"]["daily_pnl"], 0.0)
        self.assertEqual(by_time["12:00"]["daily_pnl"], 45.0)
        self.assertEqual(by_time["12:00"]["asset_changes"][0]["pnl"], 45.0)


class IntradayHoldingsReconciliationTests(unittest.TestCase):
    def snapshot(self, portfolio, closes, bars):
        with (
            patch('app.portfolio._market_today', return_value=TODAY),
            patch('app.portfolio._market_now', return_value=datetime(2026, 7, 31, 12, 0, tzinfo=MARKET_TZ)),
            patch.object(price_service, 'get_previous_close_batch', return_value=closes),
            patch.object(price_service, 'get_intraday_prices_batch', return_value=bars),
            patch.object(price_service, 'get_prices_batch', side_effect=AssertionError('Extra quote fetch')),
        ):
            return portfolio.get_intraday_values('1m', use_live_quotes=False)

    def test_latest_contains_all_holdings_and_sums_visible_cents(self):
        portfolio = Portfolio(adjust_splits=False)
        symbols = [f'STOCK{i}' for i in range(12)]
        portfolio.add_transactions([Transaction(date=date(2026, 7, 30), asset=symbol,
            action=ActionType.BUY, quantity=Decimal('1'), ave_price=Decimal('80')) for symbol in symbols])
        points = self.snapshot(portfolio,
            {symbol: Decimal('100') for symbol in symbols},
            {symbol: [{'time': '10:00', 'price': Decimal('100.005')}] for symbol in symbols})
        latest = points[-1]
        self.assertTrue(latest['holdings_complete'])
        self.assertEqual(len(latest['asset_changes']), 12)
        self.assertEqual(latest['daily_pnl'], .12)
        self.assertEqual(sum(Decimal(str(item['pnl'])) for item in latest['asset_changes']), Decimal('.12'))
        self.assertTrue(all(item['pnl'] == .01 for item in latest['asset_changes']))
        self.assertLessEqual(len(points[-2]['asset_changes']), 10)

    def test_closed_today_keeps_day_gain_rather_than_all_time_realized_gain(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            Transaction(date=date(2026, 7, 30), asset='AAPL', action=ActionType.BUY,
                quantity=Decimal('5'), ave_price=Decimal('50')),
            trade(ActionType.SELL, '5', '110', 11),
        ])
        points = self.snapshot(portfolio, {'AAPL': Decimal('100')},
            {'AAPL': [{'time': '10:00', 'price': Decimal('105')}, {'time': '11:00', 'price': Decimal('110')}]})
        self.assertEqual(portfolio.get_holdings(fetch_prices=False), [])
        latest = points[-1]
        self.assertEqual(latest['daily_pnl'], 50)
        self.assertEqual(latest['asset_changes'][0]['quantity'], 0)
        self.assertEqual(latest['asset_changes'][0]['pnl'], 50)

    def test_round_trip_and_crypto_fallback_are_included_once(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            Transaction(date=date(2026, 7, 30), asset='BTC-USD', action=ActionType.BUY,
                quantity=Decimal('2'), ave_price=Decimal('80')),
            trade(ActionType.BUY, '10', '100', 10),
            trade(ActionType.SELL, '10', '102', 11),
        ])
        latest = self.snapshot(portfolio, {'AAPL': Decimal('99'), 'BTC-USD': Decimal('100')},
            {'AAPL': [{'time': '11:00', 'price': Decimal('102')}], 'BTC-USD': []})[-1]
        changes = {item['symbol']: item for item in latest['asset_changes']}
        self.assertEqual(changes['BTC-USD']['pnl'], 0)
        self.assertEqual(changes['AAPL']['pnl'], 20)
        self.assertEqual(latest['daily_pnl'], 20)

    def test_trade_activity_tracks_executed_trades_and_last_sale_without_repricing_pnl(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            Transaction(date=date(2026, 7, 30), asset='AAPL', action=ActionType.BUY,
                quantity=Decimal('5'), ave_price=Decimal('50')),
            trade(ActionType.SELL, '2', '108', 10),
            trade(ActionType.SELL, '3', '112', 11),
            trade(ActionType.BUY, '1', '200', 13),  # Still in the future.
        ])
        bars = {'AAPL': [{'time': '09:30', 'price': Decimal('105')},
            {'time': '12:00', 'price': Decimal('200')}]}
        points = self.snapshot(portfolio, {'AAPL': Decimal('100')}, bars)
        changes = {p['time']: p['asset_changes'][0] for p in points}
        self.assertIsNone(changes['09:30']['trade_activity'])
        partial = changes['10:00']['trade_activity']
        self.assertEqual(partial['change_percent'], -40)
        self.assertEqual(partial['sold_quantity'], 2)
        self.assertFalse(partial['is_closed'])
        self.assertEqual(partial['last_sell_price'], 108)
        closed = changes['12:00']['trade_activity']
        self.assertEqual(closed['sold_quantity'], 5)
        self.assertEqual(closed['bought_quantity'], 0)
        self.assertEqual(closed['last_sell_price'], 112)
        self.assertEqual(closed['last_sell_time'], '11:00')
        self.assertEqual(closed['change_percent'], -100)
        self.assertTrue(closed['is_closed'])
        self.assertEqual(changes['12:00']['current_price'], 200)
        self.assertEqual(changes['11:00']['pnl'], 52)
        self.assertEqual(changes['12:00']['pnl'], 52)

    def test_reopened_position_is_no_longer_closed(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            trade(ActionType.BUY, '10', '100', 9),
            trade(ActionType.SELL, '10', '110', 10),
            trade(ActionType.BUY, '2', '115', 11),
        ])
        points = self.snapshot(portfolio, {'AAPL': Decimal('100')},
            {'AAPL': [{'time': '12:00', 'price': Decimal('120')}]})
        changes = {p['time']: p['asset_changes'][0] for p in points}
        self.assertTrue(changes['10:00']['trade_activity']['is_closed'])
        latest = changes['12:00']
        self.assertFalse(latest['trade_activity']['is_closed'])
        self.assertEqual(latest['trade_activity']['net_quantity'], 2)
        self.assertIsNone(latest['trade_activity']['change_percent'])
        self.assertEqual(latest['quantity'], 2)
        self.assertEqual(latest['current_price'], 120)

    def test_historical_hover_has_the_same_timed_trade_metadata(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([
            Transaction(date=date(2026, 7, 30), asset='AAPL', action=ActionType.BUY,
                quantity=Decimal('5'), ave_price=Decimal('50')),
            trade(ActionType.SELL, '5', '110', 11),
        ])
        with (
            patch('app.portfolio._market_today', return_value=date(2026, 8, 1)),
            patch.object(price_service, 'get_historical_prices_batch',
                return_value={'AAPL': {date(2026, 7, 30): Decimal('100')}}),
            patch.object(price_service, 'get_intraday_prices_batch', return_value={'AAPL': [
                {'date': TODAY.isoformat(), 'time': '10:00', 'price': Decimal('105')},
                {'date': TODAY.isoformat(), 'time': '12:00', 'price': Decimal('200')}]}),
        ):
            points = portfolio.get_intraday_values_for_date(TODAY, '1m')
        self.assertIsNone(points[0]['asset_changes'][0]['trade_activity'])
        latest = points[-1]['asset_changes'][0]
        self.assertEqual(latest['quantity'], 0)
        self.assertTrue(latest['trade_activity']['is_closed'])
        self.assertEqual(latest['trade_activity']['last_sell_price'], 110)
        self.assertEqual(latest['pnl'], 50)

    def test_transfers_do_not_create_buy_or_sell_badges(self):
        portfolio = Portfolio(adjust_splits=False)
        portfolio.add_transactions([trade(ActionType.GIFT, '5', '0', 10)])
        points = self.snapshot(portfolio, {'AAPL': Decimal('100')},
            {'AAPL': [{'time': '10:00', 'price': Decimal('105')}]})
        self.assertIsNone(points[-1]['asset_changes'][0]['trade_activity'])


if __name__ == "__main__":
    unittest.main()
