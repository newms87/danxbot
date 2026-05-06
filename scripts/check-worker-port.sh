#!/usr/bin/env bash
#
# Mutex check between docker-compose worker and host-mode worker for the
# same per-repo DANXBOT_WORKER_PORT. Both runtimes read the same env and
# bind the same host port; only one can hold it. Prior to this script,
# Docker silently degraded port-publish when host-mode already held the
# port (no host conflict, no log, container running but unreachable from
# outside). This script enforces a loud failure in every direction.
#
# Modes:
#   host        — verify safe to start the host worker. Fails if the
#                 per-repo container is running OR anything is bound to
#                 the port.
#   container   — verify safe to start the per-repo container. Fails if
#                 any process is listening on the host port.
#   post-up     — run AFTER `docker compose up -d`. Verifies the
#                 container actually published the port (i.e. docker-proxy
#                 did not silently fail). If not, stops the container
#                 and exits non-zero.
#
# Usage:
#   check-worker-port.sh <mode> <repo> <port>

set -euo pipefail

MODE="${1:?Usage: check-worker-port.sh <mode> <repo> <port>}"
REPO="${2:?Usage: check-worker-port.sh <mode> <repo> <port>}"
PORT="${3:?Usage: check-worker-port.sh <mode> <repo> <port>}"
CONTAINER="danxbot-worker-${REPO}"

container_running() {
    [ -n "$(docker ps --quiet --filter "name=^${CONTAINER}\$" 2>/dev/null)" ]
}

host_listening() {
    # ss exits 0 even with no rows; check stdout. -H suppresses header.
    [ -n "$(ss -ltnH "sport = :${PORT}" 2>/dev/null)" ]
}

case "$MODE" in
    host)
        if container_running; then
            cat >&2 <<EOF
Error: container '${CONTAINER}' is already running.
Both the container worker and host worker bind host port ${PORT}; only one runtime can run at a time.
Stop the container first:
  make stop-worker REPO=${REPO}
EOF
            exit 1
        fi
        if host_listening; then
            cat >&2 <<EOF
Error: host port ${PORT} is already in use (something else is listening).
Identify the holder with:
  ss -ltnp 'sport = :${PORT}'
Then stop it before launching this worker.
EOF
            exit 1
        fi
        ;;
    container)
        if host_listening; then
            cat >&2 <<EOF
Error: host port ${PORT} is already in use — Docker cannot publish ${PORT}:${PORT}.
Likely cause: a host-mode worker is running. Stop it before launching the container, or kill the holder reported by:
  ss -ltnp 'sport = :${PORT}'
EOF
            exit 1
        fi
        ;;
    post-up)
        # docker-proxy bind failure is non-fatal to container start; we
        # have to detect it by inspecting the runtime port table. Empty
        # = silent degrade.
        if ! docker port "${CONTAINER}" 2>/dev/null | grep -q "^${PORT}/tcp"; then
            cat >&2 <<EOF
Error: container '${CONTAINER}' started but host port ${PORT} is NOT published.
Likely cause: docker-proxy failed to bind because something else holds host port ${PORT}.
Stopping the container so the runtime is consistent. Investigate:
  ss -ltnp 'sport = :${PORT}'
EOF
            docker stop "${CONTAINER}" >/dev/null 2>&1 || true
            exit 1
        fi
        ;;
    *)
        echo "Error: unknown mode '${MODE}' (expected: host, container, post-up)" >&2
        exit 1
        ;;
esac
