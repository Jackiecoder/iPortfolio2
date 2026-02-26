"""FastAPI application entry point."""

import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from .cache_service import cache_service
from .csv_parser import CSVParseError, parse_csv_content, parse_csv_file
from .portfolio import Portfolio
from .price_service import price_service

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Templates
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# Global portfolio instance (reloaded from CSV files)
portfolio: Optional[Portfolio] = None

# API-level response cache
_api_cache: dict[str, tuple[dict, datetime]] = {}
_API_TTL = {
    "holdings": timedelta(seconds=30),
    "summary": timedelta(seconds=30),
    "daily-pnl": timedelta(seconds=60),
    "intraday": timedelta(seconds=30),
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
    """Load portfolio from all CSV files in the data directory (including subfolders)."""
    global portfolio
    portfolio = Portfolio()

    # Recursively find all CSV files in data directory and subdirectories
    csv_files = list(DATA_DIR.glob("**/*.csv"))
    if not csv_files:
        logger.info("No CSV files found in data directory")
        return portfolio

    # Collect all transactions from all files first
    all_transactions = []
    for csv_file in csv_files:
        try:
            transactions = parse_csv_file(csv_file)
            all_transactions.extend(transactions)
            # Show relative path from data directory
            relative_path = csv_file.relative_to(DATA_DIR)
            logger.info(f"Loaded {len(transactions)} transactions from {relative_path}")
        except CSVParseError as e:
            relative_path = csv_file.relative_to(DATA_DIR)
            logger.error(f"Error parsing {relative_path}: {e}")
        except Exception as e:
            relative_path = csv_file.relative_to(DATA_DIR)
            logger.error(f"Unexpected error loading {relative_path}: {e}")

    # Add all transactions at once (will be sorted globally by date)
    if all_transactions:
        portfolio.add_transactions(all_transactions)
        logger.info(f"Total: {len(all_transactions)} transactions loaded and sorted by date")

    return portfolio


@app.on_event("startup")
async def startup_event():
    """Load portfolio data on startup."""
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
        result = {
            "total_cost_basis": float(summary.total_cost_basis),
            "total_market_value": float(summary.total_market_value),
            "investment_market_value": float(summary.investment_market_value),
            "total_unrealized_pnl": float(summary.total_unrealized_pnl),
            "total_realized_pnl": float(summary.total_realized_pnl),
            "total_pnl": float(summary.total_pnl),
            "total_pnl_percent": float(summary.total_pnl_percent),
            "total_dividends": float(summary.total_dividends),
            "total_fees": float(summary.total_fees),
            "all_time_cost_basis": float(summary.all_time_cost_basis),
            "weighted_annualized_return": float(summary.weighted_annualized_return) if summary.weighted_annualized_return else None,
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
        return {"performance": history}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
    except Exception as e:
        logger.error(f"Error fetching performance: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/daily-pnl")
async def get_daily_pnl():
    """Get daily P&L for the last 14 days using EST midnight as the daily boundary."""
    if portfolio is None:
        load_portfolio()

    cached = _get_api_cache("daily-pnl")
    if cached is not None:
        return cached

    try:
        data = portfolio.get_daily_pnl_history(num_days=15)
        result = {"daily_pnl": data}
        _set_api_cache("daily-pnl", result)
        return result
    except Exception as e:
        logger.error(f"Error fetching daily P&L: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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


@app.post("/api/upload")
async def upload_csv(file: UploadFile = File(...)):
    """Upload a CSV file with transactions."""
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="File must be a CSV file")

    try:
        content = await file.read()
        content_str = content.decode("utf-8-sig")

        # Validate the CSV content
        transactions = parse_csv_content(content_str)

        # Save the file
        file_path = DATA_DIR / file.filename
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content_str)

        # Reload portfolio
        load_portfolio()

        return {
            "message": f"Successfully uploaded {file.filename}",
            "transactions_count": len(transactions),
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
):
    """Get intraday portfolio performance for today."""
    if portfolio is None:
        load_portfolio()

    # Validate interval
    valid_intervals = ["1m", "2m", "5m", "15m", "30m", "60m", "90m"]
    if interval not in valid_intervals:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid interval. Must be one of: {', '.join(valid_intervals)}"
        )

    cache_key = f"intraday_{interval}"
    cached = _get_api_cache(cache_key)
    if cached is not None:
        return cached

    try:
        intraday_data = portfolio.get_intraday_values(interval=interval)
        result = {"intraday": intraday_data}
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
    if days < 1 or days > 7:
        raise HTTPException(
            status_code=400,
            detail="Days must be between 1 and 7"
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
