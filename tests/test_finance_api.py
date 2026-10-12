"""Finance endpoint auth, validated writes and isolated portfolio boundaries."""
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from app import main
from app import finance_api
from app.finance import FinanceError, InventoryPaymentCreate, InventoryPaymentUpdate, request_data


class FinanceAPITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.auth = patch.object(main, 'API_TOKEN', 'finance-api-test')
        self.auth.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                       base_url='https://portfolio.test')
        self.headers = {'Authorization': 'Bearer finance-api-test'}
        self.state = dict(transfers=[], loans=[], products=[], movements=[], exchanges=[], projects=[], summary=[])
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
                ('POST', '/api/finance/exchanges'), ('PUT', '/api/finance/exchanges/1'), ('DELETE', '/api/finance/exchanges/1'),
                ('POST', '/api/finance/projects'), ('PUT', '/api/finance/projects/1'), ('DELETE', '/api/finance/projects/1'),
                ('POST', '/api/finance/loans'), ('PUT', '/api/finance/loans/1'), ('DELETE', '/api/finance/loans/1'),
                ('POST', '/api/finance/products'), ('PUT', '/api/finance/products/1'), ('DELETE', '/api/finance/products/1'),
                ('POST', '/api/finance/movements'), ('PUT', '/api/finance/movements/1'), ('DELETE', '/api/finance/movements/1'),
                ('POST', '/api/finance/loans/1/repayments'), ('DELETE', '/api/finance/loans/1/repayments/2'),
                ('POST', '/api/finance/movements/1/payments'), ('DELETE', '/api/finance/movements/1/payments/2'),
                ('PUT', '/api/finance/movements/1/payments/2'),
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

    async def test_money_actor_fields_reach_parent_and_child_writes_and_support_clear(self):
        bodies = [('/transfers', self.transfer),
                  ('/loans', dict(date='2026-01-01', direction='lent', counterparty='K', principal=10, request_id=str(uuid4()))),
                  ('/movements', dict(date='2026-01-01', product_id=1, kind='purchase', quantity=1, unit_price=10, request_id=str(uuid4()))),
                  ('/exchanges', dict(date='2026-01-01', from_currency='USD', to_currency='CNY', from_amount=10, to_amount=70, request_id=str(uuid4())))]
        with patch.object(finance_api.repository, 'create_record', return_value=self.state) as create, \
             patch.object(finance_api.repository, 'update_record', return_value=self.state) as update, \
             patch.object(finance_api.repository, 'create_payment', return_value=self.state) as payment:
            for path, body in bodies:
                response = await self.client.post('/api/finance' + path,
                    json={**body, 'payer': '  Kevin  ', 'recipient': 'Partner'}, headers=self.headers)
                self.assertEqual(response.status_code, 200)
                fields = request_data(create.call_args.args[1])
                self.assertEqual((fields['payer'], fields['recipient']), ('Kevin', 'Partner'))
                changed = {key: value for key, value in body.items() if key != 'request_id'}
                response = await self.client.put('/api/finance' + path + '/1',
                    json={**changed, 'version': 1, 'payer': ''}, headers=self.headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(request_data(update.call_args.args[2])['payer'], '')
                self.assertNotIn('recipient', request_data(update.call_args.args[2]))
                response = await self.client.post('/api/finance' + path,
                    json={**body, 'payer': 'A' * 201}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            for path in ('/loans/1/repayments', '/movements/1/payments'):
                response = await self.client.post('/api/finance' + path,
                    json=dict(date='2026-01-02', amount=1, request_id=str(uuid4()), payer=' Sender ', recipient=' Receiver '), headers=self.headers)
                self.assertEqual(response.status_code, 200)
                fields = request_data(payment.call_args.args[2])
                self.assertEqual((fields['payer'], fields['recipient']), ('Sender', 'Receiver'))
            self.assertEqual((create.call_count, update.call_count, payment.call_count), (4, 4, 2))

    async def test_invalid_numbers_dates_currency_and_extra_fields_do_not_write(self):
        with patch.object(finance_api.repository, 'create_record') as write, \
             patch.object(finance_api.repository, 'update_record') as update:
            for fields in [dict(amount='NaN'), dict(amount=-1), dict(amount=True), dict(currency='US'), dict(currency='HKD'),
                           dict(date='2099-01-01'), dict(date='1/1/2026'), dict(investment_transaction_id=123)]:
                with self.subTest(fields=fields):
                    response = await self.client.post('/api/finance/transfers', json={**self.transfer, **fields}, headers=self.headers)
                    self.assertEqual(response.status_code, 422)
            body = {k: v for k, v in self.transfer.items() if k != 'request_id'}
            response = await self.client.put('/api/finance/transfers/1', json={**body, 'currency': 'HKD', 'version': 1}, headers=self.headers)
            self.assertEqual(response.status_code, 422)
            write.assert_not_called()
            update.assert_not_called()

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

    async def test_exchange_crud_uses_full_state_and_optimistic_version(self):
        exchange = dict(date='2026-01-01', from_currency='USD', to_currency='CNY',
                        from_amount=1000, to_amount=7200, fee_amount=5,
                        request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record', return_value=self.state) as create, \
             patch.object(finance_api.repository, 'update_record', return_value=self.state) as update, \
             patch.object(finance_api.repository, 'void_record', return_value=self.state) as void, \
             patch.object(main, '_queue_ledger_reload') as reload:
            response = await self.client.post('/api/finance/exchanges', json=exchange, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), self.state)
            self.assertEqual(create.call_args.args[0], 'exchanges')
            self.assertEqual(create.call_args.args[1].fee_currency, 'USD')
            body = {k: v for k, v in exchange.items() if k != 'request_id'}
            response = await self.client.put('/api/finance/exchanges/7', json=body, headers=self.headers)
            self.assertEqual(response.status_code, 422)
            update.assert_not_called()
            response = await self.client.put('/api/finance/exchanges/7', json={**body, 'version': 2}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(update.call_args.args[:2], ('exchanges', 7))
            self.assertEqual(update.call_args.args[2].version, 2)
            response = await self.client.delete('/api/finance/exchanges/7?version=3', headers=self.headers)
            self.assertEqual(response.status_code, 200)
            void.assert_called_once_with('exchanges', 7, 3)
            reload.assert_not_called()

    async def test_invalid_exchange_never_reaches_writer(self):
        exchange = dict(date='2026-01-01', from_currency='USD', to_currency='CNY',
                        from_amount=1000, to_amount=7200, request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record') as write:
            for values in [dict(to_currency='USD'), dict(from_currency='HKD'), dict(from_amount=0), dict(fee_currency='JPY'),
                           dict(fee_currency='CNY', fee_amount=7200), dict(fee_amount='Infinity')]:
                response = await self.client.post('/api/finance/exchanges', json={**exchange, **values}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            write.assert_not_called()

    async def test_inventory_currency_and_twelve_place_rates_reach_domain(self):
        movement = dict(date='2026-01-01', product_id=1, kind='purchase', quantity=10,
                        unit_price=70, currency='CNY', exchange_rate='.142857142857', request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record', return_value=self.state) as write:
            response = await self.client.post('/api/finance/movements', json=movement, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(write.call_args.args[1].currency, 'CNY')
            self.assertEqual(str(write.call_args.args[1].exchange_rate), '0.142857142857')
            for values in [dict(exchange_rate=0), dict(exchange_rate='NaN'), dict(exchange_rate='.0000000000001'), dict(currency='HKD')]:
                response = await self.client.post('/api/finance/movements', json={**movement, **values}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            self.assertEqual(write.call_count, 1)

    async def test_zero_price_sale_create_and_edit_are_accepted_without_weakening_number_guards(self):
        gift = dict(date='2026-01-03', product_id=1, kind='sale', quantity=4, unit_price=0,
                    paid_amount=0, note='Gifted merchandise', request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record', return_value=self.state) as create, \
             patch.object(finance_api.repository, 'update_record', return_value=self.state) as update:
            response = await self.client.post('/api/finance/movements', json=gift, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(request_data(create.call_args.args[1])['unit_price'], '0')
            changed = {key: value for key, value in gift.items() if key != 'request_id'}
            response = await self.client.put('/api/finance/movements/7', json={**changed, 'unit_price': '0.000000', 'version': 1}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(request_data(update.call_args.args[2])['unit_price'], '0')
            for values in (dict(unit_price=-1), dict(quantity=0), dict(paid_amount='.000001')):
                response = await self.client.post('/api/finance/movements', json={**gift, **values}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            self.assertEqual((create.call_count, update.call_count), (1, 1))

    async def test_inventory_payment_fx_fields_do_not_change_loan_payment_schema(self):
        payment = dict(date='2026-01-01', amount=50, currency='USD', exchange_rate=7, request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_payment', return_value=self.state) as write:
            response = await self.client.post('/api/finance/movements/7/payments', json=payment, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertIsInstance(write.call_args.args[2], InventoryPaymentCreate)
            self.assertEqual(write.call_args.args[:2], ('movements', 7))
            self.assertEqual(request_data(write.call_args.args[2])['exchange_rate'], '7')
            response = await self.client.post('/api/finance/loans/7/repayments', json=payment, headers=self.headers)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(write.call_count, 1)

    async def test_native_inventory_amounts_without_rates_and_later_payment_rate_edits(self):
        body = dict(date='2026-01-02', product_id=1, kind='sale', quantity=2,
                    total_amount=1200, currency='USD', request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record', return_value=self.state) as create, \
             patch.object(finance_api.repository, 'update_inventory_payment', return_value=self.state) as update:
            response = await self.client.post('/api/finance/movements', json=body, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('exchange_rate', request_data(create.call_args.args[1]))
            fields = dict(date='2026-01-03', amount=70, currency='CNY', exchange_rate='.1', version=1,
                          handler=' Cashier ', payer='Kevin', recipient='Carrier')
            response = await self.client.put('/api/finance/movements/7/payments/8', json=fields, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(update.call_args.args[:2], (7, 8))
            self.assertIsInstance(update.call_args.args[2], InventoryPaymentUpdate)
            self.assertEqual(request_data(update.call_args.args[2])['exchange_rate'], '0.1')
            response = await self.client.put('/api/finance/movements/7/payments/8',
                json={**fields, 'exchange_rate': None, 'handler': ''}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(request_data(update.call_args.args[2])['exchange_rate'])
            response = await self.client.put('/api/finance/loans/7/repayments/8', json=fields, headers=self.headers)
            self.assertEqual(response.status_code, 405)
            for changed in (dict(version=True), dict(version=0), dict(exchange_rate=0), dict(amount=0)):
                response = await self.client.put('/api/finance/movements/7/payments/8',
                    json={**fields, **changed}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            self.assertEqual(update.call_count, 2)

    async def test_product_transactions_support_total_prices_custom_costs_and_handlers(self):
        purchase = dict(date='2026-01-01', product_id=1, kind='purchase', quantity=3,
                        total_amount=100, handler='  Kevin  ', request_id=str(uuid4()))
        expense = dict(date='2026-01-02', product_id=1, kind='expense', total_amount=140,
                       category='  物流  ', currency='CNY', exchange_rate='.125',
                       handler=' Freight agent ', request_id=str(uuid4()))
        sale = dict(date='2026-01-03', product_id=1, kind='sale', quantity=1,
                    total_amount=0, handler='Gift agent', request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record', return_value=self.state) as create, \
             patch.object(finance_api.repository, 'update_record', return_value=self.state) as update, \
             patch.object(finance_api.repository, 'create_payment', return_value=self.state) as payment:
            for body in (purchase, expense, sale):
                response = await self.client.post('/api/finance/movements', json=body, headers=self.headers)
                self.assertEqual(response.status_code, 200)
                fields = request_data(create.call_args.args[1])
                self.assertNotIn('unit_price', fields)
                self.assertEqual(fields['handler'], body['handler'].strip())
            self.assertEqual(fields['total_amount'], '0')
            changed = {key: value for key, value in expense.items() if key not in ('request_id', 'category')}
            response = await self.client.put('/api/finance/movements/7',
                json={**changed, 'version': 1, 'handler': ''}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            values = request_data(update.call_args.args[2])
            self.assertEqual(values['handler'], '')
            self.assertNotIn('category', values)
            response = await self.client.post('/api/finance/movements/7/payments',
                json=dict(date='2026-01-03', amount=5, handler=' Payment agent ',
                          currency='USD', exchange_rate=8, request_id=str(uuid4())), headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(request_data(payment.call_args.args[2])['handler'], 'Payment agent')

    async def test_invalid_product_expenses_and_price_totals_never_reach_writer(self):
        expense = dict(date='2026-01-01', product_id=1, kind='expense', total_amount=20,
                       category='物流', request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record') as write:
            for changed in (dict(category=''), dict(total_amount=0), dict(quantity=1), dict(unit_price=0),
                            dict(total_amount=True), dict(total_amount='NaN'), dict(handler='A' * 201)):
                response = await self.client.post('/api/finance/movements',
                    json={**expense, **changed}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            for changed in (dict(quantity=None), dict(unit_price=34), dict(total_amount=None)):
                response = await self.client.post('/api/finance/movements',
                    json={**expense, 'kind': 'sale', 'quantity': 3, 'total_amount': 100, **changed}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            write.assert_not_called()

    async def test_project_crud_returns_state_and_keeps_forecast_out_of_investments(self):
        plan = dict(date='2026-01-01', name='Tea', expected_profit=0,
                    participants=[dict(name='Kevin', contribution_amount='600.00', dividend_percent=60),
                                  dict(name='Partner', contribution_amount=400, dividend_percent=30)],
                    request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record', return_value=self.state) as create, \
             patch.object(finance_api.repository, 'update_record', return_value=self.state) as update, \
             patch.object(finance_api.repository, 'void_record', return_value=self.state) as void, \
             patch.object(main, '_queue_ledger_reload') as reload:
            response = await self.client.post('/api/finance/projects', json=plan, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), self.state)
            self.assertEqual(create.call_args.args[0], 'projects')
            self.assertEqual(request_data(create.call_args.args[1])['participants'][0]['contribution_amount'], '600')
            body = {k: v for k, v in plan.items() if k != 'request_id'}
            response = await self.client.put('/api/finance/projects/3', json={**body, 'version': 2}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(update.call_args.args[:2], ('projects', 3))
            response = await self.client.delete('/api/finance/projects/3?version=3', headers=self.headers)
            self.assertEqual(response.status_code, 200)
            void.assert_called_once_with('projects', 3, 3)
            reload.assert_not_called()

    async def test_invalid_project_plans_never_reach_writer(self):
        plan = dict(date='2026-01-01', name='Tea', participants=[dict(name='Kevin', contribution_amount=100, dividend_percent=60)], request_id=str(uuid4()))
        with patch.object(finance_api.repository, 'create_record') as create:
            for values in [dict(expected_profit=-1), dict(participants=[]), dict(currency='HKD'),
                           dict(participants=plan['participants'] * 2),
                           dict(participants=[dict(name='A', contribution_amount=100, dividend_percent=101)]),
                           dict(participants=[dict(name='A', contribution_amount='.000001', currency='CNY', exchange_rate='.000000000001', dividend_percent=50)])]:
                response = await self.client.post('/api/finance/projects', json={**plan, **values}, headers=self.headers)
                self.assertEqual(response.status_code, 422)
            create.assert_not_called()

    async def test_movement_link_null_is_forwarded_and_omitted_link_is_preserved(self):
        body = dict(date='2026-01-01', product_id=1, kind='purchase', quantity=1, unit_price=1, version=1)
        with patch.object(finance_api.repository, 'update_record', return_value=self.state) as update:
            response = await self.client.put('/api/finance/movements/1', json=body, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('project_id', request_data(update.call_args.args[2]))
            response = await self.client.put('/api/finance/movements/1', json={**body, 'project_id': None}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertIn('project_id', request_data(update.call_args.args[2]))
            self.assertIsNone(request_data(update.call_args.args[2])['project_id'])


if __name__ == '__main__':
    unittest.main()
