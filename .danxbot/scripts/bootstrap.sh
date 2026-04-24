#!/bin/bash
# bootstrap.sh — idempotent setup for danxbot.
#
# On a production instance (Ubuntu + docker installed, no host Node), this
# installs npm dependencies via a docker one-shot so no host toolchain is
# needed. Locally it uses the host's node/npm if available (faster).
#
# Exits 0 when the tree has node_modules + dashboard/dist; non-zero on any
# failure. Streams output.

set -euo pipefail

cd "$(dirname "$0")/../.."

NODE_IMG="node:20-bookworm"

run_npm() {
  local workdir="$1"
  shift
  if command -v npm >/dev/null 2>&1; then
    (cd "$workdir" && npm "$@")
  else
    # No host Node — use docker. -u matches host uid/gid so output files
    # don't end up owned by root.
    docker run --rm \
      -u "$(id -u):$(id -g)" \
      -v "$(pwd):/app" \
      -w "/app/$workdir" \
      "$NODE_IMG" \
      npm "$@"
  fi
}

echo "── Installing root npm dependencies ──"
run_npm "." install --prefer-offline --no-audit --no-fund

echo "── Installing dashboard dependencies ──"
run_npm "dashboard" install --prefer-offline --no-audit --no-fund

echo "── Building dashboard for production ──"
run_npm "dashboard" run build

echo "── Bootstrap complete ──"
