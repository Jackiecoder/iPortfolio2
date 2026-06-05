"""FastAPI application entry point."""

import logging
import mimetypes
import os
from datetime import date as date_type
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, ValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from . import news_service, repository
from .cache_service import cache_service
from .csv_parser import CSVParseError, parse_csv_content
from .db import init_schema
from .models import ActionType, Transaction
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

# API-level response cache
_api_cache: dict[str, tuple[dict, datetime]] = {}
_API_TTL = {
    "holdings": timedelta(seconds=30),
    "summary": timedelta(seconds=30),
    "daily-pnl": timedelta(seconds=60),
    "intraday": timedelta(seconds=30),
    "intraday-hist": timedelta(hours=12),
    "intraday-multiday": timedelta(seconds=60),
}


def _get_api_cache(key: str) -> Optional[dict]:
    if key in _api_cache:
        data, cached_at = _api_cache[key]
        ttl_key = key.split("_")[0]
        ttl = _API_TTL.get(ttl_key, timedelta(seconds=30))
        if datetime.now() - cached_at < ttl:
            return data
    return None


def _set_api_cache(key: str, data: dict) -> None:
    _api_cache[key] = (data, datetime.now())


def load_portfolio() -> Portfolio:
    """Load portfolio from all transactions stored in Postgres."""
    global portfolio
    portfolio = Portfolio()

    transactions = repository.get_all_transactions()
    if transactions:
        portfolio.add_transactions(transactions)
        logger.info(f"Loaded {len(transactions)} transactions from database")
    else:
        logger.info("No transactions found in database")

    return portfolio


