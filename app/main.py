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
from .split_service import split_service
from .simulator import run_simulation
from .ticker_technicals import ticker_technicals

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

# Global portfolio instance (rebuilt only when the Postgres ledger changes)
portfolio: Optional[Portfolio] = None
_portfolio_generation = 0

# API-level response cache
_api_cache: dict[str, tuple[dict, datetime]] = {}
_api_cache_lock = threading.Lock()
_api_refreshing: set[str] = set()
_dashboard_tasks: dict[tuple, asyncio.Task] = {}
_api_cache_epoch = 0
_market_refresh_lock = threading.Lock()
_market_refresh_task: Optional[asyncio.Task] = None
_today_refresh_task: Optional[asyncio.Task] = None
_today_snapshot_stamp: Optional[tuple[Portfolio, int, datetime, dict]] = None
_ledger_reload_task: Optional[asyncio.Task] = None
_ledger_write_tasks: set[asyncio.Task] = set()


def _start_ledger_reload() -> asyncio.Task:
    """Share one ledger rebuild; a newer write supersedes an unfinished rebuild."""
    global _ledger_reload_task
    if _ledger_reload_task is None or _ledger_reload_task.done():
        async def rebuild():
            global portfolio
            while True:
                generation = _portfolio_generation
                loaded = await asyncio.to_thread(_read_portfolio)
                with _api_cache_lock:
                    if generation != _portfolio_generation:
                        continue
                    portfolio = loaded
                return loaded

        _ledger_reload_task = asyncio.create_task(rebuild(), name="reload-ledger")
        def finished(task):
            if not task.cancelled() and task.exception() is not None:
                logger.error("Saved ledger could not be reloaded: %s", task.exception())
        _ledger_reload_task.add_done_callback(finished)
    return _ledger_reload_task


async def _ensure_portfolio_ready() -> None:
    """Readers wait for the committed ledger, never for market/history refreshes."""
    while portfolio is None:
        try:
            await asyncio.shield(_start_ledger_reload())
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Transactions are saved; portfolio update failed. Retry refresh.") from exc


def _queue_ledger_reload() -> None:
    global portfolio, _portfolio_generation
    # Invalidate before yielding so no post-commit request can serve the old ledger.
    with _api_cache_lock:
        portfolio = None
        _portfolio_generation += 1
    _clear_api_cache()
    _start_ledger_reload()


async def _commit_ledger_write(writer, *args, **kwargs):
    """Finish commit + invalidation even if the requesting browser disconnects."""
    async def commit():
        result = await asyncio.to_thread(writer, *args, **kwargs)
        if result is not False:
            _queue_ledger_reload()
        return result

    task = asyncio.create_task(commit(), name="commit-ledger")
    _ledger_write_tasks.add(task)
    def finished(done):
        _ledger_write_tasks.discard(done)
        if not done.cancelled() and done.exception() is not None:
            logger.error("Ledger write failed: %s", done.exception())
    task.add_done_callback(finished)
    return await asyncio.shield(task)


def _configured_refresh_interval() -> int:
    try:
        return max(15, int(os.environ.get("MARKET_REFRESH_INTERVAL_SECONDS", "300")))
    except ValueError:
        logger.warning("Invalid MARKET_REFRESH_INTERVAL_SECONDS; using 300 seconds")
        return 300


