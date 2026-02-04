#!/bin/bash
# Start the portfolio screenshot service

cd "$(dirname "$0")"
echo "Starting Portfolio Screenshot Service..."
echo "Screenshots will be saved to: $(pwd)/screenshots/"
echo "Interval: 5 minutes"
echo "Press Ctrl+C to stop."
echo ""
./venv/bin/python screenshot.py
