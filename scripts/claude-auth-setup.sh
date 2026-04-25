#!/bin/bash
# Set up Claude Code auth for the danxbot user via symlinks.
#
# Invoked from entrypoint.sh on every worker container start. Its one job:
# point the in-HOME Claude auth files at the bind-mounted CLAUDE_AUTH_DIR
# via symlinks, so token refreshes on the host (or anywhere else writing to
# the mount source) are live inside the container with no restart.
#
# Canonical layout inside $CLAUDE_AUTH_DIR (Trello 0bjFD0a2):
#   $CLAUDE_AUTH_DIR/.claude.json              ← preferences/session state.
#                                                Reached via a FILE-level
#                                                bind. Host atomic-write
#                                                rotation pins the original
#                                                inode until the next
#                                                worker restart, which is
#                                                acceptable because this
#                                                file is not auth-critical.
#   $CLAUDE_AUTH_DIR/.claude/.credentials.json ← OAuth bearer token.
#                                                Reached via a DIR-level
#                                                bind on `.claude/`. Dir
#                                                mounts expose the
#                                                directory's CURRENT file
#                                                table, so a host
#                                                rename(tmp, target) inside
#                                                the dir is visible inside
#                                                the container on the next
#                                                open() — no restart needed.
#
# DO NOT change this back to `cp`. Copying produces a snapshot that freezes
# at container start. When the host's credentials rotate (Claude Code does
# this on its own cadence via atomic write + rename), the container's copy
# goes stale and every dispatch fails with `401 "Invalid authentication
# credentials"`. The symlink approach is half the fix; the dir-bind for
# `.claude/` is the other half (Trello 9ZurZCK2 for snapshot staleness;
# 0bjFD0a2 for rename-rotation tolerance).
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

# Symmetric guard for the credentials subdir. After Trello 0bjFD0a2 split
# the layout into `.claude.json` (root) + `.claude/.credentials.json`
# (subdir under a dir-bind), `.claude.json` can exist without
# `.credentials.json` — partial provisioning, mid-deploy state, dev shell
# that ran `cp` for the config but skipped the creds. Without this
# parallel guard `ln -sfn` below would happily create a dangling symlink,
# the worker would report healthy, and every dispatch would fail with 401
# at the first auth attempt — exactly the silent-fallback failure mode
# this file's header forbids. Fail soft (exit 0) for consistency with the
# `.claude.json`-missing case so dev shells can still boot the worker for
# inspection; the WARNING makes the half-configured state visible.
if [ ! -f "$CLAUDE_AUTH_DIR/.claude/.credentials.json" ]; then
    echo "WARNING: No Claude credentials at $CLAUDE_AUTH_DIR/.claude/.credentials.json — agent will fail with 401 on first dispatch."
    exit 0
fi

# .claude/ is a REAL directory (not a symlink). Claude writes backups/ and
# per-session state here at runtime, so it must be writable. Only the two
# auth FILES inside become symlinks to the mount.
mkdir -p "$DANXBOT_HOME/.claude"

# `-f` replaces any existing regular file or symlink; `-n` prevents
# dereference when the target is an existing symlinked directory.
# `.credentials.json` lives one level down in the mount's `.claude/` subdir
# — see the layout block at the top of this file. The subdir is what makes
# host rename-rotation visible inside the container.
ln -sfn "$CLAUDE_AUTH_DIR/.claude.json"               "$DANXBOT_HOME/.claude.json"
ln -sfn "$CLAUDE_AUTH_DIR/.claude/.credentials.json"  "$DANXBOT_HOME/.claude/.credentials.json"

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
