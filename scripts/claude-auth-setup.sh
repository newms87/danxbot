#!/bin/bash
# Set up Claude Code auth for the danxbot user via symlinks.
#
# Invoked from entrypoint.sh on every worker container start. Its one job:
# point the in-HOME Claude auth files at the bind-mounted CLAUDE_AUTH_DIR
# via symlinks, so token refreshes on the host (or anywhere else writing to
# the mount source) are live inside the container with no restart.
#
# DO NOT change this back to `cp`. Copying produces a snapshot that freezes
# at container start. When the host's credentials rotate (Claude Code does
# this on its own cadence), the container's copy goes stale and every
# dispatch fails with `401 "Invalid authentication credentials"`. The
# symlink approach is the whole reason this file exists. See Trello
# 9ZurZCK2 for the bug this prevents.
#
# Required env:
#   CLAUDE_AUTH_DIR — absolute path to the mounted auth dir (source of truth)
#   DANXBOT_HOME    — absolute path to the user's HOME inside the container
#
# Optional env:
#   CHOWN_USER — user:group for chown -h on the created symlinks + parent
#                dir. Default "danxbot:danxbot". Set to empty string to skip
#                chown entirely (used by integration tests running as
#                non-root).
#
# Idempotent. `ln -sfn` overwrites any pre-existing file or symlink at the
# target path atomically, so re-invocations and upgrades from an older
# cp-based entrypoint both converge on correct symlinks.

set -eu

: "${CLAUDE_AUTH_DIR:?CLAUDE_AUTH_DIR is required}"
: "${DANXBOT_HOME:?DANXBOT_HOME is required}"
CHOWN_USER="${CHOWN_USER-danxbot:danxbot}"

if [ ! -f "$CLAUDE_AUTH_DIR/.claude.json" ]; then
    echo "WARNING: No Claude auth found at $CLAUDE_AUTH_DIR/ — agent will not work."
    exit 0
fi

# .claude/ is a REAL directory (not a symlink). Claude writes backups/ and
# per-session state here at runtime, so it must be writable. Only the two
# auth FILES inside become symlinks to the mount.
mkdir -p "$DANXBOT_HOME/.claude"

# `-f` replaces any existing regular file or symlink; `-n` prevents
# dereference when the target is an existing symlinked directory.
ln -sfn "$CLAUDE_AUTH_DIR/.claude.json"       "$DANXBOT_HOME/.claude.json"
ln -sfn "$CLAUDE_AUTH_DIR/.credentials.json"  "$DANXBOT_HOME/.claude/.credentials.json"

if [ -n "$CHOWN_USER" ]; then
    # `-h` on every chown so we never accidentally chown a symlink's
    # target — if `.claude` ever pre-existed as a symlink, a bare chown
    # on line 52 would dereference it and mutate ownership outside HOME.
    # Defense in depth: `mkdir -p` + `ln -sfn` above already enforce
    # "real dir + symlink files," so this only matters under unusual
    # state, but the cost of `-h` is zero and the failure mode is ugly.
    chown -h "$CHOWN_USER" "$DANXBOT_HOME/.claude" "$DANXBOT_HOME/.claude.json" "$DANXBOT_HOME/.claude/.credentials.json"
fi

echo "Claude Code auth configured via symlinks."
