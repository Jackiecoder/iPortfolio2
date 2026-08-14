"""FastAPI application entry point."""

import asyncio
import logging
import mimetypes
import os
import threading
from datetime import date as date_type
from datetime import datetime, time as time_type, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, ValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from . import repository
from .analysis_service import (
    AnalysisConfigurationError,
    AnalysisGenerationError,
    add_gpt_analysis,
    generate_analysis_report,
)
from .cache_service import cache_service
from .csv_parser import CSVParseError, parse_csv_content
from .db import init_schema
from .models import ActionType, Transaction, default_transaction_time
from .portfolio import Portfolio
from .price_service import price_service
from .simulator import run_simulation

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
MARKET_TZ = ZoneInfo("America/New_York")


def market_today() -> date_type:
    """Return today's date in the US market timezone."""
    return datetime.now(MARKET_TZ).date()

# Application paths
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

# Ensure directories exist
DATA_DIR.mkdir(exist_ok=True)

# Initialize FastAPI app
app = FastAPI(
    title="Portfolio Tracker",
    description="Track your investment portfolio with live market data",
    version="1.0.0",
)

# Mount static files
# Ensure the web app manifest is served with a manifest content-type (the
# extension isn't in the default mimetypes db on all platforms).
mimetypes.add_type("application/manifest+json", ".webmanifest")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Templates
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# --- Auth ---
# When API_TOKEN is set, every request except the page shell, static assets and
# the health check must carry "Authorization: Bearer <API_TOKEN>". When it's
# unset (local dev), auth is disabled.
API_TOKEN = os.environ.get("API_TOKEN")
_PUBLIC_PREFIXES = ("/static", "/healthz", "/api/healthz", "/favicon", "/sw.js", "/manifest.webmanifest")


@app.middleware("http")
async def require_token(request: Request, call_next):
    if API_TOKEN:
        path = request.url.path
        if path != "/" and not path.startswith(_PUBLIC_PREFIXES):
            header = request.headers.get("Authorization", "")
            token = header[7:] if header.startswith("Bearer ") else ""
            if token != API_TOKEN:
                return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


@app.get("/healthz")
@app.get("/api/healthz")
async def healthz():
    """Liveness/readiness probe for Cloud Run."""
    return {"status": "ok"}


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    """Serve the PWA service worker from the root so it controls the whole site.

    A worker served from /static/ would be scoped to /static/ and could not
    control navigations at /, so it must live at the origin root.
    """
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )

# Global portfolio instance (reloaded from CSV files)
portfolio: Optional[Portfolio] = None
_portfolio_generation = 0

# API-level response cache
_api_cache: dict[str, tuple[dict, datetime]] = {}
_api_cache_lock = threading.Lock()
_api_refreshing: set[str] = set()
_market_refresh_lock = threading.Lock()
_market_refresh_task: Optional[asyncio.Task] = None


def _configured_refresh_interval() -> int:
    try:
        return max(15, int(os.environ.get("MARKET_REFRESH_INTERVAL_SECONDS", "60")))
    except ValueError:
        logger.warning("Invalid MARKET_REFRESH_INTERVAL_SECONDS; using 60 seconds")
        return 60


MARKET_REFRESH_INTERVAL_SECONDS = _configured_refresh_interval()
_API_TTL = {
    # The background job replaces these once per minute. A two-minute read TTL
    # keeps the last fully-built snapshot available throughout the next cycle.
    "holdings": timedelta(minutes=2),
    "summary": timedelta(minutes=2),
    "performance": timedelta(minutes=2),
    "daily-pnl": timedelta(minutes=2),
    "dividends": timedelta(minutes=2),
    "sold": timedelta(minutes=2),
    "intraday": timedelta(minutes=2),
    "intraday-hist": timedelta(days=30),
    "intraday-multiday": timedelta(minutes=2),
}


def _get_api_cache(key: str) -> Optional[dict]:
    with _api_cache_lock:
        entry = _api_cache.get(key)
    if entry:
        data, cached_at = entry
        ttl_key = key.split("_")[0]
        ttl = _API_TTL.get(ttl_key, timedelta(seconds=30))
        if datetime.now() - cached_at < ttl:
            return data
    return None


def _set_api_cache(key: str, data: dict) -> None:
    with _api_cache_lock:
        _api_cache[key] = (data, datetime.now())


def _set_api_caches(entries: dict[str, dict]) -> None:
    """Publish a complete group of precomputed responses atomically."""
    cached_at = datetime.now()
    with _api_cache_lock:
        for key, data in entries.items():
            _api_cache[key] = (data, cached_at)


