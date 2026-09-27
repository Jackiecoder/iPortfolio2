import asyncio
from datetime import datetime, timedelta
import json
import threading
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import BackgroundTasks
from google.auth import crypt, exceptions, jwt

from app import main, scheduler_auth


class SchedulerTokenTests(unittest.TestCase):
    """Exercise the real Google verifier against a locally generated test key."""

    @classmethod
    def setUpClass(cls):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        private = key.private_bytes(serialization.Encoding.PEM,
                                    serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption())
        public = key.public_key().public_bytes(serialization.Encoding.PEM,
                                               serialization.PublicFormat.SubjectPublicKeyInfo)
        cls.signer = crypt.RSASigner.from_string(private, key_id="test-key")
        cls.cert_response = MagicMock(status=200, data=json.dumps(
            {"test-key": public.decode()}).encode())
        cls.audience = "https://example.run.app/api/internal/refresh"
        cls.email = "refresh@example.iam.gserviceaccount.com"

    def setUp(self):
        self.env = patch.dict("os.environ", {
            "SCHEDULER_AUDIENCE": self.audience,
            "SCHEDULER_SERVICE_ACCOUNT": self.email,
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.request = patch.object(scheduler_auth, "Request", return_value=MagicMock(
            return_value=self.cert_response))
        self.request.start()
        self.addCleanup(self.request.stop)

    def token(self, **overrides):
        now = int(time.time())
        claims = {"iss": "https://accounts.google.com", "aud": self.audience,
                  "iat": now - 5, "exp": now + 300, "sub": "test-subject",
                  "email": self.email, "email_verified": True, **overrides}
        return jwt.encode(self.signer, claims).decode()

    def test_accepts_only_valid_signature_and_expected_identity(self):
        self.assertIsNone(scheduler_auth.verify_scheduler_token(self.token()))

    def test_rejects_wrong_audience_issuer_identity_and_expired_token(self):
        invalid = [
            {"aud": "https://different.run.app"},
            {"iss": "https://untrusted.example"},
            {"email": "other@example.iam.gserviceaccount.com"},
            {"email_verified": False},
            {"email_verified": "true"},
            {"iat": int(time.time()) - 600, "exp": int(time.time()) - 300},
        ]
        for overrides in invalid:
            with self.subTest(overrides=overrides), self.assertRaises((ValueError, exceptions.GoogleAuthError)):
                scheduler_auth.verify_scheduler_token(self.token(**overrides))

    def test_rejects_tampered_signature_missing_token_and_missing_configuration(self):
        header, payload, signature = self.token().split(".")
        changed = ("A" if signature[0] != "A" else "B") + signature[1:]
        for token in ["", "app-api-token", f"{header}.{payload}.{changed}", f"{header}.{payload}."]:
            with self.subTest(token_kind=token[:8]), self.assertRaises(ValueError):
                scheduler_auth.verify_scheduler_token(token)
        with patch.dict("os.environ", {"SCHEDULER_AUDIENCE": ""}), self.assertRaises(ValueError):
            scheduler_auth.verify_scheduler_token(self.token())


class SchedulerRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original_portfolio = main.portfolio
        main.portfolio = MagicMock()
        self.mode = patch.object(main, "MARKET_REFRESH_MODE", "scheduler")
        self.mode.start()
        self.auth = patch.object(main, "API_TOKEN", "user-token")
        self.auth.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                       base_url="https://example.run.app")
        self.release = threading.Event()
        self.old_task = main._today_refresh_task
        main._today_refresh_task = None
        main._clear_api_cache()

    async def asyncTearDown(self):
        self.release.set()
        if main._today_refresh_task:
            await asyncio.gather(main._today_refresh_task, return_exceptions=True)
        if main._dashboard_tasks:
            await asyncio.gather(*list(main._dashboard_tasks.values()), return_exceptions=True)
        main._today_refresh_task = self.old_task
        main.portfolio = self.original_portfolio
        main._clear_api_cache()
        await self.client.aclose()
        self.mode.stop()
        self.auth.stop()

    def fresh(self):
        return {"cache_status": "fresh", "date": main.market_today().isoformat(),
                "computed_at": "2026-09-17T12:00:00-04:00",
                "intraday": [{"time": "12:00", "private_value": 123}]}

    async def test_untrusted_scheduler_headers_and_app_token_cannot_trigger_collection(self):
        with patch.object(main, "_build_today_snapshot") as collect, \
             patch.object(main, "verify_scheduler_token", side_effect=ValueError("invalid")):
            for token in [None, "user-token", "forged-token"]:
                headers = {"X-CloudScheduler": "true"}
                if token:
                    headers["Authorization"] = "Bearer " + token
                response = await self.client.post(scheduler_auth.SCHEDULER_PATH, headers=headers)
                self.assertEqual(response.status_code, 401)
        collect.assert_not_called()

    async def test_scheduler_identity_cannot_access_normal_user_apis(self):
        with patch.object(main, "verify_scheduler_token") as verify:
            for method, path in [("GET", "/api/holdings"), ("POST", "/api/transactions"),
                                 ("POST", "/api/intraday/refresh")]:
                response = await self.client.request(method, path,
                    headers={"Authorization": "Bearer scheduler-token"})
                self.assertEqual(response.status_code, 401)
        verify.assert_not_called()

    async def test_scheduled_request_waits_for_persistence_and_returns_only_metadata(self):
        started = threading.Event()
        def collect():
            started.set()
            self.release.wait(3)
            return self.fresh()
        with patch.object(main, "verify_scheduler_token"), \
             patch.object(main, "_build_today_snapshot", side_effect=collect) as build:
            request = asyncio.create_task(self.client.post(scheduler_auth.SCHEDULER_PATH,
                headers={"Authorization": "Bearer scheduler-token"}))
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            self.assertFalse(request.done())
            manual = asyncio.create_task(main.refresh_today_intraday())
            await asyncio.sleep(0)
            self.release.set()
            response = await request
            await manual
        build.assert_called_once()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {"status", "date", "computed_at", "points"})
        self.assertEqual(response.json()["points"], 1)
        self.assertNotIn("private_value", response.text)

    async def test_partial_and_failed_collection_are_retryable(self):
        with patch.object(main, "verify_scheduler_token"):
            for result in [{**self.fresh(), "cache_status": "partial"},
                           {**self.fresh(), "intraday": []}]:
                with patch.object(main, "_refresh_today_snapshot", new=AsyncMock(return_value=result)):
                    response = await self.client.post(scheduler_auth.SCHEDULER_PATH,
                        headers={"Authorization": "Bearer scheduler-token"})
                    self.assertEqual(response.status_code, 503)
            with patch.object(main, "_refresh_today_snapshot", new=AsyncMock(side_effect=RuntimeError("down"))):
                response = await self.client.post(scheduler_auth.SCHEDULER_PATH,
                    headers={"Authorization": "Bearer scheduler-token"})
                self.assertEqual(response.status_code, 503)

    async def test_restart_restores_db_cache_without_starting_timer_or_fetching(self):
        loaded = MagicMock()
        loaded.get_holdings.return_value = [MagicMock(symbol="AAPL"), MagicMock(symbol="CASH")]
        with patch.object(main, "init_schema"), \
             patch.object(main, "load_portfolio", return_value=loaded), \
             patch.object(main.price_service, "prime_intraday_cache_from_db") as warm, \
             patch.object(main, "_refresh_today_snapshot", new=AsyncMock()) as refresh, \
             patch.object(main, "_market_refresh_task", None):
            await main.startup_event()
            self.assertIsNone(main._market_refresh_task)
        warm.assert_called_once_with(["AAPL"], interval="1m")
        refresh.assert_not_awaited()

    async def test_expired_dashboard_snapshot_finishes_inside_request(self):
        main._api_cache["summary"] = ({"old": True}, datetime.now() - timedelta(minutes=3))
        started = threading.Event()
        def build(active):
            started.set()
            self.release.wait(3)
            return {"new": True}
        with patch.object(main, "_build_summary_response", side_effect=build):
            request = asyncio.create_task(main.get_summary())
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            self.assertFalse(request.done())
            self.release.set()
            result = await request
        self.assertTrue(result["new"])
        self.assertEqual(result["cache_status"], "fresh")

    async def test_expired_today_snapshot_never_queues_work_after_response(self):
        key = f"intraday_{main.market_today().isoformat()}_1m"
        main._api_cache[key] = (self.fresh(), datetime.now() - timedelta(minutes=3))
        background = BackgroundTasks()
        with patch.object(main, "_refresh_today_snapshot", new=AsyncMock(return_value=self.fresh())) as collect:
            response = await main.get_intraday(background, interval="1m", date=None)
        collect.assert_awaited_once()
        self.assertEqual(background.tasks, [])
        self.assertEqual(response["cache_status"], "fresh")


if __name__ == "__main__":
    unittest.main()
