"""Cloud Run deployment safety checks using a local mock gcloud CLI."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


DEPLOY_SCRIPT = Path(__file__).resolve().parents[1] / "deploy.sh"
MOCK_GCLOUD = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
calls_file = Path(os.environ["MOCK_CALLS"])
calls = [json.loads(line) for line in calls_file.read_text().splitlines()] if calls_file.exists() else []
with calls_file.open("a") as log:
    log.write(json.dumps(args) + "\n")
scenario = json.loads(Path(os.environ["MOCK_SCENARIO"]).read_text())
state = Path(os.environ["MOCK_STATE"])
old_revision = "iportfolio-serving-old"
latest_ready = "iportfolio-ready-but-not-serving"
deploy_calls = [call for call in calls if call[:2] == ["run", "deploy"]]
deploy = deploy_calls[-1] if deploy_calls else None
target = "iportfolio-" + deploy[deploy.index("--revision-suffix") + 1] if deploy else None

if args == ["config", "get-value", "project"]:
    print("iportfolio-497808")
elif args[:4] == ["run", "services", "list", "--platform=managed"]:
    print("iportfolio\tus-central1")
elif args[:3] == ["run", "services", "describe"]:
    if not state.exists() and scenario.get("initial_service_missing"):
        sys.exit(1)
    if state.exists() and not scenario.get("stale_traffic_status"):
        traffic = [{"revisionName": state.read_text(), "percent": 100}]
    elif deploy and scenario.get("preview_traffic_changed"):
        traffic = [{"revisionName": target, "percent": 100}]
    elif scenario.get("split_traffic"):
        traffic = [{"revisionName": old_revision, "percent": 50},
                   {"revisionName": "iportfolio-other", "percent": 50}]
    else:
        traffic = [{"revisionName": old_revision, "percent": 100},
                   {"revisionName": latest_ready, "tag": "preview"}]
    if not state.exists() and scenario.get("unknown_traffic"):
        traffic = []
    if deploy and "--tag" in deploy and not scenario.get("preview_missing_tag"):
        tag = deploy[deploy.index("--tag") + 1]
        traffic.append({"revisionName": old_revision if scenario.get("preview_wrong_tag") else target,
                        "tag": tag, "url": "https://" + tag + "---portfolio.example"})
    print(json.dumps({"status": {"latestReadyRevisionName": latest_ready,
                                 "traffic": traffic, "url": "https://portfolio.example"}}))
elif args[:3] == ["run", "revisions", "describe"]:
    deployed = any(call[:2] == ["run", "deploy"] for call in calls)
    if not deployed:
        if scenario.get("revision_exists"):
            print(args[3])
        else:
            sys.exit(1)
    elif scenario.get("target_missing"):
        sys.exit(1)
    else:
        name = old_revision if scenario.get("wrong_revision") else args[3]
        ready = "False" if scenario.get("target_not_ready") else "True"
        print(json.dumps({"metadata": {"name": name},
                          "status": {"conditions": [{"type": "Ready", "status": ready}]}}))
elif args[:2] == ["run", "deploy"]:
    if scenario.get("deploy_failure"):
        print("Build failed", file=sys.stderr)
        sys.exit(42)
    # Reproduce the misleading CLI output that triggered this fix.
    print("Service [iportfolio] revision [iportfolio-serving-old] has been deployed and is serving 100 percent of traffic.")
elif args[:3] == ["run", "services", "update-traffic"]:
    if scenario.get("traffic_failure"):
        sys.exit(43)
    revision = args[args.index("--to-revisions") + 1].removesuffix("=100")
    state.write_text(revision)
    print("Traffic updated")
elif args[:3] == ["services", "enable", "cloudscheduler.googleapis.com"]:
    pass
elif args[:3] == ["iam", "service-accounts", "describe"]:
    if scenario.get("scheduler_account_missing"):
        sys.exit(1)
    print(args[3])
elif args[:3] == ["iam", "service-accounts", "create"]:
    pass
elif args[:3] == ["scheduler", "jobs", "describe"]:
    if scenario.get("scheduler_job_missing"):
        sys.exit(1)
    print(args[3])
elif args[:3] in (["scheduler", "jobs", "create"], ["scheduler", "jobs", "update"]):
    if scenario.get("scheduler_failure"):
        sys.exit(44)
else:
    print("Unexpected mock gcloud command: " + repr(args), file=sys.stderr)
    sys.exit(99)
'''


class DeployScriptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        shutil.copyfile(DEPLOY_SCRIPT, self.root / "deploy.sh")
        self.mock_bin = self.root / "bin"
        self.mock_bin.mkdir()
        executable = self.mock_bin / "gcloud"
        executable.write_text(MOCK_GCLOUD)
        executable.chmod(0o755)
        self.calls_file = self.root / "calls.jsonl"
        self.scenario_file = self.root / "scenario.json"
        self.state_file = self.root / "traffic-revision"

    def run_deploy(self, scenario=None, suffix="crypto-test-01", autodetect=False,
                   tag="", project="iportfolio-497808"):
        self.scenario_file.write_text(json.dumps(scenario or {}))
        env = os.environ.copy()
        env.update({
            "PATH": str(self.mock_bin) + os.pathsep + env["PATH"],
            "SERVICE": "" if autodetect else "iportfolio",
            "REGION": "" if autodetect else "us-central1",
            "DEPLOY_TAG": tag,
            "MOCK_CALLS": str(self.calls_file),
            "MOCK_SCENARIO": str(self.scenario_file),
            "MOCK_STATE": str(self.state_file),
        })
        if project is None:
            env.pop("PROJECT_ID", None)
            env.pop("CLOUDSDK_CORE_PROJECT", None)
        else:
            env["PROJECT_ID"] = project
        if suffix is None:
            env.pop("REVISION_SUFFIX", None)
        else:
            env["REVISION_SUFFIX"] = suffix
        result = subprocess.run(
            ["bash", str(self.root / "deploy.sh")], cwd=self.root,
            env=env, capture_output=True, text=True, timeout=10,
        )
        calls = [json.loads(line) for line in self.calls_file.read_text().splitlines()] if self.calls_file.exists() else []
        return result, calls

    def assert_no_traffic_change(self, result, calls):
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[:3] == ["run", "services", "update-traffic"] for call in calls))
        self.assertNotIn("Deployed revision:", result.stdout)
        self.assertNotIn("Preview revision:", result.stdout)

    def test_ready_exact_revision_receives_traffic_and_actual_serving_rollback(self):
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        deploy = next(call for call in calls if call[:2] == ["run", "deploy"])
        for flag in ("--no-traffic", "--cpu-throttling", "--timeout=240s"):
            self.assertIn(flag, deploy)
        self.assertNotIn("--no-cpu-throttling", deploy)
        for flag, value in (("--source", "."), ("--revision-suffix", "crypto-test-01"),
                            ("--min", "0"), ("--max", "1"),
                            ("--min-instances", "0"), ("--max-instances", "1")):
            self.assertEqual(deploy[deploy.index(flag) + 1], value)
        update = next(call for call in calls if call[:3] == ["run", "services", "update-traffic"])
        self.assertEqual(update[update.index("--to-revisions") + 1], "iportfolio-crypto-test-01=100")
        ready_check = next(index for index, call in enumerate(calls)
                           if call[:3] == ["run", "revisions", "describe"]
                           and "--format=json(metadata.name,status.conditions)" in call)
        self.assertLess(ready_check, calls.index(update))
        scheduler = next(call for call in calls if call[:3] == ["scheduler", "jobs", "update"])
        self.assertLess(calls.index(scheduler), calls.index(update))
        self.assertIn("--schedule=*/5 * * * *", scheduler)
        self.assertIn("--time-zone=Etc/UTC", scheduler)
        self.assertIn("--uri=https://portfolio.example/api/internal/refresh", scheduler)
        self.assertIn("--http-method=POST", scheduler)
        self.assertIn("--oidc-service-account-email=iportfolio-scheduler@iportfolio-497808.iam.gserviceaccount.com", scheduler)
        self.assertIn("--oidc-token-audience=https://portfolio.example/api/internal/refresh", scheduler)
        self.assertIn("--update-env-vars=MARKET_REFRESH_MODE=scheduler,SCHEDULER_SERVICE_ACCOUNT=iportfolio-scheduler@iportfolio-497808.iam.gserviceaccount.com,SCHEDULER_AUDIENCE=https://portfolio.example/api/internal/refresh", deploy)
        for call in calls:
            self.assertIn("--project=iportfolio-497808", call)
        self.assertEqual((self.root / ".last_good_revision").read_text(),
                         "iportfolio us-central1 iportfolio-serving-old\n")
        self.assertIn("Deployed revision: iportfolio-crypto-test-01 (100% traffic)", result.stdout)
        self.assertIn("https://portfolio.example", result.stdout)

    def test_build_failure_preserves_old_traffic(self):
        result, calls = self.run_deploy({"deploy_failure": True})
        self.assert_no_traffic_change(result, calls)
        self.assertEqual(result.returncode, 42)

    def test_cli_success_cannot_route_a_revision_that_is_not_ready(self):
        result, calls = self.run_deploy({"target_not_ready": True})
        self.assert_no_traffic_change(result, calls)
        self.assertIn("current traffic was left unchanged", result.stderr)

    def test_cli_success_cannot_route_an_absent_target(self):
        result, calls = self.run_deploy({"target_missing": True})
        self.assert_no_traffic_change(result, calls)

    def test_ready_response_must_name_requested_revision(self):
        result, calls = self.run_deploy({"wrong_revision": True})
        self.assert_no_traffic_change(result, calls)

    def test_existing_suffix_is_rejected_before_source_deploy(self):
        result, calls = self.run_deploy({"revision_exists": True})
        self.assert_no_traffic_change(result, calls)
        self.assertFalse(any(call[:2] == ["run", "deploy"] for call in calls))
        self.assertIn("already exists", result.stderr)

    def test_split_traffic_clears_obsolete_single_revision_rollback(self):
        rollback = self.root / ".last_good_revision"
        rollback.write_text("stale-service stale-region stale-revision\n")
        result, _ = self.run_deploy({"split_traffic": True})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(rollback.exists())
        self.assertIn("automatic rollback is unavailable", result.stderr)
        self.assertNotIn("./rollback.sh", result.stdout)

    def test_unresolved_serving_traffic_has_no_obsolete_rollback(self):
        rollback = self.root / ".last_good_revision"
        rollback.write_text("stale-service stale-region stale-revision\n")
        result, _ = self.run_deploy({"unknown_traffic": True})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(rollback.exists())

    def test_traffic_update_failure_does_not_print_success(self):
        result, _ = self.run_deploy({"traffic_failure": True})
        self.assertEqual(result.returncode, 43)
        self.assertNotIn("Deployed revision:", result.stdout)

    def test_stale_traffic_status_does_not_print_success(self):
        result, _ = self.run_deploy({"stale_traffic_status": True})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Deployed revision:", result.stdout)
        self.assertIn("has not been confirmed", result.stderr)

    def test_default_suffix_is_fresh_and_service_can_be_detected(self):
        result, calls = self.run_deploy(suffix=None, autodetect=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        deploy = next(call for call in calls if call[:2] == ["run", "deploy"])
        suffix = deploy[deploy.index("--revision-suffix") + 1]
        self.assertRegex(suffix, r"^release-\d{8}-\d{6}-\d+$")
        self.assertIn("iportfolio-" + suffix, result.stdout)

    def test_default_project_is_resolved_and_all_cloud_calls_are_scoped(self):
        result, calls = self.run_deploy(project=None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["config", "get-value", "project"], calls)
        for call in calls:
            if call[0] != "config":
                self.assertIn("--project=iportfolio-497808", call)

    def test_scheduler_setup_failure_does_not_promote_ready_revision(self):
        result, calls = self.run_deploy({"scheduler_failure": True})
        self.assert_no_traffic_change(result, calls)
        self.assertEqual(result.returncode, 44)

    def test_missing_scheduler_identity_and_job_are_created(self):
        result, calls = self.run_deploy({"scheduler_account_missing": True,
                                         "scheduler_job_missing": True})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(call[:3] == ["iam", "service-accounts", "create"] for call in calls))
        self.assertTrue(any(call[:3] == ["scheduler", "jobs", "create"] for call in calls))

    def test_tagged_preview_preserves_traffic_and_existing_rollback(self):
        rollback = self.root / ".last_good_revision"
        previous = "iportfolio us-central1 iportfolio-earlier-release\n"
        rollback.write_text(previous)
        result, calls = self.run_deploy(tag="crypto-preview")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[:3] == ["run", "services", "update-traffic"] for call in calls))
        deploy = next(call for call in calls if call[:2] == ["run", "deploy"])
        self.assertIn("--no-traffic", deploy)
        self.assertEqual(deploy[deploy.index("--tag") + 1], "crypto-preview")
        self.assertEqual(rollback.read_text(), previous)
        self.assertIn("Preview revision: iportfolio-crypto-test-01 (production traffic unchanged)", result.stdout)
        self.assertIn("https://crypto-preview---portfolio.example", result.stdout)
        self.assertNotIn("Deployed revision:", result.stdout)
        self.assertNotIn("./rollback.sh", result.stdout)
        scheduler = next(call for call in calls if call[:3] == ["scheduler", "jobs", "update"])
        self.assertIn("--uri=https://portfolio.example/api/internal/refresh", scheduler)

    def test_tagged_preview_preserves_split_production_traffic(self):
        result, calls = self.run_deploy({"split_traffic": True}, tag="crypto-preview")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[:3] == ["run", "services", "update-traffic"] for call in calls))

    def test_preview_detects_changed_production_traffic(self):
        result, calls = self.run_deploy({"preview_traffic_changed": True}, tag="crypto-preview")
        self.assert_no_traffic_change(result, calls)
        self.assertIn("production traffic changed", result.stderr)

    def test_preview_tag_must_point_to_exact_ready_revision(self):
        result, calls = self.run_deploy({"preview_wrong_tag": True}, tag="crypto-preview")
        self.assert_no_traffic_change(result, calls)
        self.assertIn("preview tag was not confirmed", result.stderr)

    def test_preview_tag_url_must_be_present(self):
        result, calls = self.run_deploy({"preview_missing_tag": True}, tag="crypto-preview")
        self.assert_no_traffic_change(result, calls)

    def test_preview_stops_before_deployment_if_original_traffic_is_unknown(self):
        result, calls = self.run_deploy({"unknown_traffic": True}, tag="crypto-preview")
        self.assert_no_traffic_change(result, calls)
        self.assertFalse(any(call[:2] == ["run", "deploy"] for call in calls))

    def test_invalid_revision_suffix_stops_before_deployment(self):
        result, calls = self.run_deploy(suffix="Invalid_SUFFIX")
        self.assert_no_traffic_change(result, calls)
        self.assertFalse(any(call[:2] == ["run", "deploy"] for call in calls))


if __name__ == "__main__":
    unittest.main()
