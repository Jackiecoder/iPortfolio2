# iPortfolio2 — project notes for Codex

## Recording transactions (CRITICAL)

Postgres is now the source of truth. Do **not** add new transactions by editing
CSV files under `data/`; those files are historical migration inputs only.

Before writing ANY new transaction via the web UI/API/script,
**always run `date +%Y-%m-%d` first** when the user says "today" / "今天", and
use that exact value for the transaction date. Do NOT rely on the date in the
system reminder or prior conversation context. The system-reminder date can be
stale across compactions, and getting the trade date wrong corrupts cost basis
/ LT-vs-ST classification.

If the user says "今天买入 X"：
1. Run `date +%Y-%m-%d` via Bash.
2. Use that as the transaction date.
3. Mention the date in the confirmation reply so the user can catch any
   mismatch immediately (e.g. "已记录：2026-04-30 买入 MU…").

If the user gives an explicit date (e.g. "Apr-22-2026" or "4月28号"), use
that verbatim — no need to query `date`.

## Transaction format

The API accepts the same logical fields as the old CSV format:

```
date,asset,action,amount,quantity,ave_price,source,comment
```

- `date` is `YYYY-MM-DD`.
- BUY/SELL require at least two of `amount`, `quantity`, and `ave_price`; the
  backend derives the third.
- `broker` is also stored in Postgres when available.
- Bulk historical import still uses `scripts/migrate_csv_to_pg.py`.

## Cache invalidation

The FastAPI app caches `/api/holdings` and `/api/summary` for 30 s. After direct
database maintenance, call `POST /api/reload` so the in-memory portfolio matches
Postgres. Normal web/API transaction creation already reloads the portfolio.
