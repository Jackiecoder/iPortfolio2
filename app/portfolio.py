"""Portfolio calculation logic."""

import bisect
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional

from .models import (
    ActionType,
    DividendSummary,
    Holding,
    PortfolioSummary,
    Transaction,
)
from .cache_service import cache_service
from .price_service import price_service
from .split_service import split_service

logger = logging.getLogger(__name__)


class LotInfo:
    """Represents a lot of shares purchased at a specific price."""

    def __init__(self, quantity: Decimal, cost_per_share: Decimal, purchase_date: date):
        self.quantity = quantity
        self.cost_per_share = cost_per_share
        self.purchase_date = purchase_date

    @property
    def total_cost(self) -> Decimal:
        return self.quantity * self.cost_per_share


class Portfolio:
    """Manages portfolio positions and calculations."""

    def __init__(self, adjust_splits: bool = True):
        """Initialize the portfolio.

        Args:
            adjust_splits: Whether to automatically adjust for stock splits
        """
        # Symbol -> list of lots (FIFO order)
        self._lots: dict[str, list[LotInfo]] = defaultdict(list)
        # Symbol -> list of dividend amounts
        self._dividends: dict[str, list[Decimal]] = defaultdict(list)
        # Total fees paid
        self._total_fees: Decimal = Decimal("0")
        # All transactions sorted by date
        self._transactions: list[Transaction] = []
        # Split adjustment flag
        self._adjust_splits = adjust_splits
        # Cash snapshots: date -> amount
        self._cash_snapshots: dict[date, Decimal] = {}
        # Realized sales: symbol -> list of {quantity, cost_basis, proceeds}
        self._sales: dict[str, list[dict]] = defaultdict(list)

    def add_transactions(self, transactions: list[Transaction]) -> None:
        """Add transactions to the portfolio.

        Args:
            transactions: List of transactions to process
        """
        # Sort by date
        sorted_txns = sorted(transactions, key=lambda t: t.date)

        for txn in sorted_txns:
            self._process_transaction(txn)
            self._transactions.append(txn)

    def _process_transaction(self, txn: Transaction) -> None:
        """Process a single transaction.

        All quantities are adjusted to today's split-adjusted values.
        """
        symbol = txn.asset
        today = date.today()

        # Get split adjustment factor from transaction date to today
        if self._adjust_splits and txn.action in (
            ActionType.BUY, ActionType.SELL, ActionType.GIFT, ActionType.GAS
        ):
            factor = split_service.get_adjustment_factor(symbol, txn.date, today)
        else:
            factor = Decimal("1")

        if txn.action == ActionType.BUY:
            # Adjust quantity and price for splits
            adjusted_qty = txn.quantity * factor
            adjusted_price = txn.ave_price / factor if factor != 0 else txn.ave_price

            lot = LotInfo(
                quantity=adjusted_qty,
                cost_per_share=adjusted_price,
                purchase_date=txn.date,
            )
            self._lots[symbol].append(lot)

        elif txn.action == ActionType.SELL:
            # Adjust sell quantity and price for splits
            adjusted_qty = txn.quantity * factor
            adjusted_price = txn.ave_price / factor if factor != 0 else txn.ave_price
            proceeds = adjusted_qty * adjusted_price

            # Remove shares using FIFO and track cost basis
            remaining = adjusted_qty
            total_cost_basis = Decimal("0")
            qty_sold = Decimal("0")

            while remaining > 0 and self._lots[symbol]:
                lot = self._lots[symbol][0]
                if lot.quantity <= remaining:
                    # Sell entire lot
                    total_cost_basis += lot.total_cost
                    qty_sold += lot.quantity
                    remaining -= lot.quantity
                    self._lots[symbol].pop(0)
                else:
                    # Partial lot sale
                    total_cost_basis += remaining * lot.cost_per_share
                    qty_sold += remaining
                    lot.quantity -= remaining
                    remaining = Decimal("0")

            # Record the sale
            if qty_sold > 0:
                self._sales[symbol].append({
                    "date": txn.date,
                    "quantity": qty_sold,
                    "cost_basis": total_cost_basis,
                    "proceeds": proceeds,
                })

        elif txn.action == ActionType.DIV:
            self._dividends[symbol].append(txn.amount)

        elif txn.action == ActionType.GIFT:
            # Adjust quantity for splits, cost basis is zero
            adjusted_qty = txn.quantity * factor

            lot = LotInfo(
                quantity=adjusted_qty,
                cost_per_share=Decimal("0"),
                purchase_date=txn.date,
            )
            self._lots[symbol].append(lot)

        elif txn.action == ActionType.FEE:
            self._total_fees += txn.amount

        elif txn.action == ActionType.GAS:
            # Adjust gas quantity for splits
            adjusted_qty = txn.quantity * factor

            # Deduct from position using FIFO
            remaining = adjusted_qty
            while remaining > 0 and self._lots[symbol]:
                lot = self._lots[symbol][0]
                if lot.quantity <= remaining:
                    remaining -= lot.quantity
                    self._lots[symbol].pop(0)
                else:
                    lot.quantity -= remaining
                    remaining = Decimal("0")

        elif txn.action == ActionType.CASH:
            # Cash balance snapshot
            self._cash_snapshots[txn.date] = txn.amount

        elif txn.action == ActionType.FIX:
            # Reconcile position to a known quantity
            # Adjust FIX quantity for splits
            target_qty = txn.quantity * factor

            # Calculate current quantity for this symbol
            current_qty = sum(lot.quantity for lot in self._lots[symbol])

            if target_qty > current_qty:
                # Missing shares - add them as zero-cost lot
                missing_qty = target_qty - current_qty
                lot = LotInfo(
                    quantity=missing_qty,
                    cost_per_share=Decimal("0"),
                    purchase_date=txn.date,
                )
                self._lots[symbol].append(lot)
            elif target_qty < current_qty:
                # Too many shares - remove excess using FIFO
                excess_qty = current_qty - target_qty
                remaining = excess_qty
                while remaining > 0 and self._lots[symbol]:
                    lot = self._lots[symbol][0]
                    if lot.quantity <= remaining:
                        remaining -= lot.quantity
                        self._lots[symbol].pop(0)
                    else:
                        lot.quantity -= remaining
                        remaining = Decimal("0")

    def get_holdings(self, fetch_prices: bool = True) -> list[Holding]:
        """Get current holdings.

        Args:
            fetch_prices: Whether to fetch current prices

        Returns:
            List of Holding objects
        """
        holdings = []
        symbols = []

        for symbol, lots in self._lots.items():
            if not lots:
                continue

            # Quantities are already split-adjusted at transaction time
            total_quantity = sum(lot.quantity for lot in lots)
            total_cost = sum(lot.total_cost for lot in lots)

            if total_quantity <= 0:
                continue

            avg_cost = total_cost / total_quantity if total_quantity > 0 else Decimal("0")

            holding = Holding(
                symbol=symbol,
                quantity=total_quantity,
                cost_basis=total_cost,
                avg_cost=avg_cost,
            )
            holdings.append(holding)
            symbols.append(symbol)

        if fetch_prices and symbols:
            prices = price_service.get_prices_batch(symbols)
            prev_closes = price_service.get_previous_close_batch(symbols)
            for holding in holdings:
                price = prices.get(holding.symbol)
                prev_close = prev_closes.get(holding.symbol)
                if price is not None:
                    holding.update_with_price(price, prev_close)

        # Calculate holding days and annualized return for each holding
        import math
        today = date.today()
        for holding in holdings:
            holding_days = self.get_holding_days(holding.symbol)
            holding.holding_days = holding_days

            if holding_days > 0 and holding.pnl_percent is not None:
                years = Decimal(str(holding_days)) / Decimal("365")
                # Use minimum 1 year for annualized calculation
                years_for_calc = max(years, Decimal("1"))
                holding.annualized_return = holding.pnl_percent / years_for_calc

            # Calculate per-lot cost-basis weighted CAGR
            if holding.current_price and holding.symbol in self._lots:
                lots = self._lots[holding.symbol]
                weighted_sum = Decimal("0")
                total_cost_basis_weight = Decimal("0")

                for lot in lots:
                    if lot.quantity <= 0 or lot.total_cost <= 0:
                        continue

                    lot_holding_days = (today - lot.purchase_date).days
                    lot_years = Decimal(str(max(lot_holding_days, 1))) / Decimal("365")
                    lot_years_for_calc = max(lot_years, Decimal("1"))

                    lot_current_value = lot.quantity * holding.current_price
                    growth_factor = lot_current_value / lot.total_cost

                    if growth_factor > 0:
                        cagr = (Decimal(str(math.pow(float(growth_factor), float(1 / lot_years_for_calc)))) - 1) * 100
                        weighted_sum += lot.total_cost * cagr
                        total_cost_basis_weight += lot.total_cost

                if total_cost_basis_weight > 0:
                    holding.weighted_annualized_return = weighted_sum / total_cost_basis_weight

        # Add cash as a holding if we have cash snapshots
        cash_balance = self.get_cash_balance()
        if cash_balance > 0:
            cash_holding = Holding(
                symbol="CASH",
                quantity=Decimal("1"),
                cost_basis=cash_balance,
                avg_cost=cash_balance,
                current_price=cash_balance,
                market_value=cash_balance,
                unrealized_pnl=Decimal("0"),
                pnl_percent=Decimal("0"),
            )
            holdings.append(cash_holding)

        return sorted(holdings, key=lambda h: h.symbol)

    def get_cash_balance(self, as_of_date: Optional[date] = None) -> Decimal:
        """Get cash balance as of a specific date.

        Uses the most recent snapshot on or before the given date.

        Args:
            as_of_date: Date to get cash balance for (defaults to today)

        Returns:
            Cash balance as Decimal
        """
        if not self._cash_snapshots:
            return Decimal("0")

        if as_of_date is None:
            as_of_date = date.today()

        # Find the most recent snapshot on or before as_of_date
        applicable_dates = [d for d in self._cash_snapshots.keys() if d <= as_of_date]
        if not applicable_dates:
            return Decimal("0")

        latest_date = max(applicable_dates)
        return self._cash_snapshots[latest_date]

    def get_holding_days(self, symbol: str) -> int:
        """Calculate the number of days a position has been held.

        Only counts days when quantity > 0. If position was closed and reopened,
        the gap period is not counted.

        Args:
            symbol: Asset symbol

        Returns:
            Number of holding days
        """
        # Get all transactions for this symbol sorted by date
        symbol_txns = sorted(
            [t for t in self._transactions if t.asset == symbol],
            key=lambda t: t.date
        )

        if not symbol_txns:
            return 0

        # Track periods when position was open
        holding_periods = []  # List of (start_date, end_date) tuples
        current_qty = Decimal("0")
        period_start = None

        for txn in symbol_txns:
            prev_qty = current_qty

            if txn.action == ActionType.BUY or txn.action == ActionType.GIFT:
                current_qty += txn.quantity or Decimal("0")
            elif txn.action == ActionType.SELL:
                current_qty -= txn.quantity or Decimal("0")
            elif txn.action == ActionType.GAS:
                current_qty -= txn.quantity or Decimal("0")

            # Position opened
            if prev_qty <= 0 and current_qty > 0:
                period_start = txn.date

            # Position closed
            if prev_qty > 0 and current_qty <= 0 and period_start is not None:
                holding_periods.append((period_start, txn.date))
                period_start = None

        # If still holding, add current period
        if current_qty > 0 and period_start is not None:
            holding_periods.append((period_start, date.today()))

        # Calculate total holding days
        total_days = 0
        for start, end in holding_periods:
            total_days += (end - start).days

        # Minimum 1 day if we have any holding
        return max(total_days, 1) if holding_periods else 0

    def get_dividend_summaries(self) -> list[DividendSummary]:
        """Get dividend summaries by symbol.

        Returns:
            List of DividendSummary objects
        """
        summaries = []
        for symbol, amounts in self._dividends.items():
            if amounts:
                summaries.append(
                    DividendSummary(
                        symbol=symbol,
                        total_amount=sum(amounts),
                        payment_count=len(amounts),
                    )
                )
        return sorted(summaries, key=lambda s: s.symbol)

    def get_total_dividends(self) -> Decimal:
        """Get total dividends received across all assets."""
        return sum(
            sum(amounts) for amounts in self._dividends.values()
        )

    def get_total_fees(self) -> Decimal:
        """Get total fees paid."""
        return self._total_fees

    def get_sold_assets(self) -> list[dict]:
        """Get summary of sold assets with realized P&L.

        Returns:
            List of dicts with symbol, quantity, cost_basis, proceeds, avg_sell_price, pnl, pnl_percent
        """
        sold_assets = []
        for symbol, sales in self._sales.items():
            if not sales:
                continue

            total_quantity = sum(s["quantity"] for s in sales)
            total_cost_basis = sum(s["cost_basis"] for s in sales)
            total_proceeds = sum(s["proceeds"] for s in sales)

            if total_quantity > 0:
                avg_cost = total_cost_basis / total_quantity
                avg_sell_price = total_proceeds / total_quantity
                pnl = total_proceeds - total_cost_basis
                pnl_percent = (pnl / total_cost_basis * 100) if total_cost_basis > 0 else Decimal("0")

                sold_assets.append({
                    "symbol": symbol,
                    "quantity": float(total_quantity),
                    "cost_basis": float(total_cost_basis),
                    "avg_cost": float(avg_cost),
                    "proceeds": float(total_proceeds),
                    "avg_sell_price": float(avg_sell_price),
                    "pnl": float(pnl),
                    "pnl_percent": float(pnl_percent),
                })

        return sorted(sold_assets, key=lambda s: s["symbol"])

    def get_portfolio_summary(self, fetch_prices: bool = True) -> PortfolioSummary:
        """Get complete portfolio summary.

        Args:
            fetch_prices: Whether to fetch current prices

        Returns:
            PortfolioSummary object
        """
        holdings = self.get_holdings(fetch_prices=fetch_prices)
        dividend_summaries = self.get_dividend_summaries()

        # Separate investments from cash for P&L calculations
        investments = [h for h in holdings if h.symbol != "CASH"]
        cash_holding = next((h for h in holdings if h.symbol == "CASH"), None)

        # P&L only includes investments, not cash
        investment_cost_basis = sum(h.cost_basis for h in investments)
        investment_market_value = sum(
            h.market_value for h in investments if h.market_value is not None
        )
        total_unrealized_pnl = sum(
            h.unrealized_pnl for h in investments if h.unrealized_pnl is not None
        )

        # Calculate realized P&L from sold assets
        total_realized_pnl = Decimal("0")
        sold_cost_basis = Decimal("0")
        for symbol, sales in self._sales.items():
            for sale in sales:
                total_realized_pnl += sale["proceeds"] - sale["cost_basis"]
                sold_cost_basis += sale["cost_basis"]

        # Total dividends
        total_dividends = self.get_total_dividends()

        # All-time cost basis includes current holdings and sold assets
        all_time_cost_basis = investment_cost_basis + sold_cost_basis

        # Total P&L = realized + unrealized (dividends tracked separately, already in cash records)
        total_pnl = total_realized_pnl + total_unrealized_pnl

        # Total return % based on all-time invested amount
        total_pnl_percent = Decimal("0")
        if all_time_cost_basis > 0:
            total_pnl_percent = (total_pnl / all_time_cost_basis) * 100

        # Total market value includes cash for overall portfolio value
        cash_value = cash_holding.market_value if cash_holding and cash_holding.market_value else Decimal("0")
        total_market_value = investment_market_value + cash_value

        # Calculate per-lot cost-basis weighted CAGR
        # This weights each lot's annualized return by its cost basis
        weighted_annualized_return = None
        if fetch_prices:
            import math
            today = date.today()
            weighted_sum = Decimal("0")
            total_cost_basis_weight = Decimal("0")

            # Build a price lookup from holdings
            price_lookup = {h.symbol: h.current_price for h in investments if h.current_price}

            for symbol, lots in self._lots.items():
                if symbol == "CASH":
                    continue

                current_price = price_lookup.get(symbol)
                if current_price is None:
                    continue

                for lot in lots:
                    if lot.quantity <= 0 or lot.total_cost <= 0:
                        continue

                    # Calculate holding period
                    holding_days = (today - lot.purchase_date).days
                    years = Decimal(str(max(holding_days, 1))) / Decimal("365")
                    years_for_calc = max(years, Decimal("1"))  # Minimum 1 year to avoid extrapolation

                    # Calculate lot's current value and growth factor
                    lot_current_value = lot.quantity * current_price
                    growth_factor = lot_current_value / lot.total_cost

                    # CAGR = growth_factor^(1/years) - 1, as percentage
                    if growth_factor > 0:
                        cagr = (Decimal(str(math.pow(float(growth_factor), float(1 / years_for_calc)))) - 1) * 100
                        weighted_sum += lot.total_cost * cagr
                        total_cost_basis_weight += lot.total_cost

            if total_cost_basis_weight > 0:
                weighted_annualized_return = weighted_sum / total_cost_basis_weight

        return PortfolioSummary(
            total_cost_basis=investment_cost_basis,
            total_market_value=total_market_value,
            investment_market_value=investment_market_value,
            total_unrealized_pnl=total_unrealized_pnl,
            total_realized_pnl=total_realized_pnl,
            total_pnl=total_pnl,
            total_pnl_percent=total_pnl_percent,
            total_dividends=total_dividends,
            total_fees=self._total_fees,
            all_time_cost_basis=all_time_cost_basis,
            weighted_annualized_return=weighted_annualized_return,
            holdings=holdings,
            dividend_summaries=dividend_summaries,
        )

    def get_historical_values(
        self,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
    ) -> list[dict]:
        """Calculate historical portfolio values.

        Args:
            start_date: Start date (defaults to first transaction)
            end_date: End date (defaults to today)

        Returns:
            List of {date, value} dictionaries
        """
        if not self._transactions:
            return []

        if start_date is None:
            start_date = min(t.date for t in self._transactions)
        if end_date is None:
            end_date = date.today()

        # Try to get cached portfolio values first (for dates older than 7 days)
        cached_values = cache_service.get_portfolio_values(start_date, end_date)
        logger.info(f"Found {len(cached_values)} cached portfolio values")

        # Determine cutoff date for caching
        cutoff_date = cache_service._get_cache_cutoff_date()

        # If we have cached data and only need recent dates, optimize the calculation
        if cached_values:
            # Find the earliest cached date
            earliest_cached = min(cached_values.keys())

            # Check if cache covers the requested start_date
            if earliest_cached <= start_date:
                # Cache has all historical data, only calculate recent dates
                calc_start = max(start_date, cutoff_date - timedelta(days=7))
                logger.info(f"Cache covers start_date, calculating from {calc_start}")
            else:
                # Cache doesn't have all data, need to calculate from start
                calc_start = start_date
                logger.info(f"Cache incomplete (earliest: {earliest_cached}), calculating from {calc_start}")
        else:
            calc_start = start_date
            logger.info(f"No cache, calculating from {calc_start}")

        # Get all unique symbols
        symbols = set()
        for txn in self._transactions:
            if txn.action in (ActionType.BUY, ActionType.SELL, ActionType.GIFT, ActionType.GAS):
                symbols.add(txn.asset)

        # Fetch historical prices for all symbols
        # Note: yfinance returns split-adjusted prices (adjusted to today)
        # Fetch from a few days before calc_start to handle weekends/holidays
        fetch_start = calc_start - timedelta(days=7)
        historical_prices: dict[str, dict[date, Decimal]] = {}
        for symbol in symbols:
            prices = price_service.get_historical_prices(
                symbol,
                datetime.combine(fetch_start, datetime.min.time()),
                datetime.combine(end_date, datetime.max.time()),
            )
            historical_prices[symbol] = prices

        # Pre-sort price keys once per symbol for efficient bisect lookups
        sorted_price_keys = {sym: sorted(prices.keys()) for sym, prices in historical_prices.items()}

        # Calculate portfolio value for each date (starting from calc_start)
        calculated_results = []
        current_date = calc_start
        # Use same split adjustment setting - quantities will be adjusted at transaction time
        temp_portfolio = Portfolio(adjust_splits=self._adjust_splits)

        # Sort transactions by date
        sorted_txns = sorted(self._transactions, key=lambda t: t.date)

        # Fast-forward to transactions before calc_start
        txn_idx = 0
        for txn in sorted_txns:
            if txn.date < calc_start:
                temp_portfolio._process_transaction(txn)
                txn_idx += 1
            else:
                break

        while current_date <= end_date:
            # Process transactions up to current date
            while txn_idx < len(sorted_txns) and sorted_txns[txn_idx].date <= current_date:
                temp_portfolio._process_transaction(sorted_txns[txn_idx])
                txn_idx += 1

            # Calculate investment value and cost basis (excluding cash)
            investment_value = Decimal("0")
            cost_basis = Decimal("0")
            for symbol, lots in temp_portfolio._lots.items():
                # Quantities are already split-adjusted at transaction time
                total_quantity = sum(lot.quantity for lot in lots)
                lot_cost_basis = sum(lot.total_cost for lot in lots)
                cost_basis += lot_cost_basis

                if total_quantity > 0 and symbol in historical_prices:
                    # Find closest price on or before current date using bisect
                    keys = sorted_price_keys[symbol]
                    idx = bisect.bisect_right(keys, current_date) - 1
                    if idx >= 0:
                        investment_value += total_quantity * historical_prices[symbol][keys[idx]]

            # Get cash balance for this date
            cash_balance = temp_portfolio.get_cash_balance(current_date)
            total_value = investment_value + cash_balance

            if total_value > 0 or txn_idx > 0:
                calculated_results.append({
                    "date": current_date,
                    "total_value": total_value,
                    "investment_value": investment_value,
                    "cost_basis": cost_basis,
                    "cash_value": cash_balance,
                })

            current_date += timedelta(days=1)

        # Save newly calculated values to cache (only dates > 7 days old)
        if calculated_results:
            cache_service.save_portfolio_values_batch(calculated_results)

        # Merge cached and calculated results
        all_results = []

        # Add cached results for dates before calc_start
        for d in sorted(cached_values.keys()):
            if d < calc_start:
                v = cached_values[d]
                all_results.append({
                    "date": d.isoformat(),
                    "value": float(v["total_value"]),
                    "investment_value": float(v["investment_value"]),
                    "cost_basis": float(v["cost_basis"]),
                    "cash": float(v["cash_value"]),
                })

        # Add calculated results
        for r in calculated_results:
            if r["date"] >= start_date:
                all_results.append({
                    "date": r["date"].isoformat(),
                    "value": float(r["total_value"]),
                    "investment_value": float(r["investment_value"]),
                    "cost_basis": float(r["cost_basis"]),
                    "cash": float(r["cash_value"]),
                })

        return all_results

    def get_daily_pnl_history(self, num_days: int = 15) -> list[dict]:
        """Daily P&L for the last num_days days.

        Uses EST midnight as the day boundary for crypto so the numbers
        align with the intraday P&L chart baseline.
        """
        if not self._transactions:
            return []

        today = date.today()
        start_date = today - timedelta(days=num_days)

        symbols = list({
            txn.asset for txn in self._transactions
            if txn.action in (ActionType.BUY, ActionType.SELL, ActionType.GIFT, ActionType.GAS)
        })

        fetch_start = start_date - timedelta(days=7)
        prices_by_date: dict[str, dict[date, Decimal]] = {}
        for symbol in symbols:
            prices_by_date[symbol] = price_service.get_historical_prices(
                symbol,
                datetime.combine(fetch_start, datetime.min.time()),
                datetime.combine(today, datetime.max.time()),
            )

        sorted_txns = sorted(self._transactions, key=lambda t: t.date)
        temp_portfolio = Portfolio(adjust_splits=self._adjust_splits)

        txn_idx = 0
        for txn in sorted_txns:
            if txn.date < start_date:
                temp_portfolio._process_transaction(txn)
                txn_idx += 1
            else:
                break

        # Pre-sort price keys once per symbol for efficient bisect lookups
        sorted_pbd_keys = {sym: sorted(prices.keys()) for sym, prices in prices_by_date.items()}

        daily_values = []
        current_date = start_date
        while current_date <= today:
            while txn_idx < len(sorted_txns) and sorted_txns[txn_idx].date <= current_date:
                temp_portfolio._process_transaction(sorted_txns[txn_idx])
                txn_idx += 1

            investment_value = Decimal("0")
            cost_basis = Decimal("0")
            for symbol, lots in temp_portfolio._lots.items():
                total_qty = sum(lot.quantity for lot in lots)
                if total_qty <= 0:
                    continue
                if symbol in prices_by_date:
                    keys = sorted_pbd_keys[symbol]
                    idx = bisect.bisect_right(keys, current_date) - 1
                    if idx >= 0:
                        investment_value += total_qty * prices_by_date[symbol][keys[idx]]
                cost_basis += sum(lot.quantity * lot.cost_per_share for lot in lots if lot.quantity > 0)

            unrealized_pnl = investment_value - cost_basis
            cash = temp_portfolio.get_cash_balance(current_date)
            daily_values.append({
                "date": current_date.isoformat(),
                "value": float(investment_value + cash),
                "unrealized_pnl": float(unrealized_pnl),
            })
            current_date += timedelta(days=1)

        result = []
        for i in range(1, len(daily_values)):
            curr = daily_values[i]
            prev = daily_values[i - 1]
            # Daily P&L = change in unrealized P&L (investment_value - cost_basis)
            # This matches the Investment P&L chart and excludes new purchases / cash changes
            change = curr["unrealized_pnl"] - prev["unrealized_pnl"]
            pct = (change / prev["value"] * 100) if prev["value"] else 0
            result.append({
                "date": curr["date"],
                "value": curr["value"],
                "daily_pnl": change,
                "daily_pnl_percent": pct,
            })

        return result

    def get_investment_history(
        self,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
    ) -> list[dict]:
        """Calculate monthly investment amounts from transactions only.

        This method does NOT require yfinance data - it only uses transaction records.

        Args:
            start_date: Start date (defaults to first transaction)
            end_date: End date (defaults to today)

        Returns:
            List of {month, cost_basis, net_investment, transactions} dictionaries
        """
        if not self._transactions:
            return []

        if start_date is None:
            start_date = min(t.date for t in self._transactions)
        if end_date is None:
            end_date = date.today()

        # Category classification (matching frontend logic)
        def get_category(symbol: str) -> str:
            symbol_to_category = {
                'BTC-USD': 'Crypto', 'ETH-USD': 'Crypto', 'MSTR': 'Crypto', 'CRCL': 'Crypto', 'IBIT': 'Crypto',
                'VOO': 'Index', 'QQQM': 'Index', 'QQQ': 'Index', 'BRK-B': 'Index', 'SOXX': 'Index',
                'CASH': 'Cash',
            }
            if symbol in symbol_to_category:
                return symbol_to_category[symbol]
            if symbol.endswith('-USD'):
                return 'Crypto'
            return 'Individual Stocks'

        # Sort transactions by date
        sorted_txns = sorted(self._transactions, key=lambda t: t.date)

        # Group transactions by month and calculate monthly data
        monthly_data: dict[str, dict] = {}

        for txn in sorted_txns:
            if txn.date < start_date or txn.date > end_date:
                continue

            month_key = txn.date.strftime("%Y-%m")

            if month_key not in monthly_data:
                monthly_data[month_key] = {
                    "transactions": [],
                    "buys": {},  # symbol -> total amount
                    "sells": {},  # symbol -> total amount
                    "by_category": {},  # category -> net amount
                }

            # Track BUY transactions only for chart display (exclude SELL)
            if txn.action == ActionType.BUY:
                amount = float(txn.amount) if txn.amount else 0
                if txn.asset not in monthly_data[month_key]["buys"]:
                    monthly_data[month_key]["buys"][txn.asset] = 0
                monthly_data[month_key]["buys"][txn.asset] += amount
                # Track by category (BUY only)
                category = get_category(txn.asset)
                if category not in monthly_data[month_key]["by_category"]:
                    monthly_data[month_key]["by_category"][category] = 0
                monthly_data[month_key]["by_category"][category] += amount

        # Calculate cost_basis at end of each month
        temp_portfolio = Portfolio(adjust_splits=self._adjust_splits)
        txn_idx = 0

        # First, process all transactions BEFORE start_date to get initial cost_basis
        while txn_idx < len(sorted_txns) and sorted_txns[txn_idx].date < start_date:
            temp_portfolio._process_transaction(sorted_txns[txn_idx])
            txn_idx += 1

        # Calculate initial cost_basis (from before the selected period)
        prev_cost_basis = Decimal("0")
        for symbol, lots in temp_portfolio._lots.items():
            lot_cost_basis = sum(lot.total_cost for lot in lots)
            prev_cost_basis += lot_cost_basis

        # Get all months in order
        all_months = sorted(monthly_data.keys())

        results = []
        for month_key in all_months:
            # Parse month to get the last day
            year, month = map(int, month_key.split("-"))
            if month == 12:
                next_month_start = date(year + 1, 1, 1)
            else:
                next_month_start = date(year, month + 1, 1)
            month_end = next_month_start - timedelta(days=1)

            # Process all transactions up to end of month
            while txn_idx < len(sorted_txns) and sorted_txns[txn_idx].date <= month_end:
                temp_portfolio._process_transaction(sorted_txns[txn_idx])
                txn_idx += 1

            # Calculate total cost basis
            cost_basis = Decimal("0")
            for symbol, lots in temp_portfolio._lots.items():
                lot_cost_basis = sum(lot.total_cost for lot in lots)
                cost_basis += lot_cost_basis

            # Calculate net investment for this month only
            net_investment = cost_basis - prev_cost_basis

            # Build transaction details for tooltip (BUY only)
            month_info = monthly_data[month_key]
            tx_details = []
            for symbol, amount in sorted(month_info["buys"].items()):
                if amount > 0:
                    tx_details.append({"symbol": symbol, "action": "BUY", "amount": amount})

            # Sort categories by absolute amount (descending)
            by_category = month_info["by_category"]
            sorted_categories = sorted(
                by_category.items(),
                key=lambda x: abs(x[1]),
                reverse=True
            )

            results.append({
                "month": month_key,
                "cost_basis": float(cost_basis),
                "net_investment": float(net_investment),
                "transactions": tx_details,
                "by_category": {cat: amt for cat, amt in sorted_categories},
            })

            prev_cost_basis = cost_basis

        return results

    def get_intraday_values(self, interval: str = "5m") -> list[dict]:
        """Calculate intraday portfolio values for today.

        Args:
            interval: Data interval (1m, 2m, 5m, 15m, 30m, 60m)

        Returns:
            List of {time, value, pnl, pnl_percent} dictionaries
        """
        from datetime import datetime

        # Get current holdings (excluding cash for P&L calculation)
        holdings = self.get_holdings(fetch_prices=False)
        investment_holdings = [h for h in holdings if h.symbol != "CASH"]

        logger.info(f"Intraday: Found {len(investment_holdings)} investment holdings")

        if not investment_holdings:
            return []

        # Get symbols and their quantities
        symbols = [h.symbol for h in investment_holdings]
        quantities = {h.symbol: h.quantity for h in investment_holdings}
        cost_basis = sum(h.cost_basis for h in investment_holdings)

        logger.info(f"Intraday: Symbols={symbols}, Cost basis={cost_basis}")

        # Get previous close prices for pre-market baseline
        prev_close_prices = price_service.get_previous_close_batch(symbols)
        logger.info(f"Intraday: Previous close prices: {prev_close_prices}")

        # Calculate baseline value using previous close
        baseline_value = Decimal("0")
        for symbol in symbols:
            if symbol in prev_close_prices and prev_close_prices[symbol] is not None:
                baseline_value += quantities[symbol] * prev_close_prices[symbol]

        logger.info(f"Intraday: Baseline value (prev close): {baseline_value}")

        # Fetch intraday prices for all symbols
        intraday_prices = price_service.get_intraday_prices_batch(symbols, interval)

        # Find all timestamps from intraday data
        all_times = set()
        for symbol, prices in intraday_prices.items():
            logger.info(f"Intraday: {symbol} has {len(prices)} price points")
            for p in prices:
                all_times.add(p["time"])

        # Generate time slots from market open (or earlier for pre-market context)
        now = datetime.now()
        current_time = now.strftime("%H:%M")

        # Add market hours markers if we have baseline (for drawing vertical lines)
        if baseline_value > 0:
            all_times.add("00:00")
            all_times.add("09:30")  # Market open
            all_times.add("16:00")  # Market close

            # Add time points after market close up to current time (for after-hours/crypto)
            # This ensures the line continues to be drawn
            current_hour = int(current_time.split(":")[0])
            current_minute = int(current_time.split(":")[1])

            # Add intermediate points between 16:00 and current time based on interval
            # Parse interval to get minutes
            interval_minutes = 5  # Default
            if interval.endswith("m"):
                interval_minutes = int(interval[:-1])

            # Add points from 16:00 to current time
            for hour in range(16, 24):
                for minute in range(0, 60, interval_minutes):
                    time_str = f"{hour:02d}:{minute:02d}"
                    if time_str <= current_time:
                        all_times.add(time_str)

            # Add current time as final point
            all_times.add(current_time)

        logger.info(f"Intraday: Found {len(all_times)} unique time points")

        if not all_times:
            return []

        # Sort times chronologically
        sorted_times = sorted(all_times)

        # Get real-time current prices (same as holdings table uses)
        current_realtime_prices = price_service.get_prices_batch(symbols)
        logger.info(f"Intraday: Real-time prices: {current_realtime_prices}")

        # Calculate portfolio value at each time point
        results = []
        # Track last known price for each symbol (initialize with previous close)
        last_prices = {symbol: prev_close_prices.get(symbol) for symbol in symbols}

        # Use baseline_value (previous close) as the zero point for daily P&L
        zero_point_value = baseline_value

        # Check if we're at the last time point (use real-time prices for consistency)
        is_last_time_point = False

        for idx, time_str in enumerate(sorted_times):
            # Skip future times
            if time_str > current_time:
                continue

            # Check if this is the last valid time point
            is_last_time_point = (idx == len(sorted_times) - 1) or (sorted_times[idx + 1] > current_time if idx + 1 < len(sorted_times) else True)

            total_value = Decimal("0")
            has_data = False

            for symbol in symbols:
                price_at_time = None
                has_intraday_data = len(intraday_prices.get(symbol, [])) > 0

                # For the last time point, use real-time prices to match holdings table
                # But only for symbols that have intraday data today (i.e., trading today)
                if is_last_time_point and has_intraday_data and current_realtime_prices.get(symbol) is not None:
                    price_at_time = current_realtime_prices[symbol]
                    last_prices[symbol] = price_at_time
                else:
                    # Check if we have intraday data for this time
                    symbol_prices = intraday_prices.get(symbol, [])
                    for p in symbol_prices:
                        if p["time"] == time_str:
                            price_at_time = p["price"]
                            last_prices[symbol] = price_at_time
                            break

                # Use last known price (starts with previous close)
                if price_at_time is None:
                    price_at_time = last_prices.get(symbol)

                if price_at_time is not None:
                    total_value += quantities[symbol] * price_at_time
                    has_data = True

            if has_data and total_value > 0:
                # Daily P&L: change from midnight (previous close)
                daily_pnl = total_value - zero_point_value
                daily_pnl_percent = (daily_pnl / zero_point_value * 100) if zero_point_value > 0 else Decimal("0")

                # Calculate per-asset P&L changes using previous close (same as holdings table)
                asset_changes = []
                for symbol in symbols:
                    current_price = last_prices.get(symbol)
                    prev_price = prev_close_prices.get(symbol)  # Use same prev_close as holdings
                    qty = quantities[symbol]

                    if current_price is not None and prev_price is not None and prev_price > 0:
                        asset_pnl = (current_price - prev_price) * qty
                        asset_pnl_percent = ((current_price - prev_price) / prev_price) * 100
                        asset_changes.append({
                            "symbol": symbol,
                            "pnl": float(asset_pnl),
                            "pnl_percent": float(asset_pnl_percent),
                            "prev_price": float(prev_price),
                            "current_price": float(current_price),
                        })

                # Sort by absolute P&L (largest movers first)
                asset_changes.sort(key=lambda x: abs(x["pnl"]), reverse=True)

                results.append({
                    "time": time_str,
                    "value": float(total_value),
                    "baseline_value": float(zero_point_value),
                    "daily_pnl": float(daily_pnl),
                    "daily_pnl_percent": float(daily_pnl_percent),
                    "asset_changes": asset_changes[:10],  # Top 10 movers
                })

        logger.info(f"Intraday: Returning {len(results)} data points")
        return results

    def get_multiday_intraday_values(self, interval: str = "15m", days: int = 3) -> list[dict]:
        """Calculate multi-day intraday portfolio values.

        Args:
            interval: Data interval (15m, 30m, 60m)
            days: Number of days of data to return

        Returns:
            List of {datetime, value} dictionaries sorted chronologically
        """
        from datetime import datetime

        # Get current holdings (excluding cash)
        holdings = self.get_holdings(fetch_prices=False)
        investment_holdings = [h for h in holdings if h.symbol != "CASH"]

        logger.info(f"Multi-day intraday: Found {len(investment_holdings)} investment holdings")

        if not investment_holdings:
            return []

        # Get symbols and their quantities
        symbols = [h.symbol for h in investment_holdings]
        quantities = {h.symbol: h.quantity for h in investment_holdings}
        cost_basis = sum(h.cost_basis for h in investment_holdings)

        # Get previous close prices to initialize stock prices for off-hours
        prev_close_prices = price_service.get_previous_close_batch(symbols)
        logger.info(f"Multi-day intraday: Previous close prices: {prev_close_prices}")

        # Fetch multi-day intraday prices for all symbols
        intraday_prices = price_service.get_intraday_prices_batch(symbols, interval, days)

        # Collect all unique timestamps across all symbols
        all_timestamps = {}  # timestamp_str -> datetime obj
        for symbol, prices in intraday_prices.items():
            logger.info(f"Multi-day intraday: {symbol} has {len(prices)} price points")
            for p in prices:
                ts = p["timestamp"]
                if ts not in all_timestamps:
                    all_timestamps[ts] = datetime.fromisoformat(ts)

        if not all_timestamps:
            return []

        # Sort timestamps chronologically
        sorted_timestamps = sorted(all_timestamps.keys(), key=lambda x: all_timestamps[x])

        # Build price lookup: {symbol: {timestamp: price}}
        price_lookup = {}
        for symbol, prices in intraday_prices.items():
            price_lookup[symbol] = {p["timestamp"]: p["price"] for p in prices}

        # Calculate portfolio value at each timestamp
        results = []
        # Initialize last_prices with previous close (for stocks during off-hours)
        last_prices = {symbol: prev_close_prices.get(symbol) for symbol in symbols}

        for ts in sorted_timestamps:
            total_value = Decimal("0")
            has_data = False

            for symbol in symbols:
                price_at_time = price_lookup.get(symbol, {}).get(ts)

                if price_at_time is not None:
                    last_prices[symbol] = price_at_time
                elif last_prices[symbol] is not None:
                    price_at_time = last_prices[symbol]

                if price_at_time is not None:
                    total_value += quantities[symbol] * price_at_time
                    has_data = True

            if has_data and total_value > 0:
                dt = all_timestamps[ts]
                results.append({
                    "datetime": ts,
                    "date": dt.strftime("%Y-%m-%d"),
                    "time": dt.strftime("%H:%M"),
                    "value": float(total_value),
                })

        logger.info(f"Multi-day intraday: Returning {len(results)} data points")
        return results
