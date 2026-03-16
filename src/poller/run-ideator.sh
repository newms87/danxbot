#!/usr/bin/env bash
# Called by the poller to run the ideator when the Review list is low on cards.
# Uses the same lock file as run-team.sh to prevent concurrent spawns.

source ~/.profile 2>/dev/null || true

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "$PROJECT_ROOT"
export DANXBOT_EPHEMERAL=1
claude '/ideate' --dangerously-skip-permissions || true

# Clean up lock file so poller knows we're done
rm -f .poller-running

exit 0
