#!/usr/bin/env bash
# Called by the poller via wt.exe to process a single Trello card.
# Each card gets its own Claude instance — the poller spawns a new
# terminal tab per card, ensuring fresh context every time.
# Lock file is removed ONLY after Claude actually exits.

source "$(dirname "$0")/run-common.sh"

claude '/danx-next' --dangerously-skip-permissions || true

# Clean up lock file so poller knows we're done
rm -f "$DANXBOT_ROOT/.poller-running-${REPO_NAME}"

exit 0
