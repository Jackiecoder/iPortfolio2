"""Stock split service for fetching and applying split adjustments."""

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

import yfinance as yf

logger = logging.getLogger(__name__)


class SplitService:
    """Service for fetching and caching stock split data."""

    def __init__(self, cache_ttl_hours: int = 24):
        """Initialize the split service.

        Args:
            cache_ttl_hours: How long to cache split data (default 24 hours)
        """
        self.cache_ttl = timedelta(hours=cache_ttl_hours)
        # symbol -> (splits_dict, cached_at)
        # splits_dict: {date -> split_ratio}
        self._splits_cache: dict[str, tuple[dict[date, Decimal], datetime]] = {}

    def get_splits(self, symbol: str) -> dict[date, Decimal]:
        """Get all stock splits for a symbol.

        Args:
            symbol: Yahoo Finance ticker symbol

        Returns:
            Dictionary mapping split dates to split ratios
        """
        # Check cache first
        if symbol in self._splits_cache:
            splits, cached_at = self._splits_cache[symbol]
            if datetime.now() - cached_at < self.cache_ttl:
                return splits

        try:
            ticker = yf.Ticker(symbol)
            splits_series = ticker.splits

            splits = {}
            if not splits_series.empty:
                for split_date, ratio in splits_series.items():
                    # Convert pandas Timestamp to date
                    split_date_key = split_date.to_pydatetime().date()
                    splits[split_date_key] = Decimal(str(ratio))

            self._splits_cache[symbol] = (splits, datetime.now())
            return splits

        except Exception as e:
            logger.error(f"Error fetching splits for {symbol}: {e}")
            return {}

    def get_adjustment_factor(
        self,
        symbol: str,
        transaction_date: date,
        target_date: Optional[date] = None
    ) -> Decimal:
        """Calculate the cumulative split adjustment factor.

        Args:
            symbol: Yahoo Finance ticker symbol
            transaction_date: Date of the original transaction
            target_date: Date to adjust to (defaults to today)

        Returns:
            Cumulative split factor (e.g., 10.0 for a 10:1 split)
        """
        if target_date is None:
            target_date = date.today()

        splits = self.get_splits(symbol)
        if not splits:
            return Decimal("1")

        factor = Decimal("1")
        for split_date, ratio in splits.items():
            # Apply splits that occurred after transaction but before/on target date
            if transaction_date < split_date <= target_date:
                factor *= ratio

        return factor

    def adjust_quantity(
        self,
        symbol: str,
        quantity: Decimal,
        transaction_date: date,
        target_date: Optional[date] = None
    ) -> Decimal:
        """Adjust quantity for stock splits.

        Args:
            symbol: Yahoo Finance ticker symbol
            quantity: Original quantity
            transaction_date: Date of the original transaction
            target_date: Date to adjust to (defaults to today)

        Returns:
            Split-adjusted quantity
        """
        factor = self.get_adjustment_factor(symbol, transaction_date, target_date)
        return quantity * factor

    def adjust_price(
        self,
        symbol: str,
        price: Decimal,
        transaction_date: date,
        target_date: Optional[date] = None
    ) -> Decimal:
        """Adjust price for stock splits.

        Args:
            symbol: Yahoo Finance ticker symbol
            price: Original price per share
            transaction_date: Date of the original transaction
            target_date: Date to adjust to (defaults to today)

        Returns:
            Split-adjusted price
        """
        factor = self.get_adjustment_factor(symbol, transaction_date, target_date)
        if factor == 0:
            return price
        return price / factor

    def clear_cache(self) -> None:
        """Clear all cached data."""
        self._splits_cache.clear()

    def get_splits_for_symbols(self, symbols: list[str]) -> dict[str, dict[date, Decimal]]:
        """Get splits for multiple symbols (batch operation).

        Args:
            symbols: List of Yahoo Finance ticker symbols

        Returns:
            Dictionary mapping symbols to their splits
        """
        result = {}
        for symbol in symbols:
            result[symbol] = self.get_splits(symbol)
        return result


# Global split service instance
split_service = SplitService()
