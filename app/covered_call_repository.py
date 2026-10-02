"""Atomic, idempotent persistence for the covered-call lifecycle."""
import json
from decimal import Decimal

from . import repository
from .covered_calls import (inventory, opening, replay_coverage,
                            summarize, validate_event)
from .db import get_pool
from .models import Transaction
from .sale_service import prepare_sale, validate_frozen_sales


def read_calls(conn):
    return [{"id": r[0], "opening": r[1], "events": r[2]}
            for r in conn.execute("SELECT id, opening, events FROM covered_calls ORDER BY id").fetchall()]


def validate_stock_write(conn, transactions):
    """Every existing stock writer must preserve options collateral."""
    replay_coverage(transactions, read_calls(conn))


def list_calls():
    with get_pool().connection() as conn:
        # A consistent stock + option snapshot while another process commits.
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        calls = read_calls(conn)
        transactions = repository._read_transactions(conn)
        positions = inventory(transactions, calls)
    items = [summarize(c) for c in reversed(calls)]
    return {"calls": items, "inventory": positions, "summary": {
        "open_contracts": sum(c["remaining_contracts"] for c in items),
        "net_cash_flow": float(sum((Decimal(str(c["net_cash_flow"])) for c in items), Decimal(0))),
        "realized_option_pnl": float(sum((Decimal(str(c["realized_option_pnl"])) for c in items), Decimal(0))),
        "unrealized_option_pnl": None,
    }}


def preview_open(request):
    with get_pool().connection() as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        calls = read_calls(conn)
        txns = repository._read_transactions(conn)
        positions = inventory(txns, calls, request.executed_at)
        candidate = {"id": max([c["id"] for c in calls], default=0) + 1,
                     "opening": request.model_dump(mode="json"), "events": []}
        replay_coverage(txns, calls + [candidate])
    return {"valid": True, "inventory": positions, "call": summarize(candidate)}


def _insert(conn, request):
    data = request.model_dump(mode="json")
    row = conn.execute("INSERT INTO covered_calls (request_id, opening) VALUES (%s, %s::jsonb) RETURNING id",
                       (request.request_id, json.dumps(data))).fetchone()
    return {"id": row[0], "opening": data, "events": []}


def create_call(request):
    with get_pool().connection() as conn:
        repository._lock_ledger(conn)
        calls = read_calls(conn)
        for call in calls:
            if call["opening"]["request_id"] == str(request.request_id):
                if call["opening"] != request.model_dump(mode="json"):
                    raise ValueError("This request was already saved with different values; reload the ledger")
                return summarize(call)
        call = _insert(conn, request)
        replay_coverage(repository._read_transactions(conn), calls + [call])
        conn.commit()
    return summarize(call)


def record_event(call_id, request):
    with get_pool().connection() as conn:
        repository._lock_ledger(conn)
        calls = read_calls(conn)
        call = next((c for c in calls if c["id"] == call_id), None)
        if not call:
            raise ValueError("Covered call not found")
        for c in calls:
            for e in c["events"]:
                if e["request_id"] == str(request.request_id):
                    if c["id"] != call_id or e.get("request") != request.model_dump(mode="json"):
                        raise ValueError("This event was already saved with different values; reload the ledger")
                    return summarize(call)
        validate_event(call, request)
        op = opening(call)
        event = request.model_dump(mode="json", exclude={"replacement"})
        event["request"] = request.model_dump(mode="json")
        txns = repository._read_transactions(conn)
        if request.action == "ASSIGN":
            txn = Transaction(date=request.date, asset=op.asset, action="SELL",
                              quantity=request.contracts * 100, ave_price=op.strike,
                              broker=op.broker or "__unassigned__", executed_at=request.executed_at,
                              cost_basis_method=request.cost_basis_method, lot_allocations=request.lot_allocations,
                              source="Covered call assignment", comment=f"Covered call #{call_id}; option premium tracked separately")
            prepare_sale(txns, txn)
            txn.id = repository._insert_row(conn, txn, txn.broker)
            txns.append(txn)
            event["stock_transaction_id"] = txn.id
        if request.replacement:
            if any(c["opening"]["request_id"] == str(request.replacement.request_id) for c in calls):
                raise ValueError("Replacement call request has already been used")
            replacement = _insert(conn, request.replacement)
            calls.append(replacement)
            event["replacement_call_id"] = replacement["id"]
        call["events"].append(event)
        validate_frozen_sales(txns)
        replay_coverage(txns, calls)
        conn.execute("UPDATE covered_calls SET events = %s::jsonb WHERE id = %s",
                     (json.dumps(call["events"]), call_id))
        conn.commit()
    return summarize(call)


def delete_call(call_id):
    """Correct an unprocessed opening; completed events retain their audit trail."""
    with get_pool().connection() as conn:
        repository._lock_ledger(conn)
        calls = read_calls(conn)
        call = next((c for c in calls if c["id"] == call_id), None)
        if not call:
            return False
        if call["events"] or any(e.get("replacement_call_id") == call_id for c in calls for e in c["events"]):
            raise ValueError("A call with recorded lifecycle events cannot be deleted")
        conn.execute("DELETE FROM covered_calls WHERE id = %s", (call_id,))
        conn.commit()
    return True
