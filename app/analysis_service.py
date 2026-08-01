"""Deterministic portfolio analysis reports.

Reports are generated from the portfolio's transaction-aware daily P&L and
saved as snapshots.  They intentionally avoid an external LLM so an archived
report remains reproducible and does not require another API credential.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from .models import ActionType, Transaction
from .portfolio import Portfolio
from .price_service import price_service


MARKET_TZ = ZoneInfo("America/New_York")
BENCHMARKS = {"SPY": "S&P 500", "QQQ": "Nasdaq 100"}
PERIODS = {
    "1d": {"label": "1 Day", "days": 1, "title": "1-Day Investment Analysis"},
    "30d": {"label": "30 Days", "days": 30, "title": "30-Day Investment Analysis"},
    "6m": {"label": "6 Months", "days": 183, "title": "6-Month Investment Analysis"},
    "1y": {"label": "1 Year", "days": 365, "title": "1-Year Investment Analysis"},
}


def _as_float(value: Decimal | float | int | None) -> float:
    return float(value) if value is not None else 0.0


def _round(value: float | None, digits: int = 2) -> float | None:
    return round(value, digits) if value is not None and math.isfinite(value) else None


def _compound_return(returns: list[float]) -> float:
    value = 1.0
    for daily_return in returns:
        value *= 1 + daily_return / 100
    return (value - 1) * 100


def _annualized_volatility(returns: list[float]) -> float | None:
    if len(returns) < 2:
        return None
    return statistics.stdev(returns) * math.sqrt(252)


def _max_drawdown(returns: list[float]) -> float:
    value = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for daily_return in returns:
        value *= 1 + daily_return / 100
        peak = max(peak, value)
        if peak:
            max_drawdown = max(max_drawdown, (peak - value) / peak * 100)
    return max_drawdown


def _benchmark_metrics(
    prices: dict[date, Decimal], start_date: date, end_date: date
) -> dict[str, float | int | None]:
    ordered = sorted((day, _as_float(price)) for day, price in prices.items() if day <= end_date)
    if len(ordered) < 2:
        return {
            "return_pct": None,
            "annualized_volatility_pct": None,
            "max_drawdown_pct": None,
            "data_points": len(ordered),
        }

    baseline_index = max(
        (index for index, (day, _) in enumerate(ordered) if day <= start_date),
        default=0,
    )
    window = ordered[baseline_index:]
    daily_returns = [
        (window[index][1] / window[index - 1][1] - 1) * 100
        for index in range(1, len(window))
        if window[index - 1][1] > 0
    ]
    total_return = (
        (window[-1][1] / window[0][1] - 1) * 100
        if len(window) >= 2 and window[0][1] > 0
        else None
    )
    return {
        "return_pct": _round(total_return),
        "annualized_volatility_pct": _round(_annualized_volatility(daily_returns)),
        "max_drawdown_pct": _round(_max_drawdown(daily_returns)),
        "data_points": len(window),
    }


def _score_report(
    portfolio_return: float,
    spy_excess: float | None,
    max_drawdown: float,
    volatility: float | None,
    win_rate: float | None,
    top_holding_pct: float,
) -> int:
    score = 50.0
    score += max(-10, min(10, portfolio_return))
    if spy_excess is not None:
        score += max(-15, min(15, spy_excess * 2))

    if max_drawdown <= 3:
        score += 10
    elif max_drawdown <= 8:
        score += 5
    elif max_drawdown > 15:
        score -= 15
    elif max_drawdown > 10:
        score -= 7

    if volatility is not None:
        if volatility <= 15:
            score += 5
        elif volatility > 35:
            score -= 8

    if top_holding_pct <= 25:
        score += 8
    elif top_holding_pct <= 40:
        score += 2
    elif top_holding_pct <= 60:
        score -= 7
    else:
        score -= 15

    if win_rate is not None:
        if win_rate >= 55:
            score += 5
        elif win_rate < 40:
            score -= 5
    return round(max(0, min(100, score)))


def _verdict(score: int) -> tuple[str, str]:
    if score >= 80:
        return "Strong", "Results were strong on both return and risk evidence for this period."
    if score >= 65:
        return "Sound", "The investment decisions were broadly sound for this period."
    if score >= 50:
        return "Mixed", "The period produced mixed evidence; returns and risk should be weighed together."
    if score >= 35:
        return "Cautious", "The evidence calls for caution, with notable risk or benchmark underperformance."
    return "Weak", "The investment decisions performed weakly on the measured evidence for this period."


def _observations(
    portfolio_return: float,
    spy_excess: float | None,
    max_drawdown: float,
    volatility: float | None,
    top_symbol: str | None,
    top_holding_pct: float,
    transaction_count: int,
) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    if spy_excess is None:
        items.append({
            "tone": "neutral",
            "title": "Benchmark comparison unavailable",
            "body": "SPY price history was not available for the full observation window.",
        })
    elif spy_excess >= 1:
        items.append({
            "tone": "positive",
            "title": "Outperformed the broad market",
            "body": f"The portfolio return exceeded SPY by {spy_excess:.2f} percentage points.",
        })
    elif spy_excess <= -1:
        items.append({
            "tone": "warning",
            "title": "Lagged the broad market",
            "body": f"The portfolio return trailed SPY by {abs(spy_excess):.2f} percentage points.",
        })
    else:
        items.append({
            "tone": "neutral",
            "title": "Tracked the broad market",
            "body": f"Performance was within {abs(spy_excess):.2f} percentage points of SPY.",
        })

    if max_drawdown >= 10:
        items.append({
            "tone": "warning",
            "title": "Material drawdown",
            "body": f"The largest peak-to-trough decline was {max_drawdown:.2f}% during the period.",
        })
    elif portfolio_return >= 0:
        items.append({
            "tone": "positive",
            "title": "Drawdown remained contained",
            "body": f"Maximum drawdown was {max_drawdown:.2f}% while the period return stayed positive.",
        })

    if top_symbol and top_holding_pct > 40:
        items.append({
            "tone": "warning",
            "title": "Concentration risk",
            "body": f"{top_symbol} represents {top_holding_pct:.1f}% of current invested value.",
        })
    elif top_symbol:
        items.append({
            "tone": "neutral",
            "title": "Largest current position",
            "body": f"{top_symbol} is the largest holding at {top_holding_pct:.1f}% of invested value.",
        })

    if volatility is not None and volatility > 35:
        items.append({
            "tone": "warning",
            "title": "High return variability",
            "body": f"Annualized daily volatility measured {volatility:.2f}% for this window.",
        })
    if transaction_count:
        items.append({
            "tone": "neutral",
            "title": "Portfolio activity",
            "body": f"There were {transaction_count} recorded portfolio transactions in this period.",
        })
    return items[:5]


def generate_analysis_report(
    portfolio: Portfolio,
    transactions: list[Transaction],
    period: str,
    *,
    as_of: date | None = None,
) -> dict[str, Any]:
    """Generate a serializable analysis snapshot for one supported period."""
    if period not in PERIODS:
        raise ValueError(f"Unsupported analysis period: {period}")

    config = PERIODS[period]
    end_date = as_of or datetime.now(MARKET_TZ).date()
    start_date = end_date - timedelta(days=config["days"])

    history = portfolio.get_daily_pnl_history(num_days=config["days"])
    history = [
        row for row in history
        if start_date < date.fromisoformat(row["date"]) <= end_date
    ]
    weekday_returns = [
        _as_float(row.get("daily_pnl_percent"))
        for row in history
        if date.fromisoformat(row["date"]).weekday() < 5
    ]
    all_returns = [_as_float(row.get("daily_pnl_percent")) for row in history]
    portfolio_return = _compound_return(all_returns)
    period_pnl = sum(_as_float(row.get("daily_pnl")) for row in history)
    active_days = [row for row in history if abs(_as_float(row.get("daily_pnl"))) >= 0.01]
    win_rate = (
        sum(1 for row in active_days if _as_float(row.get("daily_pnl")) > 0) / len(active_days) * 100
        if active_days else None
    )
    volatility = _annualized_volatility(weekday_returns)
    max_drawdown = _max_drawdown(all_returns)

    price_start = datetime.combine(start_date - timedelta(days=7), time.min)
    price_end = datetime.combine(end_date, time.max)
    benchmark_prices = price_service.get_historical_prices_batch(
        list(BENCHMARKS), price_start, price_end
    )
    benchmark_results = []
    for symbol, name in BENCHMARKS.items():
        metrics = _benchmark_metrics(benchmark_prices.get(symbol, {}), start_date, end_date)
        benchmark_results.append({"symbol": symbol, "name": name, **metrics})
    spy_return = benchmark_results[0]["return_pct"]
    spy_excess = portfolio_return - spy_return if spy_return is not None else None

    summary = portfolio.get_portfolio_summary(fetch_prices=True)
    investable_holdings = [
        holding for holding in summary.holdings
        if holding.symbol != "CASH" and _as_float(holding.market_value) > 0
    ]
    invested_value = sum(_as_float(holding.market_value) for holding in investable_holdings)
    weighted_holdings = sorted(
        (
            {
                "symbol": holding.symbol,
                "market_value": _round(_as_float(holding.market_value)),
                "weight_pct": _round(_as_float(holding.market_value) / invested_value * 100),
            }
            for holding in investable_holdings
        ),
        key=lambda item: item["weight_pct"] or 0,
        reverse=True,
    ) if invested_value else []
    top_holding = weighted_holdings[0] if weighted_holdings else None
    top_holding_pct = _as_float(top_holding["weight_pct"]) if top_holding else 0.0
    concentration_hhi = sum((_as_float(item["weight_pct"]) / 100) ** 2 for item in weighted_holdings)

    period_transactions = [txn for txn in transactions if start_date < txn.date <= end_date]
    activity = {
        "transaction_count": len(period_transactions),
        "buy_amount": _round(sum(_as_float(txn.amount) for txn in period_transactions if txn.action == ActionType.BUY)),
        "sell_amount": _round(sum(_as_float(txn.amount) for txn in period_transactions if txn.action == ActionType.SELL)),
        "dividends": _round(sum(_as_float(txn.amount) for txn in period_transactions if txn.action == ActionType.DIV)),
        "fees": _round(sum(_as_float(txn.amount) for txn in period_transactions if txn.action == ActionType.FEE)),
    }

    contributions: defaultdict[str, float] = defaultdict(float)
    for row in history:
        for change in row.get("asset_changes", []):
            contributions[change["symbol"]] += _as_float(change.get("pnl"))
    ranked = sorted(
        ({"symbol": symbol, "pnl": _round(pnl)} for symbol, pnl in contributions.items()),
        key=lambda item: item["pnl"] or 0,
        reverse=True,
    )
    positive = [item for item in ranked if _as_float(item["pnl"]) > 0][:5]
    negative = [item for item in reversed(ranked) if _as_float(item["pnl"]) < 0][:5]

    if not history:
        score = None
        verdict_label = "Insufficient Data"
        verdict_summary = "There is not enough portfolio history to assess this period."
    else:
        score = _score_report(
            portfolio_return,
            spy_excess,
            max_drawdown,
            volatility,
            win_rate,
            top_holding_pct,
        )
        verdict_label, verdict_summary = _verdict(score)

    spy_direction = _as_float(spy_return)
    if spy_return is None:
        regime = "Unavailable"
    elif spy_direction >= 2:
        regime = "Broad Market Advance"
    elif spy_direction <= -2:
        regime = "Broad Market Decline"
    else:
        regime = "Range-Bound Market"

    generated_at = datetime.now(MARKET_TZ).isoformat()
    return {
        "report_version": 1,
        "period": period,
        "period_label": config["label"],
        "title": config["title"],
        "generated_at": generated_at,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "verdict": {
            "label": verdict_label,
            "score": score,
            "summary": verdict_summary,
        },
        "portfolio": {
            "return_pct": _round(portfolio_return),
            "pnl": _round(period_pnl),
            "win_rate_pct": _round(win_rate),
            "annualized_volatility_pct": _round(volatility),
            "max_drawdown_pct": _round(max_drawdown),
            "active_days": len(active_days),
            "data_points": len(history),
        },
        "market": {
            "regime": regime,
            "benchmarks": benchmark_results,
        },
        "relative": {
            "spy_excess_pct": _round(spy_excess),
        },
        "allocation": {
            "holding_count": len(weighted_holdings),
            "top_holding_symbol": top_holding["symbol"] if top_holding else None,
            "top_holding_pct": _round(top_holding_pct),
            "concentration_hhi": _round(concentration_hhi, 4),
            "top_holdings": weighted_holdings[:5],
        },
        "activity": activity,
        "contributors": {"positive": positive, "negative": negative},
        "observations": _observations(
            portfolio_return,
            spy_excess,
            max_drawdown,
            volatility,
            top_holding["symbol"] if top_holding else None,
            top_holding_pct,
            len(period_transactions),
        ),
        "methodology": [
            "Portfolio return compounds transaction-aware daily P&L percentages.",
            "SPY and QQQ use adjusted market closing-price history over the same window.",
            "The 0-100 score combines return, benchmark excess return, drawdown, volatility, win rate, and current concentration.",
            "This is a quantitative review of recorded results, not investment advice or a prediction of future returns.",
        ],
    }
