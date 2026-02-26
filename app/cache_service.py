"""Cache service for storing historical price data using SQLite."""

import logging
import sqlite3
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Cache data older than this many days
CACHE_THRESHOLD_DAYS = 2


class CacheService:
    """SQLite-based cache for historical price data."""

    def __init__(self, db_path: Optional[Path] = None):
        """Initialize the cache service.

        Args:
            db_path: Path to SQLite database file. Defaults to data/cache.db
        """
        if db_path is None:
            db_path = Path(__file__).parent.parent / "data" / "cache.db"

        self.db_path = db_path
        self._init_db()

    def _init_db(self) -> None:
        """Initialize the database schema."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()

            # Historical daily prices table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS historical_prices (
                    symbol TEXT NOT NULL,
                    date TEXT NOT NULL,
                    close_price TEXT NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (symbol, date)
                )
            """)

            # Historical portfolio values table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS portfolio_values (
                    date TEXT NOT NULL,
                    total_value TEXT NOT NULL,
                    investment_value TEXT NOT NULL,
                    cost_basis TEXT NOT NULL,
                    cash_value TEXT DEFAULT '0',
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (date)
                )
            """)

            # Create indexes for faster queries
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_historical_prices_symbol
                ON historical_prices(symbol)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_historical_prices_date
                ON historical_prices(date)
            """)

            conn.commit()
            logger.info(f"Cache database initialized at {self.db_path}")

    def _get_cache_cutoff_date(self) -> date:
        """Get the cutoff date for caching (2 days ago)."""
        return date.today() - timedelta(days=CACHE_THRESHOLD_DAYS)

    def is_cacheable_date(self, check_date: date) -> bool:
        """Check if a date is old enough to be cached.

        Args:
            check_date: The date to check

        Returns:
            True if the date is older than CACHE_THRESHOLD_DAYS
        """
        return check_date < self._get_cache_cutoff_date()

    # --- Historical Price Methods ---

    def get_historical_price(self, symbol: str, price_date: date) -> Optional[Decimal]:
        """Get a cached historical price.

        Args:
            symbol: Stock/crypto symbol
            price_date: Date of the price

        Returns:
            Cached price as Decimal, or None if not cached
        """
        if not self.is_cacheable_date(price_date):
            return None

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT close_price FROM historical_prices WHERE symbol = ? AND date = ?",
                (symbol, price_date.isoformat())
            )
            row = cursor.fetchone()
            if row:
                return Decimal(row[0])
        return None

    def get_historical_prices(
        self,
        symbol: str,
        start_date: date,
        end_date: date
    ) -> dict[date, Decimal]:
        """Get cached historical prices for a date range.

        Args:
            symbol: Stock/crypto symbol
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            Dictionary mapping dates to prices (only cached dates)
        """
        cutoff = self._get_cache_cutoff_date()
        # Only query for dates that could be cached
        effective_end = min(end_date, cutoff - timedelta(days=1))

        if start_date > effective_end:
            return {}

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """SELECT date, close_price FROM historical_prices
                   WHERE symbol = ? AND date >= ? AND date <= ?""",
                (symbol, start_date.isoformat(), effective_end.isoformat())
            )
            return {
                date.fromisoformat(row[0]): Decimal(row[1])
                for row in cursor.fetchall()
            }

    def save_historical_price(
        self,
        symbol: str,
        price_date: date,
        price: Decimal
    ) -> bool:
        """Save a historical price to cache.

        Args:
            symbol: Stock/crypto symbol
            price_date: Date of the price
            price: Closing price

        Returns:
            True if saved, False if date is too recent to cache
        """
        if not self.is_cacheable_date(price_date):
            return False

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """INSERT OR REPLACE INTO historical_prices (symbol, date, close_price)
                   VALUES (?, ?, ?)""",
                (symbol, price_date.isoformat(), str(price))
            )
            conn.commit()
        return True

    def save_historical_prices_batch(
        self,
        symbol: str,
        prices: dict[date, Decimal]
    ) -> int:
        """Save multiple historical prices to cache.

        Args:
            symbol: Stock/crypto symbol
            prices: Dictionary mapping dates to prices

        Returns:
            Number of prices saved
        """
        cutoff = self._get_cache_cutoff_date()
        cacheable = [
            (symbol, d.isoformat(), str(p))
            for d, p in prices.items()
            if d < cutoff
        ]

        if not cacheable:
            return 0

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.executemany(
                """INSERT OR REPLACE INTO historical_prices (symbol, date, close_price)
                   VALUES (?, ?, ?)""",
                cacheable
            )
            conn.commit()

        logger.info(f"Cached {len(cacheable)} historical prices for {symbol}")
        return len(cacheable)

    # --- Portfolio Value Methods ---

    def get_portfolio_value(self, value_date: date) -> Optional[dict]:
        """Get cached portfolio value for a date.

        Args:
            value_date: Date of the portfolio value

        Returns:
            Dictionary with value data, or None if not cached
        """
        if not self.is_cacheable_date(value_date):
            return None

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """SELECT total_value, investment_value, cost_basis, cash_value
                   FROM portfolio_values WHERE date = ?""",
                (value_date.isoformat(),)
            )
            row = cursor.fetchone()
            if row:
                return {
                    "total_value": Decimal(row[0]),
                    "investment_value": Decimal(row[1]),
                    "cost_basis": Decimal(row[2]),
                    "cash_value": Decimal(row[3]) if row[3] else Decimal("0"),
                }
        return None

    def get_portfolio_values(
        self,
        start_date: date,
        end_date: date
    ) -> dict[date, dict]:
        """Get cached portfolio values for a date range.

        Args:
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            Dictionary mapping dates to value dictionaries
        """
        cutoff = self._get_cache_cutoff_date()
        effective_end = min(end_date, cutoff - timedelta(days=1))

        if start_date > effective_end:
            return {}

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """SELECT date, total_value, investment_value, cost_basis, cash_value
                   FROM portfolio_values WHERE date >= ? AND date <= ?""",
                (start_date.isoformat(), effective_end.isoformat())
            )
            return {
                date.fromisoformat(row[0]): {
                    "total_value": Decimal(row[1]),
                    "investment_value": Decimal(row[2]),
                    "cost_basis": Decimal(row[3]),
                    "cash_value": Decimal(row[4]) if row[4] else Decimal("0"),
                }
                for row in cursor.fetchall()
            }

    def save_portfolio_value(
        self,
        value_date: date,
        total_value: Decimal,
        investment_value: Decimal,
        cost_basis: Decimal,
        cash_value: Decimal = Decimal("0")
    ) -> bool:
        """Save a portfolio value to cache.

        Args:
            value_date: Date of the value
            total_value: Total portfolio value
            investment_value: Investment value (excluding cash)
            cost_basis: Cost basis
            cash_value: Cash value

        Returns:
            True if saved, False if date is too recent to cache
        """
        if not self.is_cacheable_date(value_date):
            return False

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """INSERT OR REPLACE INTO portfolio_values
                   (date, total_value, investment_value, cost_basis, cash_value)
                   VALUES (?, ?, ?, ?, ?)""",
                (value_date.isoformat(), str(total_value), str(investment_value),
                 str(cost_basis), str(cash_value))
            )
            conn.commit()
        return True

    def save_portfolio_values_batch(self, values: list[dict]) -> int:
        """Save multiple portfolio values to cache.

        Args:
            values: List of dictionaries with date, total_value, investment_value,
                   cost_basis, cash_value

        Returns:
            Number of values saved
        """
        cutoff = self._get_cache_cutoff_date()
        cacheable = [
            (
                v["date"].isoformat(),
                str(v["total_value"]),
                str(v["investment_value"]),
                str(v["cost_basis"]),
                str(v.get("cash_value", "0"))
            )
            for v in values
            if v["date"] < cutoff
        ]

        if not cacheable:
            return 0

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.executemany(
                """INSERT OR REPLACE INTO portfolio_values
                   (date, total_value, investment_value, cost_basis, cash_value)
                   VALUES (?, ?, ?, ?, ?)""",
                cacheable
            )
            conn.commit()

        logger.info(f"Cached {len(cacheable)} portfolio values")
        return len(cacheable)

    # --- Utility Methods ---

    def clear_cache(self) -> None:
        """Clear all cached data."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM historical_prices")
            cursor.execute("DELETE FROM portfolio_values")
            conn.commit()
        logger.info("Cache cleared")

    def get_cache_stats(self) -> dict:
        """Get cache statistics.

        Returns:
            Dictionary with cache statistics
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()

            cursor.execute("SELECT COUNT(*) FROM historical_prices")
            price_count = cursor.fetchone()[0]

            cursor.execute("SELECT COUNT(DISTINCT symbol) FROM historical_prices")
            symbol_count = cursor.fetchone()[0]

            cursor.execute("SELECT COUNT(*) FROM portfolio_values")
            value_count = cursor.fetchone()[0]

            # Get date range for prices
            cursor.execute("SELECT MIN(date), MAX(date) FROM historical_prices")
            price_range = cursor.fetchone()

            # Get date range for portfolio values
            cursor.execute("SELECT MIN(date), MAX(date) FROM portfolio_values")
            value_range = cursor.fetchone()

        return {
            "historical_prices_count": price_count,
            "symbols_cached": symbol_count,
            "portfolio_values_count": value_count,
            "price_date_range": price_range,
            "value_date_range": value_range,
            "db_size_bytes": self.db_path.stat().st_size if self.db_path.exists() else 0,
        }


# Global cache service instance
cache_service = CacheService()
