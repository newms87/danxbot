#!/usr/bin/env bash
# Self-termination check for ephemeral Danxbot sessions.
# Usage: .claude/tools/danx-self-terminate.sh $PPID
#
# If DANXBOT_EPHEMERAL=1, removes the poller lock and kills the given PID.
# Otherwise, prints a message and exits cleanly.
#
# The lock file is at DANXBOT_PROJECT_ROOT/.poller-running (set by the poller
# before spawning this agent).

TARGET_PID="${1:?Usage: danx-self-terminate.sh <pid>}"

if [ "$DANXBOT_EPHEMERAL" = "1" ]; then
  if [ -n "$DANXBOT_PROJECT_ROOT" ]; then
    rm -f "$DANXBOT_PROJECT_ROOT/.poller-running"
  fi
  kill "$TARGET_PID"
else
  echo "Do not self-terminate"
fi
