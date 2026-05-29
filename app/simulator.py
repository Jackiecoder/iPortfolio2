"""Portfolio simulation logic (DCA-aware)."""
import bisect
import logging
import math
import statistics
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Optional

from .price_service import price_service

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_price(historical_prices: dict, symbol: str, target_date: date) -> Optional[float]:
    """Return the most recent close price on or before ``target_date``."""
    prices = historical_prices.get(symbol, {})
    if not prices:
        return None
    sorted_keys = sorted(prices.keys())
    idx = bisect.bisect_right(sorted_keys, target_date) - 1
    if idx < 0:
        return None
    return float(prices[sorted_keys[idx]])


def _add_months(d: date, months: int) -> date:
    """Add an integer number of months, clamping to month end."""
    total_months = d.month - 1 + months
    year = d.year + total_months // 12
    month = total_months % 12 + 1
    last_day = monthrange(year, month)[1]
    return date(year, month, min(d.day, last_day))


def _build_rebalance_set(start: date, end: date, frequency: str) -> set:
    """Return the set of dates on which to rebalance (inclusive of start)."""
    if frequency == "never":
        return set()
    dates = {start}
    current = start
    while current < end:
        if frequency == "weekly":
            current += timedelta(weeks=1)
        elif frequency == "monthly":
            current = _add_months(current, 1)
        elif frequency == "quarterly":
            current = _add_months(current, 3)
        elif frequency == "annually":
            current = _add_months(current, 12)
        else:
            break
        if current <= end:
            dates.add(current)
    return dates


def _build_dca_dates(start: date, end: date, frequency: str) -> list[date]:
    """Build the list of DCA purchase dates.

    The first DCA lands one period AFTER ``start`` — any up-front investment
    belongs in ``initial_capital``.  Set ``initial_capital == dca_amount`` to
    model "start DCA on day one".
    """
    if frequency == "none":
        return []
    dates: list[date] = []
    current = start
    while True:
        if frequency == "weekly":
            current += timedelta(days=7)
        elif frequency == "biweekly":
            current += timedelta(days=14)
        elif frequency == "monthly":
            current = _add_months(current, 1)
        else:
            break
        if current > end:
            break
        dates.append(current)
    return dates


# ---------------------------------------------------------------------------
# XIRR (money-weighted return)
# ---------------------------------------------------------------------------

def _xnpv(rate: float, cashflows: list[tuple[date, float]]) -> float:
    """Net present value of dated cash flows at a given annual rate."""
    if rate <= -1:
        return float("inf")
    t0 = cashflows[0][0]
    try:
        return sum(
            cf / (1 + rate) ** ((d - t0).days / 365.25)
            for d, cf in cashflows
        )
    except (OverflowError, ZeroDivisionError):
        return float("inf") if rate > 0 else float("-inf")


