-- iPortfolio2 Postgres schema (deployment plan 方案 A)
-- Source of truth for transactions/targets + persistent price cache.
-- Safe to run repeatedly (CREATE ... IF NOT EXISTS).

-- All portfolio transactions (BUY/SELL/DIV/GIFT/FEE/GAS/CASH/FIX).
-- One row per transaction; mirrors the CSV columns plus a broker tag
-- (taken from the originating data/<broker>/ folder) and an id/created_at.
CREATE TABLE IF NOT EXISTS transactions (
    id          BIGSERIAL PRIMARY KEY,
    date        DATE        NOT NULL,
    asset       TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    amount      NUMERIC,
    quantity    NUMERIC,
    ave_price   NUMERIC,
    source      TEXT,
    comment     TEXT,
    broker      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
-- Nullable method preserves historical FIFO; new sales persist exact buy IDs
-- and quantities in the sale date's share units, so splits replay correctly.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cost_basis_method TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS lot_allocations JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE transactions
SET executed_at = (
    CASE
        WHEN asset LIKE '%-USD' OR action = 'CASH' THEN date + TIME '00:00'
        ELSE date + TIME '09:30'
    END
) AT TIME ZONE 'America/New_York'
WHERE executed_at IS NULL;
ALTER TABLE transactions ALTER COLUMN executed_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_asset ON transactions (asset);
CREATE INDEX IF NOT EXISTS idx_transactions_date  ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_transactions_executed_at ON transactions (executed_at);

-- Confirmed standard covered calls; independent from equity lots and cash
-- balance snapshots. Lifecycle events and linked assignments commit together.
CREATE TABLE IF NOT EXISTS covered_calls (
    id BIGSERIAL PRIMARY KEY,
    request_id UUID NOT NULL UNIQUE,
    opening JSONB NOT NULL,
    events JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Normalize known broker names on existing rows. Exact-label matching keeps
-- separately named accounts distinct; no trade values or identifiers change.
UPDATE transactions AS t
SET broker = names.canonical
FROM (VALUES
    ('fidelity', 'Fidelity'),
    ('okx', 'OKX'),
    ('binance.us', 'Binance.US'),
    ('schwab', 'Schwab')
) AS names(key, canonical)
WHERE lower(btrim(t.broker)) = names.key
  AND t.broker IS DISTINCT FROM names.canonical;

-- Target allocation percentages (replaces data/targets.json).
CREATE TABLE IF NOT EXISTS targets (
    symbol     TEXT PRIMARY KEY,
    target_pct NUMERIC NOT NULL
);

-- ---------------------------------------------------------------------------
-- Persistent price/value cache (replaces data/cache.db). Wired up in phase 3.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS historical_prices (
    symbol      TEXT    NOT NULL,
    date        DATE    NOT NULL,
    close_price NUMERIC NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_historical_prices_symbol ON historical_prices (symbol);
CREATE INDEX IF NOT EXISTS idx_historical_prices_date   ON historical_prices (date);

-- Daily price-only SMA/chart snapshots. Separate from dividend-adjusted price
-- caches; only the latest day per ticker/calculation version is retained.
CREATE TABLE IF NOT EXISTS ticker_technical_snapshots (
    symbol              TEXT NOT NULL,
    calculation_version TEXT NOT NULL,
    cache_date          DATE NOT NULL,
    snapshot            JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, calculation_version)
);

CREATE TABLE IF NOT EXISTS portfolio_values (
    date             DATE PRIMARY KEY,
    total_value      NUMERIC NOT NULL,
    investment_value NUMERIC NOT NULL,
    cost_basis       NUMERIC NOT NULL,
    cash_value       NUMERIC NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intraday_prices (
    symbol   TEXT    NOT NULL,
    date     DATE    NOT NULL,
    time     TEXT    NOT NULL,
    interval TEXT    NOT NULL,
    price    NUMERIC NOT NULL,
    PRIMARY KEY (symbol, date, time, interval)
);
CREATE INDEX IF NOT EXISTS idx_intraday_prices_lookup ON intraday_prices (symbol, date, interval);

-- Immutable analysis snapshots. The JSON payload contains the complete report
-- so historical reports do not change when transactions or prices change.
CREATE TABLE IF NOT EXISTS analysis_reports (
    id           BIGSERIAL PRIMARY KEY,
    period       TEXT        NOT NULL,
    period_label TEXT        NOT NULL,
    start_date   DATE        NOT NULL,
    end_date     DATE        NOT NULL,
    title        TEXT        NOT NULL,
    verdict      TEXT        NOT NULL,
    score        INTEGER,
    report_data  JSONB       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analysis_reports_created_at
    ON analysis_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_reports_period
    ON analysis_reports (period, created_at DESC);

-- Recorded reference option midpoints, not exchange-certified closes or fills.
-- Retain their original retrieval timestamp; unavailable quotes create no row.
CREATE TABLE IF NOT EXISTS option_quote_snapshots (
    asset TEXT NOT NULL,
    expiration DATE NOT NULL,
    strike NUMERIC NOT NULL CHECK (strike > 0),
    contract_symbol TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    bid NUMERIC NOT NULL CHECK (bid > 0),
    ask NUMERIC NOT NULL CHECK (ask >= bid),
    mid NUMERIC NOT NULL CHECK (mid > 0 AND abs(mid - (bid + ask) / 2) <= 0.000001),
    source TEXT NOT NULL,
    PRIMARY KEY (asset, expiration, strike, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_option_quote_snapshots_captured_at ON option_quote_snapshots (captured_at);

-- A persisted per-day deliverable check prevents a cold instance from assuming
-- that a standard opening is still standard after a later corporate action.
CREATE TABLE IF NOT EXISTS option_contract_checks (
    call_id BIGINT NOT NULL REFERENCES covered_calls(id) ON DELETE CASCADE,
    market_date DATE NOT NULL,
    adjustment_factor NUMERIC NOT NULL CHECK (adjustment_factor > 0),
    checked_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (call_id, market_date)
);
