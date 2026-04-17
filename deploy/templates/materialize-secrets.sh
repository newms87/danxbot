#!/bin/bash
# Materialize SSM secrets for one deployment into the expected file layout.
#
# Usage:
#   materialize-secrets.sh <ssm_prefix> <region> [<repo_name>...]
#
# For each repo_name, materializes /<ssm_prefix>/repos/<repo_name>/* into
# the repo's .danxbot/.env (non-REPO_ENV keys) and .env (REPO_ENV_* with
# prefix stripped). Shared keys go to $DANXBOT_ROOT/.env.
#
# DANXBOT_ROOT defaults to /danxbot when unset (production); tests can
# override it to point at a temp directory.

set -euo pipefail

SSM_PREFIX="${1:?ssm_prefix required}"
REGION="${2:?region required}"
shift 2
REPOS=("$@")

ROOT="${DANXBOT_ROOT:-/danxbot}"

fetch_path() {
  aws ssm get-parameters-by-path \
    --path "$1" \
    --recursive \
    --with-decryption \
    --region "$REGION" \
    --query "Parameters[*].[Name,Value]" \
    --output text
}

echo "── Materializing shared keys to $ROOT/.env ──"
mkdir -p "$ROOT"
: > "$ROOT/.env"
fetch_path "$SSM_PREFIX/shared/" | while IFS=$'\t' read -r name value; do
  [ -z "$name" ] && continue
  key="${name##*/}"
  printf '%s=%s\n' "$key" "$value" >> "$ROOT/.env"
done

for repo in "${REPOS[@]}"; do
  repo_root="$ROOT/repos/$repo"
  mkdir -p "$repo_root/.danxbot"
  danxbot_env="$repo_root/.danxbot/.env"
  app_env="$repo_root/.env"
  : > "$danxbot_env"
  : > "$app_env"

  echo "── Materializing $SSM_PREFIX/repos/$repo/ → $repo_root ──"
  fetch_path "$SSM_PREFIX/repos/$repo/" | while IFS=$'\t' read -r name value; do
    [ -z "$name" ] && continue
    key="${name##*/}"
    if [[ "$key" == REPO_ENV_* ]]; then
      stripped="${key#REPO_ENV_}"
      printf '%s=%s\n' "$stripped" "$value" >> "$app_env"
    else
      printf '%s=%s\n' "$key" "$value" >> "$danxbot_env"
    fi
  done
done

echo "── Done materializing ──"
