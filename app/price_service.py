"""Price service for fetching market data using yfinance."""

import logging
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional

import yfinance as yf

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
    ) -> dict[datetime, Decimal]:
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

        cache_key = f"{symbol}_{start_date.date()}_{end_date.date()}"

        # Check cache
        if cache_key in self._history_cache:
            data, cached_at = self._history_cache[cache_key]
            if datetime.now() - cached_at < self.cache_ttl:
                return data

        try:
            ticker = yf.Ticker(symbol)
            history = ticker.history(start=start_date, end=end_date)

            prices = {}
            for date_idx, row in history.iterrows():
                # Convert pandas Timestamp to datetime.date
                date_key = date_idx.to_pydatetime().date()
                prices[date_key] = Decimal(str(row["Close"]))

            self._history_cache[cache_key] = (prices, datetime.now())
            return prices

        except Exception as e:
            logger.error(f"Error fetching historical prices for {symbol}: {e}")
            return {}

    def get_previous_close(self, symbol: str) -> Optional[Decimal]:
        """Get previous trading day's closing price for a symbol.

        Args:
            symbol: Yahoo Finance ticker symbol

        Returns:
            Previous close price as Decimal, or None if not available
        """
        try:
            ticker = yf.Ticker(symbol)
            # Get last 5 days of daily data
            history = ticker.history(period="5d")

            if history.empty or len(history) < 2:
                # If less than 2 days, return the most recent close
                if not history.empty:
                    return Decimal(str(history["Close"].iloc[-1]))
                return None

            # Return the second-to-last close (previous trading day)
            return Decimal(str(history["Close"].iloc[-2]))

        except Exception as e:
            logger.error(f"Error fetching previous close for {symbol}: {e}")
            return None

    def get_previous_close_batch(self, symbols: list[str]) -> dict[str, Optional[Decimal]]:
        """Get previous trading day's closing prices for multiple symbols.

        Args:
            symbols: List of Yahoo Finance ticker symbols

        Returns:
            Dictionary mapping symbols to previous close prices
        """
        results = {}

        if not symbols:
            return results

        try:
            # Fetch data for all symbols
            data = yf.download(
                symbols,
                period="5d",
                progress=False,
                group_by="ticker" if len(symbols) > 1 else None
            )

            for symbol in symbols:
                try:
                    if len(symbols) == 1:
                        symbol_data = data
                    else:
                        if symbol not in data.columns.get_level_values(0):
                            results[symbol] = None
                            continue
                        symbol_data = data[symbol]

                    if not symbol_data.empty and len(symbol_data) >= 2:
                        # Get second-to-last close (previous trading day)
                        close_series = symbol_data["Close"].dropna()
                        if len(close_series) >= 2:
                            results[symbol] = Decimal(str(close_series.iloc[-2]))
                        elif len(close_series) == 1:
                            results[symbol] = Decimal(str(close_series.iloc[-1]))
                        else:
                            results[symbol] = None
                    elif not symbol_data.empty:
                        results[symbol] = Decimal(str(symbol_data["Close"].dropna().iloc[-1]))
                    else:
                        results[symbol] = None

                except Exception as e:
                    logger.error(f"Error processing previous close for {symbol}: {e}")
                    results[symbol] = None

        except Exception as e:
            logger.error(f"Error in batch previous close fetch: {e}")
            # Fall back to individual fetching
            for symbol in symbols:
                if symbol not in results:
                    results[symbol] = self.get_previous_close(symbol)

        return results

    def get_intraday_prices(
        self,
        symbol: str,
        interval: str = "5m"
    ) -> list[dict]:
        """Get intraday prices for a symbol.

        Args:
            symbol: Yahoo Finance ticker symbol
            interval: Data interval (1m, 2m, 5m, 15m, 30m, 60m, 90m)

        Returns:
            List of {time, price} dictionaries for the most recent trading day
        """
        import pandas as pd
        from datetime import date

        try:
            ticker = yf.Ticker(symbol)
            # Get recent intraday data (last 5 days to ensure we get data)
            history = ticker.history(period="5d", interval=interval)

            logger.info(f"Intraday data for {symbol}: {len(history)} total rows")

            if history.empty:
                logger.warning(f"No intraday history for {symbol}")
                return []

            # Get the most recent trading date
            history.index = pd.to_datetime(history.index)
            latest_date = history.index[-1].date()
            logger.info(f"Latest trading date for {symbol}: {latest_date}")

            prices = []
            for date_idx, row in history.iterrows():
                try:
                    timestamp = date_idx.to_pydatetime()
                    # Handle timezone-aware timestamps
                    if timestamp.tzinfo is not None:
                        timestamp = timestamp.replace(tzinfo=None)

                    # Only include data from the most recent trading day
                    if timestamp.date() != latest_date:
                        continue

                    close_price = row["Close"]
                    if pd.notna(close_price):
                        prices.append({
                            "time": timestamp.strftime("%H:%M"),
                            "timestamp": timestamp.isoformat(),
                            "price": Decimal(str(close_price))
                        })
                except Exception as e:
                    logger.error(f"Error processing row for {symbol}: {e}")
                    continue

            logger.info(f"Returning {len(prices)} intraday prices for {symbol}")
            return prices

        except Exception as e:
            logger.error(f"Error fetching intraday prices for {symbol}: {e}")
            return []

    def get_intraday_prices_batch(
        self,
        symbols: list[str],
        interval: str = "5m"
    ) -> dict[str, list[dict]]:
        """Get intraday prices for multiple symbols.

        Args:
            symbols: List of Yahoo Finance ticker symbols
            interval: Data interval (1m, 2m, 5m, 15m, 30m, 60m, 90m)

        Returns:
            Dictionary mapping symbols to list of {time, price} dictionaries
        """
        results = {}

        if not symbols:
            return results

        logger.info(f"Fetching intraday data for symbols: {symbols}")

        # Use individual fetching for more reliable results
        for symbol in symbols:
            results[symbol] = self.get_intraday_prices(symbol, interval)
            logger.info(f"Got {len(results[symbol])} intraday prices for {symbol}")

        return results

    def clear_cache(self) -> None:
        """Clear all cached data."""
        self._price_cache.clear()
        self._history_cache.clear()


# Global price service instance
price_service = PriceService()
