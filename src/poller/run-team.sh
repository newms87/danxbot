#!/usr/bin/env bash
# Called by the poller via wt.exe to process a single Trello card.
# Each card gets its own Claude instance — the poller spawns a new
# terminal tab per card, ensuring fresh context every time.
# Lock file is removed ONLY after Claude actually exits.

# Non-login shells (wsl.exe -e bash) don't load ~/.profile, so PATH
# may not include ~/.local/bin where claude is installed.
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
claude '/danx-next' --dangerously-skip-permissions || true

exit 0
