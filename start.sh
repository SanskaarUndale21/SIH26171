#!/usr/bin/env bash
# One-shot dev startup: build the extension, make sure the server's venv/deps exist, start
# the server, and leave it running in the background for manual browser testing. Run this,
# then load extension/dist as an unpacked extension in chrome://extensions.
set -e
cd "$(dirname "$0")"

echo "==> Installing extension deps (skips if already installed)..."
cd extension
npm install --no-fund --no-audit
echo "==> Building extension..."
npm run build
cd ..

echo "==> Setting up server venv..."
cd server
if [ ! -d .venv ]; then
  python -m venv .venv
fi
PYTHON_BIN=".venv/Scripts/python.exe"
[ -f "$PYTHON_BIN" ] || PYTHON_BIN=".venv/bin/python"
"$PYTHON_BIN" -m pip install -q -r requirements.txt
cd ..

if [ ! -f server/.env ]; then
  echo ""
  echo "!! server/.env not found. Copy server/.env.example to server/.env and add your"
  echo "   API key (PLANNER_API_KEY) before the planner will be able to respond."
  echo ""
fi

echo "==> Starting server (scripts/dev.mjs)..."
node scripts/dev.mjs start

sleep 2
echo "==> Health check:"
if curl -s http://localhost:8100/health; then
  echo ""
else
  echo "Server did not respond -- check server/.env has a valid key, or run"
  echo "  cd server && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8100"
  echo "in the foreground to see the actual error."
fi

echo ""
echo "Server:    http://localhost:8100"
echo "Extension: load extension/dist as unpacked in chrome://extensions (Developer mode -> Load unpacked)"
echo "Demo page: demo/fixture.html"
echo "Stop the server later with: node scripts/dev.mjs stop"
