"""Data models for the portfolio tracker."""

from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, field_validator, model_validator


class ActionType(str, Enum):
    """Transaction action types."""
    BUY = "BUY"
    SELL = "SELL"
    DIV = "DIV"
    GIFT = "GIFT"
    FEE = "FEE"
    GAS = "GAS"
    CASH = "CASH"  # Cash balance snapshot
    FIX = "FIX"    # Fix/reconcile quantity to known value


class Transaction(BaseModel):
    """Represents a single portfolio transaction."""
    date: date
    asset: str
    action: ActionType
    amount: Optional[Decimal] = None
    quantity: Optional[Decimal] = None
    ave_price: Optional[Decimal] = None
    source: Optional[str] = None
    comment: Optional[str] = None

    @field_validator("asset")
    @classmethod
    def normalize_asset(cls, v: str) -> str:
        """Normalize asset symbol to uppercase."""
        return v.upper().strip()

    @model_validator(mode="after")
    def validate_fields(self) -> "Transaction":
        """Validate that required fields are present based on action type."""
        action = self.action
        amount = self.amount
        quantity = self.quantity
        ave_price = self.ave_price

        if action in (ActionType.BUY, ActionType.SELL):
            # Need at least 2 of: amount, quantity, ave_price
            provided = sum(1 for v in [amount, quantity, ave_price] if v is not None)
            if provided < 2:
                raise ValueError(
                    f"{action.value} requires at least 2 of: amount, quantity, ave_price"
                )
            # Calculate missing value if only 2 provided
            if provided == 2:
                if amount is None and quantity and ave_price:
                    self.amount = quantity * ave_price
                elif quantity is None and amount and ave_price:
                    self.quantity = amount / ave_price
                elif ave_price is None and amount and quantity:
                    self.ave_price = amount / quantity

        elif action == ActionType.DIV:
            if amount is None:
                raise ValueError("DIV action requires amount")

        elif action == ActionType.GIFT:
            if quantity is None:
                raise ValueError("GIFT action requires quantity")

        elif action == ActionType.FEE:
            if amount is None:
                raise ValueError("FEE action requires amount")

        elif action == ActionType.GAS:
            if quantity is None:
                raise ValueError("GAS action requires quantity")

        elif action == ActionType.CASH:
            if amount is None:
                raise ValueError("CASH action requires amount (cash balance)")

        elif action == ActionType.FIX:
            if quantity is None:
                raise ValueError("FIX action requires quantity (the correct total quantity)")

        return self


class Holding(BaseModel):
    """Represents a current position in an asset."""
    symbol: str
    quantity: Decimal
    cost_basis: Decimal
    avg_cost: Decimal
    current_price: Optional[Decimal] = None
    market_value: Optional[Decimal] = None
    unrealized_pnl: Optional[Decimal] = None
    pnl_percent: Optional[Decimal] = None
    prev_close: Optional[Decimal] = None
    daily_change_percent: Optional[Decimal] = None
    daily_change_amount: Optional[Decimal] = None
    holding_days: Optional[int] = None
    annualized_return: Optional[Decimal] = None
    weighted_annualized_return: Optional[Decimal] = None  # Per-lot cost-basis weighted CAGR

    def update_with_price(self, price: Decimal, prev_close: Optional[Decimal] = None) -> None:
        """Update holding with current market price."""
        self.current_price = price
        self.market_value = self.quantity * price
        self.unrealized_pnl = self.market_value - self.cost_basis
        if self.cost_basis > 0:
            self.pnl_percent = (self.unrealized_pnl / self.cost_basis) * 100
        else:
            # For gifts with zero cost basis
            self.pnl_percent = Decimal("100") if self.market_value > 0 else Decimal("0")

        # Daily price change
        if prev_close is not None and prev_close > 0:
            self.prev_close = prev_close
            self.daily_change_percent = ((price - prev_close) / prev_close) * 100
            self.daily_change_amount = (price - prev_close) * self.quantity


class DividendSummary(BaseModel):
    """Summary of dividends for an asset."""
    symbol: str
    total_amount: Decimal
    payment_count: int


class PortfolioSummary(BaseModel):
    """Overall portfolio summary."""
    total_cost_basis: Decimal
    total_market_value: Decimal  # includes cash
    investment_market_value: Decimal  # excludes cash
    total_unrealized_pnl: Decimal
    total_realized_pnl: Decimal
    total_pnl: Decimal  # realized + unrealized + dividends
    total_pnl_percent: Decimal  # total_pnl / all_time_cost_basis
    total_dividends: Decimal
    total_fees: Decimal
    all_time_cost_basis: Decimal  # includes sold assets
    weighted_annualized_return: Optional[Decimal] = None  # market-value weighted
    holdings: list[Holding]
    dividend_summaries: list[DividendSummary]
