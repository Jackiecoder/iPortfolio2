"""Cache service for storing historical price data (Postgres-backed).

Public method signatures are unchanged from the previous SQLite implementation
so price_service.py and portfolio.py don't need any changes. The backing tables
(historical_prices, portfolio_values, intraday_prices) are created by schema.sql
and use native DATE / NUMERIC types instead of TEXT.
"""

import logging
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

from .db import get_pool

logger = logging.getLogger(__name__)

# Cache data older than this many days
CACHE_THRESHOLD_DAYS = 2


class CacheService:
    """Postgres-based cache for historical price data."""

    def __init__(self, db_path=None):
        # db_path kept for backwards compatibility; ignored (Postgres is used).
        # Schema is applied at app startup via app.db.init_schema().
        pass

    def _get_cache_cutoff_date(self) -> date:
        """Get the cutoff date for caching (2 days ago)."""
        return date.today() - timedelta(days=CACHE_THRESHOLD_DAYS)

    def is_cacheable_date(self, check_date: date) -> bool:
        """Check if a date is old enough to be cached."""
        return check_date < self._get_cache_cutoff_date()

    # --- Historical Price Methods ---

    def get_historical_price(self, symbol: str, price_date: date) -> Optional[Decimal]:
        """Get a cached historical price, or None if not cached."""
        if not self.is_cacheable_date(price_date):
            return None

        with get_pool().connection() as conn:
            row = conn.execute(
                "SELECT close_price FROM historical_prices WHERE symbol = %s AND date = %s",
                (symbol, price_date),
            ).fetchone()
        return row[0] if row else None

    def get_historical_prices(
        self, symbol: str, start_date: date, end_date: date
    ) -> dict[date, Decimal]:
        """Get cached historical prices for a date range (only cacheable dates)."""
        cutoff = self._get_cache_cutoff_date()
        effective_end = min(end_date, cutoff - timedelta(days=1))
        if start_date > effective_end:
            return {}

        with get_pool().connection() as conn:
            rows = conn.execute(
                """SELECT date, close_price FROM historical_prices
                   WHERE symbol = %s AND date >= %s AND date <= %s""",
                (symbol, start_date, effective_end),
            ).fetchall()
        return {r[0]: r[1] for r in rows}

    def save_historical_price(self, symbol: str, price_date: date, price: Decimal) -> bool:
        """Save a historical price to cache. Returns False if too recent to cache."""
        if not self.is_cacheable_date(price_date):
            return False

        with get_pool().connection() as conn:
            conn.execute(
                """INSERT INTO historical_prices (symbol, date, close_price)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (symbol, date) DO UPDATE SET close_price = EXCLUDED.close_price""",
                (symbol, price_date, price),
            )
            conn.commit()
        return True

    def save_historical_prices_batch(self, symbol: str, prices: dict[date, Decimal]) -> int:
        """Save multiple historical prices to cache. Returns number saved."""
        cutoff = self._get_cache_cutoff_date()
        cacheable = [(symbol, d, p) for d, p in prices.items() if d < cutoff]
        if not cacheable:
            return 0

        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO historical_prices (symbol, date, close_price)
                       VALUES (%s, %s, %s)
                       ON CONFLICT (symbol, date) DO UPDATE SET close_price = EXCLUDED.close_price""",
                    cacheable,
                )
            conn.commit()

        logger.info(f"Cached {len(cacheable)} historical prices for {symbol}")
        return len(cacheable)

    # --- Portfolio Value Methods ---

    def get_portfolio_value(self, value_date: date) -> Optional[dict]:
        """Get cached portfolio value for a date, or None if not cached."""
        if not self.is_cacheable_date(value_date):
            return None

        with get_pool().connection() as conn:
            row = conn.execute(
                """SELECT total_value, investment_value, cost_basis, cash_value
                   FROM portfolio_values WHERE date = %s""",
                (value_date,),
            ).fetchone()
        if row:
            return {
                "total_value": row[0],
                "investment_value": row[1],
                "cost_basis": row[2],
                "cash_value": row[3] if row[3] is not None else Decimal("0"),
            }
        return None

    def get_portfolio_values(self, start_date: date, end_date: date) -> dict[date, dict]:
        """Get cached portfolio values for a date range."""
        cutoff = self._get_cache_cutoff_date()
        effective_end = min(end_date, cutoff - timedelta(days=1))
        if start_date > effective_end:
            return {}

        with get_pool().connection() as conn:
            rows = conn.execute(
                """SELECT date, total_value, investment_value, cost_basis, cash_value
                   FROM portfolio_values WHERE date >= %s AND date <= %s""",
                (start_date, effective_end),
            ).fetchall()
        return {
            r[0]: {
                "total_value": r[1],
                "investment_value": r[2],
                "cost_basis": r[3],
                "cash_value": r[4] if r[4] is not None else Decimal("0"),
            }
            for r in rows
        }

    def save_portfolio_value(
        self,
        value_date: date,
        total_value: Decimal,
        investment_value: Decimal,
        cost_basis: Decimal,
        cash_value: Decimal = Decimal("0"),
    ) -> bool:
        """Save a portfolio value to cache. Returns False if too recent to cache."""
        if not self.is_cacheable_date(value_date):
            return False

        with get_pool().connection() as conn:
            conn.execute(
                """INSERT INTO portfolio_values
                       (date, total_value, investment_value, cost_basis, cash_value)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (date) DO UPDATE SET
                       total_value = EXCLUDED.total_value,
                       investment_value = EXCLUDED.investment_value,
                       cost_basis = EXCLUDED.cost_basis,
                       cash_value = EXCLUDED.cash_value""",
                (value_date, total_value, investment_value, cost_basis, cash_value),
            )
            conn.commit()
        return True

    def save_portfolio_values_batch(self, values: list[dict]) -> int:
        """Save multiple portfolio values to cache. Returns number saved."""
        cutoff = self._get_cache_cutoff_date()
        cacheable = [
            (
                v["date"],
                v["total_value"],
                v["investment_value"],
                v["cost_basis"],
                v.get("cash_value", Decimal("0")),
            )
            for v in values
            if v["date"] < cutoff
        ]
        if not cacheable:
            return 0

        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO portfolio_values
                           (date, total_value, investment_value, cost_basis, cash_value)
                       VALUES (%s, %s, %s, %s, %s)
                       ON CONFLICT (date) DO UPDATE SET
                           total_value = EXCLUDED.total_value,
                           investment_value = EXCLUDED.investment_value,
                           cost_basis = EXCLUDED.cost_basis,
                           cash_value = EXCLUDED.cash_value""",
                    cacheable,
                )
            conn.commit()

        logger.info(f"Cached {len(cacheable)} portfolio values")
        return len(cacheable)

    # --- Intraday Price Methods ---
    # Note: the "date" is passed/returned as an isoformat string (YYYY-MM-DD) to
    # preserve the existing contract with price_service; it is stored in a DATE
    # column, so we convert at the boundary.

    def get_intraday_prices(self, symbol: str, date_str: str, interval: str) -> list[dict]:
        """Return cached intraday bars for a symbol/date/interval, or [] if not cached."""
        with get_pool().connection() as conn:
            rows = conn.execute(
                """SELECT time, price FROM intraday_prices
                   WHERE symbol = %s AND date = %s AND interval = %s
                   ORDER BY time""",
                (symbol, date.fromisoformat(date_str), interval),
            ).fetchall()
        return [{"time": r[0], "date": date_str, "price": r[1]} for r in rows]

    def has_intraday_prices(self, symbol: str, date_str: str, interval: str) -> bool:
        """Return True if we have any cached bars for this symbol/date/interval."""
        with get_pool().connection() as conn:
            row = conn.execute(
                """SELECT 1 FROM intraday_prices
                   WHERE symbol = %s AND date = %s AND interval = %s LIMIT 1""",
                (symbol, date.fromisoformat(date_str), interval),
            ).fetchone()
        return row is not None

    def save_intraday_prices(
        self, symbol: str, date_str: str, interval: str, prices: list[dict]
    ) -> int:
        """Persist intraday bars for a completed trading day. Returns rows saved."""
        if not prices:
            return 0
        d = date.fromisoformat(date_str)
        rows = [(symbol, d, p["time"], interval, p["price"]) for p in prices]
        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO intraday_prices (symbol, date, time, interval, price)
                       VALUES (%s, %s, %s, %s, %s)
                       ON CONFLICT (symbol, date, time, interval)
                       DO UPDATE SET price = EXCLUDED.price""",
                    rows,
                )
            conn.commit()
        logger.info(f"Saved {len(rows)} intraday bars for {symbol} {date_str} [{interval}]")
        return len(rows)

    def get_intraday_cached_dates(self, symbol: str, interval: str) -> list[str]:
        """Return sorted list of dates (isoformat) with cached intraday data."""
        with get_pool().connection() as conn:
            rows = conn.execute(
                """SELECT DISTINCT date FROM intraday_prices
                   WHERE symbol = %s AND interval = %s
                   ORDER BY date""",
                (symbol, interval),
            ).fetchall()
        return [r[0].isoformat() for r in rows]

    # --- Utility Methods ---

    def clear_cache(self) -> None:
        """Clear cached historical prices and portfolio values."""
        with get_pool().connection() as conn:
            conn.execute("DELETE FROM historical_prices")
            conn.execute("DELETE FROM portfolio_values")
            conn.commit()
        logger.info("Cache cleared")

    def get_cache_stats(self) -> dict:
        """Get cache statistics."""
        with get_pool().connection() as conn:
            price_count = conn.execute("SELECT COUNT(*) FROM historical_prices").fetchone()[0]
            symbol_count = conn.execute(
                "SELECT COUNT(DISTINCT symbol) FROM historical_prices"
            ).fetchone()[0]
            value_count = conn.execute("SELECT COUNT(*) FROM portfolio_values").fetchone()[0]
            price_range = conn.execute(
                "SELECT MIN(date), MAX(date) FROM historical_prices"
            ).fetchone()
            value_range = conn.execute(
                "SELECT MIN(date), MAX(date) FROM portfolio_values"
            ).fetchone()
            size_bytes = conn.execute(
                """SELECT pg_total_relation_size('historical_prices')
                        + pg_total_relation_size('portfolio_values')
                        + pg_total_relation_size('intraday_prices')"""
            ).fetchone()[0]

        return {
            "historical_prices_count": price_count,
            "symbols_cached": symbol_count,
            "portfolio_values_count": value_count,
            "price_date_range": [
                d.isoformat() if d else None for d in price_range
            ],
            "value_date_range": [
                d.isoformat() if d else None for d in value_range
            ],
            "db_size_bytes": size_bytes,
        }


# Global cache service instance
cache_service = CacheService()