MARKET_REFRESH_INTERVAL_SECONDS = _configured_refresh_interval()
_API_TTL = {
    # Other dashboard data is computed on demand; Today has its own collector.
    "holdings": timedelta(minutes=2),
    "positions": timedelta(days=1),
    "summary": timedelta(minutes=2),
    "performance": timedelta(minutes=30),
    "daily-pnl": timedelta(minutes=15),
    "dividends": timedelta(days=1),
    "sold": timedelta(days=1),
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
    global _today_snapshot_stamp, _api_cache_epoch
    with _api_cache_lock:
        _api_cache_epoch += 1
        _api_cache.clear()
        _today_snapshot_stamp = None


class _DashboardSuperseded(Exception):
    """A ledger reload invalidated a computation before it completed."""


async def _dashboard_response(key: str, builder, wait_for_fresh: bool = False) -> dict:
    """Reuse snapshots and share one refresh, without publishing pre-write data."""
    while True:
        await _ensure_portfolio_ready()
        cached = _get_api_cache(key)
        if cached is not None:
            return cached
        active_portfolio = portfolio
        generation = _portfolio_generation
        epoch = _api_cache_epoch
        task_key = (key, generation, epoch)
        task = _dashboard_tasks.get(task_key)
        if task is None:
            async def compute(active=active_portfolio, gen=generation, cache_epoch=epoch):
                started = datetime.now(MARKET_TZ)
                data = await asyncio.to_thread(builder, active)
                result = {
                    **data, "cache_status": "fresh",
                    "computed_at": datetime.now(MARKET_TZ).isoformat(),
                }
                with _api_cache_lock:
                    if (active is not portfolio or gen != _portfolio_generation
                            or cache_epoch != _api_cache_epoch):
                        raise _DashboardSuperseded()
                    _api_cache[key] = (result, datetime.now())
                logger.info("Dashboard %s computed in %.2fs", key,
                            (datetime.now(MARKET_TZ) - started).total_seconds())
                return result

            task = asyncio.create_task(compute(), name=f"dashboard-{key}")
            _dashboard_tasks[task_key] = task
            def finished(done, identity=task_key):
                if _dashboard_tasks.get(identity) is done:
                    _dashboard_tasks.pop(identity, None)
                # Stale-response refreshes can outlive their requesting browser.
                if not done.cancelled():
                    error = done.exception()
                    if error and not isinstance(error, _DashboardSuperseded):
                        logger.error("Dashboard refresh failed for %s: %s", identity[0], error)
            task.add_done_callback(finished)

        stale = _get_stale_api_cache(key, timedelta(days=1))
        if stale is not None and not wait_for_fresh:
            with _api_cache_lock:
                cached_at = _api_cache.get(key, ({}, datetime.now()))[1]
            return {**stale, "cache_status": "stale",
                    "computed_at": stale.get("computed_at") or cached_at.astimezone(MARKET_TZ).isoformat()}
        try:
            return await asyncio.shield(task)
        except _DashboardSuperseded:
            # A response begun before a transaction write must use the new ledger.
            continue


def _build_positions_response(active_portfolio: Portfolio) -> dict:
    """Ledger-only holdings: no live quote or historical-market-data requests."""
    holdings = []
    for holding in active_portfolio.get_holdings(fetch_prices=False):
        item = _holding_to_dict(holding)
        item["prices_pending"] = True
        # Total return is not known until both realized and unrealized are known.
        item["total_pnl"] = item["total_pnl_percent"] = None
        holdings.append(item)
    return {"holdings": holdings}


@app.get("/api/positions")
async def get_positions():
    await _ensure_portfolio_ready()
    return await _dashboard_response(
        f"positions_{market_today().isoformat()}", _build_positions_response
    )


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
        "ytd_basis": float(holding.ytd_basis) if holding.ytd_basis is not None else None,
        "lt_ytd_pnl": float(holding.lt_ytd_pnl) if holding.lt_ytd_pnl is not None else None,
        "st_ytd_pnl": float(holding.st_ytd_pnl) if holding.st_ytd_pnl is not None else None,
    }


