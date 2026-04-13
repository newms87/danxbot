#!/usr/bin/env bash
# Called by the poller to run the ideator when the Review list is low on cards.
# Uses the same lock file as run-team.sh to prevent concurrent spawns.

source ~/.profile 2>/dev/null || true

DANXBOT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

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
