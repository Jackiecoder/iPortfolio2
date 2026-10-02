"""Data access for portfolio records (Postgres-backed).

This is the seam that replaces reading CSV files: ``get_all_transactions``
returns the same ``Transaction`` objects the CSV loader used to produce, so
``Portfolio`` and all calculation logic are unchanged.
"""

import json
from typing import Any, Optional

from .brokers import normalize_broker
from .db import get_pool
from .models import ActionType, MARKET_TZ, Transaction


def _read_transactions(conn) -> list[Transaction]:
    rows = conn.execute(
        """SELECT date, asset, action, amount, quantity, ave_price, source, comment,
                  executed_at, id, broker, cost_basis_method, lot_allocations
           FROM transactions ORDER BY executed_at, id"""
    ).fetchall()
    return [Transaction(date=r[0], asset=r[1], action=ActionType(r[2]), amount=r[3],
                        quantity=r[4], ave_price=r[5], source=r[6], comment=r[7],
                        executed_at=r[8], id=r[9], broker=r[10], cost_basis_method=r[11],
                        lot_allocations=r[12] or []) for r in rows]


def get_all_transactions() -> list[Transaction]:
    """Load the ledger including stable acquisition IDs and frozen sale lots."""
    with get_pool().connection() as conn:
        return _read_transactions(conn)


