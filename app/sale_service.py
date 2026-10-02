"""Read-only sale previews and the same preparation used inside a DB write lock."""

from datetime import datetime
from decimal import Decimal

from .models import ActionType, CostBasisMethod, LotAllocation, MARKET_TZ, default_transaction_time
from .portfolio import LotInfo, Portfolio, _market_today
from .split_service import split_service
from .tax_lots import broker_key, is_long_term, select_lots


def sale_inventory(transactions, asset, sale_date, transaction_time=None, broker=None):
    executed_at = datetime.combine(
        sale_date, transaction_time or default_transaction_time(asset, ActionType.SELL),
        tzinfo=MARKET_TZ,
    )
    prefix = Portfolio()
    prefix.add_transactions([t for t in transactions if t.effective_executed_at <= executed_at])
    # Replay uses today's share units. The ticket must use sale-date units.
    factor = split_service.get_adjustment_factor(asset, sale_date, _market_today())
    lots = [LotInfo(l.quantity / factor, l.cost_per_share * factor, l.purchase_date,
                    l.lot_id, l.broker) for l in prefix._lots.get(asset, []) if l.quantity > 0]
    accounts = {broker_key(l.broker): l.broker for l in lots}
    account_error = None
    unassigned = broker == "__unassigned__"
    if unassigned:
        broker = None
    if not unassigned and (broker is None or not broker.strip()):
        if len(accounts) == 1:
            broker = next(iter(accounts.values()))
        elif len(accounts) > 1:
            account_error = "Choose a broker/account before selecting lots; this asset is held in multiple accounts"
    eligible = [l for l in lots if broker_key(l.broker) == broker_key(broker)]
    return eligible, broker, list(accounts.values()), account_error


def prepare_sale(transactions, txn):
    """Freeze automatic or manual selection on a new sale before insertion."""
    if any(v is None or not v.is_finite() or v <= 0 for v in (txn.quantity, txn.ave_price, txn.amount)):
        raise ValueError("Sell quantity, price and amount must be positive and finite")
    if abs(txn.amount - txn.quantity * txn.ave_price) > Decimal("0.01"):
        raise ValueError("Amount must match quantity × price (within $0.01)")
    lots, broker, _, error = sale_inventory(
        transactions, txn.asset, txn.date, txn.effective_executed_at.time(), txn.broker,
    )
    if error:
        raise ValueError(error)
    method = txn.cost_basis_method or CostBasisMethod.FIFO
    slices = select_lots(lots, txn.quantity, txn.ave_price, txn.date, method, txn.lot_allocations)
    txn.broker = broker
    txn.cost_basis_method = method
    txn.lot_allocations = [LotAllocation(lot_id=l.lot_id, quantity=q) for l, q in slices]


def preview_sale(transactions, request):
    asset = request.asset.upper().strip()
    lots, broker, accounts, error = sale_inventory(
        transactions, asset, request.date, request.transaction_time, request.broker,
    )
    result = {
        "asset": asset, "broker": broker, "accounts": accounts,
        "cost_basis_method": request.cost_basis_method,
        "valid": False, "error": error, "lots": [], "allocations": [],
        "available_quantity": float(sum((l.quantity for l in lots), Decimal(0))),
    }
    quantity, price, amount = request.quantity, request.ave_price, request.amount
    if quantity and amount and not price:
        price = amount / quantity
    elif amount and price and not quantity:
        quantity = amount / price
    if quantity and price:
        amount = quantity * price
    for lot in lots:
        result["lots"].append({
            "lot_id": lot.lot_id, "purchase_date": lot.purchase_date.isoformat(),
            "broker": lot.broker, "quantity": float(lot.quantity),
            "quantity_exact": str(lot.quantity),
            "cost_per_share": float(lot.cost_per_share),
            "cost_basis": float(lot.total_cost),
            "term": "LT" if is_long_term(lot.purchase_date, request.date) else "ST",
            "gain_per_share": float(price - lot.cost_per_share) if price else None,
        })
    if error:
        return result
    if not quantity or not price:
        result["error"] = "Enter any two of Quantity, Avg Price and Amount to preview the sale"
        return result
    if request.amount is not None and abs(request.amount - amount) > Decimal("0.01"):
        result["error"] = "Amount must match quantity × price (within $0.01)"
        return result
    try:
        slices = select_lots(lots, quantity, price, request.date,
                             request.cost_basis_method, request.lot_allocations)
    except ValueError as exc:
        result["error"] = str(exc)
        return result
    cost = Decimal(0)
    lt = Decimal(0)
    st = Decimal(0)
    for lot, qty in slices:
        cost += qty * lot.cost_per_share
        gain = qty * (price - lot.cost_per_share)
        if is_long_term(lot.purchase_date, request.date):
            lt += gain
        else:
            st += gain
        # Strings keep exact Decimal quantities on the preview -> save round trip.
        result["allocations"].append({"lot_id": lot.lot_id, "quantity": str(qty)})
    result.update({
        "valid": True, "error": None, "quantity": float(quantity),
        "proceeds": float(amount), "cost_basis": float(cost),
        "realized_pnl": float(lt + st), "lt_realized_pnl": float(lt),
        "st_realized_pnl": float(st),
        "remaining_quantity": float(sum((l.quantity for l in lots), Decimal(0)) - quantity),
        "remaining_cost_basis": float(sum((l.total_cost for l in lots), Decimal(0)) - cost),
    })
    return result


def validate_frozen_sales(transactions):
    """Backdating/deleting/importing must not invalidate a persisted lot choice."""
    if any(t.lot_allocations for t in transactions):
        replay = Portfolio()
        replay.add_transactions(transactions)
