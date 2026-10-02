"""Intraday endpoint joins option estimates without mutating stock accounting."""
import asyncio
from datetime import timedelta
from unittest import TestCase
from unittest.mock import MagicMock, patch
from fastapi import BackgroundTasks
from app import main


class OptionIntradayIntegrationTests(TestCase):
    def setUp(self):
        main._clear_api_cache()
        self.addCleanup(main._clear_api_cache)
        collector = patch.object(main.option_pnl_service, "collect", return_value={"complete": True})
        collector.start()
        self.addCleanup(collector.stop)

    def test_current_refresh_publishes_option_result_and_same_holdings_rows(self):
        fake = MagicMock()
        rows = [{"symbol": "MRVL", "pnl": 1000}]
        original = [{"time": "10:00", "daily_pnl": 1000, "asset_changes": rows, "holdings_complete": True}]
        fake.get_intraday_values.return_value = original
        decorated = [{**original[0], "holdings_daily_pnl": 1000, "option_daily_pnl": -150,
                      "combined_daily_pnl": 850, "options_complete": True}]
        with patch.object(main, "portfolio", fake), patch.object(main.option_pnl_service, "decorate", return_value=decorated) as service:
            response = main._build_today_snapshot()
        self.assertEqual(response["intraday"], decorated)
        self.assertIs(response["intraday"][0]["asset_changes"], rows)
        self.assertEqual(original[0]["daily_pnl"], 1000)
        self.assertEqual(service.call_args.kwargs, {"collect": False})
        self.assertEqual(main._get_api_cache("intraday_" + main.market_today().isoformat() + "_1m")["intraday"], decorated)

    def test_failed_option_service_preserves_holdings_and_never_returns_fake_zero(self):
        with patch.object(main.option_pnl_service, "decorate", side_effect=RuntimeError("quote storage unavailable")):
            result = main._with_option_intraday([{"time": "10:00", "daily_pnl": 1000}], main.market_today())
        self.assertEqual(result[0]["holdings_daily_pnl"], 1000)
        self.assertIsNone(result[0]["combined_daily_pnl"])
        self.assertIsNone(result[0]["option_daily_pnl"])
        self.assertFalse(result[0]["options_complete"])

    def test_historical_route_reads_saved_quotes_without_live_collection(self):
        day = main.market_today() - timedelta(days=1)
        fake = MagicMock()
        fake.get_intraday_values_for_date.return_value = [{"time": "16:00", "daily_pnl": 100}]
        expected = [{"time": "16:00", "daily_pnl": 100, "combined_daily_pnl": 80}]
        with patch.object(main, "portfolio", fake), patch.object(main.option_pnl_service, "decorate", return_value=expected) as service:
            response = asyncio.run(main.get_intraday(BackgroundTasks(), "5m", day.isoformat()))
        self.assertEqual(response["intraday"], expected)
        self.assertEqual(service.call_args.args[1], day)
        self.assertEqual(service.call_args.kwargs, {"collect": False})

    def test_background_refresh_attaches_options_before_cache_publish(self):
        fake = MagicMock()
        expected = [{"time": "10:00", "daily_pnl": 100, "combined_daily_pnl": None, "options_complete": False}]
        key = "intraday_" + main.market_today().isoformat() + "_5m"
        with patch.object(main, "portfolio", fake), patch.object(main.option_pnl_service, "decorate", return_value=expected):
            main._refresh_intraday_cache(key, main.market_today(), "5m", main._portfolio_generation)
        self.assertEqual(main._get_api_cache(key)["intraday"], expected)

    def test_collection_finishes_before_stock_snapshot_and_missing_baseline_does_not_retry(self):
        order = []
        fake = MagicMock()
        def stock(*args, **kwargs):
            order.append("stock")
            return [{"time": "10:01", "daily_pnl": 100}]
        fake.get_intraday_values.side_effect = stock
        def collect():
            order.append("quotes")
            return {"complete": True}
        def decorate(points, *args, **kwargs):
            order.append("replay")
            return [{**points[0], "options_complete": False, "combined_daily_pnl": None,
                     "options_collection_complete": True}]
        with patch.object(main, "portfolio", fake), patch.object(main.option_pnl_service, "collect", side_effect=collect), patch.object(main.option_pnl_service, "decorate", side_effect=decorate):
            result = main._build_today_snapshot()
        self.assertEqual(order, ["quotes", "stock", "replay"])
        self.assertTrue(result["options_collection_complete"])
        self.assertIsNone(result["intraday"][0]["combined_daily_pnl"])

    def test_scheduler_retries_failed_quote_collection_without_exposing_positions(self):
        response = {"cache_status": "fresh", "intraday": [{"time": "10:01"}],
                    "options_collection_complete": False}
        from unittest.mock import AsyncMock
        from fastapi import HTTPException
        with patch.object(main, "refresh_today_intraday", new=AsyncMock(return_value=response)):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(main.scheduled_market_refresh())
        self.assertEqual(error.exception.status_code, 503)
