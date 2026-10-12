"""Finance endpoint auth, validated writes and isolated portfolio boundaries."""
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from app import main
from app import finance_api
from app.finance import FinanceError


class FinanceAPITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.auth = patch.object(main, 'API_TOKEN', 'finance-api-test')
        self.auth.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                       base_url='https://portfolio.test')
        self.headers = {'Authorization': 'Bearer finance-api-test'}
        self.state = dict(transfers=[], loans=[], products=[], movements=[], summary=[])
        self.transfer = dict(date='2026-01-01', direction='in', amount='100', request_id=str(uuid4()))

    async def asyncTearDown(self):
        await self.client.aclose()
        self.auth.stop()

    async def test_every_finance_route_requires_existing_auth(self):
        with patch.object(finance_api.repository, 'list_finance') as read, \
             patch.object(finance_api.repository, 'create_record') as create:
            for method, path in [
                ('GET', '/api/finance'),
                ('POST', '/api/finance/transfers'), ('PUT', '/api/finance/transfers/1'), ('DELETE', '/api/finance/transfers/1'),
                ('POST', '/api/finance/loans'), ('PUT', '/api/finance/loans/1'), ('DELETE', '/api/finance/loans/1'),
                ('POST', '/api/finance/products'), ('PUT', '/api/finance/products/1'), ('DELETE', '/api/finance/products/1'),
                ('POST', '/api/finance/movements'), ('PUT', '/api/finance/movements/1'), ('DELETE', '/api/finance/movements/1'),
                ('POST', '/api/finance/loans/1/repayments'), ('DELETE', '/api/finance/loans/1/repayments/2'),
                ('POST', '/api/finance/movements/1/payments'), ('DELETE', '/api/finance/movements/1/payments/2'),
            ]:
                with self.subTest(method=method, path=path):
                    response = await self.client.request(method, path)
                    self.assertEqual(response.status_code, 401)
            read.assert_not_called()
            create.assert_not_called()

    async def test_full_state_mutation_does_not_reload_investments(self):
        with patch.object(finance_api.repository, 'create_record', return_value=self.state) as write, \
             patch.object(main, '_queue_ledger_reload') as reload:
            response = await self.client.post('/api/finance/transfers', json=self.transfer, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), self.state)
            self.assertEqual(write.call_args.args[0], 'transfers')
            reload.assert_not_called()

    async def test_invalid_numbers_dates_currency_and_extra_fields_do_not_write(self):
        with patch.object(finance_api.repository, 'create_record') as write:
            for fields in [dict(amount='NaN'), dict(amount=-1), dict(amount=True), dict(currency='US'),
                           dict(date='2099-01-01'), dict(date='1/1/2026'), dict(investment_transaction_id=123)]:
                with self.subTest(fields=fields):
                    response = await self.client.post('/api/finance/transfers', json={**self.transfer, **fields}, headers=self.headers)
                    self.assertEqual(response.status_code, 422)
            write.assert_not_called()

    async def test_version_required_on_edit_and_void(self):
        with patch.object(finance_api.repository, 'update_record') as update, \
             patch.object(finance_api.repository, 'void_record') as void:
            body = {k: v for k, v in self.transfer.items() if k != 'request_id'}
            response = await self.client.put('/api/finance/transfers/1', json=body, headers=self.headers)
            self.assertEqual(response.status_code, 422)
            response = await self.client.delete('/api/finance/transfers/1', headers=self.headers)
            self.assertEqual(response.status_code, 422)
            update.assert_not_called()
            void.assert_not_called()

    async def test_nested_payment_void_keeps_parent_and_version(self):
        with patch.object(finance_api.repository, 'void_payment', return_value=self.state) as void:
            response = await self.client.delete('/api/finance/loans/8/repayments/17?version=2', headers=self.headers)
            self.assertEqual(response.status_code, 200)
            void.assert_called_once_with('loans', 8, 17, 2)

    async def test_conflicts_and_missing_records_have_actionable_status(self):
        for code, detail in [(409, 'This record changed; refresh and try again'), (404, 'Record not found'), (400, 'Insufficient inventory')]:
            with patch.object(finance_api.repository, 'create_record', side_effect=FinanceError(detail, code)):
                response = await self.client.post('/api/finance/transfers', json=self.transfer, headers=self.headers)
                self.assertEqual(response.status_code, code)
                self.assertEqual(response.json()['detail'], detail)


if __name__ == '__main__':
    unittest.main()
