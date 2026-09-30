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

Today's Top Movers and Holdings mark executed trades with labeled colors:
closed positions are red, new positions or net additions of at least 25% are
green, net reductions of at least 50% are yellow, and smaller reductions are
light green. Percentages use the day's opening quantity; small additions have
a pale green "Added" label and offsetting trades show "Traded · net 0".
Transfers and quantity corrections do not count as buys or sells. Chart hover
uses only trades executed by the selected minute. Closed positions display the
last sell execution price and time; open positions retain market prices.
Daily P&L still includes the closed position's contribution through its sale.

The **Live** switch beside Refresh is off by default. When enabled, the browser
runs the same refresh every minute and automatically turns off after **3 hours**.
The expiry time is shared across tabs and survives reloads without restarting the
clock. Reopening an expired session leaves Live off; turn it on again to start a
new 3-hour session. Older saved preferences without an expiry default to off.
Manual and automatic refreshes share an in-flight guard. Automatic updates do
not show repeated toasts; a suspended tab checks expiry before catching up when
it becomes visible. Manual refresh remains available after Live expires.

Cloud Scheduler collects **1-minute bars every 5 minutes**, even with the browser
closed, by calling `POST /api/internal/refresh`. The request waits for the new or
changed bars to be upserted into Postgres and the Today chart to finish rebuilding.
Cloud Run uses request-based billing, zero minimum instances at both service and
revision levels, and at most one instance for process-local cache consistency.
The service URL stays available; a reclaimed instance starts on the next request.

`deploy.sh` sets `MARKET_REFRESH_MODE=scheduler` and creates/updates the
`iportfolio-market-refresh` Scheduler job (`*/5 * * * *`, UTC). Its dedicated
service account uses short-lived Google-signed OIDC tokens, checked for signature,
expiry, issuer, audience and verified account email. This identity can only
trigger refresh; it receives no holdings or transaction data and cannot call
the normal user APIs. Existing app-token authentication stays in place.

In scheduler mode there is no in-process timer and startup warms minute caches
from Postgres without fetching live prices. Cache misses/expired snapshots are
computed within an active request rather than relying on CPU after a response.
Transaction saves still return after commit; the next reader reloads the ledger.
Long-idle visits may incur a cold start and cache rebuild. Database, storage and
network costs remain separate from Cloud Run compute.

Local development defaults to `MARKET_REFRESH_MODE=background`; its in-process
cadence uses `MARKET_REFRESH_INTERVAL_SECONDS` (default 300, minimum 15). In
production change the Scheduler schedule to adjust cadence. Both modes preserve
1-minute resolution. Each fetch also saves
the previous day's returned bars to fill the gap around midnight. Coverage still
depends on the upstream provider; this is not a guarantee of gap-free tick data.

After deployment, verify a Scheduler execution returns HTTP 200, its next timed
execution succeeds, and the new revision has CPU throttling enabled and both
minimum instance settings at zero. The scheduler retries a failed attempt once;
partial upstream results return HTTP 503 instead of silently reporting success.
When rolling back to a revision from before the Scheduler migration, that revision
restores its own background timer; pause `iportfolio-market-refresh` to avoid
requests to an endpoint the old revision does not support.

Manual refresh calls `POST /api/intraday/refresh`. If a successful Today check
started in the current minute for the same portfolio, the server reuses it and
returns `refresh_skipped: true`. Otherwise it bypasses the minute-price TTL and
waits only for Today P&L and its movers. Empty/partial results, transaction writes,
and a new minute require another check; a fetch spanning a minute boundary does
not suppress the next minute's check. This limits polling to minute cadence;
the upstream provider can still revise an in-progress minute bar or publish late.
The browser does not redraw an identical snapshot or refresh other pages for a
skipped fetch. It uses minute closes rather than a
second live-quote download. Concurrent timer/manual requests share one fetch.
Previous-close baselines and historical caches are preserved. If a fetch falls
back to older cached bars, the response identifies `stale_symbols` and the UI
shows a warning. `computed_at` is the chart computation time, not a market quote
timestamp. Requests that lose a race with a transaction write or midnight retry
against the new portfolio/date before publishing.

