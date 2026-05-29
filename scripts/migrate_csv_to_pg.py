"""One-time migration: load data/**/*.csv and data/targets.json into Postgres.

Usage:
    DATABASE_URL=postgresql://dev:devpass@localhost:5433/iportfolio \
        python -m scripts.migrate_csv_to_pg [--reset]

--reset  Truncate the transactions and targets tables first. Without it, the
         script refuses to run if those tables already contain data (so you
         can't silently double-load).

The broker for each transaction is taken from its data/<broker>/ subfolder;
files directly under data/ (cash.csv, cash_yield.csv) get broker=NULL.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow running as `python scripts/migrate_csv_to_pg.py` too.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db, repository  # noqa: E402
from app.csv_parser import CSVParseError, parse_csv_file  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
TARGETS_FILE = DATA_DIR / "targets.json"


def _table_count(table: str) -> int:
    with db.get_pool().connection() as conn:
        return conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


def _broker_for(csv_path: Path) -> str | None:
    """Return the <broker> subfolder name, or None for files directly in data/."""
    rel = csv_path.relative_to(DATA_DIR)
    return rel.parts[0] if len(rel.parts) > 1 else None


def migrate(reset: bool) -> None:
    db.init_schema()

    existing = _table_count("transactions")
    if existing and not reset:
        sys.exit(
            f"Refusing to run: transactions already has {existing} rows. "
            f"Re-run with --reset to truncate and reload."
        )
    if reset:
        with db.get_pool().connection() as conn:
            conn.execute("TRUNCATE transactions RESTART IDENTITY")
            conn.execute("TRUNCATE targets")
            conn.commit()
        print("Truncated transactions and targets.")

    csv_files = sorted(DATA_DIR.glob("**/*.csv"))
    total_parsed = 0
    failures: list[str] = []

    for csv_file in csv_files:
        rel = csv_file.relative_to(DATA_DIR)
        broker = _broker_for(csv_file)
        try:
            txns = parse_csv_file(csv_file)
        except CSVParseError as e:
            failures.append(f"{rel}: {e}")
            continue
        repository.insert_transactions(txns, broker=broker)
        total_parsed += len(txns)
        print(f"  {rel}  ->  {len(txns):>4} txns  (broker={broker})")

    # Targets
    target_count = 0
    if TARGETS_FILE.exists():
        targets = json.loads(TARGETS_FILE.read_text())
        for symbol, pct in targets.items():
            repository.set_target(symbol, pct)
            target_count += 1

    # Verify
    db_txn_count = _table_count("transactions")
    db_target_count = _table_count("targets")

    print("\n--- summary ---")
    print(f"files processed : {len(csv_files)}")
    print(f"parsed txns     : {total_parsed}")
    print(f"transactions in DB: {db_txn_count}")
    print(f"targets loaded  : {target_count}  (in DB: {db_target_count})")

    if failures:
        print(f"\n!! {len(failures)} file(s) FAILED to parse:")
        for f in failures:
            print(f"   - {f}")

    if db_txn_count != total_parsed:
        sys.exit(
            f"\nMISMATCH: parsed {total_parsed} but DB has {db_txn_count}. "
            f"Investigate before trusting the data."
        )
    print("\nOK — DB transaction count matches parsed count.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="truncate tables before loading")
    args = ap.parse_args()
    migrate(reset=args.reset)
    db.close_pool()
