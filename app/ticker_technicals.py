"""Price-only SMA references, isolated from dividend-adjusted portfolio caches."""

import logging
import math
import threading
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import yfinance as yf
from psycopg.types.json import Jsonb

from .db import get_pool

logger = logging.getLogger(__name__)
MARKET_TZ = ZoneInfo("America/New_York")
CALCULATION_VERSION = "sma-close-v1"


def technical_date(symbol, now):
    """Match the date boundary of the daily candles used by this symbol."""
    return now.astimezone(timezone.utc if symbol.endswith("-USD") else MARKET_TZ).date()


def positive_price(value):
    try:
        value = float(value)
        return value if math.isfinite(value) and value > 0 else None
    except (TypeError, ValueError):
        return None


def build_daily_technicals(symbol, history, now):
    """Use full daily bars before today; never mix an unfinished bar into SMA."""
    is_crypto = symbol.endswith("-USD")
    today = technical_date(symbol, now)
    closes = {}
    if "Close" in history:
        for stamp, value in history["Close"].items():
            day = stamp.date()
            price = positive_price(value)
            if day < today and price is not None:
                closes[day] = price
    ordered = sorted(closes.items())
    values = [price for _, price in ordered]
    averages = []
    for window in (50, 200):
        average = math.fsum(values[-window:]) / window if len(values) >= window else None
        averages.append({
            "window": window,
            "value": average,
            "observations": min(len(values), window),
        })

    series = []
    for index, (day, price) in enumerate(ordered):
        if day < today - timedelta(days=186):
            continue
        series.append({
            "date": day.isoformat(),
            "close": price,
            **{f"sma{window}": math.fsum(values[index + 1 - window:index + 1]) / window
               if index + 1 >= window else None for window in (50, 200)},
        })
    return {
        "symbol": symbol,
        "history_as_of": ordered[-1][0].isoformat() if ordered else None,
        "history_count": len(ordered),
        "day_basis": "UTC calendar days" if is_crypto else "trading sessions",
        "averages": averages,
        "series": series,
        "cache_date": today.isoformat(),
        "history_fetched_at": now.isoformat(),
    }


def read_quote(minute_history, now):
    current_price = quote_time = None
    if "Close" in minute_history:
        for stamp, value in minute_history["Close"].sort_index().items():
            price = positive_price(value)
            # Missing timestamps must not be presented as a current quote.
            if price is not None and stamp.tzinfo is not None and stamp <= now:
                current_price = price
                quote_time = stamp.isoformat()
    return {"current_price": current_price, "quote_time": quote_time}


def compare_to_quote(daily, quote, now):
    """Recalculate distances without mutating the persisted daily snapshot."""
    current_price = quote["current_price"]
    averages = []
    for average in daily["averages"]:
        value = average["value"]
        difference = current_price - value if value is not None and current_price is not None else None
        averages.append({
            **average,
            "difference": difference,
            "difference_percent": difference / value * 100 if difference is not None else None,
            "position": ("above" if difference > 0 else "below" if difference < 0 else "at") if difference is not None else None,
        })
    return {**daily, **quote, "averages": averages, "fetched_at": now.isoformat()}


def build_technicals(symbol, history, minute_history, now):
    return compare_to_quote(build_daily_technicals(symbol, history, now), read_quote(minute_history, now), now)


class DailyTechnicalsStore:
    """Keep one daily snapshot per symbol/version across process restarts."""

    def get_or_create(self, symbol, cache_date, create):
        with get_pool().connection() as conn:
            with conn.transaction():
                # Serialize misses across workers/revisions. Recheck after the
                # lock so simultaneous first requests cannot duplicate a fetch.
                conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                             (f"ticker-technicals:{CALCULATION_VERSION}:{symbol}",))
                row = conn.execute(
                    """SELECT snapshot FROM ticker_technical_snapshots
                       WHERE symbol = %s AND calculation_version = %s AND cache_date = %s""",
                    (symbol, CALCULATION_VERSION, cache_date),
                ).fetchone()
                if row is not None:
                    return row[0]
                snapshot = create()
                conn.execute(
                    """INSERT INTO ticker_technical_snapshots
                           (symbol, calculation_version, cache_date, snapshot)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (symbol, calculation_version) DO UPDATE SET
                           cache_date = EXCLUDED.cache_date,
                           snapshot = EXCLUDED.snapshot,
                           created_at = now()
                       WHERE ticker_technical_snapshots.cache_date <= EXCLUDED.cache_date""",
                    (symbol, CALCULATION_VERSION, cache_date, Jsonb(snapshot)),
                )
                return snapshot


class TickerTechnicals:
    def __init__(self, store=None, clock=None):
        self._daily_cache = {}
        self._quote_cache = {}
        self._lock = threading.Lock()
        self._store = store if store is not None else DailyTechnicalsStore()
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def get(self, symbol):
        with self._lock:
            now = self._clock()
            cache_date = technical_date(symbol, now)
            ticker = None

            def market_ticker():
                nonlocal ticker
                if ticker is None:
                    ticker = yf.Ticker(symbol)
                return ticker

            def fetch_daily():
                # Explicit Close (not Adj Close): split-adjusted, without
                # dividend adjustment, comparable to the quoted price.
                history = market_ticker().history(period="2y", interval="1d", auto_adjust=False,
                                                 actions=False, timeout=15, raise_errors=True)
                snapshot = build_daily_technicals(symbol, history, now)
                if not snapshot["history_count"]:
                    raise ValueError("Daily price history is unavailable. Please try again.")
                return snapshot

            cached_daily = self._daily_cache.get(symbol)
            if cached_daily and cached_daily[0] == cache_date:
                daily = cached_daily[1]
            else:
                daily = self._store.get_or_create(symbol, cache_date, fetch_daily)
                self._daily_cache[symbol] = (cache_date, daily)

            cached_quote = self._quote_cache.get(symbol)
            if cached_quote and 0 <= (now - cached_quote[0]).total_seconds() < 60:
                quote = cached_quote[1]
            else:
                try:
                    minute_history = market_ticker().history(period="5d", interval="1m", prepost=True,
                                                            auto_adjust=False, actions=False,
                                                            timeout=15, raise_errors=True)
                    quote = read_quote(minute_history, self._clock())
                except Exception:
                    logger.warning("Latest quote unavailable for %s", symbol)
                    quote = {"current_price": None, "quote_time": None}
                self._quote_cache[symbol] = (self._clock(), quote)
            return compare_to_quote(daily, quote, self._clock())


ticker_technicals = TickerTechnicals()
