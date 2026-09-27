from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent.parent


class RefreshContractTests(unittest.TestCase):
    def test_manual_refresh_does_not_reload_portfolio_or_clear_history(self):
        javascript = (ROOT / "static/js/app.js").read_text(encoding="utf-8")
        template = (ROOT / "templates/index.html").read_text(encoding="utf-8")

        self.assertNotIn(
            "/api/reload?clear_price_cache=true&precompute=true",
            javascript,
        )
        self.assertIn("await refreshData();", javascript)
        self.assertNotIn("auto-refresh-option", template)
        self.assertNotIn("refreshCountdown", template)

    def test_cloud_run_scales_to_zero_and_retains_single_instance_limit(self):
        deploy_script = (ROOT / "deploy.sh").read_text(encoding="utf-8")

        self.assertIn(
            "--min 0 --max 1 --min-instances 0 --max-instances 1 --cpu-throttling",
            deploy_script,
        )


if __name__ == "__main__":
    unittest.main()
