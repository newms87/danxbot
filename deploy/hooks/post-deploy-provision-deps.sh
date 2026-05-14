#!/usr/bin/env bash
# DX-540 — post-deploy hook that materializes /srv/sfc-deps/<v>/
# from the operator-configured S3 manifest bucket on the deploy host.
#
# Invoked by deploy/cli.ts via `RemoteHost.sshRunStreaming` after
# workers come up. The script runs as the danxbot user on the remote
# host; it expects:
#   - `npx tsx` available on PATH (the host's node baseline).
#   - The danxbot repo checked out at /danxbot/app (consistent with
#     deploy/build.ts and the worker container compose mounts).
#   - SFC_DEPS_S3_BUCKET + AWS env vars exported from /danxbot/.env
#     (materialized by /usr/local/bin/materialize-secrets.sh earlier
#     in the deploy flow).
#
# Idempotent — re-running it against unchanged manifests is a no-op
# (the provisioner skips up-to-date deps dirs). Failures are
# logged + propagated via exit code 1 so the deploy surfaces them.
#
# A missing SFC_DEPS_S3_BUCKET (no consumer repo has published a
# manifest yet) returns exit code 0 with a "no source configured"
# log line — that's the normal state for a fresh danxbot install.

set -euo pipefail

REPO_ROOT="${DANXBOT_REPO_ROOT:-/danxbot/app}"
ENV_FILE="${DANXBOT_ENV_FILE:-/danxbot/.env}"

if [ ! -d "$REPO_ROOT" ]; then
  echo "[post-deploy-provision-deps] $REPO_ROOT missing — danxbot repo not mounted on host"
  exit 1
fi

# Pull SFC_DEPS_* + AWS_* out of the materialized env file so this
# script can be invoked outside the worker container's runtime env.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [ -z "${SFC_DEPS_S3_BUCKET:-}" ] && [ -z "${SFC_DEPS_LOCAL_MANIFEST_DIR:-}" ]; then
  echo "[post-deploy-provision-deps] no manifest source configured — skipping (set SFC_DEPS_S3_BUCKET to enable)"
  exit 0
fi

# Ensure the base dir exists with the right ownership before the
# Node script touches it. The script itself runs as the danxbot user;
# the install pass needs write access.
#
# Ownership-on-create only: re-running the hook on a pre-existing
# /srv/sfc-deps/ does NOT chown the directory (a prior `|| true`
# silently masked permission failures and could downgrade ownership
# to root when the hook later runs as root). The operator owns
# fixing the perms if they drift.
BASE_DIR="${SFC_DEPS_BASE_DIR:-/srv/sfc-deps}"
if [ ! -d "$BASE_DIR" ]; then
  sudo mkdir -p "$BASE_DIR"
  sudo chown "$(id -u):$(id -g)" "$BASE_DIR"
fi
if [ ! -w "$BASE_DIR" ]; then
  echo "[post-deploy-provision-deps] $BASE_DIR is not writable by $(id -un); operator must fix ownership"
  exit 1
fi

cd "$REPO_ROOT"
npx tsx scripts/provision-sfc-deps.ts