@app.on_event("startup")
async def startup_event():
    """Apply DB schema (idempotent) and load portfolio data on startup."""
    if not API_TOKEN:
        logger.warning("API_TOKEN not set — authentication is DISABLED (dev mode).")
    init_schema()
    load_portfolio()


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
        holdings = portfolio.get_holdings(fetch_prices=True)
        result = {
            "holdings": [
                {
                    "symbol": h.symbol,
                    "quantity": float(h.quantity),
                    "cost_basis": float(h.cost_basis),
                    "avg_cost": float(h.avg_cost),
                    "current_price": float(h.current_price) if h.current_price else None,
                    "market_value": float(h.market_value) if h.market_value else None,
                    "unrealized_pnl": float(h.unrealized_pnl) if h.unrealized_pnl else None,
                    "pnl_percent": float(h.pnl_percent) if h.pnl_percent else None,
                    "daily_change_percent": float(h.daily_change_percent) if h.daily_change_percent else None,
                    "daily_change_amount": float(h.daily_change_amount) if h.daily_change_amount else None,
                    "holding_days": h.holding_days,
                    "annualized_return": float(h.annualized_return) if h.annualized_return else None,
                    "weighted_annualized_return": float(h.weighted_annualized_return) if h.weighted_annualized_return else None,
                    "long_term_quantity": float(h.long_term_quantity) if h.long_term_quantity is not None else None,
                    "short_term_quantity": float(h.short_term_quantity) if h.short_term_quantity is not None else None,
                    "lt_unrealized_pnl": float(h.lt_unrealized_pnl) if h.lt_unrealized_pnl is not None else None,
                    "st_unrealized_pnl": float(h.st_unrealized_pnl) if h.st_unrealized_pnl is not None else None,
                    "realized_pnl": float(h.realized_pnl) if h.realized_pnl is not None else None,
                    "lt_realized_pnl": float(h.lt_realized_pnl) if h.lt_realized_pnl is not None else None,
                    "st_realized_pnl": float(h.st_realized_pnl) if h.st_realized_pnl is not None else None,
                    "total_pnl": float(h.total_pnl) if h.total_pnl is not None else None,
                    "total_pnl_percent": float(h.total_pnl_percent) if h.total_pnl_percent is not None else None,
                    "ytd_pnl": float(h.ytd_pnl) if h.ytd_pnl is not None else None,
                    "ytd_pnl_percent": float(h.ytd_pnl_percent) if h.ytd_pnl_percent is not None else None,
                    "lt_ytd_pnl": float(h.lt_ytd_pnl) if h.lt_ytd_pnl is not None else None,
                    "st_ytd_pnl": float(h.st_ytd_pnl) if h.st_ytd_pnl is not None else None,
                }
                for h in holdings
            ]
        }
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
        summary = portfolio.get_portfolio_summary(fetch_prices=True)

        # YTD P&L: change in (investment_value - cost_basis) since Jan 1
        ytd_pnl = 0.0
        ytd_pnl_percent = 0.0
        ytd_lt_pnl = None
        ytd_st_pnl = None
        today = market_today()
        jan1 = date_type(today.year, 1, 1)
        ytd_history = portfolio.get_historical_values(
            start_date=jan1, end_date=today
        )
        if ytd_history and len(ytd_history) >= 1:
            first = ytd_history[0]
            first_inv_pnl = float(first["investment_value"]) - float(first["cost_basis"])
            # Use live unrealized P&L for the "now" leg so YTD P&L tracks intraday price moves
            last_inv_pnl = float(summary.total_unrealized_pnl)
            ytd_pnl = last_inv_pnl - first_inv_pnl
            first_total = float(first["value"])
            if first_total > 0:
                ytd_pnl_percent = ytd_pnl / first_total * 100

        # YTD LT/ST P&L: compute LT/ST unrealized P&L at Jan 1, diff against today
        if summary.lt_unrealized_pnl is not None and summary.st_unrealized_pnl is not None:
            jan1_lt, jan1_st = portfolio.get_lt_st_unrealized_pnl_at_date(jan1)
            ytd_lt_pnl = float(summary.lt_unrealized_pnl) - float(jan1_lt)
            ytd_st_pnl = float(summary.st_unrealized_pnl) - float(jan1_st)

        result = {
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
            "weighted_annualized_return": float(summary.weighted_annualized_return) if summary.weighted_annualized_return else None,
            "ytd_pnl": ytd_pnl,
            "ytd_pnl_percent": ytd_pnl_percent,
            "ytd_lt_pnl": ytd_lt_pnl,
            "ytd_st_pnl": ytd_st_pnl,
            "holdings": [
                {
                    "symbol": h.symbol,
                    "quantity": float(h.quantity),
                    "cost_basis": float(h.cost_basis),
                    "avg_cost": float(h.avg_cost),
                    "current_price": float(h.current_price) if h.current_price else None,
                    "market_value": float(h.market_value) if h.market_value else None,
                    "unrealized_pnl": float(h.unrealized_pnl) if h.unrealized_pnl else None,
                    "pnl_percent": float(h.pnl_percent) if h.pnl_percent else None,
                    "daily_change_percent": float(h.daily_change_percent) if h.daily_change_percent else None,
                    "daily_change_amount": float(h.daily_change_amount) if h.daily_change_amount else None,
                    "holding_days": h.holding_days,
                    "annualized_return": float(h.annualized_return) if h.annualized_return else None,
                    "weighted_annualized_return": float(h.weighted_annualized_return) if h.weighted_annualized_return else None,
                    "long_term_quantity": float(h.long_term_quantity) if h.long_term_quantity is not None else None,
                    "short_term_quantity": float(h.short_term_quantity) if h.short_term_quantity is not None else None,
                    "lt_unrealized_pnl": float(h.lt_unrealized_pnl) if h.lt_unrealized_pnl is not None else None,
                    "st_unrealized_pnl": float(h.st_unrealized_pnl) if h.st_unrealized_pnl is not None else None,
                    "realized_pnl": float(h.realized_pnl) if h.realized_pnl is not None else None,
                    "lt_realized_pnl": float(h.lt_realized_pnl) if h.lt_realized_pnl is not None else None,
                    "st_realized_pnl": float(h.st_realized_pnl) if h.st_realized_pnl is not None else None,
                    "total_pnl": float(h.total_pnl) if h.total_pnl is not None else None,
                    "total_pnl_percent": float(h.total_pnl_percent) if h.total_pnl_percent is not None else None,
                    "ytd_pnl": float(h.ytd_pnl) if h.ytd_pnl is not None else None,
                    "ytd_pnl_percent": float(h.ytd_pnl_percent) if h.ytd_pnl_percent is not None else None,
                    "lt_ytd_pnl": float(h.lt_ytd_pnl) if h.lt_ytd_pnl is not None else None,
                    "st_ytd_pnl": float(h.st_ytd_pnl) if h.st_ytd_pnl is not None else None,
                }
                for h in summary.holdings
            ],
            "dividend_summaries": [
                {
                    "symbol": d.symbol,
                    "total_amount": float(d.total_amount),
                    "payment_count": d.payment_count,
                }
                for d in summary.dividend_summaries
            ],
        }
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

        history = portfolio.get_historical_values(start_date=start, end_date=end)
        realized_by_year = portfolio.get_realized_pnl_by_year()
        return {"performance": history, "realized_by_year": realized_by_year}
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

    try:
        data = portfolio.get_daily_pnl_history(num_days=num_days)
        result = {"daily_pnl": data}
        _set_api_cache(cache_key, result)
        return result
    except Exception as e:
        logger.error(f"Error fetching daily P&L: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _held_symbols() -> list[str]:
    """Current holding symbols (no price fetch), for highlighting in news."""
    if portfolio is None:
        load_portfolio()
    try:
        holdings = portfolio.get_holdings(fetch_prices=False)
        return sorted({h.symbol for h in holdings})
    except Exception as e:
        logger.warning("could not list held symbols: %s", e)
        return []


@app.get("/api/news/intraday-recap")
async def news_intraday_recap(date: str = Query(..., description="YYYY-MM-DD")):
    """AI intraday market-narrative recap for a date, plus the user's held
    tickers so the frontend can highlight relevant names."""
    try:
        date_type.fromisoformat(date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
    recap = news_service.get_intraday_recaps(date)
    recap["held_tickers"] = _held_symbols()
    return recap


@app.get("/api/news/stock")
async def news_stock(ticker: str = Query(..., description="Stock ticker symbol")):
    """Recent news headlines for a single ticker."""
    if not ticker.strip():
        raise HTTPException(status_code=400, detail="ticker is required")
    return news_service.get_stock_news(ticker)


@app.get("/api/dividends")
async def get_dividends():
    """Get dividend summary and history."""
    if portfolio is None:
        load_portfolio()

    try:
        summaries = portfolio.get_dividend_summaries()
        total = portfolio.get_total_dividends()

        return {
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
    except Exception as e:
        logger.error(f"Error fetching dividends: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/sold")
async def get_sold_assets():
    """Get summary of sold assets with realized P&L."""
    if portfolio is None:
        load_portfolio()

    try:
        sold_assets = portfolio.get_sold_assets()
        total_pnl = sum(s["pnl"] for s in sold_assets)
        total_proceeds = sum(s["proceeds"] for s in sold_assets)
        total_cost_basis = sum(s["cost_basis"] for s in sold_assets)

        return {
            "sold_assets": sold_assets,
            "total_pnl": total_pnl,
            "total_proceeds": total_proceeds,
            "total_cost_basis": total_cost_basis,
        }
    except Exception as e:
        logger.error(f"Error fetching sold assets: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _refresh_after_write() -> None:
    """Reload the portfolio and drop the API response cache after a DB write."""
    load_portfolio()
    _api_cache.clear()


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


@app.post("/api/transactions")
async def create_transaction(txn_in: TransactionCreate):
    """Add a single transaction to the database."""
    try:
        # Reuse Transaction's validation + missing-value derivation.
        txn = Transaction(
            date=txn_in.date,
            asset=txn_in.asset,
            action=txn_in.action,
            amount=txn_in.amount,
            quantity=txn_in.quantity,
            ave_price=txn_in.ave_price,
            source=txn_in.source,
            comment=txn_in.comment,
        )
    except ValidationError as e:
        msgs = "; ".join(err.get("msg", "invalid") for err in e.errors())
        raise HTTPException(status_code=400, detail=msgs)

    try:
        new_id = repository.insert_transaction(txn, broker=txn_in.broker)
        _refresh_after_write()
        return {
            "id": new_id,
            "message": f"Added {txn.action.value} {txn.asset} on {txn.date.isoformat()}",
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

        _refresh_after_write()

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
async def reload_portfolio(clear_history_cache: bool = Query(False, description="Also clear historical data cache")):
    """Reload portfolio from CSV files."""
    try:
        load_portfolio()
        price_service.clear_cache()
        _api_cache.clear()
        if clear_history_cache:
            cache_service.clear_cache()
        return {"message": "Portfolio reloaded successfully"}
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

    _refresh_after_write()
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
            key=lambda t: t.date,
            reverse=True,
        )[:limit]
        result = {
            "symbol": symbol.upper(),
            "transactions": [
                {
                    "date": t.date.isoformat(),
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
        cache_key = f"intraday_{interval}"
    cached = _get_api_cache(cache_key)
    if cached is not None:
        return cached

    try:
        if target_date == today:
            intraday_data = portfolio.get_intraday_values(interval=interval)
        else:
            intraday_data = portfolio.get_intraday_values_for_date(target_date, interval=interval)
        result = {"intraday": intraday_data, "date": target_date.isoformat()}
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
