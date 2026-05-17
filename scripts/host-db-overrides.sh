#!/usr/bin/env bash
# Resolve host-mapped postgres ports for the danxbot shared DB and the
# connected repo's Laravel app DB (if the repo declares one), so
# `make launch-worker-host` can export overrides that make the host
# worker reach what the docker worker normally reaches via
# docker-network DNS.
#
# Default invocation prints a human-readable summary (one line per
# resolved override). `--export` prints `KEY=value` lines suitable for
# `eval "$(... --export)"`.
#
# Container conventions:
#   - danxbot shared postgres: `danxbot-postgres-db`
#   - connected repo's Laravel app DB (optional): `<REPO>-pgsql-1`
#
# Connected-repo Laravel app DB probe is GATED on `DANX_DB_HOST` being
# set in `<repo>/.danxbot/.env`. Repos that aren't Laravel apps (e.g.
# danxbot itself) leave `DANX_DB_HOST` empty and the probe is skipped
# entirely — no warning, no override.
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

DANXBOT_PG_PORT="$(resolve_port danxbot-postgres-db 5432)"

# Determine whether this repo declares a Laravel app DB. The repo's
# `.danxbot/.env` is the source of truth — DANX_DB_HOST empty (or the
# file absent) means "no Laravel app DB, skip the probe".
REPO_ENV_FILE=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for candidate in \
  "${SCRIPT_DIR}/../repos/${REPO}/.danxbot/.env" \
  "${SCRIPT_DIR}/../../repos/${REPO}/.danxbot/.env"; do
  if [ -f "$candidate" ]; then
    REPO_ENV_FILE="$candidate"
    break
  fi
done

REPO_HAS_APP_DB=0
if [ -n "$REPO_ENV_FILE" ]; then
  # Source in a subshell so we don't pollute caller env, just read the
  # DANX_DB_HOST value.
  REPO_DB_HOST="$(awk -F= '/^DANX_DB_HOST=/{sub(/^DANX_DB_HOST=/,""); print; exit}' "$REPO_ENV_FILE" | tr -d '"' | tr -d "'")"
  if [ -n "${REPO_DB_HOST:-}" ]; then
    REPO_HAS_APP_DB=1
  fi
fi

PLATFORM_PG_PORT=""
PLATFORM_CONTAINER="${REPO}-pgsql-1"
if [ "$REPO_HAS_APP_DB" = "1" ]; then
  PLATFORM_PG_PORT="$(resolve_port "$PLATFORM_CONTAINER" 5432)"
fi

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
  echo "  (danxbot-postgres-db not running — leaving DANXBOT_DB_HOST/PORT untouched)"
fi

if [ "$REPO_HAS_APP_DB" = "1" ]; then
  if [ -n "$PLATFORM_PG_PORT" ]; then
    emit DANXBOT_PLATFORM_DB_HOST 127.0.0.1
    emit DANXBOT_PLATFORM_DB_PORT "$PLATFORM_PG_PORT"
    emit DANX_DB_HOST 127.0.0.1
    emit DANX_DB_PORT "$PLATFORM_PG_PORT"
  elif [ "$MODE" != "--export" ]; then
    echo "  ($PLATFORM_CONTAINER not running — host worker cannot reach connected repo's Laravel app DB)"
  fi
fi