Startup restores the ledger and persisted bars; dashboard responses compute on demand.
The browser renders Today before fetching the rest of the dashboard. After a
manual refresh, other pages update separately without delaying the chart or
overwriting it. Transaction writes return as soon as Postgres commits. A shared
reload rebuilds the ledger within the next reading request; readers wait without waiting
for prices or history. After saving, the modal closes, today's share count updates
from the saved receipt, and pending values show a spinner. Confirmed quantities
and selected-lot costs arrive from `/api/positions`; each remaining panel updates independently.
Historical quantities wait for the server's split adjustments. Update failures
are shown separately from save failures, with a retry that never resubmits the trade.

On Cloud Run, `deploy.sh` enables CPU throttling and allows the instance count to
fall to zero. The external authenticated scheduler supplies the five-minute
cadence, so idle time no longer needs a continuously billed CPU. The maximum
remains one instance; restarting it recovers the ledger and bars from Postgres.

## Sell tax lots

In **Add Transaction → SELL**, choose FIFO, LIFO, High Cost, Low Cost,
Tax Optimizer, or Specified Lots. The preview shows purchase dates, remaining
shares, cost per share, holding period, and estimated realized ST/LT gains.
**Specify these lots** copies an automatic selection into editable quantities.
Selected quantities must exactly match the sale, and must be available in the
chosen broker/account at the sale's date and execution time. When there is more
than one account, choose one explicitly; "Unassigned account" covers untagged lots.
Use distinct broker labels for separate accounts at the same institution.

High Cost ranks by highest per-share basis regardless of age. Tax Optimizer uses
Schwab's published order: short-term losses, long-term losses, short-term and
long-term break-even lots, long-term gains, then short-term gains; highest cost
first within each group. Long-term means more than one calendar year. These are
recorded-basis estimates, without wash-sale adjustments, personal tax rates, or
special holding-period rules for gifts/inheritances. Confirm the same lot choice
with the actual broker; this app neither places orders nor changes broker settings.

`POST /api/transactions/preview-sale` is read-only. `POST /api/transactions`
accepts `cost_basis_method` and `lot_allocations` (`lot_id`, `quantity`). New sales
freeze their exact acquisition IDs and quantities in Postgres, including automatic
methods. Allocations are stored in sale-date share units and replayed with splits.
A ledger write lock validates inventory and subsequent frozen sales before commit;
over-sales, invalid selections and historical edits that break saved allocations
roll back. Referenced purchases cannot be deleted until dependent sales are removed.
Holdings, realized/YTD/annual P&L and expanded transaction history share this replay.

Existing transactions and legacy CSV imports retain their original pooled FIFO
matching. Historical account transfers or broker-specific basis corrections are
not inferred. Existing GIFT/FIX zero-cost assumptions are unchanged. New sales are
account-scoped; reconcile available lots with broker records before recording.

