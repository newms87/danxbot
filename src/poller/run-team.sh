#!/usr/bin/env bash
# Called by the poller via wt.exe to process a single Trello card.
# Each card gets its own Claude instance — the poller spawns a new
# terminal tab per card, ensuring fresh context every time.
# Lock file is removed ONLY after Claude actually exits.
#
# The poller passes the repo name via DANXBOT_REPO_NAME env var.

# Non-login shells (wsl.exe -e bash) don't load ~/.profile, so PATH
# may not include ~/.local/bin where claude is installed.
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
    rm -f "$DANXBOT_ROOT/.poller-running-${DANXBOT_REPO_NAME}"
    exit 1
  fi
fi

# Resolve repo from DANXBOT_REPO_NAME (set by the poller)
# Falls back to first REPOS entry for backwards compatibility during migration
if [ -n "$DANXBOT_REPO_NAME" ]; then
  REPO_NAME="$DANXBOT_REPO_NAME"
else
  REPO_NAME="${REPOS%%:*}"
  REPO_NAME="${REPO_NAME%%,*}"
fi

REPO_DIR="$DANXBOT_ROOT/repos/$REPO_NAME"

if [ ! -d "$REPO_DIR" ]; then
  echo "ERROR: Target repo not found at $REPO_DIR"
  rm -f "$DANXBOT_ROOT/.poller-running-${REPO_NAME}"
  exit 1
fi

cd "$REPO_DIR"

# Source the target repo's .env so MCP env var placeholders resolve correctly.
# This overrides danxbot's .env values with repo-specific ones (e.g., TRELLO_API_KEY).
if [ -f "$REPO_DIR/.env" ]; then
  source "$REPO_DIR/.env"
fi

export DANXBOT_EPHEMERAL=1
export DANXBOT_PROJECT_ROOT="$DANXBOT_ROOT"
claude '/danx-next' --dangerously-skip-permissions || true

exit 0
