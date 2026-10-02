"""Option quote browser acceptance using synthetic data only; no personal APIs."""
import json
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, parse_qs
from jinja2 import Environment, FileSystemLoader, select_autoescape
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
def run():
    now=datetime.now(timezone.utc)
    expiry=(now+timedelta(days=30)).date().isoformat()
    later=(now+timedelta(days=60)).date().isoformat()
    call=dict(id=1,asset='MRVL',broker='Synthetic account',date=now.date().isoformat(),transaction_time='09:30:00',
        expiration=expiry,strike=280,contracts=2,remaining_contracts=1,premium=13,fees=1.30,events=[],status='OPEN',
        reserved_shares=100,net_opening_premium=2598.70,realized_option_pnl=0,comment='',adjustment_required=False,outcome_pending=False)
    q=dict(contract_symbol='MRVL-CALL-FIXTURE',strike=280,bid=10.8,ask=11.2,mid=11,last=9,last_trade_at=(now-timedelta(days=2)).isoformat(),volume=0,open_interest=159,quote_status='two_sided')
    mode={'value':'fresh'}
    errors=[]
    output=Path(os.environ.get('IPORTFOLIO_QA_OUTPUT','/tmp/option-quotes-qa'));output.mkdir(parents=True,exist_ok=True)
    env=Environment(loader=FileSystemLoader(ROOT/'templates'),autoescape=select_autoescape())
    def route_request(route):
        req=route.request;url=urlparse(req.url);path=url.path
        if path.startswith('/static/'):
            p=ROOT/path.lstrip('/')
            route.fulfill(path=str(p)) if p.is_file() else route.fulfill(status=404,body='missing');return
        if path in ('/','/demo'):
            route.fulfill(content_type='text/html',body=env.get_template('index.html').render(demo_mode=path=='/demo'));return
        if path=='/api/covered-calls':
            result=dict(calls=[call],inventory=[dict(asset='MRVL',broker='Synthetic account',shares=150,reserved_shares=100,available_shares=50,available_contracts=0)],summary=dict(open_contracts=1,net_cash_flow=2598.7,realized_option_pnl=0))
        elif path=='/api/options/calls':
            if mode['value']=='error':
                route.fulfill(status=503,content_type='application/json',body=json.dumps({'detail':'Synthetic quote outage'}));return
            params=parse_qs(url.query);symbol=params['symbol'][0];expiration=params.get('expiration',[expiry])[0]
            result=dict(symbol=symbol,expiration=expiration,expirations=[expiry,later],calls=[q,{**q,'strike':285,'bid':0,'ask':0,'mid':None,'quote_status':'unavailable'}],
                source='Synthetic quote fixture',fetched_at=now.isoformat(),cache_status=mode['value'],cache_age_seconds=0,
                delay_notice='Reference quotes; may be delayed. Bid/ask timestamp not supplied.',warning='Older snapshot; estimates paused.')
        else:
            route.fulfill(status=404,body='No external API access allowed');return
        route.fulfill(content_type='application/json',body=json.dumps(result))
    with sync_playwright() as p:
        browser=getattr(p,os.environ.get('IPORTFOLIO_QA_BROWSER','chromium')).launch(headless=True)
        context=browser.new_context(viewport={'width':1440,'height':1000},service_workers='block')
        context.route('https://quotes.test/**',route_request)
        context.add_init_script((ROOT/'static/js/demo-portfolio.js').read_text()+"""
            const quoteTestFetch=window.fetch.bind(window), quoteTestDemo=window.DemoPortfolio.create();
            window.fetch=(input,init)=> {
              const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
              return path==='/api/covered-calls'||path==='/api/options/calls'?quoteTestFetch(input,init):quoteTestDemo.fetch(input,init);
            };
        """)
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('https://quotes.test/',wait_until='networkidle')
        page.locator('#covered-calls-tab').click()
        card=page.locator('[data-cc-quote="1"]')
        expect(card).to_contain_text('$1,120.00')
        expect(card).to_contain_text('$199.35')
        expect(card).to_contain_text('Last trade:')
        expect(card).to_contain_text('Bid/ask timestamp not supplied')
        for width in [320,390,430,1440]:
            page.set_viewport_size({'width':width,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'Overflow at {width}'
            expect(page.locator('#trackerCoveredCalls')).to_have_css('opacity','1')
            page.screenshot(path=str(output/f'quotes-{width}.png'),full_page=True,animations='disabled')
        page.locator('#oqForm button').click()
        expect(page.locator('#oqResults')).to_contain_text('Synthetic quote fixture')
        expect(page.locator('#oqResults tbody tr')).to_have_count(2)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Quote table page overflow'
        page.screenshot(path=str(output/'quote-chain-mobile.png'),full_page=True,animations='disabled')
        page.locator('#oqStrike').fill('280')
        expect(page.locator('#oqResults tbody tr')).to_have_count(1)
        page.locator('#oqExpiry').select_option(later)
        expect(page.locator('#oqResults')).to_be_empty()
        page.locator('#oqForm button').click()
        expect(page.locator('#oqResults tbody tr')).to_have_count(1)
        page.locator('#anonymousBtn').click()
        expect(card).not_to_contain_text('$1,120.00')
        expect(page.locator('#oqResults')).not_to_contain_text('$280.00')
        page.locator('#anonymousBtn').click()
        mode['value']='stale';page.locator('#ccReloadBtn').click()
        expect(card).to_contain_text('Older snapshot')
        expect(card).not_to_contain_text('$199.35')
        mode['value']='error';page.locator('#ccReloadBtn').click()
        expect(card).to_contain_text('Quotes unavailable')
        expect(card).not_to_contain_text('$1,120.00')
        page.locator('#oqForm button').click()
        expect(page.locator('#oqStatus')).to_contain_text('Synthetic quote outage')
        expect(page.locator('#oqResults')).to_be_empty()
        mode['value']='fresh';page.locator('#ccReloadBtn').click()
        expect(card).to_contain_text('$199.35')
        page.goto('https://quotes.test/demo',wait_until='networkidle')
        page.locator('#covered-calls-tab').click()
        expect(page.locator('#ccOpenBtn')).to_be_disabled()
        expect(page.locator('#oqSymbol')).to_have_value('MU')
        page.locator('#oqForm button').click()
        expect(page.locator('#oqResults')).to_contain_text('Synthetic demo')
        assert not errors,errors
        browser.close()
    print('PASS: call lookup, Ask/Mid estimates, stale/error recovery, anonymous mode, Demo isolation, 320/390/430/1440 layout; screenshots:',output)

if __name__=='__main__':run()
