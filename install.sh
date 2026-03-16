#!/usr/bin/env bash
set -euo pipefail

echo "=== Danxbot Setup ==="
echo ""

# Check Node.js >= 20
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "Install Node.js 20+ from https://nodejs.org/ or via nvm:"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "  nvm install 20"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js 20+ is required (found $(node -v))."
  echo "Upgrade via nvm: nvm install 20"
  exit 1
fi
echo "Node.js $(node -v) OK"

# Check Claude Code CLI
if ! command -v claude &>/dev/null; then
  echo "Claude Code CLI not found — installing..."
  npm i -g @anthropic-ai/claude-code
fi
echo "Claude Code CLI OK"

# Install dependencies (both root and dashboard)
echo "Installing dependencies..."
npm install
cd dashboard && npm install && cd ..

# Build dashboard so the volume mount has dist/ on the host
echo "Building dashboard..."
cd dashboard && npm run build && cd ..

# Hand off to Claude's interactive setup skill
echo ""
echo "Launching interactive setup..."
claude '/setup' --dangerously-skip-permissions
