"""FastAPI application entry point."""

import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

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


def load_portfolio() -> Portfolio:
    """Load portfolio from all CSV files in the data directory (including subfolders)."""
    global portfolio
    portfolio = Portfolio()

    # Recursively find all CSV files in data directory and subdirectories
    csv_files = list(DATA_DIR.glob("**/*.csv"))
    if not csv_files:
        logger.info("No CSV files found in data directory")
        return portfolio

    for csv_file in csv_files:
        try:
            transactions = parse_csv_file(csv_file)
            portfolio.add_transactions(transactions)
            # Show relative path from data directory
            relative_path = csv_file.relative_to(DATA_DIR)
            logger.info(f"Loaded {len(transactions)} transactions from {relative_path}")
        except CSVParseError as e:
            relative_path = csv_file.relative_to(DATA_DIR)
            logger.error(f"Error parsing {relative_path}: {e}")
        except Exception as e:
            relative_path = csv_file.relative_to(DATA_DIR)
            logger.error(f"Unexpected error loading {relative_path}: {e}")

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

    try:
        holdings = portfolio.get_holdings(fetch_prices=True)
        return {
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
                }
                for h in holdings
            ]
        }
    except Exception as e:
        logger.error(f"Error fetching holdings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/summary")
async def get_summary():
    """Get portfolio summary including totals."""
    if portfolio is None:
        load_portfolio()

    try:
        summary = portfolio.get_portfolio_summary(fetch_prices=True)
        return {
            "total_cost_basis": float(summary.total_cost_basis),
            "total_market_value": float(summary.total_market_value),
            "total_unrealized_pnl": float(summary.total_unrealized_pnl),
            "total_pnl_percent": float(summary.total_pnl_percent),
            "total_dividends": float(summary.total_dividends),
            "total_fees": float(summary.total_fees),
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
async def reload_portfolio():
    """Reload portfolio from CSV files."""
    try:
        load_portfolio()
        price_service.clear_cache()
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
