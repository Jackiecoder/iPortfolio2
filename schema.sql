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
CREATE INDEX IF NOT EXISTS idx_transactions_asset ON transactions (asset);
CREATE INDEX IF NOT EXISTS idx_transactions_date  ON transactions (date);

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
