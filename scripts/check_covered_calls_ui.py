"""Opt-in browser + disposable-Postgres acceptance check; no production calls.

IPORTFOLIO_TEST_DATABASE_URL=... PYTHONDONTWRITEBYTECODE=1 venv/bin/python scripts/check_covered_calls_ui.py
Other dashboard panels use the public synthetic demo adapter. The covered-call
forms talk to the real repository against a newly created test schema.
"""
import json
import os
from pathlib import Path
import sys
from decimal import Decimal
from unittest.mock import patch
from urllib.parse import urlparse
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg_pool import ConnectionPool
from jinja2 import Environment, FileSystemLoader, select_autoescape
from playwright.sync_api import sync_playwright, expect
from app import db, repository
from app import covered_call_repository as calls
from app.covered_calls import CallOpen, CallEvent
from app.main import SalePreviewRequest
from app.models import Transaction
from app.sale_service import preview_sale
from app.portfolio import Portfolio


def run():
    dsn = os.environ['IPORTFOLIO_TEST_DATABASE_URL']
    if conninfo_to_dict(dsn).get('host') not in ('127.0.0.1', 'localhost', '::1'):
        raise RuntimeError('Use only a disposable localhost database')
    schema = 'cc_ui_' + uuid4().hex
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA {schema}')
    pool = ConnectionPool(dsn, kwargs={'options': f'-c search_path={schema}'})
    pool.wait()
    output = Path(os.environ.get('IPORTFOLIO_QA_OUTPUT', '/tmp/iportfolio-covered-call-qa'))
    output.mkdir(exist_ok=True, parents=True)
    try:
        with patch.object(db, '_pool', pool), patch('app.split_service.split_service.get_adjustment_factor', return_value=Decimal(1)):
            db.init_schema()
            repository.insert_transaction(Transaction(date='2026-01-02', asset='MRVL', action='BUY', quantity=150, ave_price=263, broker='Schwab'))
            env = Environment(loader=FileSystemLoader(ROOT / 'templates'), autoescape=select_autoescape())
            errors, requests = [], []
            fail_coverage = [False]
            def route_request(route):
                request = route.request
                path = urlparse(request.url).path
                if path.startswith('/static/'):
                    file = ROOT / path.lstrip('/')
                    if not file.is_file():
                        route.fulfill(status=404, body='Not found'); return
                    route.fulfill(path=str(file)); return
                if path in ('/', '/demo'):
                    route.fulfill(content_type='text/html', body=env.get_template('index.html').render(demo_mode=path == '/demo')); return
                if path.startswith('/api/'):
                    requests.append((request.method, path))
                    body = json.loads(request.post_data or '{}')
                    try:
                        if path == '/api/covered-calls':
                            if fail_coverage[0] and request.method == 'GET':
                                raise ValueError('Synthetic coverage outage')
                            result = calls.list_calls() if request.method == 'GET' else {'call': calls.create_call(CallOpen(**body)), 'message': 'Covered call recorded'}
                        elif path.endswith('/events'):
                            result = {'call': calls.record_event(int(path.split('/')[-2]), CallEvent(**body)), 'message': 'Event recorded'}
                        elif path == '/api/transactions/preview-sale':
                            result = preview_sale(repository.get_all_transactions(), SalePreviewRequest(**body))
                        else:
                            raise ValueError('Unexpected test endpoint: ' + path)
                        route.fulfill(content_type='application/json', body=json.dumps(result)); return
                    except ValueError as exc:
                        route.fulfill(status=400, content_type='application/json', body=json.dumps({'detail': str(exc)})); return
                route.fulfill(status=404, body='Not found')
            with sync_playwright() as p:
                browser = getattr(p, os.environ.get('IPORTFOLIO_QA_BROWSER', 'chromium')).launch(headless=True)
                context = browser.new_context(viewport={'width': 1440, 'height': 1050}, service_workers='block')
                context.route('https://portfolio.test/**', route_request)
                adapter = (ROOT / 'static/js/demo-portfolio.js').read_text()
                context.add_init_script(adapter + """
                  const testNativeFetch = window.fetch.bind(window);
                  const testDemo = window.DemoPortfolio.create();
                  window.fetch = async (input, init) => {
                    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
                    if (path.startsWith('/api/covered-calls') || path === '/api/transactions/preview-sale') return testNativeFetch(input, init);
                    if (['/api/positions', '/api/holdings', '/api/summary'].includes(path)) {
                      const demo = await (await testDemo.fetch(input, init)).json();
                      const cc = await (await testNativeFetch('/api/covered-calls')).json();
                      const shares = cc.inventory?.find(p => p.asset === 'MRVL')?.shares ?? 150;
                      const template = demo.holdings.find(h => h.symbol === 'MU');
                      demo.holdings.push({ ...template, symbol: 'MRVL', quantity: shares,
                        cost_basis: shares * 263, avg_cost: 263, current_price: 270,
                        market_value: shares * 270, unrealized_pnl: shares * 7 });
                      return new Response(JSON.stringify(demo), { headers: { 'Content-Type': 'application/json' } });
                    }
                    return testDemo.fetch(input, init);
                  };
                """)
                page = context.new_page()
                page.on('pageerror', lambda err: errors.append(str(err)))
                page.goto('https://portfolio.test/', wait_until='networkidle')
                expect(page.locator('#covered-calls-tab')).to_have_text('Option')
                page.locator('#holdings-tab').click()
                badge = page.locator('[data-cc-coverage="MRVL"]')
                expect(badge).to_contain_text('CC 1 available')
                assert page.locator('[data-cc-coverage="ETH-USD"]').count() == 0
                page.locator('#covered-calls-tab').click()
                expect(page.locator('#trackerCoveredCalls h2')).to_have_text('Covered Call')
                expect(page.locator('#ccList')).to_contain_text('No covered calls')

                def fill_open():
                    page.locator('#ccOpenBtn').click()
                    expect(page.locator('#coveredCallModal')).to_have_class('modal fade show')
                    page.locator('#ccHolding').select_option('0')
                    page.locator('#ccDate').fill('2026-01-05')
                    page.locator('#ccTime').fill('10:00')
                    page.locator('#ccExpiration').fill('2026-02-20')
                    page.locator('#ccStrike').fill('280')
                    page.locator('#ccPremium').fill('13')
                    page.locator('#ccFees').fill('0.65')

                fill_open()
                page.locator('#ccComment').fill('<img src=x onerror=alert(1)> Broker fill')
                expect(page.locator('#ccEstimate')).to_contain_text('1,299.35')
                page.set_viewport_size({'width': 390, 'height': 844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile overflow'
                page.screenshot(path=str(output / 'covered-call-mobile-form.png'), full_page=True, animations='disabled')
                assert page.locator('#ccSaveBtn').bounding_box()['y'] < 844, 'Mobile save button must remain on-screen'
                page.locator('#ccConfirmed').check(); page.locator('#ccSaveBtn').click()
                expect(page.locator('#coveredCallModal')).not_to_be_visible()
                expect(page.locator('#ccList .cc-card')).to_have_count(1)
                assert calls.list_calls()['summary']['realized_option_pnl'] == 0
                assert page.locator('#ccList img').count() == 0
                assert calls.list_calls()['inventory'][0]['shares'] == 150

                page.locator('#holdings-tab').click()
                expect(badge).to_contain_text('CC 1 open')
                expect(badge).to_contain_text('0 available')
                badge.click()
                expect(page.locator('#ccHoldingDetails')).to_contain_text('Schwab')
                expect(page.locator('#ccHoldingDetails')).to_contain_text('100')
                expect(page.locator('#ccHoldingDetails')).to_contain_text('50')
                assert page.locator('.txn-detail-row').count() == 0, 'Coverage click expanded stock transactions'
                page.screenshot(path=str(output / 'holdings-coverage-details.png'), full_page=True, animations='disabled')
                fail_coverage[0] = True
                page.locator('#ccHoldingReload').click()
                expect(page.locator('#ccHoldingDetails')).to_contain_text('could not be loaded')
                expect(badge).to_contain_text('unavailable')
                fail_coverage[0] = False
                page.locator('#ccHoldingReload').click()
                expect(page.locator('#ccHoldingDetails')).to_contain_text('100')
                page.locator('#holdingCoverageModal .btn-close').click()
                for width in [320, 390, 430, 1024, 1440, 2048]:
                    page.set_viewport_size({'width': width, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Coverage overflow at {width}'
                    expect(badge).to_be_visible()
                    page.screenshot(path=str(output / f'holdings-coverage-{width}.png'), full_page=True, animations='disabled')
                    assert page.locator('.holdings-table-scroll').evaluate('e => e.scrollHeight - e.clientHeight <= 1'), 'Holdings must show every row without an inner vertical scrollbar'
                    page.evaluate("window.scrollBy(0, document.querySelector('#holdingsTable').getBoundingClientRect().top + 160)")
                    page.wait_for_function("""mobile => {
                        const nav = document.querySelector('.app-navbar');
                        const rect = nav.getBoundingClientRect();
                        const top = mobile ? document.querySelector('#trackerTabs').getBoundingClientRect().bottom
                            : (['fixed','sticky'].includes(getComputedStyle(nav).position) && rect.top <= 0 && rect.bottom > 0 ? rect.bottom : 0);
                        return Math.abs(document.querySelector('#holdingsTable th').getBoundingClientRect().top - top) < 2;
                    }""", arg=width < 768)
                    assert page.evaluate('scrollY > 0 && document.querySelector(".holdings-table-scroll").scrollTop === 0'), 'Holdings must scroll with the page'
                    page.evaluate('document.querySelector(".holdings-table-scroll").scrollLeft = 180')
                    page.wait_for_function("Math.abs(document.querySelector('#holdingsTable th').getBoundingClientRect().left - document.querySelector('#holdingsBody .holding-row td').getBoundingClientRect().left) < 2")
                    page.wait_for_function("Math.abs(document.querySelector('#holdingsTable th[data-col=\"4\"]').getBoundingClientRect().left - document.querySelector('#holdingsBody .holding-row [data-col=\"4\"]').getBoundingClientRect().left) < 2")
                    page.evaluate('document.querySelector(".holdings-table-scroll").scrollLeft = 0; window.scrollTo(0, 0)')

                page.set_viewport_size({'width': 390, 'height': 844})
                page.locator('#anonymousBtn').click()
                expect(badge).to_have_text('CC ***')
                assert '100' not in badge.get_attribute('title')
                badge.click()
                expect(page.locator('#ccHoldingDetails')).not_to_contain_text('Schwab')
                expect(page.locator('#ccHoldingDetails')).not_to_contain_text('100')
                page.locator('#holdingCoverageModal .btn-close').click()
                page.locator('#anonymousBtn').click()
                page.locator('#covered-calls-tab').click()
                fill_open()
                page.locator('#ccConfirmed').check(); page.locator('#ccSaveBtn').click()
                expect(page.locator('#ccError')).to_contain_text('Insufficient unreserved')
                assert len(calls.list_calls()['calls']) == 1
                page.locator('#coveredCallModal .btn-close').click()

                page.locator('[data-cc-manage]').click()
                page.locator('#ccEventAction').select_option('ROLL')
                page.locator('#ccDate').fill('2026-01-20'); page.locator('#ccTime').fill('15:00')
                page.locator('#ccPremium').fill('20'); page.locator('#ccFees').fill('0.65')
                page.locator('#ccNewExpiry').fill('2026-03-20'); page.locator('#ccNewStrike').fill('290')
                page.locator('#ccNewPremium').fill('22'); page.locator('#ccNewFees').fill('0.65')
                assert page.locator('#ccSaveBtn').bounding_box()['y'] < 844, 'Roll save button must remain on-screen'
                expect(page.locator('#ccEstimate')).to_contain_text('198.70')
                page.locator('#ccConfirmed').check(); page.locator('#ccSaveBtn').click()
                expect(page.locator('#coveredCallModal')).not_to_be_visible()
                expect(page.locator('#ccList .cc-card')).to_have_count(2)
                assert calls.list_calls()['summary']['open_contracts'] == 1
                assert calls.list_calls()['inventory'][0]['available_shares'] == 50
                page.locator('#holdings-tab').click()
                expect(badge).to_contain_text('CC 1 open')
                expect(badge).to_contain_text('0 available')
                page.locator('#covered-calls-tab').click()

                page.locator('[data-cc-manage]').click()
                page.locator('#ccEventAction').select_option('ASSIGN')
                page.locator('#ccDate').fill('2026-02-02'); page.locator('#ccTime').fill('15:00')
                page.locator('#ccFees').fill('0.65')
                page.locator('#ccLotMethod').select_option('SPECIFIC')
                expect(page.locator('[data-cc-lot]')).to_have_count(1)
                page.locator('[data-cc-lot]').fill('100')
                expect(page.locator('#ccSalePreview')).to_contain_text('Stock proceeds')
                page.locator('#ccConfirmed').check(); page.locator('#ccSaveBtn').click()
                expect(page.locator('#coveredCallModal')).not_to_be_visible()
                assert calls.list_calls()['summary']['open_contracts'] == 0
                ledger = repository.get_all_transactions()
                assert len(ledger) == 2
                portfolio = Portfolio(); portfolio.add_transactions(ledger)
                assert sum(l.quantity for l in portfolio._lots['MRVL']) == 50
                assert ledger[-1].cost_basis_method.value == 'SPECIFIC'
                page.locator('#holdings-tab').click()
                expect(badge).to_have_text('CC 0 available')
                badge.click()
                expect(page.locator('#ccHoldingDetails')).to_contain_text('50')
                expect(page.locator('#ccHoldingDetails')).to_contain_text('No open covered calls')
                page.locator('#holdingCoverageModal .btn-close').click()
                page.locator('#covered-calls-tab').click()

                page.set_viewport_size({'width': 1440, 'height': 1050})
                expect(page.locator('.modal-backdrop')).to_have_count(0)
                page.screenshot(path=str(output / 'covered-call-desktop.png'), full_page=True, animations='disabled')
                page.set_viewport_size({'width': 390, 'height': 844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile ledger overflow'
                page.screenshot(path=str(output / 'covered-call-mobile.png'), full_page=True, animations='disabled')
                page.locator('#anonymousBtn').click()
                expect(page.locator('#ccList')).not_to_contain_text('Schwab')
                expect(page.locator('#ccMetrics')).not_to_contain_text('1,497.40')
                for width in [320, 736]:
                    page.set_viewport_size({'width': width, 'height': 844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Overflow at {width}'

                requests.clear()
                page.goto('https://portfolio.test/demo', wait_until='networkidle')
                page.locator('#covered-calls-tab').click()
                expect(page.locator('#ccOpenBtn')).to_be_disabled()
                expect(page.locator('#ccStatus')).to_contain_text('Demo is read-only')
                page.locator('#holdings-tab').click()
                expect(page.locator('[data-cc-coverage="MU"]')).to_have_text('CC 0 available')
                assert not requests, 'Demo contacted a personal-data endpoint'
                assert not errors, errors
                browser.close()
                print('PASS: mobile/desktop open, overcoverage rejection, roll, specified-lot assignment, privacy, demo isolation, Holdings coverage and responsive detail modal; screenshots:', output)
    finally:
        pool.close()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA {schema} CASCADE')


if __name__ == '__main__': run()
