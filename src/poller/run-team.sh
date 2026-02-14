#!/usr/bin/env bash
# Called by the poller via wt.exe to run the /start-team skill.
# Uses -p (print mode) so Claude exits after completion.
# Trap ensures the lock file is always cleaned up, even on errors.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK_FILE="$PROJECT_ROOT/.poller-running"

cleanup() {
  rm -f "$LOCK_FILE"
}
trap cleanup EXIT

cd "$PROJECT_ROOT"
claude -p '/start-team' --dangerously-skip-permissions