def _build_summary_response(active_portfolio: Portfolio) -> dict:
    """Calculate the full live summary without consulting the API cache."""
    summary = active_portfolio.get_portfolio_summary(fetch_prices=True)

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
        "ytd_pnl": float(summary.ytd_pnl) if summary.ytd_pnl is not None else None,
        "ytd_pnl_percent": float(summary.ytd_pnl_percent) if summary.ytd_pnl_percent is not None else None,
        "ytd_basis": float(summary.ytd_basis) if summary.ytd_basis is not None else None,
        "ytd_lt_pnl": float(summary.ytd_lt_pnl) if summary.ytd_lt_pnl is not None else None,
        "ytd_st_pnl": float(summary.ytd_st_pnl) if summary.ytd_st_pnl is not None else None,
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
        "annual_asset_pnl_by_year": active_portfolio.get_annual_asset_pnl_by_year(
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


def _build_today_snapshot() -> dict:
    """Fetch/persist 1m bars and publish Today without rebuilding other pages."""
    global _today_snapshot_stamp
    started_at = datetime.now(MARKET_TZ)
    active_portfolio = portfolio
    generation = _portfolio_generation
    today = market_today()
    if active_portfolio is None:
        raise RuntimeError("Portfolio is not loaded")
    metadata = {}
    intraday = active_portfolio.get_intraday_values(
        "1m", refresh_prices=True, use_live_quotes=False, refresh_metadata=metadata
    )
    result = {
        "intraday": intraday,
        "date": today.isoformat(),
        "cache_status": "partial" if metadata.get("stale_symbols") else "fresh",
        "computed_at": datetime.now(MARKET_TZ).isoformat(),
        **metadata,
    }
    with _api_cache_lock:
        if (generation != _portfolio_generation or active_portfolio is not portfolio
                or today != market_today()):
            return {"status": "superseded"}
        _api_cache[f"intraday_{today.isoformat()}_1m"] = (result, datetime.now())
        _today_snapshot_stamp = (active_portfolio, generation, started_at, result)
    logger.info(
        "Today snapshot refreshed: %s points in %.2fs",
        len(intraday), (datetime.now(MARKET_TZ) - started_at).total_seconds(),
    )
    return result


def _reusable_today_snapshot() -> Optional[dict]:
    """Reuse a successful check begun in this minute for the same portfolio.

    Use fetch start, not completion or a synthetic chart endpoint: a request
    spanning a minute boundary must not suppress the next minute's check.
    Epoch minutes also distinguish repeated wall-clock minutes at DST fall-back.
    """
    stamp = _today_snapshot_stamp
    if stamp is None:
        return None
    active_portfolio, generation, started_at, result = stamp
    now = datetime.now(MARKET_TZ)
    if (
        active_portfolio is portfolio
        and generation == _portfolio_generation
        and int(started_at.timestamp() // 60) == int(now.timestamp() // 60)
        and result.get("cache_status") == "fresh"
        and not result.get("stale_symbols")
        and result.get("intraday")
    ):
        return {**result, "refresh_skipped": True}
    return None


async def _refresh_today_snapshot() -> dict:
    """Share a running fetch between timer/manual requests, even on disconnect."""
    global _today_refresh_task
    for _ in range(2):
        await _ensure_portfolio_ready()
        if _today_refresh_task is None or _today_refresh_task.done():
            cached = _reusable_today_snapshot()
            if cached is not None:
                return cached
            _today_refresh_task = asyncio.create_task(asyncio.to_thread(_build_today_snapshot))
        result = await asyncio.shield(_today_refresh_task)
        if result.get("status") != "superseded":
            return result
    raise HTTPException(status_code=409, detail="Portfolio changed during refresh; please retry.")


@app.post("/api/intraday/refresh")
async def refresh_today_intraday():
    """Wait only for fresh minute bars and the Today chart, retaining history."""
    try:
        return await _refresh_today_snapshot()
    except HTTPException:
        raise
    except Exception:
        logger.exception("Today refresh failed")
        raise HTTPException(status_code=503, detail="Today data could not be refreshed. Please retry.")


async def _market_refresh_loop() -> None:
    """Refresh on a fixed start-to-start cadence, including calculation time."""
    loop = asyncio.get_running_loop()
    next_refresh_at = loop.time() + MARKET_REFRESH_INTERVAL_SECONDS
    while True:
        await asyncio.sleep(max(0, next_refresh_at - loop.time()))
        try:
            await _refresh_today_snapshot()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Scheduled market refresh failed")
        finally:
            next_refresh_at += MARKET_REFRESH_INTERVAL_SECONDS
            while next_refresh_at <= loop.time():
                next_refresh_at += MARKET_REFRESH_INTERVAL_SECONDS


def _read_portfolio() -> Portfolio:
    """Build a ledger without exposing partially replayed transactions."""
    loaded = Portfolio()

    transactions = repository.get_all_transactions()
    if transactions:
        loaded.add_transactions(transactions)
        logger.info(f"Loaded {len(transactions)} transactions from database")
    else:
        logger.info("No transactions found in database")
    return loaded


def load_portfolio() -> Portfolio:
    """Load portfolio from all transactions stored in Postgres."""
    global portfolio, _portfolio_generation
    loaded = _read_portfolio()
    portfolio = loaded
    _portfolio_generation += 1
    _clear_api_cache()

    return portfolio


@app.on_event("startup")
async def startup_event():
    """Prepare Today first; other pages compute their responses on demand."""
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
    await _refresh_today_snapshot()
    _market_refresh_task = asyncio.create_task(
        _market_refresh_loop(), name="market-snapshot-refresh"
    )


@app.on_event("shutdown")
async def shutdown_event():
    """Stop the scheduled refresh cleanly during deploys and local restarts."""
    global _market_refresh_task
    if _ledger_write_tasks:
        await asyncio.gather(*list(_ledger_write_tasks), return_exceptions=True)
    if _ledger_reload_task is not None:
        await asyncio.gather(_ledger_reload_task, return_exceptions=True)
    if _dashboard_tasks:
        await asyncio.gather(*list(_dashboard_tasks.values()), return_exceptions=True)
    if _market_refresh_task is None:
        return
    _market_refresh_task.cancel()
    try:
        await _market_refresh_task
    except asyncio.CancelledError:
        pass
    _market_refresh_task = None
    # A shielded collector may still be persisting bars after its caller exits.
    if _today_refresh_task is not None:
        await asyncio.gather(_today_refresh_task, return_exceptions=True)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Serve the main dashboard page."""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/holdings")
async def get_holdings(wait_for_fresh: bool = False):
    """Share the summary's live pricing work; ledger-only data is /api/positions."""
    summary = await get_summary(wait_for_fresh=wait_for_fresh)
    return {key: value for key, value in summary.items()
            if key in {"holdings", "computed_at", "cache_status"}}


@app.get("/api/summary")
async def get_summary(wait_for_fresh: bool = False):
    await _ensure_portfolio_ready()
    try:
        return await _dashboard_response("summary", _build_summary_response, wait_for_fresh)
    except Exception as e:
        logger.exception("Error fetching summary")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/performance")
async def get_performance(
    start_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    wait_for_fresh: bool = False,
):
    """All chart ranges share one history calculation and slice it in memory."""
    await _ensure_portfolio_ready()
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d").date() if start_date else None
        end = datetime.strptime(end_date, "%Y-%m-%d").date() if end_date else None
        if start and end and start > end:
            raise ValueError("Start date must not be after end date")
        result = await _dashboard_response(
            _performance_cache_key(None, None), _build_performance_response, wait_for_fresh
        )
        if start is not None or end is not None:
            result = _slice_performance_response(result, start or date_type.min, end or date_type.max)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
    except Exception as e:
        logger.exception("Error fetching performance")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/daily-pnl")
async def get_daily_pnl(num_days: int = 42, wait_for_fresh: bool = False):
    """Short and monthly panels share the same computed daily series."""
    await _ensure_portfolio_ready()
    if num_days < 1 or num_days > 3660:
        raise HTTPException(status_code=400, detail="num_days must be between 1 and 3660")
    window = max(400, num_days)
    try:
        result = await _dashboard_response(
            f"daily-pnl_{window}",
            lambda active: {"daily_pnl": active.get_daily_pnl_history(num_days=window)},
            wait_for_fresh,
        )
        if num_days != window:
            result = {**result, "daily_pnl": result["daily_pnl"][-num_days:]}
        return result
    except Exception as e:
        logger.exception("Error fetching daily P&L")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dividends")
async def get_dividends():
    """Get dividend summary and history."""
    await _ensure_portfolio_ready()

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
    await _ensure_portfolio_ready()

    try:
        return await _dashboard_response("sold", _build_sold_response)
    except Exception as e:
        logger.error(f"Error fetching sold assets: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
        new_id = await _commit_ledger_write(repository.insert_transaction, txn, broker=txn_in.broker)
    except Exception as e:
        logger.error(f"Error adding transaction: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "id": new_id,
        "message": (
            f"Added {txn.action.value} {txn.asset} on "
            f"{txn.effective_executed_at.strftime('%Y-%m-%d %H:%M')} ET"
        ),
        "transaction": {
            **txn.model_dump(mode="json"), "id": new_id, "broker": txn_in.broker,
            "amount": float(txn.amount) if txn.amount is not None else None,
            "quantity": float(txn.quantity) if txn.quantity is not None else None,
            "ave_price": float(txn.ave_price) if txn.ave_price is not None else None,
            "transaction_time": txn.effective_executed_at.strftime('%H:%M'),
        },
        "refresh_pending": True,
    }


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
        count = await _commit_ledger_write(repository.insert_transactions, transactions)

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
        deleted = await _commit_ledger_write(repository.delete_transaction, txn_id)
    except Exception as e:
        logger.error(f"Error deleting transaction {txn_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    if not deleted:
        raise HTTPException(status_code=404, detail=f"Transaction {txn_id} not found")

    return {"id": txn_id, "message": f"Deleted transaction {txn_id}"}


@app.get("/api/transactions/{symbol}")
async def get_transactions(
    symbol: str,
    limit: int = Query(20, description="Max transactions to return"),
    actions: Optional[str] = Query(None, description="Comma-separated action types to filter (e.g. BUY,SELL)"),
):
    """Get recent transactions for a specific symbol."""
    await _ensure_portfolio_ready()

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


_TICKER_HISTORY_PERIOD_DAYS = {
    "1M": 31,
    "3M": 93,
    "6M": 186,
    "1Y": 366,
    "3Y": 365 * 3 + 1,
    "5Y": 365 * 5 + 2,
}


def _sample_ticker_prices(
    prices: dict[date_type, Decimal], granularity: str
) -> list[dict]:
    """Return the last available close in each requested time bucket."""
    if granularity == "daily":
        sampled = sorted(prices.items())
    else:
        buckets: dict[tuple[int, ...], tuple[date_type, Decimal]] = {}
        for price_date, close in sorted(prices.items()):
            if granularity == "weekly":
                iso_year, iso_week, _ = price_date.isocalendar()
                key = (iso_year, iso_week)
            else:
                key = (price_date.year, price_date.month)
            buckets[key] = (price_date, close)
        sampled = list(buckets.values())

    return [
        {"date": price_date.isoformat(), "close": float(close)}
        for price_date, close in sampled
    ]


@app.get("/api/ticker-technicals")
async def get_ticker_technicals(symbol: str = Query(..., min_length=1, max_length=32)):
    """Latest market quote versus 50/200 completed daily closing prices."""
    await _ensure_portfolio_ready()
    symbol = symbol.strip().upper()
    if symbol == "CASH" or symbol not in {t.asset for t in portfolio._transactions}:
        raise HTTPException(status_code=404, detail="Ticker is not in the portfolio ledger")
    try:
        return await asyncio.to_thread(ticker_technicals.get, symbol)
    except Exception:
        logger.exception("Unable to load moving averages for %s", symbol)
        raise HTTPException(status_code=503, detail="Price history is temporarily unavailable. Please try again.")


@app.get("/api/ticker-history")
async def get_ticker_history(
    symbol: Optional[str] = Query(None, description="Portfolio ticker symbol"),
    period: str = Query("6M", description="1M, 3M, 6M, 1Y, 3Y, 5Y, or ALL"),
):
    """Return a ticker price series with BUY/SELL markers from the ledger."""
    await _ensure_portfolio_ready()

    valid_periods = {*_TICKER_HISTORY_PERIOD_DAYS, "ALL"}
    period = period.upper()
    if period not in valid_periods:
        raise HTTPException(status_code=400, detail=f"Invalid period: {period}")

    all_transactions = portfolio._transactions
    available_symbols = sorted({t.asset for t in all_transactions if t.asset != "CASH"})
    active_symbols = sorted(
        holding.symbol
        for holding in portfolio.get_holdings(fetch_prices=False)
        if holding.symbol != "CASH"
    )
    active_symbol_set = set(active_symbols)
    archived_symbols = [
        symbol for symbol in available_symbols if symbol not in active_symbol_set
    ]
    if not available_symbols:
        return {
            "symbol": None,
            "period": period,
            "granularity": "daily",
            "available_symbols": [],
            "active_symbols": [],
            "archived_symbols": [],
            "prices": [],
            "transactions": [],
        }

    selected_symbol = (symbol or "").strip().upper()
    if not selected_symbol:
        selected_symbol = active_symbols[0] if active_symbols else available_symbols[0]
    if selected_symbol not in available_symbols:
        raise HTTPException(
            status_code=404,
            detail=f"Ticker {selected_symbol} is not in the portfolio ledger",
        )

    symbol_transactions = [t for t in all_transactions if t.asset == selected_symbol]
    end_date = market_today()
    if period == "ALL":
        start_date = min(t.date for t in symbol_transactions)
    else:
        start_date = end_date - timedelta(days=_TICKER_HISTORY_PERIOD_DAYS[period])

    if period in {"1M", "3M", "6M"}:
        granularity = "daily"
    elif period == "1Y":
        granularity = "weekly"
    else:
        granularity = "monthly"

    prices = await asyncio.to_thread(
        price_service.get_historical_prices,
        selected_symbol,
        start_date,
        end_date,
    )
    sampled_prices = _sample_ticker_prices(prices, granularity)

    markers = []
    for txn in symbol_transactions:
        if txn.action not in {ActionType.BUY, ActionType.SELL}:
            continue
        if txn.date < start_date or txn.date > end_date:
            continue
        original_price = txn.ave_price
        if original_price is None and txn.amount is not None and txn.quantity:
            original_price = abs(txn.amount / txn.quantity)
        if original_price is None:
            continue
        factor = await asyncio.to_thread(
            split_service.get_adjustment_factor,
            selected_symbol,
            txn.date,
            end_date,
        )
        adjusted_price = original_price / factor if factor else original_price
        markers.append({
            "date": txn.date.isoformat(),
            "executed_at": txn.effective_executed_at.isoformat(),
            "action": txn.action.value,
            "price": float(adjusted_price),
            "execution_price": float(original_price),
            "quantity": float(txn.quantity) if txn.quantity is not None else None,
            "amount": float(txn.amount) if txn.amount is not None else None,
        })

    return {
        "symbol": selected_symbol,
        "period": period,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "granularity": granularity,
        "available_symbols": available_symbols,
        "active_symbols": active_symbols,
        "archived_symbols": archived_symbols,
        "prices": sampled_prices,
        "transactions": markers,
    }


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
    await _ensure_portfolio_ready()

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
            if interval == "1m":
                background_tasks.add_task(_refresh_today_snapshot)
            else:
                _queue_intraday_refresh(
                    background_tasks, cache_key, target_date, interval
                )
            return {**stale, "cache_status": "stale-refreshing"}

    try:
        if target_date == today:
            if interval == "1m":
                return await _refresh_today_snapshot()
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
    await _ensure_portfolio_ready()

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
        data = await asyncio.to_thread(
            portfolio.get_multiday_intraday_values, interval=interval, days=days
        )
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
    await _ensure_portfolio_ready()

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
    await _ensure_portfolio_ready()
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
