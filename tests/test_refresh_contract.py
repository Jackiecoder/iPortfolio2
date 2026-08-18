from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent.parent


class RefreshContractTests(unittest.TestCase):
    def test_manual_refresh_reads_snapshot_without_server_reload(self):
        javascript = (ROOT / "static/js/app.js").read_text(encoding="utf-8")

        self.assertNotIn(
            "/api/reload?clear_price_cache=true&precompute=true",
            javascript,
        )
        self.assertIn("await refreshData();", javascript)

    def test_cloud_run_uses_one_instance_for_in_memory_snapshot(self):
        deploy_script = (ROOT / "deploy.sh").read_text(encoding="utf-8")

        self.assertIn("--min 1 --max 1 --no-cpu-throttling", deploy_script)


if __name__ == "__main__":
    unittest.main()
