#!/usr/bin/env bash
# Self-termination check for ephemeral Danxbot sessions.
# Usage: ./scripts/self-terminate.sh $PPID
#
# If DANXBOT_EPHEMERAL=1, removes the poller lock and kills the given PID.
# Otherwise, prints a message and exits cleanly.

TARGET_PID="${1:?Usage: self-terminate.sh <pid>}"

if [ "$DANXBOT_EPHEMERAL" = "1" ]; then
  rm -f .poller-running
  kill "$TARGET_PID"
else
  echo "Do not self-terminate"
fi
