#!/usr/bin/env bash
#
# Danxbot Agent Creation E2E Test (DX-262)
#
# Validates that POSTing a new agent through the dashboard creates a git
# worktree whose .git pointer resolves from the host worker's perspective —
# the exact thing that broke in docker-mode dashboard (DX-262 root cause:
# `git worktree add` ran with the container path baked into worktree
# metadata, breaking the host worker's `syncWorktree(<agent>)`).
#
# This test creates a throwaway agent, asserts the worktree exists AND is
# a real git repository (i.e. `git -C <worktree> status` exits 0 from the
# host), then deletes it and asserts cleanup.
#
# Prerequisites: dashboard reachable (default http://localhost:5566),
# a valid bearer token at ~/.config/danxbot/dashboard-token, and a
# connected repo named DANXBOT_TEST_REPO (default: danxbot).
#
# Cost: ~$0 — no Claude API calls. Pure dashboard API + filesystem assertion.
#
# Usage:
#   ./src/__tests__/system/test-agent-creation.sh
#
# Env overrides:
#   DASHBOARD_URL   default http://localhost:5566
#   DASHBOARD_TOKEN default $(cat ~/.config/danxbot/dashboard-token)
#   DANXBOT_TEST_REPO default danxbot

set -euo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:5566}"
DASHBOARD_TOKEN="${DASHBOARD_TOKEN:-$(cat "${HOME}/.config/danxbot/dashboard-token" 2>/dev/null || echo "")}"
TEST_REPO="${DANXBOT_TEST_REPO:-danxbot}"
TEST_AGENT="e2etest-$(date +%s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(realpath "${PROJECT_ROOT}/repos/${TEST_REPO}")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; NC='\033[0m'

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${YELLOW}→${NC} $1"; }

# Always attempt cleanup so a partial failure does not leave a phantom
# agent record + stuck worktree behind.
cleanup() {
  curl -sS -X DELETE \
    -H "Authorization: Bearer ${DASHBOARD_TOKEN}" \
    "${DASHBOARD_URL}/api/agents/${TEST_AGENT}?repo=${TEST_REPO}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo -e "${BOLD}DX-262 — Agent creation E2E${NC}"
echo "  Dashboard:    ${DASHBOARD_URL}"
echo "  Repo:         ${TEST_REPO}  (${REPO_ROOT})"
echo "  Agent:        ${TEST_AGENT}"

if [[ -z "$DASHBOARD_TOKEN" ]]; then
  fail "DASHBOARD_TOKEN unset and ~/.config/danxbot/dashboard-token missing"
  exit 1
fi

# --- 1. POST /api/agents ---
info "POST /api/agents"
post_body=$(cat <<JSON
{
  "name": "${TEST_AGENT}",
  "bio": "DX-262 throwaway agent for worktree-creation validation",
  "capabilities": ["test"],
  "schedule": "always",
  "enabled": true
}
JSON
)
post_code=$(curl -sS -o /tmp/dx262-post.json -w "%{http_code}" -X POST \
  -H "Authorization: Bearer ${DASHBOARD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$post_body" \
  "${DASHBOARD_URL}/api/agents?repo=${TEST_REPO}")

if [[ "$post_code" == "201" ]]; then
  pass "POST returned 201"
else
  fail "POST returned ${post_code} (expected 201)"
  echo "    body: $(cat /tmp/dx262-post.json)"
  exit 1
fi

# --- 2. Worktree directory exists ---
WORKTREE="${REPO_ROOT}/.danxbot/worktrees/${TEST_AGENT}"
if [[ -d "$WORKTREE" ]]; then
  pass "Worktree dir present at ${WORKTREE}"
else
  fail "Worktree dir missing: ${WORKTREE}"
  exit 1
fi

# --- 3. The DX-262 assertion — .git pointer resolves from host ---
# Pre-fix: dashboard ran `git worktree add` from inside the container,
# baking `/danxbot/app/repos/<name>/.git/worktrees/<agent>` into the
# worktree's `.git` pointer. That path is invisible to the host worker
# → `fatal: not a git repository`. Post-fix: dashboard runs the op at
# the mirror-bound host abs path so the pointer works on both sides.
if (cd "$WORKTREE" && git status >/dev/null 2>&1); then
  pass "git status inside worktree exits 0 (gitdir resolves from host)"
else
  gitdir_content="$(cat "$WORKTREE/.git" 2>/dev/null || echo "<.git missing>")"
  fail "git status inside worktree FAILED — DX-262 regression"
  echo "    .git contents: $gitdir_content"
  echo "    Expected gitdir to point at a path real on the host."
  exit 1
fi

# --- 4. Settings record contains the agent ---
settings_path="${REPO_ROOT}/.danxbot/settings.json"
if node -e "const s=require('fs').readFileSync('${settings_path}','utf-8'); const j=JSON.parse(s); if (!j.agents || !j.agents['${TEST_AGENT}']) process.exit(1);" 2>/dev/null; then
  pass "settings.json contains agents.${TEST_AGENT}"
else
  fail "settings.json missing agents.${TEST_AGENT}"
fi

# --- 5. DELETE /api/agents/<name> ---
info "DELETE /api/agents/${TEST_AGENT}"
del_code=$(curl -sS -o /tmp/dx262-del.json -w "%{http_code}" -X DELETE \
  -H "Authorization: Bearer ${DASHBOARD_TOKEN}" \
  "${DASHBOARD_URL}/api/agents/${TEST_AGENT}?repo=${TEST_REPO}")

if [[ "$del_code" == "204" ]]; then
  pass "DELETE returned 204"
else
  fail "DELETE returned ${del_code} (expected 204)"
  echo "    body: $(cat /tmp/dx262-del.json)"
fi

# --- 6. Worktree torn down ---
if [[ ! -d "$WORKTREE" ]]; then
  pass "Worktree dir removed after DELETE"
else
  fail "Worktree dir still present: ${WORKTREE}"
fi

# --- 7. Settings record dropped ---
if node -e "const s=require('fs').readFileSync('${settings_path}','utf-8'); const j=JSON.parse(s); if (j.agents && j.agents['${TEST_AGENT}']) process.exit(1);" 2>/dev/null; then
  pass "settings.json no longer contains agents.${TEST_AGENT}"
else
  fail "settings.json still has agents.${TEST_AGENT}"
fi

# Disarm the EXIT trap — DELETE already ran cleanly.
trap - EXIT

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}PASSED${NC} — agent create+dispatch+delete validated end-to-end (${PASS} checks)"
  exit 0
else
  echo -e "${RED}${BOLD}FAILED${NC} — ${FAIL} of $((PASS+FAIL)) checks failed"
  exit 1
fi
