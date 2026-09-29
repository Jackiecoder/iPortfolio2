"""Shared lot selection for previews, committed sales and portfolio replay.

Tax Optimizer follows Schwab's published ordering, not an estimate of a user's
tax bill. Quantities passed here are always in the same split-adjusted units.
"""

from datetime import date
from decimal import Decimal

from .models import CostBasisMethod


def is_long_term(acquired: date, disposed: date) -> bool:
    """IRS holding period is MORE than one calendar year (including leap years)."""
    try:
        anniversary = acquired.replace(year=acquired.year + 1)
    except ValueError:  # February 29
        anniversary = date(acquired.year + 1, 2, 28)
    return disposed > anniversary


def broker_key(broker):
    return (broker or "").strip().casefold()


def select_lots(lots, quantity, price, sale_date, method, allocations=()):
    """Return (lot, quantity) slices without mutating inventory; fail closed."""
    lots = [lot for lot in lots if lot.quantity > 0]
    if quantity <= 0 or not quantity.is_finite():
        raise ValueError("Sell quantity must be positive and finite")
    if allocations or method == CostBasisMethod.SPECIFIC:
        by_id = {lot.lot_id: lot for lot in lots}
        slices = []
        seen = set()
        for allocation in allocations:
            lot_id, qty = allocation.lot_id, allocation.quantity
            if lot_id in seen:
                raise ValueError("A lot can only be selected once")
            seen.add(lot_id)
            lot = by_id.get(lot_id)
            if lot is None:
                raise ValueError(f"Lot #{lot_id} is unavailable for this asset, account or sale time")
            if qty <= 0 or not qty.is_finite() or qty > lot.quantity:
                raise ValueError(f"Selected quantity exceeds available shares in lot #{lot_id}")
            slices.append((lot, qty))
        if sum((qty for _, qty in slices), Decimal(0)) != quantity:
            raise ValueError("Selected lot quantities must exactly match the sell quantity")
        return slices

    def optimizer_key(lot):
        gain = price - lot.cost_per_share
        lt = is_long_term(lot.purchase_date, sale_date)
        if gain < 0:
            group = 1 if lt else 0
        elif gain == 0:
            group = 3 if lt else 2
        else:
            group = 4 if lt else 5
        return group, gain

    # Stable sorting preserves execution order / transaction ID for ties.
    if method == CostBasisMethod.LIFO:
        lots = list(reversed(lots))
    elif method == CostBasisMethod.HIGH_COST:
        lots = sorted(lots, key=lambda lot: -lot.cost_per_share)
    elif method == CostBasisMethod.LOW_COST:
        lots = sorted(lots, key=lambda lot: lot.cost_per_share)
    elif method == CostBasisMethod.TAX_OPTIMIZER:
        lots = sorted(lots, key=optimizer_key)
    elif method != CostBasisMethod.FIFO:
        raise ValueError("Unknown cost basis method")
    remaining = quantity
    slices = []
    for lot in lots:
        qty = min(lot.quantity, remaining)
        if qty > 0:
            slices.append((lot, qty))
            remaining -= qty
        if not remaining:
            break
    if remaining > 0:
        raise ValueError("Sell quantity exceeds available shares in this account at the sale time")
    return slices