def _get_stale_api_cache(key: str, max_age: timedelta) -> Optional[dict]:
    """Return an expired cache entry when it is still useful as a fast fallback."""
    with _api_cache_lock:
        entry = _api_cache.get(key)
    if not entry:
        return None
    data, cached_at = entry
    return data if datetime.now() - cached_at < max_age else None


def _clear_api_cache() -> None:
    with _api_cache_lock:
        _api_cache.clear()


def _refresh_intraday_cache(
    cache_key: str, target_date: date_type, interval: str, generation: int
) -> None:
    """Refresh one intraday response after a stale response has been sent."""
    try:
        active_portfolio = portfolio
        if active_portfolio is None:
            return
        if target_date == market_today():
            data = active_portfolio.get_intraday_values(interval=interval)
        else:
            data = active_portfolio.get_intraday_values_for_date(
                target_date, interval=interval
            )
        if generation == _portfolio_generation:
            _set_api_cache(
                cache_key, {
                    "intraday": data,
                    "date": target_date.isoformat(),
                    "cache_status": "fresh",
                }
            )
    except Exception:
        logger.exception("Background intraday refresh failed for %s", cache_key)
    finally:
        with _api_cache_lock:
            _api_refreshing.discard(cache_key)


def _queue_intraday_refresh(
    background_tasks: BackgroundTasks,
    cache_key: str,
    target_date: date_type,
    interval: str,
) -> None:
    with _api_cache_lock:
        if cache_key in _api_refreshing:
            return
        _api_refreshing.add(cache_key)
    background_tasks.add_task(
        _refresh_intraday_cache,
        cache_key,
        target_date,
        interval,
        _portfolio_generation,
    )


def _holding_to_dict(holding) -> dict:
    """Serialize one Holding consistently across holdings and summary APIs."""
    return {
        "symbol": holding.symbol,
        "quantity": float(holding.quantity),
        "cost_basis": float(holding.cost_basis),
        "avg_cost": float(holding.avg_cost),
        "current_price": float(holding.current_price) if holding.current_price is not None else None,
        "market_value": float(holding.market_value) if holding.market_value is not None else None,
        "unrealized_pnl": float(holding.unrealized_pnl) if holding.unrealized_pnl is not None else None,
        "pnl_percent": float(holding.pnl_percent) if holding.pnl_percent is not None else None,
        "daily_change_percent": float(holding.daily_change_percent) if holding.daily_change_percent is not None else None,
        "daily_change_amount": float(holding.daily_change_amount) if holding.daily_change_amount is not None else None,
        "holding_days": holding.holding_days,
        "annualized_return": float(holding.annualized_return) if holding.annualized_return is not None else None,
        "weighted_annualized_return": float(holding.weighted_annualized_return) if holding.weighted_annualized_return is not None else None,
        "long_term_quantity": float(holding.long_term_quantity) if holding.long_term_quantity is not None else None,
        "short_term_quantity": float(holding.short_term_quantity) if holding.short_term_quantity is not None else None,
        "lt_unrealized_pnl": float(holding.lt_unrealized_pnl) if holding.lt_unrealized_pnl is not None else None,
        "st_unrealized_pnl": float(holding.st_unrealized_pnl) if holding.st_unrealized_pnl is not None else None,
        "realized_pnl": float(holding.realized_pnl) if holding.realized_pnl is not None else None,
        "lt_realized_pnl": float(holding.lt_realized_pnl) if holding.lt_realized_pnl is not None else None,
        "st_realized_pnl": float(holding.st_realized_pnl) if holding.st_realized_pnl is not None else None,
        "total_pnl": float(holding.total_pnl) if holding.total_pnl is not None else None,
        "total_pnl_percent": float(holding.total_pnl_percent) if holding.total_pnl_percent is not None else None,
        "ytd_pnl": float(holding.ytd_pnl) if holding.ytd_pnl is not None else None,
        "ytd_pnl_percent": float(holding.ytd_pnl_percent) if holding.ytd_pnl_percent is not None else None,
        "lt_ytd_pnl": float(holding.lt_ytd_pnl) if holding.lt_ytd_pnl is not None else None,
        "st_ytd_pnl": float(holding.st_ytd_pnl) if holding.st_ytd_pnl is not None else None,
    }


