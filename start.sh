#!/bin/bash

# Portfolio Tracker Startup Script
cd "$(dirname "$0")"

# Activate virtual environment
source venv/bin/activate

# Kill any existing process on port 8000
lsof -ti:8000 | xargs kill -9 2>/dev/null

# Start the server in background
echo "Starting Portfolio Tracker..."
uvicorn app.main:app --host 127.0.0.1 --port 8000 &

# Wait for server to start
sleep 2

# Open browser
open http://127.0.0.1:8000

echo "Portfolio Tracker is running at http://127.0.0.1:8000"
echo "Press Ctrl+C to stop the server"

# Wait for the background process
wait
