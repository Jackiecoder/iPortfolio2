# Portfolio Tracker

A Python-based portfolio tracking application that reads transaction data from CSV files and displays a comprehensive dashboard with holdings, performance charts, and dividend tracking.

## Features

- **Holdings Summary**: View all current positions with live market prices from Yahoo Finance
- **Performance Charts**: Track portfolio value over time with interactive charts
- **Asset Allocation**: Visualize portfolio distribution with a pie chart
- **Dividend Tracking**: Monitor dividend income by asset
- **CSV Import**: Easy transaction import via CSV files

## Installation

1. Create a virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

1. Start the server:
   ```bash
   uvicorn app.main:app --reload
   ```

2. Open your browser to `http://localhost:8000`

3. Upload a CSV file or place CSV files in the `data/` directory

## Live snapshot refresh

The server collects **1-minute bars every 5 minutes** by default, incrementally
upserts new or changed bars into Postgres, and rebuilds only the Today chart.
Override the collection cadence with `MARKET_REFRESH_INTERVAL_SECONDS` (minimum
15 seconds); this does not change the 1-minute resolution. Each fetch also saves
the previous day's returned bars to fill the gap around midnight. Coverage still
depends on the upstream provider; this is not a guarantee of gap-free tick data.

Manual refresh calls `POST /api/intraday/refresh`, bypasses the minute-price TTL,
and waits only for Today P&L and its movers. It uses minute closes rather than a
second live-quote download. Concurrent timer/manual requests share one fetch.
Previous-close baselines and historical caches are preserved. If a fetch falls
back to older cached bars, the response identifies `stale_symbols` and the UI
shows a warning. `computed_at` is the chart computation time, not a market quote
timestamp. Requests that lose a race with a transaction write or midnight retry
against the new portfolio/date before publishing.

Startup prepares Today first; other dashboard responses compute on demand.
The browser renders Today before fetching the rest of the dashboard. After a
manual refresh, other pages update separately without delaying the chart or
overwriting it. Transaction writes still rebuild the full snapshot before returning.

On Cloud Run, the included `deploy.sh` keeps exactly one instance alive and
disables CPU throttling so the in-process portfolio, response cache, and refresh
loop stay consistent while there are no requests. This uses always-on Cloud Run
resources and therefore has a higher baseline cost than scaling to zero.
Reducing collection frequency alone does **not** reduce this fixed compute bill.
Request-based billing would require replacing the unattended in-process timer
with an external authenticated scheduler; this change does not alter billing.

## CSV Format

Your transaction CSV files should have the following columns:

| Column | Required | Description |
|--------|----------|-------------|
| date | Yes | Transaction date (YYYY-MM-DD) |
| asset | Yes | Yahoo Finance symbol (e.g., AAPL, MSFT) |
| action | Yes | BUY, SELL, DIV, GIFT, FEE, or GAS |
| amount | Conditional | Dollar amount |
| quantity | Conditional | Number of shares/units |
| ave_price | Optional | Average price per share |
| source | Optional | Transaction source |
| comment | Optional | Notes |

### Action Types

- **BUY**: Purchase shares (needs 2 of: amount, quantity, ave_price)
- **SELL**: Sell shares (needs 2 of: amount, quantity, ave_price)
- **DIV**: Dividend received (amount only)
- **GIFT**: Received shares (quantity only, zero cost basis)
- **FEE**: Fee paid (amount only)
- **GAS**: Gas/network fee (quantity only, deducted from position)

### Example CSV

```csv
date,asset,action,amount,quantity,ave_price,source,comment
2024-01-15,AAPL,BUY,1500.00,10,,Schwab,Initial purchase
2024-02-01,AAPL,DIV,8.50,,,Schwab,Q1 dividend
2024-03-01,MSFT,GIFT,,5,,,Birthday gift
2024-03-15,ETH-USD,GAS,,0.002,,,Network fee
```

## API Endpoints

- `GET /api/holdings` - Current positions with live prices
- `GET /api/summary` - Complete portfolio summary
- `GET /api/performance` - Historical portfolio value
- `GET /api/dividends` - Dividend summary and history
- `POST /api/upload` - Upload CSV file
- `POST /api/reload` - Reload portfolio from CSV files
- `GET /api/files` - List CSV files in data directory

## Project Structure

```
iPortfolio2/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI application
│   ├── models.py            # Pydantic data models
│   ├── portfolio.py         # Portfolio calculation logic
│   ├── csv_parser.py        # CSV file parsing
│   └── price_service.py     # yfinance integration
├── static/
│   ├── css/style.css
│   └── js/app.js
├── templates/
│   └── index.html           # Dashboard template
├── data/
│   └── sample.csv           # Sample transaction file
├── requirements.txt
└── README.md
```

## Technology Stack

- **Backend**: Python with FastAPI
- **Frontend**: HTML/CSS/JavaScript with Chart.js
- **Market Data**: yfinance
- **Data Processing**: Pandas, Pydantic