def _build_summary_response(active_portfolio: Portfolio) -> dict:
    """Calculate the full live summary without consulting the API cache."""
    summary = active_portfolio.get_portfolio_summary(fetch_prices=True)

    ytd_pnl = 0.0
    ytd_pnl_percent = 0.0
    ytd_lt_pnl = None
    ytd_st_pnl = None
    today = market_today()
    jan1 = date_type(today.year, 1, 1)
    ytd_history = active_portfolio.get_historical_values(
        start_date=jan1, end_date=today
    )
    if ytd_history:
        first = ytd_history[0]
        first_inv_pnl = float(first["investment_value"]) - float(first["cost_basis"])
        last_inv_pnl = float(summary.total_unrealized_pnl)
        ytd_pnl = last_inv_pnl - first_inv_pnl
        first_total = float(first["value"])
        if first_total > 0:
            ytd_pnl_percent = ytd_pnl / first_total * 100

    if summary.lt_unrealized_pnl is not None and summary.st_unrealized_pnl is not None:
        jan1_lt, jan1_st = active_portfolio.get_lt_st_unrealized_pnl_at_date(jan1)
        ytd_lt_pnl = float(summary.lt_unrealized_pnl) - float(jan1_lt)
        ytd_st_pnl = float(summary.st_unrealized_pnl) - float(jan1_st)

    return {
        "total_cost_basis": float(summary.total_cost_basis),
        "total_market_value": float(summary.total_market_value),
        "investment_market_value": float(summary.investment_market_value),
        "total_unrealized_pnl": float(summary.total_unrealized_pnl),
        "lt_unrealized_pnl": float(summary.lt_unrealized_pnl) if summary.lt_unrealized_pnl is not None else None,
        "st_unrealized_pnl": float(summary.st_unrealized_pnl) if summary.st_unrealized_pnl is not None else None,
        "total_realized_pnl": float(summary.total_realized_pnl),
        "total_pnl": float(summary.total_pnl),
        "total_pnl_percent": float(summary.total_pnl_percent),
        "total_dividends": float(summary.total_dividends),
        "total_fees": float(summary.total_fees),
        "all_time_cost_basis": float(summary.all_time_cost_basis),
        "weighted_annualized_return": float(summary.weighted_annualized_return) if summary.weighted_annualized_return is not None else None,
        "ytd_pnl": ytd_pnl,
        "ytd_pnl_percent": ytd_pnl_percent,
        "ytd_lt_pnl": ytd_lt_pnl,
        "ytd_st_pnl": ytd_st_pnl,
        "holdings": [_holding_to_dict(holding) for holding in summary.holdings],
        "dividend_summaries": [
            {
                "symbol": item.symbol,
                "total_amount": float(item.total_amount),
                "payment_count": item.payment_count,
            }
            for item in summary.dividend_summaries
        ],
    }


def _performance_cache_key(
    start_date: Optional[date_type], end_date: Optional[date_type]
) -> str:
    start = start_date.isoformat() if start_date else "all"
    end = end_date.isoformat() if end_date else "all"
    return f"performance_{start}_{end}"


def _build_performance_response(
    active_portfolio: Portfolio,
    start_date: Optional[date_type] = None,
    end_date: Optional[date_type] = None,
) -> dict:
    return {
        "performance": active_portfolio.get_historical_values(
            start_date=start_date, end_date=end_date
        ),
        "realized_by_year": active_portfolio.get_realized_pnl_by_year(),
        "realized_details_by_year": active_portfolio.get_realized_details_by_year(),
    }


def _slice_performance_response(
    response: dict, start_date: date_type, end_date: date_type
) -> dict:
    return {
        **response,
        "performance": [
            point
            for point in response.get("performance", [])
            if start_date.isoformat() <= point["date"] <= end_date.isoformat()
        ],
    }


def _build_sold_response(active_portfolio: Portfolio) -> dict:
    sold_assets = active_portfolio.get_sold_assets()
    return {
        "sold_assets": sold_assets,
        "total_pnl": sum(item["pnl"] for item in sold_assets),
        "total_proceeds": sum(item["proceeds"] for item in sold_assets),
        "total_cost_basis": sum(item["cost_basis"] for item in sold_assets),
    }


