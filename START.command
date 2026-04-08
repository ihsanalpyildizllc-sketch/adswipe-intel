#!/bin/bash
cd "$(dirname "$0")"
echo "================================================"
echo "  AdSwipe Intel — starting up..."
echo "================================================"

# Check Node.js
if ! command -v node &> /dev/null; then
  osascript -e 'display alert "Node.js not found" message "Please install Node.js from nodejs.org then try again." buttons {"OK"} default button "OK"'
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run — takes ~2 min for Puppeteer)..."
  npm install
fi

# Open browser after 2 seconds
sleep 2 && open "http://localhost:3000" &

# Start server
node server.js