def _xirr(cashflows: list[tuple[date, float]]) -> float:
    """Compute XIRR (annualised money-weighted return) via bisection.

    ``cashflows`` must contain at least one negative (outflow) and one positive
    (inflow) amount.  Returns 0.0 if no valid rate can be found.
    """
    if len(cashflows) < 2:
        return 0.0
    has_pos = any(cf > 0 for _, cf in cashflows)
    has_neg = any(cf < 0 for _, cf in cashflows)
    if not (has_pos and has_neg):
        return 0.0

    low, high = -0.9999, 10.0
    f_low = _xnpv(low, cashflows)
    f_high = _xnpv(high, cashflows)

    # Expand high if needed (rare — very profitable short-duration)
    tries = 0
    while f_low * f_high > 0 and tries < 20:
        high *= 2
        f_high = _xnpv(high, cashflows)
        tries += 1

    if f_low * f_high > 0:
        return 0.0

    for _ in range(100):
        mid = (low + high) / 2
        f_mid = _xnpv(mid, cashflows)
        if abs(f_mid) < 0.01:
            return mid
        if f_low * f_mid < 0:
            high = mid
            f_high = f_mid
        else:
            low = mid
            f_low = f_mid
    return (low + high) / 2


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _compute_metrics(
    values: list[float],
    cashflows: list[tuple[date, float]],
    total_invested: float,
    start_date: date,
    end_date: date,
    data_interval_days: int,
) -> dict:
    """Compute metrics for a time-series of portfolio values with cash flows.

    Cash flows must be provided as ``[(date, amount)]`` where outflows (deposits
    into the portfolio) are NEGATIVE and inflows (the terminal value) are
    POSITIVE — the convention used by XIRR.
    """
    if not values or total_invested <= 0:
        return {
            "final_value": round(values[-1] if values else 0, 2),
            "total_invested": round(total_invested, 2),
            "total_return": 0.0,
            "cagr": 0.0,
            "max_drawdown": 0.0,
            "annualised_volatility": 0.0,
            "sharpe_ratio": 0.0,
        }

    end_value = values[-1]
    total_return = (end_value - total_invested) / total_invested * 100

    # CAGR via XIRR — correctly handles cash flows
    cagr = _xirr(cashflows) * 100

    # Max drawdown — on the "value curve minus invested-to-date"?  No — just on
    # raw value, that's what people care about emotionally.
    peak = 0.0
    max_drawdown = 0.0
    for v in values:
        if v > peak:
            peak = v
        dd = (peak - v) / peak * 100 if peak > 0 else 0
        if dd > max_drawdown:
            max_drawdown = dd

    # Annualised volatility — based on period returns of portfolio value.  This
    # is an approximation when cash flows happen between samples, but it's the
    # standard way to display "how bouncy was this ride".
    annualised_vol = 0.0
    if len(values) > 2:
        returns = [
            (values[i] - values[i - 1]) / values[i - 1]
            for i in range(1, len(values))
            if values[i - 1] > 0
        ]
        if len(returns) > 1:
            std = statistics.stdev(returns)
            periods_per_year = 365.25 / data_interval_days
            annualised_vol = std * math.sqrt(periods_per_year) * 100

    # Sharpe (risk-free ≈ 4.5 %)
    risk_free = 4.5
    sharpe = (cagr - risk_free) / annualised_vol if annualised_vol > 0 else 0.0

    return {
        "final_value": round(end_value, 2),
        "total_invested": round(total_invested, 2),
        "total_return": round(total_return, 2),
        "cagr": round(cagr, 2),
        "max_drawdown": round(max_drawdown, 2),
        "annualised_volatility": round(annualised_vol, 2),
        "sharpe_ratio": round(sharpe, 2),
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_simulation(
    allocations: list[dict],
    start_date: date,
    end_date: date,
    initial_capital: float,
    rebalance_frequency: str = "never",
    data_interval_days: int = 7,
    benchmark: Optional[str] = "VOO",
    dca_frequency: str = "none",
    dca_amount: float = 0.0,
) -> dict:
    """Run a portfolio back-test with optional DCA contributions.

    Args:
        allocations:           ``[{symbol, weight}]`` — weights are normalised.
        start_date/end_date:   Simulation bounds.
        initial_capital:       Up-front lump sum on ``start_date`` (may be 0).
        rebalance_frequency:   ``never|weekly|monthly|quarterly|annually``.
        data_interval_days:    Chart sampling period.
        benchmark:             Symbol for comparison (e.g. ``VOO``).  DCAs into
                               the benchmark on the same schedule.
        dca_frequency:         ``none|weekly|biweekly|monthly``.
        dca_amount:            Dollar amount deposited each DCA date.

    Returns:
        ``{data_points, metrics, benchmark_data, benchmark_metrics, config}``
    """
    if not allocations:
        raise ValueError("At least one allocation is required")
    if start_date >= end_date:
        raise ValueError("start_date must be before end_date")
    if initial_capital < 0 or dca_amount < 0:
        raise ValueError("Capital/DCA amounts must be non-negative")
    if dca_frequency != "none" and dca_amount <= 0:
        raise ValueError("DCA amount must be positive when DCA is enabled")
    if initial_capital == 0 and (dca_frequency == "none" or dca_amount == 0):
        raise ValueError("Either initial_capital or DCA must be positive")

    # ---- normalise weights ------------------------------------------------
    symbols = [a["symbol"].upper().strip() for a in allocations]
    raw_weights = {a["symbol"].upper().strip(): float(a["weight"]) for a in allocations}
    total_w = sum(raw_weights.values())
    if total_w <= 0:
        raise ValueError("Weights must be positive")
    weights = {s: w / total_w * 100 for s, w in raw_weights.items()}

    # ---- fetch historical prices ------------------------------------------
    fetch_symbols = list(symbols)
    bench_upper = benchmark.upper().strip() if benchmark else None
    if bench_upper and bench_upper not in fetch_symbols:
        fetch_symbols.append(bench_upper)

    logger.info(
        "Simulator: fetch %s  %s → %s  (initial=%s, DCA %s × $%s, rebal=%s)",
        fetch_symbols, start_date, end_date,
        initial_capital, dca_frequency, dca_amount, rebalance_frequency,
    )
    historical_prices: dict[str, dict] = {}
    for sym in fetch_symbols:
        historical_prices[sym] = price_service.get_historical_prices(
            sym,
            datetime.combine(start_date - timedelta(days=14), datetime.min.time()),
            datetime.combine(end_date + timedelta(days=2), datetime.max.time()),
        )

    # ---- build sampling / DCA / rebalance calendars -----------------------
    sample_dates: list[date] = []
    d = start_date
    while d <= end_date:
        sample_dates.append(d)
        d += timedelta(days=data_interval_days)
    if sample_dates[-1] != end_date:
        sample_dates.append(end_date)

    rebalance_dates = _build_rebalance_set(start_date, end_date, rebalance_frequency)
    dca_dates = _build_dca_dates(start_date, end_date, dca_frequency)

    # Merge all events into a single timeline
    event_types: dict[date, set] = {}
    for d in sample_dates:
        event_types.setdefault(d, set()).add("sample")
    for d in dca_dates:
        event_types.setdefault(d, set()).add("dca")
    for d in rebalance_dates:
        event_types.setdefault(d, set()).add("rebalance")

    # ---- initialise ------------------------------------------------------
    shares: dict[str, float] = {s: 0.0 for s in symbols}
    total_invested = 0.0
    cashflows: list[tuple[date, float]] = []  # negative = deposit

    if initial_capital > 0:
        for sym in symbols:
            p = _get_price(historical_prices, sym, start_date)
            if p and p > 0:
                shares[sym] = initial_capital * weights[sym] / 100 / p
        total_invested += initial_capital
        cashflows.append((start_date, -initial_capital))

    # Benchmark state
    bench_shares = 0.0
    bench_invested = 0.0
    bench_cashflows: list[tuple[date, float]] = []
    bench_values: list[float] = []
    benchmark_data: list[dict] = []

    if bench_upper and initial_capital > 0:
        bp0 = _get_price(historical_prices, bench_upper, start_date)
        if bp0 and bp0 > 0:
            bench_shares = initial_capital / bp0
            bench_invested += initial_capital
            bench_cashflows.append((start_date, -initial_capital))

    # ---- iterate chronologically -----------------------------------------
    data_points: list[dict] = []
    portfolio_values: list[float] = []

    for event_date in sorted(event_types.keys()):
        if event_date < start_date or event_date > end_date:
            continue
        events = event_types[event_date]

        current_prices = {
            sym: _get_price(historical_prices, sym, event_date) for sym in symbols
        }
        current_prices = {k: v for k, v in current_prices.items() if v}

        # 1) Rebalance (before DCA so new money lands at fresh targets)
        rebalanced = False
        if (
            "rebalance" in events
            and event_date > start_date
            and rebalance_frequency != "never"
        ):
            pv_pre = sum(
                shares.get(s, 0.0) * current_prices.get(s, 0.0) for s in symbols
            )
            if pv_pre > 0:
                for sym in symbols:
                    p = current_prices.get(sym)
                    if p and p > 0:
                        shares[sym] = pv_pre * weights[sym] / 100 / p
                rebalanced = True

        # 2) DCA into the portfolio (and the benchmark)
        dca_event = False
        if "dca" in events and dca_amount > 0:
            for sym in symbols:
                p = current_prices.get(sym)
                if p and p > 0:
                    shares[sym] += dca_amount * weights[sym] / 100 / p
            total_invested += dca_amount
            cashflows.append((event_date, -dca_amount))
            dca_event = True

            if bench_upper:
                bp = _get_price(historical_prices, bench_upper, event_date)
                if bp and bp > 0:
                    bench_shares += dca_amount / bp
                    bench_invested += dca_amount
                    bench_cashflows.append((event_date, -dca_amount))

        # 3) Record a sample
        if "sample" in events:
            pv = sum(
                shares.get(s, 0.0) * current_prices.get(s, 0.0) for s in symbols
            )
            portfolio_values.append(pv)

            alloc_pcts: dict[str, float] = {}
            if pv > 0:
                for sym in symbols:
                    sv = shares.get(sym, 0.0) * current_prices.get(sym, 0.0)
                    alloc_pcts[sym] = round(sv / pv * 100, 2)

            data_points.append({
                "date":         event_date.isoformat(),
                "value":        round(pv, 2),
                "invested":     round(total_invested, 2),
                "allocations":  alloc_pcts,
                "rebalanced":   rebalanced,
                "dca":          dca_event,
            })

            if bench_upper:
                bp = _get_price(historical_prices, bench_upper, event_date)
                if bp is not None:
                    bv = bench_shares * bp
                    bench_values.append(bv)
                    benchmark_data.append({
                        "date":     event_date.isoformat(),
                        "value":    round(bv, 2),
                        "invested": round(bench_invested, 2),
                    })

    # ---- close out cashflow series with terminal value --------------------
    final_value = portfolio_values[-1] if portfolio_values else 0.0
    cashflows_full = cashflows + [(end_date, final_value)]
    metrics = _compute_metrics(
        portfolio_values,
        cashflows_full,
        total_invested,
        start_date,
        end_date,
        data_interval_days,
    )

    # ---- benchmark metrics ------------------------------------------------
    benchmark_metrics: Optional[dict] = None
    if bench_upper and bench_values:
        bench_final = bench_values[-1]
        bench_cashflows_full = bench_cashflows + [(end_date, bench_final)]
        bm = _compute_metrics(
            bench_values,
            bench_cashflows_full,
            bench_invested,
            start_date,
            end_date,
            data_interval_days,
        )
        bm["symbol"] = bench_upper
        benchmark_metrics = bm

    return {
        "data_points": data_points,
        "metrics": metrics,
        "benchmark_data": benchmark_data,
        "benchmark_metrics": benchmark_metrics,
        "config": {
            "allocations": [
                {"symbol": s, "weight": round(weights[s], 2)} for s in symbols
            ],
            "initial_capital":     initial_capital,
            "rebalance_frequency": rebalance_frequency,
            "data_interval_days":  data_interval_days,
            "benchmark":           bench_upper,
            "dca_frequency":       dca_frequency,
            "dca_amount":          dca_amount,
            "dca_count":           len(dca_dates),
        },
    }
