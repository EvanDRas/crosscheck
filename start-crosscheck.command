#!/bin/bash
# Double-click launcher for Crosscheck (macOS). If macOS blocks it, right-click
# the file, choose Open, and confirm once. Linux: run ./start-crosscheck.command
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Crosscheck needs Node.js (free): https://nodejs.org — install the LTS version, then run this again."
  read -r -p "Press Enter to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run — installing dependencies, give it a minute..."
  npm install
fi
(sleep 2 && (open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null)) &
echo "Crosscheck is starting — your browser will open. Keep this window open while you use it."
node server.js
