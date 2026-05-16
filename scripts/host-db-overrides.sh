#!/usr/bin/env bash
# Resolve host-mapped postgres ports for the danxbot shared DB and the
# connected repo's Laravel platform DB, so `make launch-worker-host` can
# export overrides that make the host worker reach what the docker
# worker normally reaches via docker-network DNS.
#
# Default invocation prints a human-readable summary (one line per
# resolved override). `--export` prints `KEY=value` lines suitable for
# `eval "$(... --export)"`.
#
# Container conventions:
#   - danxbot shared postgres: `danxbot-postgres-1`
#   - per-repo Laravel postgres: `<REPO>-pgsql-1`
#
# Missing container = noop for that override (the caller's .env value
# stands). Unmapped 5432/tcp on a present container = warn + skip.

set -euo pipefail

REPO="${1:-}"
MODE="${2:-summary}"

if [ -z "$REPO" ]; then
  echo "usage: host-db-overrides.sh <repo> [--export]" >&2
  exit 1
fi

# Resolve host-mapped port for <container>:<internal_port>/tcp.
# Echoes the port or empty string if not found.
resolve_port() {
  local container="$1"
  local internal="$2"
  if ! docker ps -q -f "name=^${container}$" 2>/dev/null | grep -q .; then
    return 0
  fi
  docker port "$container" "${internal}/tcp" 2>/dev/null \
    | head -1 \
    | awk -F: '{print $NF}' \
    | tr -d '\n'
}

DANXBOT_PG_PORT="$(resolve_port danxbot-postgres-1 5432)"
PLATFORM_CONTAINER="${REPO}-pgsql-1"
PLATFORM_PG_PORT="$(resolve_port "$PLATFORM_CONTAINER" 5432)"

emit() {
  local key="$1"
  local val="$2"
  if [ "$MODE" = "--export" ]; then
    printf 'export %s=%s\n' "$key" "$val"
  else
    printf '  %s=%s\n' "$key" "$val"
  fi
}

if [ "$MODE" != "--export" ]; then
  echo "host-db-overrides for repo=$REPO:"
fi

if [ -n "$DANXBOT_PG_PORT" ]; then
  emit DANXBOT_DB_HOST 127.0.0.1
  emit DANXBOT_DB_PORT "$DANXBOT_PG_PORT"
elif [ "$MODE" != "--export" ]; then
  echo "  (danxbot-postgres-1 not running — leaving DANXBOT_DB_HOST/PORT untouched)"
fi

if [ -n "$PLATFORM_PG_PORT" ]; then
  emit DANXBOT_PLATFORM_DB_HOST 127.0.0.1
  emit DANXBOT_PLATFORM_DB_PORT "$PLATFORM_PG_PORT"
  emit DANX_DB_HOST 127.0.0.1
  emit DANX_DB_PORT "$PLATFORM_PG_PORT"
elif [ "$MODE" != "--export" ]; then
  echo "  ($PLATFORM_CONTAINER not running — host worker cannot reach platform DB)"
fi
