"""Price service for fetching market data using yfinance."""

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

import yfinance as yf

from .cache_service import cache_service

logger = logging.getLogger(__name__)


class PriceService:
    """Service for fetching current and historical prices."""

    def __init__(self, cache_ttl_seconds: int = 300):
        """Initialize the price service.

        Args:
            cache_ttl_seconds: How long to cache prices (default 5 minutes)
        """
        self.cache_ttl = timedelta(seconds=cache_ttl_seconds)
        self._price_cache: dict[str, tuple[Decimal, datetime]] = {}
        self._history_cache: dict[str, tuple[dict, datetime]] = {}
        self._prev_close_cache: dict[str, tuple[dict, datetime]] = {}
        self._crypto_midnight_cache: dict[str, tuple[dict, datetime]] = {}
        self._intraday_cache: dict[str, tuple[list, datetime]] = {}

    def get_current_price(self, symbol: str) -> Optional[Decimal]:
        """Get current price for a symbol.

        Args:
            symbol: Yahoo Finance ticker symbol

        Returns:
            Current price as Decimal, or None if not available
        """
        # Check cache first
        if symbol in self._price_cache:
            price, cached_at = self._price_cache[symbol]
            if datetime.now() - cached_at < self.cache_ttl:
                return price

        try:
            ticker = yf.Ticker(symbol)
            # Try intraday data first for real-time price
            hist = ticker.history(period="1d", interval="1m")
            if not hist.empty:
                price = hist["Close"].iloc[-1]
                decimal_price = Decimal(str(price))
                self._price_cache[symbol] = (decimal_price, datetime.now())
                return decimal_price

            # Fallback to daily data
            hist = ticker.history(period="5d")
            if not hist.empty:
                price = hist["Close"].iloc[-1]
                decimal_price = Decimal(str(price))
                self._price_cache[symbol] = (decimal_price, datetime.now())
                return decimal_price

            logger.warning(f"No price data available for {symbol}")
            return None

        except Exception as e:
            logger.error(f"Error fetching price for {symbol}: {e}")
            return None

    def get_prices_batch(self, symbols: list[str]) -> dict[str, Optional[Decimal]]:
        """Get current prices for multiple symbols.

        Args:
            symbols: List of Yahoo Finance ticker symbols

        Returns:
            Dictionary mapping symbols to prices (None if unavailable)
        """
        results = {}
        uncached_symbols = []

        # Check cache first
        for symbol in symbols:
            if symbol in self._price_cache:
                price, cached_at = self._price_cache[symbol]
                if datetime.now() - cached_at < self.cache_ttl:
                    results[symbol] = price
                    continue
            uncached_symbols.append(symbol)

        if not uncached_symbols:
            return results

        # Fetch uncached symbols - try intraday data first for real-time prices
        try:
            data = yf.download(
                uncached_symbols,
                period="1d",
                interval="1m",
                progress=False,
                group_by="ticker" if len(uncached_symbols) > 1 else None
            )

            for symbol in uncached_symbols:
                try:
                    if len(uncached_symbols) == 1:
                        # Single symbol - data is not grouped
                        if not data.empty:
                            price = data["Close"].dropna().iloc[-1]
                            decimal_price = Decimal(str(price))
                            self._price_cache[symbol] = (decimal_price, datetime.now())
                            results[symbol] = decimal_price
                        else:
                            results[symbol] = None
                    else:
                        # Multiple symbols - data is grouped by ticker
                        if symbol in data.columns.get_level_values(0):
                            symbol_data = data[symbol]
                            if not symbol_data.empty and not symbol_data["Close"].isna().all():
                                price = symbol_data["Close"].dropna().iloc[-1]
                                decimal_price = Decimal(str(price))
                                self._price_cache[symbol] = (decimal_price, datetime.now())
                                results[symbol] = decimal_price
                            else:
                                results[symbol] = None
                        else:
                            results[symbol] = None
                except Exception as e:
                    logger.error(f"Error processing price for {symbol}: {e}")
                    results[symbol] = None

        except Exception as e:
            logger.error(f"Error in batch price fetch: {e}")

        # Fall back to individual fetching for any missing symbols
        for symbol in uncached_symbols:
            if symbol not in results or results[symbol] is None:
                results[symbol] = self.get_current_price(symbol)

        return results

    def get_historical_prices(
        self,
        symbol: str,
        start_date: datetime,
        end_date: Optional[datetime] = None
    ) -> dict[date, Decimal]:
        """Get historical prices for a symbol.

        Args:
            symbol: Yahoo Finance ticker symbol
            start_date: Start date for historical data
            end_date: End date (defaults to today)

        Returns:
            Dictionary mapping dates to closing prices
        """
        if end_date is None:
            end_date = datetime.now()

        start_d = start_date.date() if isinstance(start_date, datetime) else start_date
        end_d = end_date.date() if isinstance(end_date, datetime) else end_date

        # Try to get cached prices first (for dates older than 7 days)
        cached_prices = cache_service.get_historical_prices(symbol, start_d, end_d)

        # Determine which dates we still need to fetch
        # We need to fetch: dates not in cache AND dates within last 7 days
        cutoff_date = cache_service._get_cache_cutoff_date()

        # If all requested dates are cached, return early
        if end_d < cutoff_date and len(cached_prices) > 0:
            # Check if we have all dates (approximately)
            cache_key = f"{symbol}_{start_d}_{end_d}"
            if cache_key in self._history_cache:
                data, cached_at = self._history_cache[cache_key]
                if datetime.now() - cached_at < self.cache_ttl:
                    return data

        # Determine the fetch range - only fetch what's needed
        if cached_prices:
            # Check if cache covers the requested start_date
            earliest_cached = min(cached_prices.keys())
            if earliest_cached <= start_d:
                # Cache has all historical data, only fetch recent dates
                fetch_start = max(start_d, cutoff_date - timedelta(days=7))
            else:
                # Cache doesn't have all data, fetch from start
                fetch_start = start_d
        else:
            fetch_start = start_d

        try:
            ticker = yf.Ticker(symbol)
            history = ticker.history(start=fetch_start, end=end_d + timedelta(days=1))

            fetched_prices = {}
            for date_idx, row in history.iterrows():
                # Convert pandas Timestamp to datetime.date
                date_key = date_idx.to_pydatetime().date()
                fetched_prices[date_key] = Decimal(str(row["Close"]))

            # Save newly fetched prices to persistent cache (only dates > 7 days old)
            if fetched_prices:
                cache_service.save_historical_prices_batch(symbol, fetched_prices)

            # Merge cached and fetched prices
            all_prices = {**cached_prices, **fetched_prices}

            # Update memory cache
            cache_key = f"{symbol}_{start_d}_{end_d}"
            self._history_cache[cache_key] = (all_prices, datetime.now())

            return all_prices

        except Exception as e:
            logger.error(f"Error fetching historical prices for {symbol}: {e}")
            # Return cached data if available, even on error
            return cached_prices if cached_prices else {}

    def _is_crypto_symbol(self, symbol: str) -> bool:
        """Return True if this symbol is a 24/7 crypto asset."""
        return any(symbol.endswith(s) for s in ('-USD', '-USDT', '-BTC', '-ETH'))

    def _get_crypto_est_midnight_price_batch(self, symbols: list[str]) -> dict[str, Optional[Decimal]]:
        """For crypto, return the price at the most recent EST midnight using 1h data."""
        import pytz
        from datetime import datetime as dt

        cache_key = str(sorted(symbols))
        if cache_key in self._crypto_midnight_cache:
            data, cached_at = self._crypto_midnight_cache[cache_key]
            if datetime.now() - cached_at < self.cache_ttl:
                return data

        est = pytz.timezone('US/Eastern')
        now_est = dt.now(est)
        # Today's midnight in EST (start of today)
        midnight_est = est.localize(dt(now_est.year, now_est.month, now_est.day, 0, 0, 0))
        midnight_utc = midnight_est.astimezone(pytz.utc)

        logger.info(f"Crypto baseline: using EST midnight = {midnight_est} (UTC: {midnight_utc})")

        results = {}
        for symbol in symbols:
            try:
                ticker = yf.Ticker(symbol)
                history = ticker.history(period="2d", interval="1h")

                if history.empty:
                    results[symbol] = None
                    continue

                # Normalise index to UTC
                if history.index.tzinfo is None:
                    history.index = history.index.tz_localize('UTC')
                else:
                    history.index = history.index.tz_convert(pytz.utc)

                # Find the last candle whose open time is <= midnight UTC
                before = history[history.index <= midnight_utc]
                if before.empty:
                    results[symbol] = Decimal(str(history['Close'].iloc[0]))
                else:
                    results[symbol] = Decimal(str(before['Close'].iloc[-1]))

                logger.info(f"Crypto EST midnight price for {symbol}: {results[symbol]}")

            except Exception as e:
                logger.error(f"Error fetching EST midnight price for {symbol}: {e}")
                results[symbol] = None

        self._crypto_midnight_cache[cache_key] = (results, datetime.now())
        return results

    def get_historical_prices_est_midnight_batch(
        self, symbols: list[str], num_days: int = 16
    ) -> dict[str, dict]:
        """Return prices at EST midnight for each of the past num_days days.

        Crypto (24/7): sampled from 1h intraday at midnight ET.
        Stocks: use daily close (market closes ~4 pm ET, well before midnight).

        Returns: {symbol: {date: Decimal}}
        """
        import pytz
        from datetime import datetime as dt, timedelta

        est = pytz.timezone('US/Eastern')
        now_est = dt.now(est)
        results: dict[str, dict] = {s: {} for s in symbols}

        crypto = [s for s in symbols if self._is_crypto_symbol(s)]
        stocks  = [s for s in symbols if not self._is_crypto_symbol(s)]

        # Crypto: 1-hour data sampled at midnight ET
        for symbol in crypto:
            try:
                ticker = yf.Ticker(symbol)
                history = ticker.history(period=f"{num_days + 3}d", interval="1h")
                if history.empty:
                    continue
                if history.index.tzinfo is None:
                    history.index = history.index.tz_localize('UTC')
                else:
                    history.index = history.index.tz_convert(pytz.utc)

                for i in range(num_days):
                    target_date = now_est.date() - timedelta(days=i)
                    midnight_utc = est.localize(
                        dt(target_date.year, target_date.month, target_date.day, 0, 0, 0)
                    ).astimezone(pytz.utc)

                    before = history[history.index <= midnight_utc]
                    if not before.empty:
                        results[symbol][target_date] = Decimal(str(before['Close'].iloc[-1]))
            except Exception as e:
                logger.error(f"Error fetching EST midnight history for {symbol}: {e}")

        # Stocks: daily close
        if stocks:
            try:
                data = yf.download(
                    stocks, period=f"{num_days + 7}d", progress=False,
                    group_by="ticker" if len(stocks) > 1 else None,
                )
                for symbol in stocks:
                    try:
                        sd = data if len(stocks) == 1 else (
                            data[symbol] if symbol in data.columns.get_level_values(0) else None
                        )
                        if sd is None or sd.empty:
                            continue
                        for ts, price in sd["Close"].dropna().items():
                            d = ts.date() if hasattr(ts, "date") else ts
                            results[symbol][d] = Decimal(str(price))
                    except Exception as e:
                        logger.error(f"Error processing daily close for {symbol}: {e}")
            except Exception as e:
                logger.error(f"Error fetching stock daily closes: {e}")

        return results

    def _get_prev_close_from_series(self, close_series, today_date) -> Optional[Decimal]:
        """Return the most recent completed trading day's close.

        When the market is open, yfinance includes today's partial bar as the
        last row, so the previous close is iloc[-2].  When the market is closed
        (e.g. overnight, weekends) today has no bar yet, so iloc[-1] is already
        the most recent completed session — use that directly.
        """
        close_series = close_series.dropna()
        if close_series.empty:
            return None

        last_date = close_series.index[-1]
        # Normalize to a plain date for comparison
        if hasattr(last_date, "date"):
            last_date = last_date.date()

        if last_date == today_date:
            # Today's bar is present → previous completed session is iloc[-2]
            if len(close_series) >= 2:
                return Decimal(str(close_series.iloc[-2]))
            return Decimal(str(close_series.iloc[-1]))
        else:
            # No bar for today yet → iloc[-1] is already yesterday's close
            return Decimal(str(close_series.iloc[-1]))

    def get_previous_close(self, symbol: str) -> Optional[Decimal]:
        """Get previous trading day's closing price for a symbol.

        Args:
            symbol: Yahoo Finance ticker symbol

        Returns:
            Previous close price as Decimal, or None if not available
        """
        try:
            from datetime import date as _date
            ticker = yf.Ticker(symbol)
            # Get last 5 days of daily data
            history = ticker.history(period="5d")

            if history.empty:
                return None

            return self._get_prev_close_from_series(history["Close"], _date.today())

        except Exception as e:
            logger.error(f"Error fetching previous close for {symbol}: {e}")
            return None

    def get_previous_close_batch(self, symbols: list[str]) -> dict[str, Optional[Decimal]]:
        """Get previous trading day's closing prices for multiple symbols.

        Crypto symbols (24/7 markets) use the price at the most recent EST
        midnight so the intraday baseline aligns with the calendar day in
        Eastern time.  Stock symbols use the last official daily close.

        Args:
            symbols: List of Yahoo Finance ticker symbols

        Returns:
            Dictionary mapping symbols to previous close prices
        """
        from datetime import date as _date
        today = _date.today()
        results = {}

        if not symbols:
            return results

        cache_key = str(sorted(symbols))
        if cache_key in self._prev_close_cache:
            data, cached_at = self._prev_close_cache[cache_key]
            if datetime.now() - cached_at < self.cache_ttl:
                return data

        crypto_symbols = [s for s in symbols if self._is_crypto_symbol(s)]
        stock_symbols  = [s for s in symbols if not self._is_crypto_symbol(s)]

        # --- Crypto: use EST midnight price ---
        if crypto_symbols:
            crypto_results = self._get_crypto_est_midnight_price_batch(crypto_symbols)
            results.update(crypto_results)

        # --- Stocks: use last daily close ---
        if stock_symbols:
            try:
                data = yf.download(
                    stock_symbols,
                    period="5d",
                    progress=False,
                    group_by="ticker" if len(stock_symbols) > 1 else None
                )

                for symbol in stock_symbols:
                    try:
                        if len(stock_symbols) == 1:
                            symbol_data = data
                        else:
                            if symbol not in data.columns.get_level_values(0):
                                results[symbol] = None
                                continue
                            symbol_data = data[symbol]

                        if symbol_data.empty:
                            results[symbol] = None
                        else:
                            results[symbol] = self._get_prev_close_from_series(
                                symbol_data["Close"], today
                            )

                    except Exception as e:
                        logger.error(f"Error processing previous close for {symbol}: {e}")
                        results[symbol] = None

            except Exception as e:
                logger.error(f"Error in batch previous close fetch for stocks: {e}")
                for symbol in stock_symbols:
                    if symbol not in results:
                        results[symbol] = self.get_previous_close(symbol)

        self._prev_close_cache[cache_key] = (results, datetime.now())
        return results

    def get_intraday_prices(
        self,
        symbol: str,
        interval: str = "5m",
        days: int = 1
    ) -> list[dict]:
        """Get intraday prices for a symbol.

        Args:
            symbol: Yahoo Finance ticker symbol
            interval: Data interval (1m, 2m, 5m, 15m, 30m, 60m, 90m)
            days: Number of days of data to return (1 = today only, 3 = last 3 days)

        Returns:
            List of {time, price} dictionaries
        """
        import pandas as pd
        from datetime import date, timedelta

        intraday_key = f"{symbol}_{interval}_{days}"
        if intraday_key in self._intraday_cache:
            data, cached_at = self._intraday_cache[intraday_key]
            if datetime.now() - cached_at < self.cache_ttl:
                return data

        try:
            ticker = yf.Ticker(symbol)
            # Get recent intraday data (fetch more days to ensure we have enough)
            fetch_period = f"{max(days + 2, 5)}d"
            history = ticker.history(period=fetch_period, interval=interval)

            logger.info(f"Intraday data for {symbol}: {len(history)} total rows")

            if history.empty:
                logger.warning(f"No intraday history for {symbol}")
                return []

            # Get the most recent trading date
            history.index = pd.to_datetime(history.index)

            # For crypto (24/7), use today's date; for stocks, use the latest date in data
            today = date.today()
            is_crypto = symbol.endswith('-USD')

            if is_crypto:
                # For crypto, filter from today back N days
                end_date = today
            else:
                # For stocks, use the most recent trading day in the data
                last_timestamp = history.index[-1].to_pydatetime()
                if last_timestamp.tzinfo is not None:
                    local_tz = datetime.now().astimezone().tzinfo
                    last_timestamp = last_timestamp.astimezone(local_tz).replace(tzinfo=None)
                end_date = last_timestamp.date()

                # For single-day intraday view (days=1), only return data if it's today
                # On weekends/holidays, stocks should show no intraday data (use prev close)
                if days == 1 and end_date != today:
                    logger.info(f"Skipping intraday data for {symbol}: last trading day {end_date} != today {today}")
                    return []

            # Calculate start date based on days parameter
            start_date = end_date - timedelta(days=days - 1)

            logger.info(f"Date range for {symbol}: {start_date} to {end_date} (crypto: {is_crypto})")

            prices = []
            for date_idx, row in history.iterrows():
                try:
                    timestamp = date_idx.to_pydatetime()
                    # Handle timezone-aware timestamps - convert to local time
                    if timestamp.tzinfo is not None:
                        local_tz = datetime.now().astimezone().tzinfo
                        timestamp = timestamp.astimezone(local_tz).replace(tzinfo=None)

                    # Only include data within the date range
                    if timestamp.date() < start_date or timestamp.date() > end_date:
                        continue

                    close_price = row["Close"]
                    if pd.notna(close_price):
                        prices.append({
                            "time": timestamp.strftime("%H:%M"),
                            "date": timestamp.strftime("%Y-%m-%d"),
                            "timestamp": timestamp.isoformat(),
                            "price": Decimal(str(close_price))
                        })
                except Exception as e:
                    logger.error(f"Error processing row for {symbol}: {e}")
                    continue

            logger.info(f"Returning {len(prices)} intraday prices for {symbol}")
            self._intraday_cache[intraday_key] = (prices, datetime.now())
            return prices

        except Exception as e:
            logger.error(f"Error fetching intraday prices for {symbol}: {e}")
            return []

    def get_intraday_prices_batch(
        self,
        symbols: list[str],
        interval: str = "5m",
        days: int = 1
    ) -> dict[str, list[dict]]:
        """Get intraday prices for multiple symbols.

        Args:
            symbols: List of Yahoo Finance ticker symbols
            interval: Data interval (1m, 2m, 5m, 15m, 30m, 60m, 90m)
            days: Number of days of data to return

        Returns:
            Dictionary mapping symbols to list of {time, price} dictionaries
        """
        results = {}

        if not symbols:
            return results

        logger.info(f"Fetching intraday data for symbols: {symbols}, days: {days}")

        # Use individual fetching for more reliable results
        for symbol in symbols:
            results[symbol] = self.get_intraday_prices(symbol, interval, days)
            logger.info(f"Got {len(results[symbol])} intraday prices for {symbol}")

        return results

    def clear_cache(self) -> None:
        """Clear all cached data."""
        self._price_cache.clear()
        self._history_cache.clear()
        self._prev_close_cache.clear()
        self._crypto_midnight_cache.clear()
        self._intraday_cache.clear()


# Global price service instance
price_service = PriceService()
