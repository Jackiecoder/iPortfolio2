"""Covered-call ledger rules. Option cash flows are separate from stock P&L.

Only standard 100-share contracts are supported. Expiry is an explicitly
confirmed broker event, never inferred from a clock or an underlying quote.
"""
from collections import defaultdict
from datetime import date, datetime, time
from decimal import Decimal
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from .brokers import normalize_broker
from .models import ActionType, CostBasisMethod, LotAllocation, MARKET_TZ
from .portfolio import Portfolio, _market_today
from .split_service import split_service
from .tax_lots import broker_key

D = Decimal
MULTIPLIER = 100


class CallOpen(BaseModel):
    request_id: UUID
    asset: str = Field(min_length=1, max_length=20)
    broker: Optional[str] = Field(default=None, max_length=120)
    date: date
    transaction_time: time = time(9, 30)
    expiration: date
    strike: Decimal = Field(gt=0, allow_inf_nan=False)
    contracts: int = Field(gt=0, le=100000, strict=True)
    premium: Decimal = Field(ge=0, allow_inf_nan=False)
    fees: Decimal = Field(default=D(0), ge=0, allow_inf_nan=False)
    comment: str = Field(default="", max_length=1000)

    @field_validator("asset")
    @classmethod
    def symbol(cls, value):
        value = value.strip().upper()
        if not value or value == "CASH" or value.endswith("-USD"):
            raise ValueError("Covered calls require a stock or ETF holding")
        return value

    @field_validator("broker")
    @classmethod
    def account(cls, value):
        return normalize_broker(None if value == "__unassigned__" else value)

    @model_validator(mode="after")
    def dates(self):
        if self.expiration < self.date:
            raise ValueError("Expiration cannot precede the opening trade")
        if self.executed_at > datetime.now(MARKET_TZ):
            raise ValueError("Record completed trades only; execution cannot be in the future")
        return self

    @property
    def executed_at(self):
        return datetime.combine(self.date, self.transaction_time, tzinfo=MARKET_TZ)


class CallEvent(BaseModel):
    request_id: UUID
    action: Literal["CLOSE", "EXPIRE", "ASSIGN", "ROLL"]
    date: date
    transaction_time: time = time(16, 0)
    contracts: int = Field(gt=0, le=100000, strict=True)
    premium: Decimal = Field(default=D(0), ge=0, allow_inf_nan=False)
    fees: Decimal = Field(default=D(0), ge=0, allow_inf_nan=False)
    comment: str = Field(default="", max_length=1000)
    cost_basis_method: CostBasisMethod = CostBasisMethod.FIFO
    lot_allocations: list[LotAllocation] = Field(default_factory=list)
    replacement: Optional[CallOpen] = None

    @model_validator(mode="after")
    def fields(self):
        if self.action in ("EXPIRE", "ASSIGN") and self.premium != 0:
            raise ValueError("Expiry and assignment do not buy back the option; premium must be zero")
        if self.action != "ASSIGN" and self.lot_allocations:
            raise ValueError("Stock lots are only used for assignment")
        if (self.action == "ROLL") != (self.replacement is not None):
            raise ValueError("Only a roll requires a replacement call")
        if self.executed_at > datetime.now(MARKET_TZ):
            raise ValueError("Record confirmed broker events only; execution cannot be in the future")
        return self

    @property
    def executed_at(self):
        return datetime.combine(self.date, self.transaction_time, tzinfo=MARKET_TZ)


def opening(call):
    return CallOpen.model_validate(call["opening"])


def event_time(event):
    return datetime.combine(date.fromisoformat(event["date"]),
                            time.fromisoformat(event["transaction_time"]), tzinfo=MARKET_TZ)


def remaining(call):
    return int(call["opening"]["contracts"]) - sum(e["contracts"] for e in call["events"])


def validate_event(call, event):
    op = opening(call)
    if split_service.get_adjustment_factor(op.asset, op.date, event.date) != 1:
        raise ValueError("A corporate action adjusted this contract. Confirm the adjusted contract details; "
                         "only standard 100-share contracts are supported")
    last_time = max([op.executed_at, *[event_time(e) for e in call["events"]]])
    if event.executed_at <= last_time:
        raise ValueError("Event time must be after the opening trade and the last recorded event")
    if event.contracts > remaining(call):
        raise ValueError("Event quantity exceeds the remaining open contracts")
    if event.action == "EXPIRE" and event.executed_at < datetime.combine(op.expiration, time(16), tzinfo=MARKET_TZ):
        raise ValueError("Only confirm expiry after expiration market close and broker confirmation")
    if event.action in ("CLOSE", "ROLL") and event.date > op.expiration:
        raise ValueError("An expired contract cannot be bought back or rolled; record its broker outcome")
    if event.replacement:
        new = event.replacement
        if new.asset != op.asset or broker_key(new.broker) != broker_key(op.broker):
            raise ValueError("A roll must use the same underlying and broker/account")
        if new.executed_at != event.executed_at or new.contracts != event.contracts:
            raise ValueError("Replacement time and contracts must match the rolled contracts")
        if (new.expiration, new.strike) == (op.expiration, op.strike):
            raise ValueError("A roll must change the expiration or strike")


