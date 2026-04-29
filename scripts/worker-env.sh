#!/usr/bin/env bash
# Per-repo worker env preparation. SOURCED by Makefile targets
# `launch-worker` and `launch-all-workers` so the two cannot drift on
# how DANXBOT_WORKER_PORT (and friends) are resolved before
# `docker compose up`.
#
# Usage (sourced, never executed):
#   . ./scripts/worker-env.sh <repo-name>
#
# Reads:
#   ./.env                            — root-level shared vars (optional)
#   $REPOS_DIR/<repo>/.danxbot/.env   — per-repo vars incl. DANXBOT_WORKER_PORT
#
# Exports:
#   - Every var defined in either .env file (per-repo wins over root —
#     per-repo is sourced last). Trello XTyPLay0: docker compose's
#     ${CLAUDE_CONFIG_FILE:?...} / ${CLAUDE_CREDS_DIR:?...} interpolation
#     in `.danxbot/config/compose.yml` reads only the shell env at
#     compose-up time, so the documented `.env.example` override block
#     was previously a no-op for `make launch-worker` (only
#     `launch-worker-host` sourced `.env` files). This helper now does
#     it for both targets.
#   - DANXBOT_WORKER_PORT, DANXBOT_REPO_ROOT, CLAUDE_AUTH_DIR are
#     ALWAYS overwritten with values resolved from disk paths and the
#     awk pipeline below — never inherited from parent shell. The
#     overwrite happens AFTER the file-source so a stale shell value
#     (or even a wrong value in either .env) is shadowed.
#
# Trello oGbjLtjN: `launch-all-workers` was leaking the parent shell's
# DANXBOT_WORKER_PORT into every per-repo compose, so the first repo
# won the host bind and the rest failed with "port is already
# allocated". This helper unifies the env-prep both targets need so the
# shadowing class of bug cannot recur from drift.
#
# Trello cjAyJpgr: CLAUDE_PROJECTS_DIR was removed from the export set.
# Each worker's compose.yml now mounts its OWN <repo>/claude-projects/
# via a static `../../claude-projects` path — no env-var indirection,
# no shared danxbot dir, no cross-repo JSONL leakage. Worker compose
# uses Docker's auto-create-on-first-up for the source dir; the
# Makefile recipe explicitly mkdirs it (with the dev's UID, not root)
# before `compose up` so the worker container's `danxbot` user (UID
# 1000) can write to it.

__worker_env_main() {
    local repo="${1:-}"
    if [ -z "$repo" ]; then
        echo "Error: worker-env.sh requires a repo name argument" >&2
        return 1
    fi

    local repos_dir="${REPOS_DIR:-./repos}"
    local repo_path="$repos_dir/$repo"
    local repo_env="$repo_path/.danxbot/.env"

    if [ ! -f "$repo_env" ]; then
        echo "Error: $repo_env not found — needs DANXBOT_WORKER_PORT" >&2
        return 1
    fi

    # Source root + per-repo .env so any var defined in either flows out
    # as an export (per-repo last → wins for shared keys). The awk
    # extraction below shadows DANXBOT_WORKER_PORT regardless, preserving
    # oGbjLtjN race protection. Mirrors `launch-worker-host`'s pattern;
    # lifted here so docker + host runtime modes stay in sync (Trello
    # XTyPLay0). Root `.env` is guarded because tests run from tmpdirs;
    # in real use Make is invoked from the repo root where `.env` exists.
    set -a
    [ -f ./.env ] && . ./.env
    . "$repo_env"
    set +a

    # CRITICAL: read the port from the per-repo .env, NEVER inherit from
    # the parent shell. A leftover DANXBOT_WORKER_PORT (from a prior
    # `make launch-worker` in the same session) would otherwise shadow
    # the per-repo value here, and every loop iteration in
    # `launch-all-workers` would bind the same host port. Mechanism that
    # caught this in production: dev shell had `DANXBOT_WORKER_PORT=5561`
    # exported, `launch-all-workers` brought up `worker-platform` on
    # 5561 (its .env says 5560), then `worker-danxbot` and
    # `worker-gpt-manager` failed to bind the now-allocated 5561.
    #
    # The awk pipeline strips the common `.env` accidents that a naive
    # `cut -d= -f2-` would silently propagate: surrounding `"`/`'`
    # quotes, leading/trailing whitespace, and a CRLF `\r` left over
    # from a Windows-edited file. The numeric guard catches anything
    # that survives — yelling loudly is the right answer for a port
    # value that isn't a port.
    local port
    port="$(awk -F= '/^DANXBOT_WORKER_PORT=/{v=$2; sub(/[ \t\r"'\'']+$/,"",v); sub(/^[ \t"'\'']+/,"",v); print v}' "$repo_env" | tail -n1)"
    if [ -z "$port" ]; then
        echo "Error: DANXBOT_WORKER_PORT missing in $repo_env" >&2
        return 1
    fi
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
        echo "Error: DANXBOT_WORKER_PORT in $repo_env is not numeric: '$port'" >&2
        return 1
    fi

    # Capture realpath into locals first so a missing directory surfaces
    # as an explicit error instead of an empty export. The `claude-auth`
    # dir is scaffolded by the setup skill on a fresh checkout — if it's
    # absent, the worker would silently bind `:` (empty path) into the
    # container and produce a confusing failure downstream.
    local repo_root claude_auth_dir
    repo_root="$(realpath "$repo_path" 2>/dev/null)" \
        || { echo "Error: realpath failed for $repo_path" >&2; return 1; }
    claude_auth_dir="$(realpath "$repos_dir/danxbot/claude-auth" 2>/dev/null)" \
        || { echo "Error: realpath failed for $repos_dir/danxbot/claude-auth" >&2; return 1; }

    # Explicit overwrite — shadows any inherited shell value.
    export DANXBOT_WORKER_PORT="$port"
    export DANXBOT_REPO_ROOT="$repo_root"
    export CLAUDE_AUTH_DIR="$claude_auth_dir"

    return 0
}

__worker_env_main "$@"
__worker_env_status=$?
unset -f __worker_env_main
# Propagate status to the caller. `return` works when sourced; the
# `|| exit` fallback handles the misuse case where someone runs this
# file directly.
return $__worker_env_status 2>/dev/null || exit $__worker_env_status
