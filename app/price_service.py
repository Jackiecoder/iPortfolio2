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
            # Use history method for reliable price fetching
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

        # Fetch uncached symbols using yf.download for batch efficiency
        try:
            data = yf.download(
                uncached_symbols,
                period="5d",
                progress=False,
                group_by="ticker" if len(uncached_symbols) > 1 else None
            )

            for symbol in uncached_symbols:
                try:
                    if len(uncached_symbols) == 1:
                        # Single symbol - data is not grouped
                        if not data.empty:
                            price = data["Close"].iloc[-1]
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
            # Fall back to individual fetching
            for symbol in uncached_symbols:
                if symbol not in results:
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

    def clear_cache(self) -> None:
        """Clear all cached data."""
        self._price_cache.clear()
        self._history_cache.clear()


# Global price service instance
price_service = PriceService()