def replay_coverage(transactions, calls, as_of=None):
    """Check coverage at every historical event, including later backdated sales.

    Run inside the shared ledger write lock for mutations. Stock replay retains
    the existing authoritative lot allocations and account scoping.
    """
    if not calls and as_of is None:
        return None, {}
    timeline = []
    for txn in transactions:
        priority = 0 if txn.action in (ActionType.BUY, ActionType.GIFT) else 3
        timeline.append((txn.effective_executed_at, priority, txn.id or 0, "stock", txn))
    for call in calls:
        op = opening(call)
        timeline.append((op.executed_at, 2, call["id"], "open", call))
        for event in call["events"]:
            timeline.append((event_time(event), 1, call["id"], "release", (call, event)))
    timeline.sort(key=lambda row: row[:3])
    portfolio = Portfolio()
    reserved = defaultdict(lambda: D(0))
    for at, _, _, kind, item in timeline:
        if as_of and at > as_of:
            break
        if kind == "stock":
            portfolio._process_transaction(item)
        else:
            call = item if kind == "open" else item[0]
            op = opening(call)
            factor = split_service.get_adjustment_factor(op.asset, op.date, _market_today())
            key = (op.asset, broker_key(op.broker))
            qty = op.contracts if kind == "open" else item[1]["contracts"]
            reserved[key] += D(qty * MULTIPLIER) * factor * (1 if kind == "open" else -1)
            if reserved[key] < 0:
                raise ValueError("Covered-call events release more contracts than were opened")
        for (asset, account), required in reserved.items():
            owned = sum((lot.quantity for lot in portfolio._lots.get(asset, [])
                         if broker_key(lot.broker) == account), D(0))
            if owned < required:
                raise ValueError(f"Insufficient unreserved {asset} shares in {account or 'Unassigned'} "
                                 f"on {at.strftime('%Y-%m-%d %H:%M')} ET: "
                                 f"{owned} owned, {required} required by covered calls")
    return portfolio, dict(reserved)


def inventory(transactions, calls, as_of=None):
    as_of = as_of or datetime.now(MARKET_TZ)
    portfolio, reserved = replay_coverage(transactions, calls, as_of)
    rows = {}
    for asset, lots in portfolio._lots.items():
        if asset == "CASH" or asset.endswith("-USD"):
            continue
        factor = split_service.get_adjustment_factor(asset, as_of.date(), _market_today())
        for lot in lots:
            if lot.quantity <= 0:
                continue
            key = (asset, broker_key(lot.broker))
            row = rows.setdefault(key, {"asset": asset, "broker": lot.broker, "shares": D(0)})
            row["shares"] += lot.quantity / factor
    for key, row in rows.items():
        factor = split_service.get_adjustment_factor(row["asset"], as_of.date(), _market_today())
        row["reserved_shares"] = reserved.get(key, D(0)) / factor
        row["available_shares"] = row["shares"] - row["reserved_shares"]
        row["available_contracts"] = int(row["available_shares"] // MULTIPLIER)
    return [{k: float(v) if isinstance(v, Decimal) else v for k, v in row.items()}
            for _, row in sorted(rows.items())]


def summarize(call):
    op = opening(call)
    left = remaining(call)
    gross = op.premium * op.contracts * MULTIPLIER
    cash = gross - op.fees
    realized = D(0)
    events = []
    for e in call["events"]:
        paid = D(e["premium"]) * e["contracts"] * MULTIPLIER if e["action"] in ("CLOSE", "ROLL") else D(0)
        fees = D(e["fees"])
        cash -= paid + fees
        # Allocate opening fees proportionally for partial closes/assignments.
        pnl = op.premium * e["contracts"] * MULTIPLIER - op.fees * D(e["contracts"]) / op.contracts - paid - fees
        realized += pnl
        events.append({**e, "option_pnl": float(pnl), "cash_flow": float(-paid - fees)})
    actions = {e["action"] for e in events}
    status = "OPEN" if left else (next(iter(actions)) if len(actions) == 1 else "COMPLETED")
    adjusted = split_service.get_adjustment_factor(op.asset, op.date, _market_today()) != 1
    return {
        "id": call["id"], **op.model_dump(mode="json"), "events": events,
        "remaining_contracts": left, "reserved_shares": left * MULTIPLIER,
        "status": status, "outcome_pending": bool(left and op.expiration < _market_today()),
        "adjustment_required": bool(left and adjusted),
        "gross_premium": float(gross), "net_opening_premium": float(gross - op.fees),
        "net_cash_flow": float(cash), "realized_option_pnl": float(realized),
        "unrealized_option_pnl": None,
    }
