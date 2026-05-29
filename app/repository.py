"""Data access for transactions and targets (Postgres-backed).

This is the seam that replaces reading CSV files: ``get_all_transactions``
returns the same ``Transaction`` objects the CSV loader used to produce, so
``Portfolio`` and all calculation logic are unchanged.
"""

from typing import Optional

from .db import get_pool
from .models import ActionType, Transaction


def get_all_transactions() -> list[Transaction]:
    """Load every transaction from the DB as Transaction objects, sorted by date."""
    with get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT date, asset, action, amount, quantity, ave_price, source, comment
               FROM transactions
               ORDER BY date, id"""
        ).fetchall()

    transactions: list[Transaction] = []
    for r in rows:
        transactions.append(
            Transaction(
                date=r[0],
                asset=r[1],
                action=ActionType(r[2]),
                amount=r[3],
                quantity=r[4],
                ave_price=r[5],
                source=r[6],
                comment=r[7],
            )
        )
    return transactions


def insert_transaction(txn: Transaction, broker: Optional[str] = None) -> int:
    """Insert one transaction; returns its new id."""
    with get_pool().connection() as conn:
        row = conn.execute(
            """INSERT INTO transactions
                   (date, asset, action, amount, quantity, ave_price, source, comment, broker)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                txn.date,
                txn.asset,
                txn.action.value,
                txn.amount,
                txn.quantity,
                txn.ave_price,
                txn.source,
                txn.comment,
                broker,
            ),
        ).fetchone()
        conn.commit()
    return row[0]


def insert_transactions(transactions: list[Transaction], broker: Optional[str] = None) -> int:
    """Bulk-insert transactions (used by CSV upload and the migration script)."""
    if not transactions:
        return 0
    params = [
        (
            t.date, t.asset, t.action.value, t.amount, t.quantity,
            t.ave_price, t.source, t.comment, broker,
        )
        for t in transactions
    ]
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO transactions
                       (date, asset, action, amount, quantity, ave_price, source, comment, broker)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                params,
            )
        conn.commit()
    return len(params)


def get_targets() -> dict[str, float]:
    """Return target allocation percentages keyed by symbol."""
    with get_pool().connection() as conn:
        rows = conn.execute("SELECT symbol, target_pct FROM targets").fetchall()
    return {r[0]: float(r[1]) for r in rows}


def set_target(symbol: str, target_pct: Optional[float]) -> None:
    """Set or (when pct is None/0) remove a symbol's target allocation."""
    with get_pool().connection() as conn:
        if target_pct is None or target_pct == 0:
            conn.execute("DELETE FROM targets WHERE symbol = %s", (symbol,))
        else:
            conn.execute(
                """INSERT INTO targets (symbol, target_pct) VALUES (%s, %s)
                   ON CONFLICT (symbol) DO UPDATE SET target_pct = EXCLUDED.target_pct""",
                (symbol, target_pct),
            )
        conn.commit()
