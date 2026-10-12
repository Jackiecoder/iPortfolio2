"""Public crypto market data, with explicit aliases for non-Coinbase assets."""

from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime, time as day_time, timedelta, timezone
from decimal import Decimal, InvalidOperation
import math
import re
from threading import Lock
import time
from zoneinfo import ZoneInfo

import requests
import yfinance as yf


MARKET_TZ = ZoneInfo("America/New_York")
UTC = timezone.utc


def is_crypto_symbol(symbol: str) -> bool:
    return symbol.endswith(("-USD", "-USDT", "-BTC", "-ETH"))


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _midnight(day: date) -> datetime:
    return datetime.combine(day, day_time.min, MARKET_TZ)


def _positive_price(value) -> Decimal:
    price = Decimal(str(value))
    if not price.is_finite() or price <= 0:
        raise ValueError("Market data returned an invalid price")
    return price


@dataclass(frozen=True)
class Candle:
    timestamp: int
    open: Decimal
    close: Decimal


class CryptoPriceService:
    """Fetch USD prices and paginate Coinbase candles under its 300-bar limit.

    Completed UTC pages are reused in memory; only the current page expires.
    Requests share a rate limiter across portfolio worker threads.
    """

    BASE_URL = "https://api.exchange.coinbase.com"
    MAX_CANDLES = 300
    MAX_CACHED_PAGES = 256
    GRANULARITIES = {60, 300, 900, 3600, 21600, 86400}
    # Yahoo's NIGHT-USD identifies Midnight (midnight.vip), a different asset.
    # Cardano's Midnight NIGHT launched in December 2025 and has this ticker.
    # Keep the application/ledger symbol unchanged and route every price path.
    YAHOO_PRODUCTS = {"NIGHT-USD": "NIGHT39064-USD"}

    def __init__(self, live_ttl_seconds: int = 60):
        self.live_ttl_seconds = live_ttl_seconds
        self._request_lock = Lock()
        self._last_request_at = 0.0
        self._cache_lock = Lock()
        # (symbol, granularity, page start) -> (page end, fetched at, candles)
        self._pages: OrderedDict[tuple, tuple[int, float, list[Candle]]] = OrderedDict()

    @staticmethod
    def _product(symbol: str) -> str:
        if not is_crypto_symbol(symbol) or not re.fullmatch(r"[A-Z0-9]+-[A-Z0-9]+", symbol):
            raise ValueError(f"Invalid Coinbase product: {symbol}")
        return symbol

    def _get_json(self, path: str, params=None):
        for attempt in range(3):
            with self._request_lock:
                delay = 0.2 - (time.monotonic() - self._last_request_at)
                if delay > 0:
                    time.sleep(delay)
                self._last_request_at = time.monotonic()
            response = requests.get(
                f"{self.BASE_URL}{path}",
                params=params,
                headers={"Accept": "application/json", "User-Agent": "iPortfolio2/1.0"},
                timeout=(3.05, 10),
            )
            if response.status_code == 429 or response.status_code >= 500:
                if attempt < 2:
                    time.sleep(0.5 * (2 ** attempt))
                    continue
            response.raise_for_status()
            return response.json()
        raise RuntimeError("Coinbase request failed")

    def get_current_price(self, symbol: str) -> Decimal:
        product = self._product(symbol)
        if product in self.YAHOO_PRODUCTS:
            history = yf.Ticker(self.YAHOO_PRODUCTS[product]).history(
                period="1d", interval="1m", auto_adjust=False, raise_errors=True,
            )
            if not history.empty:
                for value in reversed(history.sort_index()["Close"].tolist()):
                    try:
                        return _positive_price(value)
                    except (ValueError, TypeError, InvalidOperation):
                        continue
            raise ValueError(f"No valid Yahoo quote for {symbol}")
        return _positive_price(self._get_json(f"/products/{product}/ticker")["price"])

    def _candles(
        self, symbol: str, start: datetime, end: datetime, granularity: int
    ) -> list[Candle]:
        product = self._product(symbol)
        if granularity not in self.GRANULARITIES:
            raise ValueError(f"Unsupported Coinbase granularity: {granularity}")
        if start.tzinfo is None or end.tzinfo is None:
            raise ValueError("Candle bounds must include a timezone")

        if product in self.YAHOO_PRODUCTS:
            return self._yahoo_candles(product, start, end, granularity)

        now = _utc_now().timestamp()
        start_epoch = start.timestamp()
        end_epoch = min(end.timestamp(), now)
        if end_epoch <= start_epoch:
            return []

        span = self.MAX_CANDLES * granularity
        page_start = int(start_epoch // span) * span
        # Request complete buckets so the current candle can be returned, then
        # discard any rows outside the caller's precise [start, end) bounds.
        request_end = math.ceil(end_epoch / granularity) * granularity
        candles: dict[int, Candle] = {}
        while page_start < request_end:
            page_end = min(page_start + span, request_end)
            key = (product, granularity, page_start)
            with self._cache_lock:
                cached = self._pages.get(key)
                if cached is not None:
                    self._pages.move_to_end(key)

            reusable = cached is not None and cached[0] >= page_end and (
                cached[0] <= now - granularity
                or time.monotonic() - cached[1] < self.live_ttl_seconds
            )
            if reusable:
                rows = cached[2]
            else:
                params = {
                    "start": datetime.fromtimestamp(page_start, UTC).isoformat(),
                    "end": datetime.fromtimestamp(page_end, UTC).isoformat(),
                    "granularity": granularity,
                }
                payload = self._get_json(f"/products/{product}/candles", params)
                if not isinstance(payload, list):
                    raise ValueError("Coinbase returned an invalid candle response")
                rows = []
                for row in payload:
                    if not isinstance(row, (list, tuple)) or len(row) != 6:
                        raise ValueError("Coinbase returned an invalid candle")
                    try:
                        timestamp = int(row[0])
                        candle = Candle(timestamp, _positive_price(row[3]), _positive_price(row[4]))
                    except (ValueError, TypeError, InvalidOperation) as exc:
                        raise ValueError("Coinbase returned an invalid candle") from exc
                    # Coinbase may also return candles before the requested start.
                    if page_start <= timestamp < page_end:
                        rows.append(candle)
                with self._cache_lock:
                    self._pages[key] = (page_end, time.monotonic(), rows)
                    self._pages.move_to_end(key)
                    while len(self._pages) > self.MAX_CACHED_PAGES:
                        self._pages.popitem(last=False)

            for candle in rows:
                if start_epoch <= candle.timestamp < end_epoch:
                    candles[candle.timestamp] = candle
            page_start += span
        return [candles[timestamp] for timestamp in sorted(candles)]

    def _yahoo_candles(
        self, symbol: str, start: datetime, end: datetime, granularity: int
    ) -> list[Candle]:
        """Normalize the mapped asset's real OHLC bars; never synthesize prices.

        Yahoo minute history is limited to its rolling window. Older collected
        minutes remain available through PriceService's persistent cache.
        Missing/empty responses are never cached here, so recovery can retry.
        """
        native = {60: "1m", 300: "5m", 900: "15m", 3600: "1h",
                  21600: "1h", 86400: "1d"}
        now = _utc_now()
        start_epoch = start.timestamp()
        end_epoch = min(end.timestamp(), now.timestamp())
        if end_epoch <= start_epoch:
            return []
        fetch_start = start.astimezone(UTC)
        if granularity == 60:
            fetch_start = max(fetch_start, now - timedelta(days=7))
        elif granularity < 3600:
            fetch_start = max(fetch_start, now - timedelta(days=59))
        elif granularity < 86400:
            fetch_start = max(fetch_start, now - timedelta(days=729))
        if fetch_start.timestamp() >= end_epoch:
            return []
        history = yf.Ticker(self.YAHOO_PRODUCTS[symbol]).history(
            start=fetch_start, end=datetime.fromtimestamp(end_epoch, UTC),
            interval=native[granularity], auto_adjust=False, raise_errors=True,
        )
        candles: dict[int, Candle] = {}
        for index, row in history.sort_index(kind="stable").iterrows():
            timestamp = index.to_pydatetime()
            if timestamp.tzinfo is None:
                raise ValueError("Yahoo candle timestamps must include a timezone")
            epoch = int(timestamp.timestamp())
            if not start_epoch <= epoch < end_epoch:
                continue
            try:
                opened = _positive_price(row["Open"])
                closed = _positive_price(row["Close"])
            except (ValueError, TypeError, InvalidOperation):
                # Yahoo includes missing OHLC rows, notably at range boundaries.
                continue
            # Preserve native timestamps: rounding an off-boundary hourly row
            # could invent an exact midnight reference. Only 6h needs aggregation.
            bucket = epoch // granularity * granularity if granularity == 21600 else epoch
            if bucket < start_epoch:
                continue
            existing = candles.get(bucket)
            candles[bucket] = Candle(bucket, existing.open if existing else opened, closed)
        if not candles:
            raise ValueError(f"No valid Yahoo candles for {symbol}")
        return [candles[timestamp] for timestamp in sorted(candles)]

    def get_intraday_prices(
        self, symbol: str, interval: str, days: int, today: date
    ) -> list[dict]:
        if days < 1:
            return []
        native = {1: 60, 2: 60, 5: 300, 15: 900, 30: 900, 60: 3600, 90: 900}
        if not interval.endswith("m") or int(interval[:-1]) not in native:
            raise ValueError(f"Unsupported Crypto interval: {interval}")
        minutes = int(interval[:-1])
        start = _midnight(today - timedelta(days=days - 1))
        end = _midnight(today + timedelta(days=1))
        candles = self._candles(symbol, start, end, native[minutes])

        bars: dict[tuple[str, str], dict] = {}
        for candle in candles:
            local = datetime.fromtimestamp(candle.timestamp, MARKET_TZ)
            midnight_epoch = _midnight(local.date()).timestamp()
            bucket = midnight_epoch + ((candle.timestamp - midnight_epoch) // (minutes * 60)) * minutes * 60
            timestamp = datetime.fromtimestamp(bucket, MARKET_TZ).replace(tzinfo=None)
            # Keep the final close in each aggregate bucket. The existing DB
            # represents repeated fall-back hours by one local time per date.
            bars[(timestamp.date().isoformat(), timestamp.strftime("%H:%M"))] = {
                "time": timestamp.strftime("%H:%M"),
                "date": timestamp.date().isoformat(),
                "timestamp": timestamp.isoformat(),
                "price": candle.close,
            }
        return [bars[key] for key in sorted(bars)]

    def get_historical_prices(
        self, symbol: str, start: date, end: date
    ) -> dict[date, Decimal]:
        # Preserve the existing Crypto daily-chart convention: UTC daily close.
        candles = self._candles(
            symbol,
            datetime.combine(start, day_time.min, UTC),
            datetime.combine(end + timedelta(days=1), day_time.min, UTC),
            86400,
        )
        return {datetime.fromtimestamp(c.timestamp, UTC).date(): c.close for c in candles}

    def get_midnight_prices(
        self, symbol: str, start: date, end: date
    ) -> dict[date, Decimal]:
        candles = self._candles(
            symbol,
            _midnight(start) - timedelta(hours=1),
            _midnight(end) + timedelta(hours=1),
            3600,
        )
        by_timestamp = {c.timestamp: c for c in candles}
        prices: dict[date, Decimal] = {}
        day = start
        while day <= end:
            midnight = int(_midnight(day).timestamp())
            if midnight in by_timestamp:
                # The open is known at midnight; the hourly close is an hour
                # later and would move today's P&L baseline after the day starts.
                prices[day] = by_timestamp[midnight].open
            elif midnight - 3600 in by_timestamp:
                prices[day] = by_timestamp[midnight - 3600].close
            day += timedelta(days=1)
        return prices

    def clear_cache(self) -> None:
        with self._cache_lock:
            self._pages.clear()
