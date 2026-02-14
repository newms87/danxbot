#!/usr/bin/env bash
# Called by the poller via wt.exe to run the /start-team skill.
# Runs Claude in interactive mode (full output visibility).
# Claude self-terminates via `kill $PPID` when the workflow completes.
# Lock file is removed ONLY after Claude actually exits.

# Non-login shells (wsl.exe -e bash) don't load ~/.profile, so PATH
# may not include ~/.local/bin where claude is installed.
source ~/.profile 2>/dev/null || true

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "$PROJECT_ROOT"
claude '/start-team' --dangerously-skip-permissions || true

exit 0