def _refresh_market_snapshot(
    force_prices: bool = True, wait_for_lock: bool = False
) -> dict:
    """Pull live prices, precompute dashboard data, then atomically publish it."""
    if not _market_refresh_lock.acquire(blocking=wait_for_lock):
        return {"status": "already-refreshing"}

    started_at = datetime.now(MARKET_TZ)
    entries: dict[str, dict] = {}
    try:
        active_portfolio = portfolio
        generation = _portfolio_generation
        if active_portfolio is None:
            return {"status": "portfolio-unavailable"}

        if force_prices:
            price_service.clear_live_cache()

        try:
            summary = _build_summary_response(active_portfolio)
            entries["summary"] = summary
            entries["holdings"] = {"holdings": summary["holdings"]}
            entries["dividends"] = {
                "total_dividends": summary["total_dividends"],
                "by_asset": summary["dividend_summaries"],
            }
        except Exception:
            logger.exception("Failed to precompute portfolio summary")

        try:
            sold = _build_sold_response(active_portfolio)
            entries["sold"] = sold
        except Exception:
            logger.exception("Failed to precompute sold positions")

        try:
            all_performance = _build_performance_response(active_portfolio)
            entries[_performance_cache_key(None, None)] = all_performance
            today = market_today()
            jan1 = date_type(today.year, 1, 1)
            try:
                one_year_ago = today.replace(year=today.year - 1)
            except ValueError:
                one_year_ago = date_type(today.year - 1, 2, 28)
            entries[_performance_cache_key(jan1, today)] = _slice_performance_response(
                all_performance, jan1, today
            )
            entries[_performance_cache_key(one_year_ago, today)] = _slice_performance_response(
                all_performance, one_year_ago, today
            )
        except Exception:
            logger.exception("Failed to precompute performance charts")

        try:
            monthly_pnl = {"daily_pnl": active_portfolio.get_daily_pnl_history(num_days=400)}
            entries["daily-pnl_400"] = monthly_pnl
            entries["daily-pnl_42"] = {"daily_pnl": monthly_pnl["daily_pnl"][-42:]}
        except Exception:
            logger.exception("Failed to precompute daily P&L")

        try:
            today = market_today()
            intraday = active_portfolio.get_intraday_values(interval="1m")
            entries[f"intraday_{today.isoformat()}_1m"] = {
                "intraday": intraday,
                "date": today.isoformat(),
                "cache_status": "fresh",
            }
        except Exception:
            logger.exception("Failed to precompute intraday chart")

        if generation != _portfolio_generation or active_portfolio is not portfolio:
            logger.info("Discarding market snapshot for superseded portfolio generation")
            return {"status": "superseded"}

        _set_api_caches(entries)
        finished_at = datetime.now(MARKET_TZ)
        logger.info(
            "Market snapshot refreshed: %s responses in %.2fs",
            len(entries),
            (finished_at - started_at).total_seconds(),
        )
        return {
            "status": "fresh",
            "responses_precomputed": len(entries),
            "refreshed_at": finished_at.isoformat(),
        }
    finally:
        _market_refresh_lock.release()


async def _market_refresh_loop() -> None:
    """Refresh the in-memory dashboard snapshot once per configured interval."""
    while True:
        await asyncio.sleep(MARKET_REFRESH_INTERVAL_SECONDS)
        try:
            await asyncio.to_thread(_refresh_market_snapshot, True)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Scheduled market refresh failed")


def load_portfolio() -> Portfolio:
    """Load portfolio from all transactions stored in Postgres."""
    global portfolio, _portfolio_generation
    portfolio = Portfolio()

    transactions = repository.get_all_transactions()
    if transactions:
        portfolio.add_transactions(transactions)
        logger.info(f"Loaded {len(transactions)} transactions from database")
    else:
        logger.info("No transactions found in database")

    _portfolio_generation += 1

    return portfolio


@app.on_event("startup")
async def startup_event():
    """Load the portfolio, build the first snapshot, and start minute refreshes."""
    global _market_refresh_task
    if not API_TOKEN:
        logger.warning("API_TOKEN not set — authentication is DISABLED (dev mode).")
    init_schema()
    loaded = load_portfolio()
    symbols = [
        holding.symbol
        for holding in loaded.get_holdings(fetch_prices=False)
        if holding.symbol != "CASH"
    ]
    price_service.prime_intraday_cache_from_db(symbols, interval="1m")
    await asyncio.to_thread(_refresh_market_snapshot, True)
    _market_refresh_task = asyncio.create_task(
        _market_refresh_loop(), name="market-snapshot-refresh"
    )