Once explicit sales have been recorded, roll back only to a version that reads
`lot_allocations`; older releases would display FIFO costs despite the saved choices.
References: [Schwab cost basis methods](https://www.schwab.com/learn/story/save-on-taxes-know-your-cost-basis)
and [IRS holding periods](https://www.irs.gov/taxtopics/tc409).

Regression tests: `venv/bin/python -m unittest discover -s tests` and
`node --test tests/*.js`. Real Postgres integration tests are enabled only with
`IPORTFOLIO_TEST_DATABASE_URL` pointing to a disposable localhost database; they
use isolated schemas and cover concurrent sales, rollback, deletion and reload.

## Covered calls

The **Option** tab supports **Covered Call** only. Holdings shows each stock's
open covered calls and additional available contracts. Tap its CC label for
reserved/free shares and account details. Capacity is summed only after rounding
down within each account (60 shares in each of two accounts still cover no call).
These indicators use recorded fills, not pending broker orders; an unconfirmed
expiration continues to reserve shares. Missing, stale or adjusted-contract data
shows a status instead of an optimistic capacity. Anonymous mode masks quantities.

Open **Tracker → Option → Record sell to open** to record an actual broker
fill. Select the stock and broker/account, execution date/time (Eastern), expiry,
strike, integer contract count, premium **per share**, and total fees. One standard
contract reserves 100 shares in that account. The record does not place a broker
order or sell the shares. For example, 150 available shares cover one contract;
a $13 fill with $0.65 fees records $1,299.35 of option cash flow.

**Record outcome / roll** supports partial or full buybacks, confirmed worthless
expiration, assignment, and rolling. A roll atomically records the old buyback and
new opening, and retains the old call's realized gain/loss separately from the net
roll credit/debit. Assignment creates one linked stock sale at the strike and uses
the existing automatic or specified tax-lot selection. Do not enter this stock
sale again in Transactions. Lifecycle events require actual broker confirmation;
passing the expiration date never releases collateral automatically.

Option records are stored in the Postgres `covered_calls` table. All stock and
option writes share the ledger lock; historical edits, ordinary stock sales and
imports cannot consume reserved shares. Opening/event request UUIDs make retries
idempotent. An incorrect opening can be removed only before lifecycle events or
roll links exist; lifecycle records are append-only. Linked assignment sales cannot
be deleted independently. Account labels must match the stock ledger; use distinct
labels for different accounts at one broker.

The tab reports **net option cash flow** and **realized economic option P&L**
separately. An opening premium is cash received, not realized profit. Open-option
market values and unrealized option P&L are unavailable; portfolio headline values,
stock return calculations and tax reports do not incorporate option valuation or
assigned-premium tax adjustments. Cash balances remain manual snapshots. Only
standard 100-share contracts are supported; detected splits flag affected open
positions and block lifecycle actions using unadjusted contract math.

API: `GET/POST /api/covered-calls`, read-only
`POST /api/covered-calls/preview`, `POST /api/covered-calls/{id}/events`, and
`DELETE /api/covered-calls/{id}`. These use the same authentication as other private
portfolio endpoints. `/demo` returns an empty synthetic option ledger and disables
recording.

The Python and Node regression suites include covered-call rules and cash-flow
checks. To run database and browser acceptance checks against a **disposable
localhost Postgres**, set `IPORTFOLIO_TEST_DATABASE_URL`, then run:

```bash
PYTHONDONTWRITEBYTECODE=1 venv/bin/python -m unittest discover -s tests
node --test tests/test_*.js
PYTHONDONTWRITEBYTECODE=1 venv/bin/python scripts/check_covered_calls_ui.py
```

The database checks create isolated schemas and drop them on completion. Browser
checks use synthetic fixtures, test mobile/desktop entry, coverage rejection,
rolling, assignment, privacy and demo isolation, and save screenshots under
`/tmp/iportfolio-covered-call-qa` (override with `IPORTFOLIO_QA_OUTPUT`).

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

- `GET /api/ticker-technicals?symbol=MU` - Latest timestamped market price, 50/200-day simple moving averages, dollar/percentage distances, and six months of daily chart data
- `GET /api/holdings` - Current positions with live prices
- `GET /api/summary` - Complete portfolio summary
- `GET /api/performance` - Historical portfolio value
- `GET /api/dividends` - Dividend summary and history
- `POST /api/upload` - Upload CSV file
- `POST /api/reload` - Reload portfolio from CSV files
- `GET /api/files` - List CSV files in data directory

### Top Movers moving averages

Click any Top Movers row (or focus it and press Enter/Space) to compare its latest
market quote with the 50-day and 200-day SMA. The popup also shows the daily close
and both moving averages over the last six months. It always requests a market
quote, including for fully sold positions or when viewing a historical intraday
date; it does not reuse the row's last sale price or historical hover price.

SMA windows use valid daily closes strictly before the current day: New York
trading sessions for stocks and UTC calendar days for crypto. Today's daily bar
is excluded even after the market closes. Yahoo `Close` prices are split-adjusted
without dividend adjustment (`auto_adjust=False`), fetched independently of the
portfolio's historical-price cache. Full 50/200-observation windows are required;
short histories and unavailable quotes are labeled explicitly. Quote timestamps
and the final daily-close date remain visible; quotes may include extended hours
and may be delayed. Daily averages and chart data are calculated lazily on the
first request for each ticker/day, then stored in Postgres and reused for that
entire day, including after service restarts. The daily key follows New York
dates for stocks and UTC dates for crypto. Concurrent cache misses share a
database lock; failed history fetches are not cached and can be retried. Only
the latest daily snapshot per ticker/calculation version is retained. Current
quotes use an independent 60-second memory cache; distances are recalculated
against those quotes without fetching or recomputing daily history. Normal
dashboard refreshes do not invalidate daily snapshots. Above/below describes
distance from an average, not daily P&L.

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

## Demo preview

Open `/demo` (or the **Demo** navigation button) to show a public sample portfolio:
1 TSLA, 3 VOO, 3 QQQM, 3 SOXX, 1 MU and 1 ETH. Prices, history and reports are
synthetic. Demo requests are handled entirely in the browser, without reading
the account token or calling private APIs. Transactions are read-only; Trade
Preview and the illustrative simulator work locally. Reset demo restores the
initial display settings and allocation targets. The demo has a separate PWA
manifest so installing it opens `/demo`.

To preview without starting Postgres or the market-data scheduler:

```bash
venv/bin/python scripts/preview_demo.py
```

Then open `http://127.0.0.1:8766/demo`. This preview server binds only to localhost
and rejects all network API requests.

## Technology Stack

- **Backend**: Python with FastAPI
- **Frontend**: HTML/CSS/JavaScript with Chart.js
- **Market Data**: yfinance
- **Data Processing**: Pandas, Pydantic


### Call reference quotes

Option → Call prices looks up standard calls by ticker, listed expiry and optional
strike using Yahoo Finance through yfinance. Open covered-call cards independently
load matching quotes on entry, refresh and once a minute while the Option tab is
visible. No quote fills a trade form or changes the ledger. `GET /api/options/calls`
requires normal application authentication, and never reads private holdings.

Bid, Ask, midpoint, Last and last-trade time are separate fields. Quotes may be
delayed; Yahoo does not supply bid/ask timestamps here. Retrieval time is explicitly
labeled and must not be treated as exchange quote time. A 60-second server cache,
four-request concurrency cap and short failure backoff limit upstream calls. An
upstream failure can return a clearly stale snapshot for at most 15 minutes;
stale quotes are excluded from valuation. Missing/zero or crossed quotes never
become a zero-cost buyback. No Last-price fallback is used for valuation.

Buyback cost uses Ask × remaining contracts × 100. Estimated unrealized option
P&L uses the valid bid/ask midpoint, subtracting the remaining share of opening
fees. Closing fees and stock performance are excluded. Expired, adjusted and
unmatched contracts have no valuation. These estimates do not change stock totals
or reported realized option P&L. Demo quotes are synthetic and never use Yahoo.

Provider interface: https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.html

### Covered-call cash flow and estimated daily P&L

The Option tab leads with gross premiums received, buybacks paid, fees and net
cash collected across recorded fills. Net cash collected is not realized profit.
The existing realized option ledger and equity/cash balance accounting are unchanged.

Single-day Intraday responses retain their original `daily_pnl` and equity
`asset_changes`; additional `holdings_daily_pnl`, `option_daily_pnl`,
`combined_daily_pnl`, `options_complete`, `option_cash_flow` and `option_details`
provide the estimated covered-call contribution. Holdings and the Intraday header
use the same complete snapshot for the breakdown. Unknown option valuations leave
the combined graph empty at that point and label the displayed holdings subtotal.
Historical multi-day value, performance and daily/monthly history remain
holdings-only. Combined return percentages are not computed from a stock-only basis.

The scheduled five-minute refresh saves quotes for recorded open standard calls to
Postgres; manual refresh uses the same bounded collector. Prior-session baselines
are reference midpoints retrieved 30–45 minutes after the scheduled equity session
close, with an exchange calendar handling holidays and early closes. They are
**estimates, not official closing prices**: Yahoo lists OPRA data as delayed, and
our feed supplies no bid/ask timestamp. No Last-price substitution is used. During trading, a collected midpoint may be
carried for at most six minutes, retaining its actual retrieval time; new upstream
responses must have been retrieved within two minutes. New
installations and previously untracked contracts remain incomplete until an
eligible prior-session reference exists. Missing or old quotes never become zero
P&L, and later snapshots are not backfilled into earlier chart points.

Daily short-call P&L equals the opening short liability plus the day's actual net
option cash flow minus the remaining liability. Same-day opens use actual fills;
partial closes and rolls use event times and fees. Assignment removes the option
obligation while the linked stock sale already occurs at the strike, so intrinsic
value must not be deducted again. Unconfirmed expiry or contract adjustments block
valuation. No option price or estimate creates a transaction.

Browser regression: `scripts/check_option_intraday_ui.py` uses synthetic fixtures
for known/missing baselines, past points, cash flow, privacy and desktop/mobile
Holdings reconciliation in Chromium and WebKit.
