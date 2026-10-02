from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

import httpx

from app.option_price_service import OptionPriceService, OptionQuoteUnavailable, OptionExpiryUnavailable, normalize_call
from app import main

NOW = datetime(2026, 9, 30, 14, 0, tzinfo=timezone.utc)
ROW = dict(contractSymbol='MRVL261030C00280000', strike=280, contractSize='REGULAR',
           bid=10.8, ask=11.2, lastPrice=10.75, lastTradeDate=NOW-timedelta(days=2), volume=0, openInterest=159)


class OptionQuoteTests(unittest.TestCase):
    def setUp(self):
        self.now = NOW
        self.fetches = []
        self.fail = False
        def loader(symbol, expiration):
            self.fetches.append((symbol, expiration))
            if self.fail: raise RuntimeError('provider failure')
            return '2026-10-30', ['2026-10-30'], [deepcopy(ROW)]
        self.service = OptionPriceService(loader=loader, clock=lambda:self.now)

    def test_valid_bid_ask_and_old_trade_timestamp_stay_distinct(self):
        q = normalize_call(ROW, 'MRVL', '2026-10-30')
        self.assertEqual(q['mid'], 11)
        self.assertEqual(q['bid'], 10.8)
        self.assertEqual(q['last'], 10.75)
        self.assertIsNone(q['quote_at'])
        self.assertEqual(q['last_trade_at'], (NOW-timedelta(days=2)).isoformat())
        self.assertEqual(q['volume'], 0)

    def test_rejects_wrong_side_root_strike_expiry_and_adjusted_deliverable(self):
        for updates in [dict(contractSymbol='MRVL261030P00280000'), dict(contractSymbol='MRVL1261030C00280000'),
                        dict(contractSymbol='MU261030C00280000'), dict(strike=281), dict(contractSize='MINI'),
                        dict(contractSymbol='MRVL261023C00280000')]:
            self.assertIsNone(normalize_call({**ROW, **updates}, 'MRVL', '2026-10-30'))

    def test_zero_missing_crossed_and_nonfinite_quotes_are_not_valuations(self):
        for bid,ask in [(0,0), (None,11), (12,11), (float('nan'),float('inf')),(-1,11)]:
            q=normalize_call({**ROW,'bid':bid,'ask':ask},'MRVL','2026-10-30')
            self.assertIsNone(q['mid'])
        self.assertEqual(normalize_call({**ROW,'bid':12},'MRVL','2026-10-30')['quote_status'],'crossed')

    def test_cache_explicit_expiry_alias_and_retrieval_timestamp(self):
        result=self.service.get_chain('mrvl')
        self.assertEqual(result['fetched_at'],NOW.isoformat())
        self.now+=timedelta(seconds=40)
        cached=self.service.get_chain('MRVL','2026-10-30')
        self.assertEqual(len(self.fetches),1)
        self.assertEqual(cached['cache_status'],'cached')
        self.assertEqual(cached['cache_age_seconds'],40)
        self.assertEqual(cached['fetched_at'],result['fetched_at'])

    def test_failed_refresh_stale_snapshot_and_failure_backoff(self):
        self.service.get_chain('MRVL','2026-10-30')
        self.now+=timedelta(seconds=61);self.fail=True
        result=self.service.get_chain('MRVL','2026-10-30')
        self.assertEqual(result['cache_status'],'stale')
        self.assertEqual(result['fetched_at'],NOW.isoformat())
        self.service.get_chain('MRVL','2026-10-30')
        self.assertEqual(len(self.fetches),2)
        self.now+=timedelta(minutes=16)
        with self.assertRaises(OptionQuoteUnavailable):self.service.get_chain('MRVL','2026-10-30')

    def test_first_failure_and_busy_limit_are_explicitly_unavailable(self):
        self.fail=True
        with self.assertRaises(OptionQuoteUnavailable):self.service.get_chain('MRVL')
        with self.assertRaises(OptionQuoteUnavailable):self.service.get_chain('MRVL')
        self.assertEqual(len(self.fetches),1)
        self.service.inflight=set(range(4))
        with self.assertRaises(OptionQuoteUnavailable):self.service.get_chain('MU')
        self.assertEqual(len(self.fetches),1)

    def test_expired_and_unsupported_symbols_do_not_contact_provider(self):
        for symbol in ['CASH','BTC-USD','http://x','^SPX','../../../secret']:
            with self.assertRaises(ValueError):self.service.get_chain(symbol)
        with self.assertRaises(OptionExpiryUnavailable):self.service.get_chain('MRVL','2026-09-29')
        self.assertEqual(self.fetches,[])

    def test_default_expiration_cache_does_not_survive_past_expiry(self):
        self.service.get_chain('MRVL')
        self.now=datetime(2026,10,31,4,0,1,tzinfo=timezone.utc)
        self.fail=True
        with self.assertRaises(OptionQuoteUnavailable):self.service.get_chain('MRVL')


class OptionQuoteAPITests(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_read_only_and_failure_boundaries(self):
        with patch.object(main,'API_TOKEN','test-only'), patch.object(main.option_price_service,'get_chain') as quotes, \
                patch.object(main.covered_call_repository,'list_calls') as ledger:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='http://test') as client:
                self.assertEqual((await client.get('/api/options/calls?symbol=MRVL')).status_code,401)
                quotes.assert_not_called()
                headers={'Authorization':'Bearer test-only'}
                quotes.return_value={'calls':[],'source':'test'}
                result=await client.get('/api/options/calls?symbol=MRVL&expiration=2026-10-30',headers=headers)
                self.assertEqual(result.status_code,200)
                quotes.assert_called_once_with('MRVL','2026-10-30')
                for query in ['symbol=../../x','symbol=MRVL&expiration=invalid']:
                    self.assertEqual((await client.get('/api/options/calls?'+query,headers=headers)).status_code,422)
                quotes.side_effect=OptionQuoteUnavailable()
                self.assertEqual((await client.get('/api/options/calls?symbol=MU',headers=headers)).status_code,503)
                quotes.side_effect=OptionExpiryUnavailable('Unlisted expiration')
                self.assertEqual((await client.get('/api/options/calls?symbol=MU',headers=headers)).status_code,400)
                ledger.assert_not_called()


if __name__=='__main__':unittest.main()
