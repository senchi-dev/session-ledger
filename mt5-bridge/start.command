#!/bin/bash
# Double-click to start the read-only MT5 bridge for the Session Ledger. MetaTrader 5 must be open and logged in.
cd "$(dirname "$0")"
VENV="$HOME/.session-ledger-mt5/venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "First run: setting up…"
  python3 -m venv "$VENV" && "$VENV/bin/pip" install -q mt5-mac || { echo "Setup failed"; exit 1; }
fi
exec "$VENV/bin/python" bridge.py
