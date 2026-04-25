#!/usr/bin/env bash
# Verify CLAUDE_CONFIG_FILE and CLAUDE_CREDS_DIR are set in the shell
# environment before `make launch-worker REPO=danxbot` invokes
# `docker compose up`. These vars feed compose interpolation in
# .danxbot/config/compose.yml — the file-bind for `.claude.json` and
# the dir-bind for `.claude/`. When unset, compose silently fell back
# to a stale snapshot dir under `claude-auth/` that broke dispatches
# within ~24h of setup once host token rotation kicked in
# (Trello th8GCprR).
#
# This is the first line of defense; the matching `${VAR:?...}` syntax
# in compose.yml is the second. Failing here means the operator never
# reaches docker compose with broken config, and the error message can
# point them at .env.example for the copy-pasteable block.
#
# Exit 0 if both vars are non-empty; exit 1 with a clear error otherwise.

set -euo pipefail

missing=()
if [ -z "${CLAUDE_CONFIG_FILE:-}" ]; then
  missing+=("CLAUDE_CONFIG_FILE")
fi
if [ -z "${CLAUDE_CREDS_DIR:-}" ]; then
  missing+=("CLAUDE_CREDS_DIR")
fi

if [ ${#missing[@]} -ne 0 ]; then
  {
    echo "Error: required env vars missing: ${missing[*]}"
    echo ""
    echo "Set CLAUDE_CONFIG_FILE and CLAUDE_CREDS_DIR in your danxbot .env to point"
    echo "at your live host Claude Code auth file/dir, so token rotation is visible"
    echo "inside the worker container without a restart."
    echo ""
    echo "See .env.example for a copy-pasteable block."
  } >&2
  exit 1
fi
