#!/usr/bin/env bash
# Called by the poller to run the ideator when the Review list is low on cards.
# Uses per-repo lock files to prevent concurrent spawns.

source "$(dirname "$0")/run-common.sh"

claude '/danx-ideate' --dangerously-skip-permissions || true

# Clean up lock file so poller knows we're done
rm -f "$DANXBOT_ROOT/.poller-running-${REPO_NAME}"

exit 0
