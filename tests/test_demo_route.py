import unittest
from unittest.mock import patch

import httpx

from app import main


class DemoRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_demo_is_public_but_does_not_open_private_api_access(self):
        # ASGITransport intentionally does not start the real DB/scheduler lifespan.
        with patch.object(main, 'API_TOKEN', 'test-only'), \
                patch.object(main, 'portfolio') as portfolio:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
                response = await client.get('/demo')
                self.assertEqual(response.status_code, 200)
                self.assertIn('data-portfolio-mode="demo"', response.text)
                self.assertIn('/static/js/demo-portfolio.js?v=3', response.text)
                self.assertIn('action="/" method="get"', response.text)
                self.assertIn('aria-label="Demo portfolio" aria-pressed="true"', response.text)
                for route in ['/api/summary', '/api/positions', '/api/transactions', '/demo/private']:
                    self.assertEqual((await client.get(route)).status_code, 401)
                self.assertEqual((await client.post('/api/transactions', json={})).status_code, 401)
                self.assertEqual(portfolio.mock_calls, [])

    async def test_personal_shell_has_demo_switch_without_loading_the_demo_adapter(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            response = await client.get('/')
            self.assertIn('action="/demo" method="get"', response.text)
            self.assertIn('aria-label="Demo portfolio" aria-pressed="false"', response.text)
            self.assertIn('data-portfolio-mode="personal"', response.text)
            self.assertNotIn('src="/static/js/demo-portfolio.js', response.text)
