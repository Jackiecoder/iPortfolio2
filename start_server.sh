#!/bin/bash
# Start the portfolio tracker server

cd "$(dirname "$0")"
echo "Starting Portfolio Tracker Server..."
echo "Open http://localhost:8000 in your browser"
echo "Press Ctrl+C to stop."
echo ""
./venv/bin/uvicorn app.main:app --reload
