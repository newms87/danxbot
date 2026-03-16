#!/usr/bin/env bash
# Called by the poller via wt.exe to process a single Trello card.
# Each card gets its own Claude instance — the poller spawns a new
# terminal tab per card, ensuring fresh context every time.
# Lock file is removed ONLY after Claude actually exits.

# Non-login shells (wsl.exe -e bash) don't load ~/.profile, so PATH
# may not include ~/.local/bin where claude is installed.
source ~/.profile 2>/dev/null || true

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "$PROJECT_ROOT"
export DANXBOT_EPHEMERAL=1
claude '/next-card' --dangerously-skip-permissions || true

exit 0
