"""Synthetic option-day-P&L browser acceptance; never reads personal APIs.

Run with the project Python environment. Defaults to Chromium and WebKit at
320/390/430/1440px. Set IPORTFOLIO_QA_BROWSERS or IPORTFOLIO_QA_WIDTHS to focus
an iteration. All financial/API responses are synthetic; static app code is real.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from jinja2 import Environment, FileSystemLoader, select_autoescape
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
TODAY = '2026-09-30'
PREVIOUS = '2026-09-29'
NOW = datetime(2026, 9, 30, 14, 0, tzinfo=timezone.utc)


def snapshot(day=TODAY, missing=False):
    """Distinct early/latest values catch later quote or cash-flow backfilling."""
    points = []
    for index, (at, stock, option, cash) in enumerate([
        ('09:30', 400, None, 0), ('09:45', 700, -50, 1299.35),
        ('10:00', 1000, -150, 1299.35),
    ]):
        unknown = missing or option is None or day != TODAY
        mark = None if unknown else option
        points.append(dict(
            time=at, value=50000 + stock, baseline_value=50000,
            daily_pnl=stock, daily_pnl_percent=stock / 500,
            holdings_daily_pnl=stock, option_daily_pnl=mark,
            combined_daily_pnl=None if unknown else stock + mark,
            combined_daily_pnl_percent=None if unknown else (stock + mark) / 488,
            option_cash_flow=cash, options_present=True, options_complete=not unknown,
            option_details=[dict(call_id=1, asset='MU', pnl=mark,
                reason='Prior-session reference is missing' if unknown else None,
                asof=None if unknown else day + 'T' + ('13:45:00' if index == 1 else '14:00:00') + '+00:00')],
            holdings_complete=True,
            asset_changes=[dict(symbol='MU', quantity=150, pnl=stock * .7,
                pnl_percent=stock * .7 / 390, current_price=261),
                dict(symbol='VOO', quantity=3, pnl=stock * .3,
                pnl_percent=stock * .3 / 16, current_price=560)],
        ))
    return dict(date=day, computed_at=NOW.isoformat(), cache_status='fresh', intraday=points)


def calls_fixture():
    call = dict(id=1, asset='MU', broker='Synthetic account', date=PREVIOUS,
        transaction_time='09:30:00', expiration='2026-10-30', strike=280,
        contracts=2, remaining_contracts=1, premium=13, fees=1.3,
        events=[], status='OPEN', reserved_shares=100,
        net_opening_premium=2598.7, realized_option_pnl=98.70,
        comment='', adjustment_required=False, outcome_pending=False)
    return dict(calls=[call], inventory=[dict(asset='MU', broker='Synthetic account',
        shares=150, reserved_shares=100, available_shares=50, available_contracts=0)],
        summary=dict(open_contracts=1, premiums_received=2600, buyback_paid=1200,
            fees_paid=1.95, net_cash_flow=1398.05, realized_option_pnl=98.70))


def no_overflow(page, label):
    dimensions = page.evaluate('({page:document.documentElement.scrollWidth, viewport:innerWidth})')
    assert dimensions['page'] <= dimensions['viewport'] + 1, f'{label}: page overflow {dimensions}'


def metric_values(page, selector):
    return page.locator(selector + ' .pnl-breakdown-grid strong').all_text_contents()


def run():
    output = Path(os.environ.get('IPORTFOLIO_QA_OUTPUT', '/tmp/option-intraday-qa'))
    output.mkdir(parents=True, exist_ok=True)
    engines = os.environ.get('IPORTFOLIO_QA_BROWSERS', 'chromium,webkit').split(',')
    widths = [int(x) for x in os.environ.get('IPORTFOLIO_QA_WIDTHS', '320,390,430,1440').split(',')]
    template = Environment(loader=FileSystemLoader(ROOT / 'templates'),
        autoescape=select_autoescape()).get_template('index.html')
    adapter = (ROOT / 'static/js/demo-portfolio.js').read_text()
    with sync_playwright() as p:
        for engine in engines:
            browser = getattr(p, engine).launch(headless=True)
            try:
                for width in widths:
                    state = {'missing': False}
                    errors, api_requests = [], []
                    context = browser.new_context(viewport={'width': width, 'height': 844},
                        is_mobile=width < 768, has_touch=width < 768, service_workers='block')

                    def route_request(route):
                        request = route.request
                        url = urlparse(request.url)
                        path = url.path
                        if path.startswith('/static/'):
                            local = ROOT / path.lstrip('/')
                            route.fulfill(path=str(local)) if local.is_file() else route.fulfill(status=404)
                            return
                        if path in ('/', '/demo'):
                            route.fulfill(content_type='text/html', body=template.render(demo_mode=path == '/demo'))
                            return
                        if path.startswith('/api/'):
                            api_requests.append((request.method, path))
                            if path in ('/api/intraday', '/api/intraday/refresh'):
                                result = snapshot(parse_qs(url.query).get('date', [TODAY])[0], state['missing'])
                            elif path == '/api/covered-calls':
                                assert request.method == 'GET', 'Unexpected financial write'
                                result = calls_fixture()
                            elif path == '/api/options/calls':
                                params = parse_qs(url.query)
                                result = dict(symbol=params.get('symbol', ['MU'])[0], expiration='2026-10-30',
                                    expirations=['2026-10-30'], calls=[dict(contract_symbol='MU261030C00280000',
                                    strike=280, bid=10.8, ask=11.2, mid=11, last=11.1,
                                    last_trade_at=NOW.isoformat(), quote_at=None, volume=4, open_interest=200,
                                    quote_status='two_sided')], source='Synthetic quote fixture',
                                    fetched_at=NOW.isoformat(), cache_status='fresh', cache_age_seconds=0,
                                    delay_notice='Reference quotes; may be delayed. Bid/ask timestamp not supplied.')
                            else:
                                raise AssertionError('Unexpected synthetic API transport: ' + path)
                            route.fulfill(content_type='application/json', body=json.dumps(result))
                            return
                        route.fulfill(status=404, body='No external financial access allowed')

                    context.route('https://option-day.test/**', route_request)
                    context.add_init_script(adapter + """
                        const acceptanceNativeFetch = window.fetch.bind(window);
                        const acceptanceDemo = window.DemoPortfolio.create();
                        window.fetch = async (input, init) => {
                            const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
                            if (['/api/intraday','/api/intraday/refresh','/api/covered-calls','/api/options/calls'].includes(path))
                                return acceptanceNativeFetch(input, init);
                            const response = await acceptanceDemo.fetch(input, init);
                            if (['/api/holdings','/api/summary','/api/positions'].includes(path)) {
                                const body = await response.json();
                                const sample = body.holdings.find(row => row.symbol === 'MU');
                                sample.quantity = 150;
                                for (let i = 0; i < 10; i++) body.holdings.push({...sample, symbol:'FIX'+i, quantity:1});
                                return new Response(JSON.stringify(body), {headers:{'Content-Type':'application/json'}});
                            }
                            return response;
                        };
                        localStorage.setItem('trackerActiveTab', '#trackerToday');
                        localStorage.setItem('summaryCardsExpanded', '1');
                    """)
                    page = context.new_page()
                    page.clock.set_fixed_time(NOW)
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto('https://option-day.test/', wait_until='networkidle')
                    expect(page.locator('#intradayPnlBreakdown')).to_be_visible()
                    expect(page.locator('#intradayLatestPnl')).to_contain_text('850.00')
                    assert metric_values(page, '#intradayPnlBreakdown') == ['$1,000.00', '-$150.00', '$850.00']
                    expect(page.locator('#intradayPnlBreakdown .pnl-cashflow')).to_contain_text('$1,299.35')
                    no_overflow(page, f'{engine} {width} Today')
                    chart = page.evaluate("""() => {
                        const chart = Chart.getChart('intradayChart');
                        return {labels: chart.data.labels, datasets:chart.data.datasets.map(s=>({label:s.label,data:s.data}))};
                    }""")
                    combined, stocks = chart['datasets'][:2]
                    assert combined['data'][chart['labels'].index('09:30')] is None, 'Earlier missing option mark was backfilled'
                    assert combined['data'][chart['labels'].index('09:45')] == 650
                    assert combined['data'][chart['labels'].index('10:00')] == 850
                    assert stocks['data'][chart['labels'].index('10:00')] == 1000
                    assert all(value is None for i, value in enumerate(combined['data']) if chart['labels'][i] > '10:00'), 'Future chart values'
                    # Exercise the real chart hover callback with its own point index.
                    page.evaluate("""() => { const c=Chart.getChart('intradayChart');
                        c.options.onHover({}, [{index:c.data.labels.indexOf('09:45'),datasetIndex:0}], c); }""")
                    expect(page.locator('#intradayLatestPnl')).to_contain_text('650.00')
                    assert metric_values(page, '#intradayPnlBreakdown') == ['$700.00', '-$50.00', '$650.00']
                    page.evaluate("""() => { const c=Chart.getChart('intradayChart');
                        c.options.onHover({}, [{index:c.data.labels.indexOf('09:30'),datasetIndex:1}], c); }""")
                    expect(page.locator('#intradayLatestPnl')).to_contain_text('400.00')
                    assert metric_values(page, '#intradayPnlBreakdown') == ['$400.00', 'Unavailable', 'Unavailable']
                    expect(page.locator('#intradayPnlBreakdown .pnl-cashflow strong')).to_have_text('$0.00')
                    page.evaluate("document.querySelector('#intradayChart').onmouseleave()")
                    expect(page.locator('#intradayLatestPnl')).to_contain_text('850.00')
                    page.screenshot(path=str(output / f'{engine}-{width}-today.png'), full_page=True, animations='disabled')

                    page.locator('#holdings-tab').click()
                    expect(page.locator('#holdingsPnlBreakdown')).to_be_visible()
                    expect(page.locator('#trackerHoldings')).to_have_css('opacity', '1')
                    assert metric_values(page, '#holdingsPnlBreakdown') == ['$1,000.00', '-$150.00', '$850.00']
                    rows = page.locator('#holdingsBody .holding-row [data-col="5"]').all_text_contents()
                    amount = lambda value: float(value.replace('$','').replace(',','').replace('+','').strip())
                    assert abs(sum(amount(value) for value in rows) - 1000) < .01, rows
                    no_overflow(page, f'{engine} {width} Holdings')
                    if width < 768:
                        page.evaluate("window.scrollBy(0, document.querySelector('#holdingsTable').getBoundingClientRect().top + 160)")
                        page.wait_for_function("Math.abs(document.querySelector('#holdingsTable th').getBoundingClientRect().top - document.querySelector('#trackerTabs').getBoundingClientRect().bottom) < 2")
                        assert page.evaluate("document.querySelector('.holdings-table-scroll').scrollTop === 0"), 'Nested mobile vertical scroll'
                        page.evaluate("document.querySelector('.holdings-table-scroll').scrollLeft = 180")
                        page.wait_for_function("Math.abs(document.querySelector('#holdingsBody .holding-row [data-col=\"0\"]').getBoundingClientRect().left - document.querySelector('.holdings-table-scroll').getBoundingClientRect().left) < 2")
                        page.evaluate("document.querySelector('.holdings-table-scroll').scrollLeft = 0; window.scrollTo(0,0)")
                    else:
                        page.locator('.holdings-table-scroll').evaluate('(element) => element.scrollTop = 150')
                        page.wait_for_function("Math.abs(document.querySelector('#holdingsTable th').getBoundingClientRect().top - document.querySelector('.holdings-table-scroll').getBoundingClientRect().top) < 2")
                        page.locator('.holdings-table-scroll').evaluate('(element) => element.scrollTop = 0')
                    page.screenshot(path=str(output / f'{engine}-{width}-holdings.png'), full_page=True, animations='disabled')
                    page.locator('#anonymousBtn').click()
                    assert metric_values(page, '#holdingsPnlBreakdown') == ['***', '***', '***']
                    expect(page.locator('#holdingsPnlBreakdown .pnl-cashflow')).not_to_contain_text('1,299.35')
                    page.locator('#covered-calls-tab').click()
                    expect(page.locator('#ccMetrics')).not_to_contain_text('2,600.00')
                    page.locator('#anonymousBtn').click()
                    expect(page.locator('#ccMetrics')).to_contain_text('Premiums received')
                    expect(page.locator('#ccMetrics')).to_contain_text('$2,600.00')
                    expect(page.locator('#ccMetrics')).to_contain_text('$1,200.00')
                    expect(page.locator('#ccMetrics')).to_contain_text('$1.95')
                    expect(page.locator('#ccMetrics')).to_contain_text('$1,398.05')
                    expect(page.locator('#ccProfitMetrics')).to_contain_text('$98.70')
                    expect(page.locator('#trackerCoveredCalls')).to_have_css('opacity', '1')
                    no_overflow(page, f'{engine} {width} Option')
                    page.screenshot(path=str(output / f'{engine}-{width}-cashflow.png'), full_page=True, animations='disabled')

                    # Reload actual page against a missing-baseline response, avoiding direct UI mutation.
                    state['missing'] = True
                    page.reload(wait_until='networkidle')
                    page.locator('#today-tab').click()
                    expect(page.locator('#intradayPnlBreakdown')).to_contain_text('Combined total unavailable')
                    assert metric_values(page, '#intradayPnlBreakdown') == ['$1,000.00', 'Unavailable', 'Unavailable']
                    expect(page.locator('#intradayPnlLabel')).to_contain_text('Holdings subtotal')
                    expect(page.locator('#intradayLatestPnl')).to_contain_text('1,000.00')
                    expect(page.locator('#intradayLatestReturn')).not_to_contain_text('2.00%')
                    no_overflow(page, f'{engine} {width} missing baseline')
                    page.screenshot(path=str(output / f'{engine}-{width}-missing.png'), full_page=True, animations='disabled')
                    page.locator('#holdings-tab').click()
                    expect(page.locator('#holdingsPnlBreakdown')).to_be_visible()
                    assert metric_values(page, '#holdingsPnlBreakdown') == ['$1,000.00', 'Unavailable', 'Unavailable']
                    page.locator('#today-tab').click()
                    page.locator('#intradayDatePicker').fill(PREVIOUS)
                    page.locator('#intradayDatePicker').dispatch_event('change')
                    expect(page.locator('#intradayDatePicker')).to_have_value(PREVIOUS)
                    expect(page.locator('#intradayPnlBreakdown')).to_contain_text('Combined total unavailable')
                    assert page.evaluate("Chart.getChart('intradayChart').data.datasets[0].data.every(v=>v===null)"), 'Historical missing marks filled with current marks'
                    # Demo must replace native transport, remain synthetic and disallow ledger writes.
                    count_before = len(api_requests)
                    page.goto('https://option-day.test/demo', wait_until='networkidle')
                    page.locator('#covered-calls-tab').click()
                    expect(page.locator('#ccOpenBtn')).to_be_disabled()
                    expect(page.locator('#oqSymbol')).to_have_value('MU')
                    page.locator('#oqForm button').click()
                    expect(page.locator('#oqResults')).to_contain_text('Synthetic demo')
                    assert len(api_requests) == count_before, 'Demo accessed the normal API transport'
                    assert not errors, errors
                    assert not [req for req in api_requests if req[0] != 'GET' and req[1] != '/api/intraday/refresh'], api_requests
                    context.close()
                    print(f'PASS {engine} {width}: combined/missing P&L, Holdings reconciliation, hover/history, cash flow, privacy, Demo isolation, layout')
            finally:
                browser.close()
    print('Screenshots:', output)


if __name__ == '__main__':
    run()
