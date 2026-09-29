"""HTTP auth, validation and commit/reload boundaries for option recording."""
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from app import main


class CoveredCallAPITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.auth = patch.object(main, 'API_TOKEN', 'covered-call-api-test')
        self.auth.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                       base_url='https://portfolio.test')
        self.headers = {'Authorization': 'Bearer covered-call-api-test'}
        self.opening = dict(request_id=str(uuid4()), asset='MRVL', broker='Schwab',
                            date='2026-01-05', expiration='2026-02-20', strike='280',
                            contracts=1, premium='13', fees='.65')

    async def asyncTearDown(self):
        await self.client.aclose()
        self.auth.stop()

    async def test_all_option_endpoints_require_authentication(self):
        with patch.object(main.covered_call_repository, 'list_calls') as read, \
             patch.object(main, '_commit_ledger_write') as write:
            for method, path in [('GET', '/api/covered-calls'), ('POST', '/api/covered-calls'),
                                 ('POST', '/api/covered-calls/preview'),
                                 ('POST', '/api/covered-calls/1/events'),
                                 ('DELETE', '/api/covered-calls/1')]:
                with self.subTest(method=method, path=path):
                    response = await self.client.request(method, path)
                    self.assertEqual(response.status_code, 401)
            read.assert_not_called()
            write.assert_not_called()

    async def test_invalid_and_future_fills_do_not_reach_writer(self):
        with patch.object(main, '_commit_ledger_write') as write:
            for fields in [{'contracts': 1.5}, {'fees': '-1'}, {'premium': 'NaN'},
                           {'date': '2099-01-01', 'expiration': '2099-02-01'}]:
                response = await self.client.post('/api/covered-calls',
                                                  json={**self.opening, **fields}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            write.assert_not_called()

    async def test_opening_uses_commit_then_schedules_reload(self):
        with patch.object(main.covered_call_repository, 'create_call', return_value={'id': 17}) as create, \
             patch.object(main, '_queue_ledger_reload') as reload:
            response = await self.client.post('/api/covered-calls', json=self.opening, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['call']['id'], 17)
            self.assertTrue(response.json()['refresh_pending'])
            self.assertEqual(create.call_args.args[0].contracts, 1)
            reload.assert_called_once()

    async def test_coverage_error_is_actionable_and_does_not_reload(self):
        with patch.object(main.covered_call_repository, 'create_call', side_effect=ValueError('Insufficient unreserved MRVL shares')), \
             patch.object(main, '_queue_ledger_reload') as reload:
            response = await self.client.post('/api/covered-calls', json=self.opening, headers=self.headers)
            self.assertEqual(response.status_code, 400)
            self.assertIn('Insufficient unreserved', response.json()['detail'])
            reload.assert_not_called()

    async def test_expiry_cannot_charge_buyback_premium(self):
        body = dict(request_id=str(uuid4()), action='EXPIRE', date='2026-02-20',
                    transaction_time='16:00', contracts=1, premium='13')
        with patch.object(main, '_commit_ledger_write') as write:
            response = await self.client.post('/api/covered-calls/1/events', json=body, headers=self.headers)
            self.assertEqual(response.status_code, 422)
            write.assert_not_called()

    async def test_delete_preserves_linked_events(self):
        with patch.object(main.covered_call_repository, 'delete_call', side_effect=ValueError('A call with recorded lifecycle events cannot be deleted')), \
             patch.object(main, '_queue_ledger_reload') as reload:
            response = await self.client.delete('/api/covered-calls/1', headers=self.headers)
            self.assertEqual(response.status_code, 409)
            reload.assert_not_called()


if __name__ == '__main__':
    unittest.main()
