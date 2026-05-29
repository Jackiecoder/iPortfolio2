# iPortfolio2 — project notes for Claude

## Recording transactions (CRITICAL)

Before writing ANY new transaction row to a CSV under `data/<broker>/`,
**always run `date +%Y-%m-%d` first** and use that exact value for the date
column — do NOT rely on the date in the system reminder, do NOT infer
"今天" from prior conversation context. The system-reminder date can be
stale across compactions, and getting the trade date wrong corrupts cost
basis / LT-vs-ST classification.

If the user says "今天买入 X"：
1. Run `date +%Y-%m-%d` via Bash.
2. Use that as the transaction date.
3. Mention the date in the confirmation reply so the user can catch any
   mismatch immediately (e.g. "已记录：2026-04-30 买入 MU…").

If the user gives an explicit date (e.g. "Apr-22-2026" or "4月28号"), use
that verbatim — no need to query `date`.

## CSV format

Files live under `data/<broker>/<broker>_<symbol>.csv`. Header:

```
date,asset,action,amount,quantity,ave_price,source,comment
```

- `date` is `YYYY-MM-DD`.
- `ave_price` is optional for BUY/SELL; if omitted the loader derives it
  from `amount / quantity`.
- New rows go at the **top** of the data section (newest first), matching
  existing convention.

## Cache invalidation

The FastAPI app caches `/api/holdings` and `/api/summary` for 30 s. After
editing a CSV the user should refresh once and wait, or hit
`/api/reload-portfolio` to force a reload.