def get_all_transactions_with_meta() -> list[dict]:
    """Load every transaction as plain dicts including id/broker/created_at.

    Used by the transactions browser UI, which needs the row id to delete a
    specific record. Unlike ``get_all_transactions`` this does not build
    ``Transaction`` objects (no validation/derivation) so it surfaces rows
    exactly as stored. Sorted newest-first.
    """
    with get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT id, date, asset, action, amount, quantity, ave_price,
                      source, comment, broker, created_at, executed_at, cost_basis_method, lot_allocations
               FROM transactions
               ORDER BY executed_at DESC, id DESC"""
        ).fetchall()

    def _num(v):
        return float(v) if v is not None else None

    return [
        {
            "id": r[0],
            "date": r[1].isoformat() if r[1] is not None else None,
            "asset": r[2],
            "action": r[3],
            "amount": _num(r[4]),
            "quantity": _num(r[5]),
            "ave_price": _num(r[6]),
            "source": r[7],
            "comment": r[8],
            "broker": r[9],
            "cost_basis_method": r[12],
            "lot_allocations": r[13] or [],
            "created_at": r[10].isoformat() if r[10] is not None else None,
            "executed_at": r[11].isoformat() if r[11] is not None else None,
            "transaction_time": (
                r[11].astimezone(MARKET_TZ).strftime("%H:%M") if r[11] is not None else None
            ),
        }
        for r in rows
    ]


def _lock_ledger(conn):
    # All writers take this lock before reading or mutating. It serializes even
    # simultaneous requests/processes and protects the entire validation+commit.
    conn.execute("LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE")


def delete_transaction(txn_id: int) -> bool:
    from .sale_service import validate_frozen_sales
    from .covered_call_repository import read_calls, validate_stock_write
    with get_pool().connection() as conn:
        _lock_ledger(conn)
        transactions = _read_transactions(conn)
        if any(e.get("stock_transaction_id") == txn_id for c in read_calls(conn) for e in c["events"]):
            raise ValueError("This sale is linked to a covered-call assignment and cannot be deleted separately")
        if any(a.lot_id == txn_id for t in transactions for a in t.lot_allocations):
            raise ValueError("This purchase is used by a saved sale. Remove the dependent sale first")
        validate_frozen_sales([t for t in transactions if t.id != txn_id])
        validate_stock_write(conn, [t for t in transactions if t.id != txn_id])
        cur = conn.execute("DELETE FROM transactions WHERE id = %s", (txn_id,))
        conn.commit()
        return cur.rowcount > 0


def _insert_row(conn, txn, broker):
    row = conn.execute(
        """INSERT INTO transactions
               (date, asset, action, amount, quantity, ave_price, source, comment, broker,
                executed_at, cost_basis_method, lot_allocations)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
           RETURNING id""",
        (txn.date, txn.asset, txn.action.value, txn.amount, txn.quantity, txn.ave_price,
         txn.source, txn.comment, broker, txn.effective_executed_at,
         txn.cost_basis_method.value if txn.cost_basis_method else None,
         json.dumps([a.model_dump(mode="json") for a in txn.lot_allocations])),
    ).fetchone()
    return row[0]


def insert_transaction(txn: Transaction, broker: Optional[str] = None) -> int:
    """Validate and insert a trade atomically, freezing the chosen sale lots."""
    from .sale_service import prepare_sale, validate_frozen_sales
    from .covered_call_repository import validate_stock_write
    with get_pool().connection() as conn:
        _lock_ledger(conn)
        transactions = _read_transactions(conn)
        txn.broker = normalize_broker(broker if broker is not None else txn.broker)
        if txn.action == ActionType.SELL:
            prepare_sale(transactions, txn)
        txn.id = _insert_row(conn, txn, txn.broker)
        validate_frozen_sales(transactions + [txn])
        validate_stock_write(conn, transactions + [txn])
        conn.commit()
    return txn.id


def insert_transactions(transactions: list[Transaction], broker: Optional[str] = None) -> int:
    """Import legacy CSV rows, without changing or invalidating saved lot choices."""
    from .sale_service import validate_frozen_sales
    from .covered_call_repository import validate_stock_write
    if not transactions:
        return 0
    with get_pool().connection() as conn:
        _lock_ledger(conn)
        existing = _read_transactions(conn)
        for txn in transactions:
            txn.broker = normalize_broker(broker if broker is not None else txn.broker)
            txn.id = _insert_row(conn, txn, txn.broker)
        validate_frozen_sales(existing + transactions)
        validate_stock_write(conn, existing + transactions)
        conn.commit()
    return len(transactions)


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


def _analysis_report_row(row: tuple, include_data: bool) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": row[0],
        "period": row[1],
        "period_label": row[2],
        "start_date": row[3].isoformat(),
        "end_date": row[4].isoformat(),
        "title": row[5],
        "verdict": row[6],
        "score": row[7],
        "created_at": row[8].isoformat(),
    }
    if include_data:
        payload = row[9]
        if isinstance(payload, str):
            payload = json.loads(payload)
        result["report_data"] = payload
    else:
        result["summary"] = row[9]
    return result


def create_analysis_report(report: dict[str, Any]) -> dict[str, Any]:
    """Persist and return one complete analysis report snapshot."""
    verdict = report["verdict"]
    with get_pool().connection() as conn:
        row = conn.execute(
            """INSERT INTO analysis_reports
                   (period, period_label, start_date, end_date, title, verdict, score, report_data)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
               RETURNING id, period, period_label, start_date, end_date, title,
                         verdict, score, created_at, report_data""",
            (
                report["period"],
                report["period_label"],
                report["start_date"],
                report["end_date"],
                report["title"],
                verdict["label"],
                verdict["score"],
                json.dumps(report),
            ),
        ).fetchone()
        conn.commit()
    return _analysis_report_row(row, include_data=True)


def list_analysis_reports(limit: int = 50) -> list[dict[str, Any]]:
    """Return newest analysis report metadata for the archive list."""
    with get_pool().connection() as conn:
        rows = conn.execute(
            """SELECT id, period, period_label, start_date, end_date, title,
                      verdict, score, created_at,
                      report_data->'verdict'->>'summary' AS summary
               FROM analysis_reports
               ORDER BY created_at DESC, id DESC
               LIMIT %s""",
            (limit,),
        ).fetchall()
    return [_analysis_report_row(row, include_data=False) for row in rows]


def get_analysis_report(report_id: int) -> Optional[dict[str, Any]]:
    """Return one archived report, including its immutable JSON payload."""
    with get_pool().connection() as conn:
        row = conn.execute(
            """SELECT id, period, period_label, start_date, end_date, title,
                      verdict, score, created_at, report_data
               FROM analysis_reports
               WHERE id = %s""",
            (report_id,),
        ).fetchone()
    return _analysis_report_row(row, include_data=True) if row else None