@app.on_event("shutdown")
async def shutdown_event():
    """Stop the scheduled refresh cleanly during deploys and local restarts."""
    global _market_refresh_task
    if _market_refresh_task is None:
        return
    _market_refresh_task.cancel()
    try:
        await _market_refresh_task
    except asyncio.CancelledError:
        pass
    _market_refresh_task = None


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Serve the main dashboard page."""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/holdings")
async def get_holdings():
    """Get current holdings with live prices."""
    if portfolio is None:
        load_portfolio()

    cached = _get_api_cache("holdings")
    if cached is not None:
        return cached

    try:
        active_portfolio = portfolio
        holdings = await asyncio.to_thread(active_portfolio.get_holdings, True)
        result = {"holdings": [_holding_to_dict(item) for item in holdings]}
        _set_api_cache("holdings", result)
        return result
    except Exception as e:
        logger.error(f"Error fetching holdings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/summary")
async def get_summary():
    """Get portfolio summary including totals."""
    if portfolio is None:
        load_portfolio()

    cached = _get_api_cache("summary")
    if cached is not None:
        return cached

    try:
        active_portfolio = portfolio
        result = await asyncio.to_thread(_build_summary_response, active_portfolio)
        _set_api_cache("summary", result)
        return result
    except Exception as e:
        logger.error(f"Error fetching summary: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/performance")
async def get_performance(
    start_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
):
    """Get historical portfolio performance data."""
    if portfolio is None:
        load_portfolio()

    try:
        from datetime import datetime

        start = None
        end = None

        if start_date:
            start = datetime.strptime(start_date, "%Y-%m-%d").date()
        if end_date:
            end = datetime.strptime(end_date, "%Y-%m-%d").date()

        cache_key = _performance_cache_key(start, end)
        cached = _get_api_cache(cache_key)
        if cached is not None:
            return cached

        # Any requested chart window can be sliced from the precomputed ALL
        # series in memory, avoiding another historical calculation.
        all_cached = _get_api_cache(_performance_cache_key(None, None))
        if all_cached is not None and (start is not None or end is not None):
            start_bound = start or date_type.min
            end_bound = end or date_type.max
            result = _slice_performance_response(
                all_cached, start_bound, end_bound
            )
            _set_api_cache(cache_key, result)
            return result

        active_portfolio = portfolio
        result = await asyncio.to_thread(
            _build_performance_response, active_portfolio, start, end
        )
        _set_api_cache(cache_key, result)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
    except Exception as e:
        logger.error(f"Error fetching performance: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/daily-pnl")
async def get_daily_pnl(num_days: int = 42):
    """Get daily P&L for the last `num_days` days using EST midnight as the daily boundary.

    Default 42 days so the 5-week (current + past 4) Daily P&L panel always
    has a full window's worth of data, even when today falls early in the week.
    """
    if portfolio is None:
        load_portfolio()

    # Cache is keyed on the endpoint name only, so vary it by num_days.
    # `_get_api_cache` splits on "_" to look up the TTL, so use "_" not ":" in the suffix.
    cache_key = f"daily-pnl_{num_days}"
    cached = _get_api_cache(cache_key)
    if cached is not None:
        return cached

    monthly_cached = _get_api_cache("daily-pnl_400")
    if monthly_cached is not None and 0 < num_days <= 400:
        result = {"daily_pnl": monthly_cached.get("daily_pnl", [])[-num_days:]}
        _set_api_cache(cache_key, result)
        return result

    try:
        active_portfolio = portfolio
        data = await asyncio.to_thread(
            active_portfolio.get_daily_pnl_history, num_days
        )
        result = {"daily_pnl": data}
        _set_api_cache(cache_key, result)
        return result
    except Exception as e:
        logger.error(f"Error fetching daily P&L: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dividends")
async def get_dividends():
    """Get dividend summary and history."""
    if portfolio is None:
        load_portfolio()

    cached = _get_api_cache("dividends")
    if cached is not None:
        return cached

    try:
        summaries = portfolio.get_dividend_summaries()
        total = portfolio.get_total_dividends()

        result = {
            "total_dividends": float(total),
            "by_asset": [
                {
                    "symbol": s.symbol,
                    "total_amount": float(s.total_amount),
                    "payment_count": s.payment_count,
                }
                for s in summaries
            ],
        }
        _set_api_cache("dividends", result)
        return result
    except Exception as e:
        logger.error(f"Error fetching dividends: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/sold")
async def get_sold_assets():
    """Get summary of sold assets with realized P&L."""
    if portfolio is None:
        load_portfolio()

    cached = _get_api_cache("sold")
    if cached is not None:
        return cached

    try:
        result = _build_sold_response(portfolio)
        _set_api_cache("sold", result)
        return result
    except Exception as e:
        logger.error(f"Error fetching sold assets: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _refresh_after_write() -> dict:
    """Reload transactions and leave a complete fresh dashboard snapshot."""
    load_portfolio()
    _clear_api_cache()
    return _refresh_market_snapshot(force_prices=False, wait_for_lock=True)


class TransactionCreate(BaseModel):
    """Request body for adding a single transaction."""
    date: date_type
    asset: str
    action: ActionType
    amount: Optional[Decimal] = None
    quantity: Optional[Decimal] = None
    ave_price: Optional[Decimal] = None
    source: Optional[str] = None
    comment: Optional[str] = None
    broker: Optional[str] = None
    transaction_time: Optional[time_type] = None


@app.post("/api/transactions")
async def create_transaction(txn_in: TransactionCreate):
    """Add a single transaction to the database."""
    try:
        # Reuse Transaction's validation + missing-value derivation.
        execution_time = txn_in.transaction_time or default_transaction_time(
            txn_in.asset, txn_in.action
        )
        txn = Transaction(
            date=txn_in.date,
            asset=txn_in.asset,
            action=txn_in.action,
            amount=txn_in.amount,
            quantity=txn_in.quantity,
            ave_price=txn_in.ave_price,
            source=txn_in.source,
            comment=txn_in.comment,
            executed_at=datetime.combine(
                txn_in.date, execution_time, tzinfo=MARKET_TZ
            ),
        )
    except ValidationError as e:
        msgs = "; ".join(err.get("msg", "invalid") for err in e.errors())
        raise HTTPException(status_code=400, detail=msgs)

    try:
        new_id = repository.insert_transaction(txn, broker=txn_in.broker)
        await asyncio.to_thread(_refresh_after_write)
        return {
            "id": new_id,
            "message": (
                f"Added {txn.action.value} {txn.asset} on "
                f"{txn.effective_executed_at.strftime('%Y-%m-%d %H:%M')} ET"
            ),
        }
    except Exception as e:
        logger.error(f"Error adding transaction: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/upload")
async def upload_csv(file: UploadFile = File(...)):
    """Upload a CSV file and import its transactions into the database."""
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a CSV file")

    try:
        content = await file.read()
        content_str = content.decode("utf-8-sig")

        # Parse + validate, then bulk-insert into Postgres (no file is written).
        transactions = parse_csv_content(content_str)
        count = repository.insert_transactions(transactions)

        await asyncio.to_thread(_refresh_after_write)

        return {
            "message": f"Imported {count} transactions from {file.filename}",
            "transactions_count": count,
        }
    except CSVParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="File encoding error. Please use UTF-8 encoding.",
        )
    except Exception as e:
        logger.error(f"Error uploading file: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/reload")
async def reload_portfolio(
    clear_history_cache: bool = Query(False, description="Also clear historical data cache"),
    clear_price_cache: bool = Query(False, description="Force a fresh market-data fetch"),
    precompute: bool = Query(False, description="Precompute dashboard responses before returning"),
):
    """Reload portfolio transactions while preserving market caches by default."""
    try:
        load_portfolio()
        if clear_price_cache:
            price_service.clear_cache()
        _clear_api_cache()
        if clear_history_cache:
            cache_service.clear_cache()
        refresh = None
        if precompute:
            refresh = await asyncio.to_thread(
                _refresh_market_snapshot, False, True
            )
        return {
            "message": "Portfolio reloaded successfully",
            "refresh": refresh,
        }
    except Exception as e:
        logger.error(f"Error reloading portfolio: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/transactions")
async def list_all_transactions():
    """Return every transaction (newest first) with its id and broker.

    Powers the Transactions browser tab so the user can spot and remove
    mistaken records. Rows are returned exactly as stored.
    """
    try:
        return {"transactions": repository.get_all_transactions_with_meta()}
    except Exception as e:
        logger.error(f"Error listing transactions: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/transactions/{txn_id}")
async def delete_transaction(txn_id: int):
    """Permanently delete a single transaction by id, then reload the portfolio."""
    try:
        deleted = repository.delete_transaction(txn_id)
    except Exception as e:
        logger.error(f"Error deleting transaction {txn_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    if not deleted:
        raise HTTPException(status_code=404, detail=f"Transaction {txn_id} not found")

    await asyncio.to_thread(_refresh_after_write)
    return {"id": txn_id, "message": f"Deleted transaction {txn_id}"}


@app.get("/api/transactions/{symbol}")
async def get_transactions(
    symbol: str,
    limit: int = Query(20, description="Max transactions to return"),
    actions: Optional[str] = Query(None, description="Comma-separated action types to filter (e.g. BUY,SELL)"),
):
    """Get recent transactions for a specific symbol."""
    if portfolio is None:
        load_portfolio()

    try:
        action_filter = {a.strip().upper() for a in actions.split(",")} if actions else None
        txns = sorted(
            [
                t for t in portfolio._transactions
                if t.asset == symbol.upper()
                and (action_filter is None or t.action.value in action_filter)
            ],
            key=lambda t: t.effective_executed_at,
            reverse=True,
        )[:limit]
        result = {
            "symbol": symbol.upper(),
            "transactions": [
                {
                    "date": t.date.isoformat(),
                    "executed_at": t.effective_executed_at.isoformat(),
                    "transaction_time": t.effective_executed_at.strftime("%H:%M"),
                    "action": t.action.value,
                    "quantity": float(t.quantity) if t.quantity is not None else None,
                    "ave_price": float(t.ave_price) if t.ave_price is not None else None,
                    "amount": float(t.amount) if t.amount is not None else None,
                }
                for t in txns
            ],
        }
        return result
    except Exception as e:
        logger.error(f"Error fetching transactions for {symbol}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/files")
async def list_files():
    """List CSV files in the data directory."""
    try:
        files = [
            {
                "name": f.name,
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime,
            }
            for f in DATA_DIR.glob("*.csv")
        ]
        return {"files": files}
    except Exception as e:
        logger.error(f"Error listing files: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/intraday")
async def get_intraday(
    background_tasks: BackgroundTasks,
    interval: str = Query("5m", description="Data interval (1m, 5m, 15m, 30m, 60m)"),
    date: Optional[str] = Query(None, description="Date in YYYY-MM-DD format (defaults to today)"),
):
    """Get intraday portfolio performance for a given date (defaults to today)."""
    if portfolio is None:
        load_portfolio()

    valid_intervals = ["1m", "2m", "5m", "15m", "30m", "60m", "90m"]
    if interval not in valid_intervals:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid interval. Must be one of: {', '.join(valid_intervals)}"
        )

    today = market_today()
    target_date = today
    if date:
        try:
            target_date = date_type.fromisoformat(date)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        if target_date > today:
            raise HTTPException(status_code=400, detail="Date cannot be in the future.")

    if target_date < today:
        cache_key = f"intraday-hist_{target_date.isoformat()}_{interval}"
    else:
        cache_key = f"intraday_{target_date.isoformat()}_{interval}"
    cached = _get_api_cache(cache_key)
    if cached is not None:
        return cached

    if target_date == today:
        stale = _get_stale_api_cache(cache_key, timedelta(minutes=15))
        if stale is not None:
            _queue_intraday_refresh(
                background_tasks, cache_key, target_date, interval
            )
            return {**stale, "cache_status": "stale-refreshing"}

    try:
        if target_date == today:
            intraday_data = await asyncio.to_thread(
                portfolio.get_intraday_values, interval
            )
        else:
            intraday_data = await asyncio.to_thread(
                portfolio.get_intraday_values_for_date, target_date, interval
            )
        result = {
            "intraday": intraday_data,
            "date": target_date.isoformat(),
            "cache_status": "fresh",
        }
        _set_api_cache(cache_key, result)
        return result
    except Exception as e:
        logger.error(f"Error fetching intraday data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/intraday-multiday")
async def get_intraday_multiday(
    interval: str = Query("15m", description="Data interval (15m, 30m, 60m)"),
    days: int = Query(3, description="Number of days (1-7)"),
):
    """Get multi-day intraday portfolio performance."""
    if portfolio is None:
        load_portfolio()

    # Validate interval
    valid_intervals = ["15m", "30m", "60m"]
    if interval not in valid_intervals:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid interval. Must be one of: {', '.join(valid_intervals)}"
        )

    # Validate days
    if days < 1 or days > 8:
        raise HTTPException(
            status_code=400,
            detail="Days must be between 1 and 8"
        )

    cache_key = f"intraday-multiday_{interval}_{days}"
    cached = _get_api_cache(cache_key)
    if cached is not None:
        return cached

    try:
        data = portfolio.get_multiday_intraday_values(interval=interval, days=days)
        result = {"data": data, "interval": interval, "days": days}
        _set_api_cache(cache_key, result)
        return result
    except Exception as e:
        logger.error(f"Error fetching multi-day intraday data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/investments")
async def get_investments(
    start_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
):
    """Get historical investment amounts (cost basis) from transactions only.

    This endpoint does NOT require yfinance data - it only uses transaction records.
    Much faster and more reliable for showing investment history.
    """
    if portfolio is None:
        load_portfolio()

    try:
        from datetime import datetime

        start = None
        end = None

        if start_date:
            start = datetime.strptime(start_date, "%Y-%m-%d").date()
        if end_date:
            end = datetime.strptime(end_date, "%Y-%m-%d").date()

        history = portfolio.get_investment_history(start_date=start, end_date=end)
        return {"investments": history}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
    except Exception as e:
        logger.error(f"Error fetching investment history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/cache/stats")
async def get_cache_stats():
    """Get cache statistics."""
    try:
        stats = cache_service.get_cache_stats()
        return stats
    except Exception as e:
        logger.error(f"Error getting cache stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/cache/clear")
async def clear_cache():
    """Clear all cached data."""
    try:
        cache_service.clear_cache()
        price_service.clear_cache()
        _clear_api_cache()
        return {"message": "Cache cleared successfully"}
    except Exception as e:
        logger.error(f"Error clearing cache: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# --- Target allocation endpoints ---

class TargetUpdate(BaseModel):
    symbol: str
    target_pct: Optional[float] = None


@app.get("/api/targets")
async def get_targets():
    """Get target allocation percentages."""
    return repository.get_targets()


@app.post("/api/targets")
async def set_target(update: TargetUpdate):
    """Set or remove a target allocation percentage for a symbol."""
    repository.set_target(update.symbol, update.target_pct)
    return repository.get_targets()


# ---------------------------------------------------------------------------
# Simulator
# ---------------------------------------------------------------------------

class SimulatorAllocation(BaseModel):
    symbol: str
    weight: float


class SimulatorRequest(BaseModel):
    allocations: list[SimulatorAllocation]
    start_date: str          # YYYY-MM-DD
    end_date: str            # YYYY-MM-DD
    initial_capital: float = 0.0
    rebalance_frequency: str = "never"   # never / weekly / monthly / quarterly / annually
    data_interval_days: int = 7
    benchmark: Optional[str] = "VOO"
    dca_frequency: str = "none"          # none / weekly / biweekly / monthly
    dca_amount: float = 0.0


class AnalysisReportRequest(BaseModel):
    start_date: date_type
    end_date: date_type


@app.post("/api/simulator/run")
async def simulator_run(req: SimulatorRequest):
    """Run a portfolio back-test simulation (supports DCA)."""
    from datetime import date as date_type
    try:
        start = date_type.fromisoformat(req.start_date)
        end = date_type.fromisoformat(req.end_date)
        allocs = [{"symbol": a.symbol, "weight": a.weight} for a in req.allocations]
        result = run_simulation(
            allocations=allocs,
            start_date=start,
            end_date=end,
            initial_capital=req.initial_capital,
            rebalance_frequency=req.rebalance_frequency,
            data_interval_days=req.data_interval_days,
            benchmark=req.benchmark if req.benchmark else None,
            dca_frequency=req.dca_frequency,
            dca_amount=req.dca_amount,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Simulator error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Saved portfolio analysis
# ---------------------------------------------------------------------------

def _generate_and_save_analysis(start_date: date_type, end_date: date_type) -> dict:
    active_portfolio = portfolio
    if active_portfolio is None:
        raise RuntimeError("Portfolio is not loaded")
    report = generate_analysis_report(
        active_portfolio,
        repository.get_all_transactions(),
        start_date=start_date,
        end_date=end_date,
    )
    report = add_gpt_analysis(report)
    return repository.create_analysis_report(report)


@app.post("/api/analysis/reports")
async def create_analysis_report(req: AnalysisReportRequest):
    """Generate a GPT analysis for the requested dates and persist its snapshot."""
    if portfolio is None:
        load_portfolio()
    if req.start_date > req.end_date:
        raise HTTPException(status_code=400, detail="Start date must be on or before end date")
    if req.end_date > market_today():
        raise HTTPException(status_code=400, detail="End date cannot be in the future")
    try:
        report = await asyncio.to_thread(
            _generate_and_save_analysis,
            req.start_date,
            req.end_date,
        )
        return {"report": report}
    except AnalysisConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except AnalysisGenerationError as exc:
        logger.error("GPT analysis request failed", exc_info=True)
        raise HTTPException(status_code=502, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.error("Analysis report generation failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/analysis/reports")
async def list_analysis_reports(limit: int = Query(50, ge=1, le=100)):
    """List saved reports, newest first."""
    reports = await asyncio.to_thread(repository.list_analysis_reports, limit)
    return {"reports": reports}


@app.get("/api/analysis/reports/{report_id}")
async def get_analysis_report(report_id: int):
    """Load one previously generated report snapshot."""
    report = await asyncio.to_thread(repository.get_analysis_report, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Analysis report not found")
    return {"report": report}
