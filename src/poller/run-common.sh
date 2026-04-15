#!/usr/bin/env bash
# Shared setup for poller-spawned Claude agents.
# Source this file from run-team.sh / run-ideator.sh, then run the claude command.
#
# Sets: DANXBOT_ROOT, REPO_NAME, REPO_DIR, DANXBOT_EPHEMERAL, DANXBOT_PROJECT_ROOT
# Changes cwd to REPO_DIR.
# Requires: DANXBOT_REPO_NAME env var (set by the poller).

source ~/.profile 2>/dev/null || true

DANXBOT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Source .env to ensure env vars are available (wsl.exe doesn't inherit them)
set -a
source "$DANXBOT_ROOT/.env" 2>/dev/null || true
set +a

# Auth mode: subscription uses ~/.claude/.credentials.json, api-key uses ANTHROPIC_API_KEY
if [ "${CLAUDE_AUTH_MODE:-api-key}" = "subscription" ]; then
  unset ANTHROPIC_API_KEY
  if [ ! -f "$HOME/.claude/.credentials.json" ]; then
    echo "ERROR: CLAUDE_AUTH_MODE=subscription but ~/.claude/.credentials.json not found"
    echo "Run 'claude' interactively to authenticate first."
    rm -f "$DANXBOT_ROOT/.poller-running-${DANXBOT_REPO_NAME}"
    exit 1
  fi
fi

# DANXBOT_REPO_NAME is required — set by the poller before spawning
if [ -z "$DANXBOT_REPO_NAME" ]; then
  echo "ERROR: DANXBOT_REPO_NAME not set. This script must be called by the poller."
  exit 1
fi
REPO_NAME="$DANXBOT_REPO_NAME"

REPO_DIR="$DANXBOT_ROOT/repos/$REPO_NAME"

if [ ! -d "$REPO_DIR" ]; then
  echo "ERROR: Target repo not found at $REPO_DIR"
  rm -f "$DANXBOT_ROOT/.poller-running-${REPO_NAME}"
  exit 1
fi

cd "$REPO_DIR"

# Source the target repo's .env so MCP env var placeholders resolve correctly.
if [ -f "$REPO_DIR/.env" ]; then
  source "$REPO_DIR/.env"
fi

export DANXBOT_EPHEMERAL=1
export DANXBOT_PROJECT_ROOT="$DANXBOT_ROOT"
