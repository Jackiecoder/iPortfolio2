#!/bin/bash
# Start the portfolio tracker server

cd "$(dirname "$0")"

# Load local env overrides if present (DATABASE_URL, API_TOKEN, ...)
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# Default to the local Docker Postgres when not otherwise configured.
export DATABASE_URL="${DATABASE_URL:-postgresql://dev:devpass@localhost:5433/iportfolio}"

echo "Starting Portfolio Tracker Server..."
echo "DATABASE_URL=$DATABASE_URL"
if [ -n "$API_TOKEN" ]; then echo "Auth: ENABLED"; else echo "Auth: disabled (set API_TOKEN to enable)"; fi
echo "Open http://localhost:8000 in your browser"
echo "Press Ctrl+C to stop."
echo ""
./venv/bin/uvicorn app.main:app --reload
