"""Postgres connection pool and schema bootstrap.

The whole app talks to Postgres through this module. The connection string
comes from the ``DATABASE_URL`` environment variable so the same code runs
against a local Docker Postgres (dev) and Cloud SQL (prod) without changes.
"""

import logging
import os
from pathlib import Path
from typing import Optional

from psycopg_pool import ConnectionPool

logger = logging.getLogger(__name__)

_pool: Optional[ConnectionPool] = None


def get_dsn() -> str:
    """Return the Postgres connection string, or raise if it isn't configured."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError(
            "DATABASE_URL is not set. Point it at a Postgres instance, e.g. "
            "postgresql://dev:devpass@localhost:5433/iportfolio"
        )
    return dsn


def get_pool() -> ConnectionPool:
    """Return the process-wide connection pool, creating it on first use."""
    global _pool
    if _pool is None:
        _pool = ConnectionPool(conninfo=get_dsn(), min_size=1, max_size=5, open=True)
        logger.info("Opened Postgres connection pool")
    return _pool


def init_schema(schema_path: Optional[Path] = None) -> None:
    """Apply schema.sql (idempotent — uses CREATE ... IF NOT EXISTS)."""
    if schema_path is None:
        schema_path = Path(__file__).resolve().parent.parent / "schema.sql"
    sql = schema_path.read_text()
    with get_pool().connection() as conn:
        conn.execute(sql)
    logger.info("Schema applied from %s", schema_path)


def close_pool() -> None:
    """Close the pool (used on shutdown / in tests)."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
