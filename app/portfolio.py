"""Portfolio calculation logic."""

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

        # Total P&L = realized + unrealized + dividends
        total_pnl = total_realized_pnl + total_unrealized_pnl + total_dividends

        # Total return % based on all-time invested amount
        total_pnl_percent = Decimal("0")
        if all_time_cost_basis > 0:
            total_pnl_percent = (total_pnl / all_time_cost_basis) * 100

        # Total market value includes cash for overall portfolio value
        cash_value = cash_holding.market_value if cash_holding and cash_holding.market_value else Decimal("0")
        total_market_value = investment_market_value + cash_value

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

        # Get all unique symbols
        symbols = set()
        for txn in self._transactions:
            if txn.action in (ActionType.BUY, ActionType.SELL, ActionType.GIFT, ActionType.GAS):
                symbols.add(txn.asset)

        # Fetch historical prices for all symbols
        # Note: yfinance returns split-adjusted prices (adjusted to today)
        # Fetch from a few days before start_date to handle weekends/holidays
        fetch_start = start_date - timedelta(days=7)
        historical_prices: dict[str, dict[date, Decimal]] = {}
        for symbol in symbols:
            prices = price_service.get_historical_prices(
                symbol,
                datetime.combine(fetch_start, datetime.min.time()),
                datetime.combine(end_date, datetime.max.time()),
            )
            historical_prices[symbol] = prices

        # Calculate portfolio value for each date
        results = []
        current_date = start_date
        # Use same split adjustment setting - quantities will be adjusted at transaction time
        temp_portfolio = Portfolio(adjust_splits=self._adjust_splits)

        # Sort transactions by date
        sorted_txns = sorted(self._transactions, key=lambda t: t.date)
        txn_idx = 0

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
                    # Find closest price on or before current date
                    symbol_prices = historical_prices[symbol]
                    price = None
                    for d in sorted(symbol_prices.keys(), reverse=True):
                        if d <= current_date:
                            price = symbol_prices[d]
                            break
                    if price is not None:
                        investment_value += total_quantity * price

            # Get cash balance for this date
            cash_balance = temp_portfolio.get_cash_balance(current_date)
            total_value = investment_value + cash_balance

            if total_value > 0 or txn_idx > 0:
                results.append({
                    "date": current_date.isoformat(),
                    "value": float(total_value),
                    "investment_value": float(investment_value),
                    "cost_basis": float(cost_basis),
                    "cash": float(cash_balance),
                })

            current_date += timedelta(days=1)

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
            # Add current time if after market close to show after-hours data
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

                # For the last time point, use real-time prices to match holdings table
                if is_last_time_point and current_realtime_prices.get(symbol) is not None:
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
