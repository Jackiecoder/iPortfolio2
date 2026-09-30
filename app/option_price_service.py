"""Read-only standard call quotes. Never infer fills or expiry from market data."""
from collections import OrderedDict
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import logging
import math
import re
import threading
from zoneinfo import ZoneInfo

import yfinance as yf

logger = logging.getLogger(__name__)
MARKET_TZ = ZoneInfo('America/New_York')


class OptionQuoteUnavailable(Exception):
    pass


class OptionExpiryUnavailable(ValueError):
    pass


def number(value, positive=False):
    try:
        result = float(value)
        return result if math.isfinite(result) and (result > 0 if positive else result >= 0) else None
    except (ValueError, TypeError):
        return None


def trade_time(value):
    try:
        value = value.to_pydatetime() if hasattr(value, 'to_pydatetime') else value
        if not isinstance(value, datetime) or value.tzinfo is None:
            return None
        return value.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError):
        return None


def normalize_call(row, symbol, expiration):
    """Reject adjusted roots, wrong expiries, puts and mismatched strikes."""
    contract = str(row.get('contractSymbol', ''))
    match = re.fullmatch(r'([A-Z.\-]+)(\d{6})C(\d{8})', contract)
    if not match or row.get('contractSize') != 'REGULAR':
        return None
    clean_root = lambda s: s.replace('.', '').replace('-', '')
    if clean_root(match[1]) != clean_root(symbol) or match[2] != date.fromisoformat(expiration).strftime('%y%m%d'):
        return None
    try:
        strike = Decimal(str(row.get('strike')))
        if not strike.is_finite() or strike <= 0 or strike != Decimal(match[3]) / 1000:
            return None
    except InvalidOperation:
        return None
    bid, ask = number(row.get('bid'), positive=True), number(row.get('ask'), positive=True)
    crossed = bid is not None and ask is not None and bid > ask
    mid = round((bid + ask) / 2, 6) if bid is not None and ask is not None and not crossed else None
    return {'contract_symbol': contract, 'strike': float(strike), 'bid': bid, 'ask': ask,
            'mid': mid, 'last': number(row.get('lastPrice'), positive=True),
            'last_trade_at': trade_time(row.get('lastTradeDate')), 'quote_at': None,
            'volume': number(row.get('volume')), 'open_interest': number(row.get('openInterest')),
            'quote_status': 'crossed' if crossed else 'two_sided' if mid is not None else 'one_sided' if bid or ask else 'unavailable'}


class OptionPriceService:
    def __init__(self, loader=None, clock=None):
        self.loader = loader or self._download
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.cache = OrderedDict()
        self.failures = OrderedDict()
        self.inflight = set()
        self.lock = threading.Lock()

    def _download(self, symbol, expiration):
        ticker = yf.Ticker(symbol)
        # The public yfinance API manages Yahoo's ordinary cookie/crumb flow.
        expirations = ticker.options
        if not expirations:
            raise OptionQuoteUnavailable('No listed call expirations returned by Yahoo Finance.')
        selected = expiration or expirations[0]
        if selected not in expirations:
            raise OptionExpiryUnavailable('This expiration is not available from Yahoo Finance. Choose a listed date.')
        chain = ticker.option_chain(selected)
        if chain.calls is None or chain.calls.empty:
            raise OptionQuoteUnavailable('No call quotes returned for this expiration.')
        return selected, list(expirations), chain.calls.to_dict('records')

    def get_chain(self, symbol, expiration=None):
        symbol = symbol.strip().upper()
        if not re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,14}', symbol) or symbol == 'CASH' or symbol.endswith('-USD'):
            raise ValueError('Enter a stock or ETF ticker.')
        now = self.clock()
        if expiration and date.fromisoformat(expiration) < now.astimezone(MARKET_TZ).date():
            raise OptionExpiryUnavailable('Expired contracts do not have a current quote here.')
        key = (symbol, expiration)
        with self.lock:
            cached = self.cache.get(key)
            if cached and date.fromisoformat(cached[1]["expiration"]) < now.astimezone(MARKET_TZ).date():
                cached = None
            age = (now - cached[0]).total_seconds() if cached else None
            if cached and 0 <= age < 60:
                return {**cached[1], 'cache_status': 'cached', 'cache_age_seconds': int(age)}
            retry_at = self.failures.get(key)
            if key in self.inflight or len(self.inflight) >= 4 or (retry_at and (now - retry_at).total_seconds() < 30):
                return self._fallback(cached, now)
            self.inflight.add(key)
        try:
            selected, expirations, rows = self.loader(symbol, expiration)
            if date.fromisoformat(selected) < now.astimezone(MARKET_TZ).date():
                raise OptionExpiryUnavailable("Provider returned an expired contract date.")
            if expiration and selected != expiration:
                raise OptionQuoteUnavailable('Provider returned a different expiration.')
            calls = [q for row in rows if (q := normalize_call(row, symbol, selected)) is not None]
            if not calls:
                raise OptionQuoteUnavailable('No standard 100-share call contracts returned.')
            fetched = self.clock()
            result = {'symbol': symbol, 'expiration': selected, 'expirations': expirations,
                      'calls': sorted(calls, key=lambda q: q['strike']), 'source': 'Yahoo Finance',
                      'fetched_at': fetched.isoformat(), 'quote_at': None,
                      'delay_notice': 'Reference quotes; may be delayed. Bid/ask timestamps are not supplied. Last trade time is not the bid/ask time.',
                      'cache_status': 'fresh', 'cache_age_seconds': 0}
            with self.lock:
                for cache_key in {key, (symbol, selected)}:
                    self.cache[cache_key] = (fetched, result)
                    self.cache.move_to_end(cache_key)
                while len(self.cache) > 64:
                    self.cache.popitem(last=False)
                self.failures.pop(key, None)
            return result
        except OptionExpiryUnavailable:
            raise
        except Exception as exc:
            logger.warning('Call quotes unavailable for %s (%s)', symbol, type(exc).__name__)
            with self.lock:
                self.failures[key] = self.clock()
                self.failures.move_to_end(key)
                while len(self.failures) > 64:
                    self.failures.popitem(last=False)
            return self._fallback(cached, self.clock())
        finally:
            with self.lock:
                self.inflight.discard(key)

    @staticmethod
    def _fallback(cached, now):
        age = (now - cached[0]).total_seconds() if cached else None
        if cached and 0 <= age <= 900:
            return {**cached[1], 'cache_status': 'stale', 'cache_age_seconds': int(age),
                    'warning': 'Refresh unavailable. Showing an older snapshot; valuation estimates are paused.'}
        raise OptionQuoteUnavailable('Call quotes are temporarily unavailable. Try again shortly.')


option_price_service = OptionPriceService()
