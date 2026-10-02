"""An unavailable day-opening quote must never turn position value into profit."""

from datetime import date, datetime, timedelta
from decimal import Decimal
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app.models import ActionType, Transaction
from app.portfolio import Portfolio
from app.price_service import price_service


ET = ZoneInfo("America/New_York")
TODAY = date(2026, 10, 2)
NIGHT = "NIGHT-USD"


def transaction(day, symbol, action, quantity, price, hour=0):
    return Transaction(
        date=day,
        asset=symbol,
        action=action,
        quantity=Decimal(quantity),
        ave_price=Decimal(price),
        executed_at=datetime.combine(day, datetime.min.time(), ET).replace(hour=hour),
    )


class MissingPnlBaselineTests(unittest.TestCase):
    def _portfolio(self, target, include_stock=False, sell_night=False):
        portfolio = Portfolio(adjust_splits=False)
        transactions = [
            transaction(target - timedelta(days=1), NIGHT, ActionType.BUY, "100", ".04"),
        ]
        if include_stock:
            transactions.append(transaction(
                target - timedelta(days=1), "AAPL", ActionType.BUY, "2", "90", 10,
            ))
        if sell_night:
            transactions.append(transaction(target, NIGHT, ActionType.SELL, "100", ".05", 2))
        portfolio.add_transactions(transactions)
        return portfolio

    def _chart(self, portfolio, target, baselines, prices, bar_overrides=None):
        bars = {
            symbol: [
                {
                    "date": target.isoformat(),
                    "time": time,
                    "timestamp": f"{target.isoformat()}T{time}:00",
                    "price": price,
                }
                for time in ("00:00", "01:00", "02:00", "06:59")
            ]
            for symbol, price in prices.items()
        }
        for symbol, rows in (bar_overrides or {}).items():
            bars[symbol] = [
                {
                    "date": target.isoformat(),
                    "time": time,
                    "timestamp": f"{target.isoformat()}T{time}:00",
                    "price": price,
                }
                for time, price in rows
            ]
        historical = {
            symbol: {target - timedelta(days=1): baseline} if baseline is not None else {}
            for symbol, baseline in baselines.items()
        }
        midnight = {
            symbol: {target: baseline} if baseline is not None else {}
            for symbol, baseline in baselines.items()
        }
        with (
            patch("app.portfolio._market_today", return_value=TODAY),
            patch("app.portfolio._market_now", return_value=datetime(2026, 10, 2, 6, 59, tzinfo=ET)),
            patch.object(price_service, "get_previous_close_batch", return_value=baselines),
            patch.object(price_service, "get_historical_prices_batch", return_value=historical),
            patch.object(price_service, "get_historical_prices_est_midnight_batch", return_value=midnight),
            patch.object(price_service, "get_intraday_prices_batch", return_value=bars) as fetch_bars,
            patch.object(price_service, "get_prices_batch", return_value=prices) as fetch_quotes,
            patch.object(price_service, "stale_intraday_symbols", return_value=[NIGHT]) as stale_symbols,
        ):
            if target != TODAY:
                return portfolio.get_intraday_values_for_date(target, "1m")
            metadata = {}
            points = portfolio.get_intraday_values(
                "1m", refresh_prices=True, use_live_quotes=False, refresh_metadata=metadata,
            )
            self.assertEqual(fetch_bars.call_args.kwargs, {"force_refresh": True})
            fetch_quotes.assert_not_called()
            stale_symbols.assert_called_once()
            self.assertEqual(metadata["stale_symbols"], [NIGHT])
            self.assertTrue(points[-1]["holdings_complete"])
            return points

    def _assert_unknown_asset(self, point):
        self.assertEqual(point["missing_baseline_symbols"], [NIGHT])
        asset = next(asset for asset in point["asset_changes"] if asset["symbol"] == NIGHT)
        self.assertIsNone(asset["pnl"])
        self.assertIsNone(asset["pnl_percent"])
        self.assertEqual(asset["current_price"], .0444)

    def test_today_missing_zero_and_negative_baselines_do_not_inflate_known_pnl(self):
        for baseline in (None, Decimal("0"), Decimal("-.01")):
            with self.subTest(baseline=baseline):
                points = self._chart(
                    self._portfolio(TODAY, include_stock=True),
                    TODAY,
                    {NIGHT: baseline, "AAPL": Decimal("100")},
                    {NIGHT: Decimal(".0444"), "AAPL": Decimal("110")},
                )
                self.assertTrue(points)
                for point in points:
                    self.assertAlmostEqual(point["value"], 224.44)
                    self.assertEqual(point["baseline_value"], 200.0)
                    self.assertEqual(point["daily_pnl"], 20.0)
                    self.assertEqual(point["daily_pnl_percent"], 10.0)
                    self._assert_unknown_asset(point)

    def test_latest_keeps_unknown_rows_beyond_top_ten_and_sums_known_visible_cents(self):
        portfolio = Portfolio(adjust_splits=False)
        stocks = [f"STOCK{index}" for index in range(12)]
        portfolio.add_transactions([
            transaction(TODAY - timedelta(days=1), symbol, ActionType.BUY, "1", "80", 10)
            for symbol in stocks
        ] + [transaction(TODAY - timedelta(days=1), NIGHT, ActionType.BUY, "100", ".04")])
        baselines = {symbol: Decimal("100") for symbol in stocks}
        baselines[NIGHT] = None
        prices = {symbol: Decimal("100.005") for symbol in stocks}
        prices[NIGHT] = Decimal(".0444")

        points = self._chart(portfolio, TODAY, baselines, prices)
        latest = points[-1]

        self.assertEqual(len(latest["asset_changes"]), 13)
        self.assertLessEqual(len(points[-2]["asset_changes"]), 10)
        self.assertAlmostEqual(latest["value"], 1204.5)
        self.assertEqual(latest["baseline_value"], 1200.0)
        self.assertEqual(latest["daily_pnl"], .12)
        self.assertEqual(latest["daily_pnl_percent"], .01)
        self._assert_unknown_asset(latest)
        known = [row for row in latest["asset_changes"] if row["pnl"] is not None]
        self.assertTrue(all(row["pnl"] == .01 for row in known))
        self.assertEqual(sum(Decimal(str(row["pnl"])) for row in known), Decimal(".12"))
        self.assertTrue(all(row["quantity"] == 1 and row["trade_activity"] is None for row in known))

    def test_historical_missing_zero_and_negative_baselines_do_not_inflate_known_pnl(self):
        target = TODAY - timedelta(days=1)
        for baseline in (None, Decimal("0"), Decimal("-.01")):
            with self.subTest(baseline=baseline):
                points = self._chart(
                    self._portfolio(target, include_stock=True),
                    target,
                    {NIGHT: baseline, "AAPL": Decimal("100")},
                    {NIGHT: Decimal(".0444"), "AAPL": Decimal("110")},
                )
                self.assertTrue(points)
                for point in points:
                    self.assertAlmostEqual(point["value"], 224.44)
                    self.assertEqual(point["baseline_value"], 200.0)
                    self.assertEqual(point["daily_pnl"], 20.0)
                    self.assertEqual(point["daily_pnl_percent"], 10.0)
                    self._assert_unknown_asset(point)

    def test_all_unknown_opening_positions_have_unknown_pnl_but_keep_valuation(self):
        for target in (TODAY, TODAY - timedelta(days=1)):
            with self.subTest(target=target):
                point = self._chart(
                    self._portfolio(target), target,
                    {NIGHT: None}, {NIGHT: Decimal(".0444")},
                )[-1]
                self.assertAlmostEqual(point["value"], 4.44)
                self.assertEqual(point["baseline_value"], 0.0)
                self.assertIsNone(point["daily_pnl"])
                self.assertIsNone(point["daily_pnl_percent"])
                self._assert_unknown_asset(point)

    def test_fully_sold_position_with_unknown_opening_price_stays_unknown(self):
        for target in (TODAY, TODAY - timedelta(days=1)):
            with self.subTest(target=target):
                point = self._chart(
                    self._portfolio(target, sell_night=True), target,
                    {NIGHT: None}, {NIGHT: Decimal(".0444")},
                )[-1]
                self.assertEqual(point["value"], 0.0)
                self.assertEqual(point["baseline_value"], 0.0)
                self.assertIsNone(point["daily_pnl"])
                self.assertIsNone(point["daily_pnl_percent"])
                self._assert_unknown_asset(point)

    def test_trade_cash_from_unknown_opening_position_does_not_affect_known_pnl(self):
        for target in (TODAY, TODAY - timedelta(days=1)):
            with self.subTest(target=target):
                point = self._chart(
                    self._portfolio(target, include_stock=True, sell_night=True), target,
                    {NIGHT: None, "AAPL": Decimal("100")},
                    {NIGHT: Decimal(".0444"), "AAPL": Decimal("110")},
                )[-1]
                self.assertEqual(point["value"], 220.0)
                self.assertEqual(point["baseline_value"], 200.0)
                self.assertEqual(point["daily_pnl"], 20.0)
                self.assertEqual(point["daily_pnl_percent"], 10.0)
                self._assert_unknown_asset(point)

    def test_purchase_in_unknown_opening_position_does_not_affect_known_basis(self):
        for target in (TODAY, TODAY - timedelta(days=1)):
            with self.subTest(target=target):
                portfolio = self._portfolio(target, include_stock=True)
                portfolio.add_transactions([
                    transaction(target, NIGHT, ActionType.BUY, "100", ".04", 2),
                ])
                point = self._chart(
                    portfolio, target,
                    {NIGHT: None, "AAPL": Decimal("100")},
                    {NIGHT: Decimal(".0444"), "AAPL": Decimal("110")},
                )[-1]
                self.assertAlmostEqual(point["value"], 228.88)
                self.assertEqual(point["baseline_value"], 200.0)
                self.assertEqual(point["daily_pnl"], 20.0)
                self.assertEqual(point["daily_pnl_percent"], 10.0)
                self._assert_unknown_asset(point)

    def test_new_same_day_buy_uses_execution_cost_without_a_midnight_price(self):
        for target in (TODAY, TODAY - timedelta(days=1)):
            with self.subTest(target=target):
                portfolio = Portfolio(adjust_splits=False)
                portfolio.add_transactions([
                    transaction(target, NIGHT, ActionType.BUY, "100", ".04", 1),
                ])
                point = self._chart(
                    portfolio, target, {NIGHT: None}, {NIGHT: Decimal(".0444")},
                )[-1]
                self.assertEqual(point["missing_baseline_symbols"], [])
                self.assertAlmostEqual(point["value"], 4.44)
                self.assertEqual(point["baseline_value"], 4.0)
                self.assertAlmostEqual(point["daily_pnl"], .44)
                self.assertEqual(point["daily_pnl_percent"], 11.0)
                asset = next(asset for asset in point["asset_changes"] if asset["symbol"] == NIGHT)
                self.assertAlmostEqual(asset["pnl"], .44)
                self.assertEqual(asset["pnl_percent"], 11.0)

    def test_unpriced_new_gift_or_fix_is_unknown_when_a_later_quote_arrives(self):
        for target in (TODAY, TODAY - timedelta(days=1)):
            for action in (ActionType.GIFT, ActionType.FIX):
                with self.subTest(target=target, action=action):
                    portfolio = Portfolio(adjust_splits=False)
                    portfolio.add_transactions([
                        transaction(target - timedelta(days=1), "AAPL", ActionType.BUY, "2", "90", 10),
                        transaction(target, NIGHT, action, "100", "0", 2),
                    ])
                    point = self._chart(
                        portfolio, target,
                        {NIGHT: None, "AAPL": Decimal("100")},
                        {NIGHT: Decimal(".0444"), "AAPL": Decimal("110")},
                        bar_overrides={NIGHT: [("06:59", Decimal(".0444"))]},
                    )[-1]
                    self.assertAlmostEqual(point["value"], 224.44)
                    self.assertEqual(point["baseline_value"], 200.0)
                    self.assertEqual(point["daily_pnl"], 20.0)
                    self.assertEqual(point["daily_pnl_percent"], 10.0)
                    self._assert_unknown_asset(point)

    def test_new_gift_or_fix_with_a_pretransfer_quote_only_counts_subsequent_gain(self):
        for target in (TODAY, TODAY - timedelta(days=1)):
            for action in (ActionType.GIFT, ActionType.FIX):
                with self.subTest(target=target, action=action):
                    portfolio = Portfolio(adjust_splits=False)
                    portfolio.add_transactions([
                        transaction(target - timedelta(days=1), "AAPL", ActionType.BUY, "2", "90", 10),
                        transaction(target, NIGHT, action, "100", "0", 2),
                    ])
                    point = self._chart(
                        portfolio, target,
                        {NIGHT: None, "AAPL": Decimal("100")},
                        {NIGHT: Decimal(".0444"), "AAPL": Decimal("110")},
                        bar_overrides={NIGHT: [
                            ("01:00", Decimal(".04")),
                            ("06:59", Decimal(".0444")),
                        ]},
                    )[-1]
                    self.assertEqual(point["missing_baseline_symbols"], [])
                    self.assertAlmostEqual(point["value"], 224.44)
                    self.assertEqual(point["baseline_value"], 204.0)
                    self.assertAlmostEqual(point["daily_pnl"], 20.44)
                    self.assertAlmostEqual(point["daily_pnl_percent"], 20.44 / 204 * 100)
                    asset = next(asset for asset in point["asset_changes"] if asset["symbol"] == NIGHT)
                    self.assertAlmostEqual(asset["pnl"], .44)
                    self.assertEqual(asset["pnl_percent"], 11.0)


if __name__ == "__main__":
    unittest.main()
