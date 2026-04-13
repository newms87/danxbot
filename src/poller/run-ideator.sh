#!/usr/bin/env bash
# Called by the poller to run the ideator when the Review list is low on cards.
# Uses the same lock file as run-team.sh to prevent concurrent spawns.

source ~/.profile 2>/dev/null || true

DANXBOT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

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
    rm -f "$DANXBOT_ROOT/.poller-running"
    exit 1
  fi
fi

# Resolve the primary repo from REPOS env var (first entry, format: name:url)
REPO_NAME="${REPOS%%:*}"
REPO_NAME="${REPO_NAME%%,*}"
REPO_DIR="$DANXBOT_ROOT/repos/$REPO_NAME"

if [ ! -d "$REPO_DIR" ]; then
  echo "ERROR: Target repo not found at $REPO_DIR"
  rm -f "$DANXBOT_ROOT/.poller-running"
  exit 1
fi

cd "$REPO_DIR"
export DANXBOT_EPHEMERAL=1
export DANXBOT_PROJECT_ROOT="$DANXBOT_ROOT"
claude '/danx-ideate' --dangerously-skip-permissions || true

# Clean up lock file so poller knows we're done
rm -f "$DANXBOT_ROOT/.poller-running"

exit 0
