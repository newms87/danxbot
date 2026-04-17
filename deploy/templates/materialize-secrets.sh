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

# Write atomically to tmp files then mv into place — if the fetch fails
# partway through, the existing .env survives instead of being truncated.
write_atomic() {
  local dest="$1"
  local tmp="${dest}.tmp.$$"
  cat > "$tmp"
  mv "$tmp" "$dest"
}

# awk snippet that writes a .env line, double-quoting values that contain
# whitespace, `#`, `$`, `"`, or `\`. Simple alphanumeric/URL values stay
# unquoted so docker-compose (which may treat literal quotes as-is) gets
# clean values; Laravel's dotenv (which requires quoting around whitespace)
# gets correctly-quoted values.
AWK_EMIT='
function emit(key, val) {
  if (val ~ /[ \t#$"\\]/) {
    gsub(/\\/, "\\\\", val)
    gsub(/"/, "\\\"", val)
    printf "%s=\"%s\"\n", key, val
  } else {
    printf "%s=%s\n", key, val
  }
}
'

echo "── Materializing shared keys to $ROOT/.env ──"
mkdir -p "$ROOT"
fetch_path "$SSM_PREFIX/shared/" | awk -F'\t' "$AWK_EMIT"'
  NF >= 2 && $1 != "" {
    n = split($1, parts, "/"); key = parts[n];
    val = $2;
    for (i = 3; i <= NF; i++) val = val "\t" $i;
    emit(key, val);
  }
' | write_atomic "$ROOT/.env"

for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  repo_root="$ROOT/repos/$repo"
  mkdir -p "$repo_root/.danxbot"
  danxbot_env="$repo_root/.danxbot/.env"
  app_env="$repo_root/.env"

  echo "── Materializing $SSM_PREFIX/repos/$repo/ → $repo_root ──"
  raw=$(fetch_path "$SSM_PREFIX/repos/$repo/")
  echo "$raw" | awk -F'\t' "$AWK_EMIT"'
    NF >= 2 && $1 != "" {
      n = split($1, parts, "/"); key = parts[n];
      val = $2;
      for (i = 3; i <= NF; i++) val = val "\t" $i;
      if (key ~ /^REPO_ENV_/) next;
      emit(key, val);
    }
  ' | write_atomic "$danxbot_env"
  echo "$raw" | awk -F'\t' "$AWK_EMIT"'
    NF >= 2 && $1 != "" {
      n = split($1, parts, "/"); key = parts[n];
      val = $2;
      for (i = 3; i <= NF; i++) val = val "\t" $i;
      if (key !~ /^REPO_ENV_/) next;
      stripped = substr(key, length("REPO_ENV_") + 1);
      emit(stripped, val);
    }
  ' | write_atomic "$app_env"
done

echo "── Done materializing ──"
