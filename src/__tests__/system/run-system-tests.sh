#!/usr/bin/env bash
#
# Danxbot System Tests — End-to-end tests against real Docker workers.
#
# Prerequisites: Docker infrastructure running (make launch-infra + make launch-worker).
# Each test uses real Claude API calls ($0.05-$0.10 per dispatch test).
#
# Usage:
#   ./src/__tests__/system/run-system-tests.sh [OPTIONS]
#
# Options:
#   --worker-port PORT   Worker port (default: 5561)
#   --test NAME          Run a single test (health, dispatch, heartbeat, cancel, error, poller, yaml-memory, multi-worker, cleanup)
#   --host-mode          Include host-mode-only tests (stall detection)
#   --api-token TOKEN    API token for dispatch requests (default: "system-test-token")

set -euo pipefail

# --- Configuration ---

WORKER_PORT="${DANXBOT_WORKER_PORT:-5561}"
WORKER_HOST="127.0.0.1"
SINGLE_TEST=""
HOST_MODE=false
API_TOKEN="system-test-token"
LOG_FILE="/tmp/danxbot-system-test-results.log"
CAPTURE_PID=""
CAPTURE_PORT=""
CAPTURE_OUTPUT=""
CAPTURE_HOST=""  # Host IP reachable from Docker containers (detected at runtime)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# --- Colors ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No color

# --- Counters ---

PASS=0
FAIL=0
SKIP=0
TOTAL_START=""

# --- Argument Parsing ---

while [[ $# -gt 0 ]]; do
  case $1 in
    --worker-port) WORKER_PORT="$2"; shift 2 ;;
    --test) SINGLE_TEST="$2"; shift 2 ;;
    --host-mode) HOST_MODE=true; shift ;;
    --api-token) API_TOKEN="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

WORKER_URL="http://${WORKER_HOST}:${WORKER_PORT}"

# --- Helpers ---

log() { echo -e "$1" | tee -a "$LOG_FILE"; }
log_header() { log "\n${BOLD}${CYAN}=== $1 ===${NC}"; }
log_pass() { log "  ${GREEN}✓${NC} $1"; }
log_fail() { log "  ${RED}✗${NC} $1"; }
log_info() { log "  ${YELLOW}→${NC} $1"; }

pass() { PASS=$((PASS + 1)); log_pass "$1"; }
fail() { FAIL=$((FAIL + 1)); log_fail "$1"; }
skip() { SKIP=$((SKIP + 1)); log "  ${YELLOW}⊘${NC} $1 (skipped)"; }

# JSON field extraction (no jq dependency — uses node with process.argv for safety)
json_field() {
  local json="$1" field="$2"
  node -e "const d=JSON.parse(process.argv[1]); const v=d[process.argv[2]]; process.stdout.write(String(v ?? ''));" "$json" "$field" 2>/dev/null
}

# HTTP helpers
http_get() {
  curl -s --max-time 10 "$1" 2>/dev/null || echo '{"error":"curl_failed"}'
}

http_post() {
  local url="$1" body="$2"
  curl -s --max-time 30 -X POST -H "Content-Type: application/json" -d "$body" "$url" 2>/dev/null || echo '{"error":"curl_failed"}'
}

# Poll job status until non-running or timeout
poll_status() {
  local job_id="$1" timeout_s="${2:-120}" interval_s="${3:-2}"
  local elapsed=0 response status
  while [[ $elapsed -lt $timeout_s ]]; do
    response=$(http_get "${WORKER_URL}/api/status/${job_id}")
    status=$(json_field "$response" "status")
    if [[ "$status" != "running" && -n "$status" ]]; then
      echo "$response"
      return 0
    fi
    sleep "$interval_s"
    elapsed=$((elapsed + interval_s))
  done
  echo "$response"
  return 1
}

# Detect the host IP reachable from Docker containers.
# When the worker runs in Docker, 127.0.0.1 points to the container itself.
# We need the Docker bridge gateway IP so the container can reach our capture server.
detect_capture_host() {
  if [[ -n "$CAPTURE_HOST" ]]; then return; fi

  # Check if the worker is in Docker by looking for a container matching the port
  local container_name
  container_name=$(docker ps --filter "publish=${WORKER_PORT}" --format "{{.Names}}" 2>/dev/null | head -1)

  if [[ -n "$container_name" ]]; then
    # Worker is in Docker — get the gateway IP from the container's network
    CAPTURE_HOST=$(docker inspect "$container_name" --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' 2>/dev/null | head -1)
    if [[ -z "$CAPTURE_HOST" ]]; then
      CAPTURE_HOST="172.17.0.1"  # Docker default bridge gateway
    fi
    log_info "Worker in Docker — capture server reachable at $CAPTURE_HOST"
  else
    # Worker is on host — localhost works
    CAPTURE_HOST="127.0.0.1"
  fi
}

# Start capture server in background
start_capture_server() {
  detect_capture_host

  local port_file
  port_file=$(mktemp /tmp/danxbot-capture-port-XXXXXX)
  CAPTURE_OUTPUT=$(mktemp /tmp/danxbot-capture-XXXXXX.json)

  (cd "$PROJECT_ROOT" && npx tsx src/__tests__/integration/helpers/capture-server-cli.ts --output "$CAPTURE_OUTPUT" > "$port_file" 2>/dev/null) &
  CAPTURE_PID=$!

  # Wait for port to be written (up to 5s)
  local waited=0
  while [[ ! -s "$port_file" && $waited -lt 50 ]]; do
    sleep 0.1
    waited=$((waited + 1))
  done

  CAPTURE_PORT=$(head -1 "$port_file" | tr -d '[:space:]')
  rm -f "$port_file"

  if [[ -z "$CAPTURE_PORT" ]]; then
    log_fail "Capture server failed to start"
    return 1
  fi
  log_info "Capture server started on port $CAPTURE_PORT (pid $CAPTURE_PID, host $CAPTURE_HOST)"
}

# Stop capture server and read captured requests
stop_capture_server() {
  if [[ -n "$CAPTURE_PID" ]]; then
    kill "$CAPTURE_PID" 2>/dev/null || true
    wait "$CAPTURE_PID" 2>/dev/null || true
    CAPTURE_PID=""
  fi
}

# Count requests in capture output by method
count_captured() {
  local method="$1"
  if [[ ! -f "$CAPTURE_OUTPUT" ]]; then echo "0"; return; fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    console.log(data.filter(r => r.method === process.argv[2]).length);
  " "$CAPTURE_OUTPUT" "$method" 2>/dev/null || echo "0"
}

# Count requests in capture output by path prefix
count_captured_by_path() {
  local prefix="$1"
  if [[ ! -f "$CAPTURE_OUTPUT" ]]; then echo "0"; return; fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    console.log(data.filter(r => r.path.startsWith(process.argv[2])).length);
  " "$CAPTURE_OUTPUT" "$prefix" 2>/dev/null || echo "0"
}

# Find a captured request body field by method+path
captured_has_status() {
  local status="$1"
  if [[ ! -f "$CAPTURE_OUTPUT" ]]; then echo "false"; return; fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const found = data.some(r => {
      try { return JSON.parse(r.body).status === process.argv[2]; } catch { return false; }
    });
    console.log(found);
  " "$CAPTURE_OUTPUT" "$status" 2>/dev/null || echo "false"
}

# DX-164 Phase 6 — multi-worker test seeds alice/bob/charlie into the
# operator's `<repo>/.danxbot/settings.json` and may write fixture YAMLs.
# These globals let the EXIT trap restore them even when `set -e` aborts
# mid-test. Empty strings = nothing to roll back.
MW_SETTINGS_FILE=""
MW_SETTINGS_BACKUP=""
MW_FIXTURE_PATHS=""

cleanup() {
  stop_capture_server
  if [[ -n "${CAPTURE_OUTPUT:-}" && -f "$CAPTURE_OUTPUT" ]]; then
    rm -f "$CAPTURE_OUTPUT"
  fi
  # Restore the multi-worker test's mutated state on every exit path,
  # including `set -e` aborts mid-helper. Idempotent — guarded on the
  # globals being set at all.
  if [[ -n "$MW_SETTINGS_FILE" && -n "$MW_SETTINGS_BACKUP" ]]; then
    _multi_worker_restore_settings "$MW_SETTINGS_FILE" "$MW_SETTINGS_BACKUP" || true
    MW_SETTINGS_FILE=""
    MW_SETTINGS_BACKUP=""
  fi
  if [[ -n "$MW_FIXTURE_PATHS" ]]; then
    # shellcheck disable=SC2086
    rm -f $MW_FIXTURE_PATHS 2>/dev/null || true
    MW_FIXTURE_PATHS=""
  fi
}
trap cleanup EXIT

# --- Prerequisites ---

check_prerequisites() {
  log_header "Prerequisites"

  # Check worker is reachable
  local health
  health=$(http_get "${WORKER_URL}/health")
  local status
  status=$(json_field "$health" "status")

  if [[ "$status" == "ok" || "$status" == "degraded" ]]; then
    pass "Worker reachable at ${WORKER_URL} (status: $status)"
  else
    fail "Worker not reachable at ${WORKER_URL}"
    log "  Response: $health"
    log "\n${RED}Prerequisites failed. Ensure workers are running (make launch-worker REPO=danxbot).${NC}"
    exit 1
  fi

  # Check no orphaned temp dirs
  local stale_mcp stale_term
  stale_mcp=$(find /tmp -maxdepth 1 -name "danxbot-mcp-*" -mmin +60 2>/dev/null | wc -l)
  stale_term=$(find /tmp -maxdepth 1 -name "danxbot-term-*" -mmin +60 2>/dev/null | wc -l)
  if [[ "$stale_mcp" -eq 0 && "$stale_term" -eq 0 ]]; then
    pass "No stale temp dirs"
  else
    log_info "Found $stale_mcp stale MCP dirs, $stale_term stale terminal dirs (consider cleanup)"
  fi

  # Check ANTHROPIC_API_KEY is set (needed for dispatch tests)
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    pass "ANTHROPIC_API_KEY is set"
  else
    fail "ANTHROPIC_API_KEY not set — dispatch tests will fail"
    exit 1
  fi
}

# --- Test Functions ---

test_health() {
  log_header "test-system-health"
  local start_time=$SECONDS

  local health
  health=$(http_get "${WORKER_URL}/health")

  local status db_connected uptime repo
  status=$(json_field "$health" "status")
  db_connected=$(json_field "$health" "db_connected")
  uptime=$(json_field "$health" "uptime_seconds")
  repo=$(json_field "$health" "repo")

  if [[ "$status" == "ok" ]]; then
    pass "Status is ok"
  else
    fail "Status is '$status' (expected ok)"
  fi

  if [[ "$db_connected" == "true" ]]; then
    pass "db_connected is true"
  else
    fail "db_connected is '$db_connected' (expected true)"
  fi

  if [[ -n "$uptime" && "$uptime" -gt 0 ]]; then
    pass "uptime_seconds is $uptime (> 0)"
  else
    fail "uptime_seconds is '$uptime' (expected > 0)"
  fi

  log_info "Worker repo: $repo ($((SECONDS - start_time))s)"
}

test_dispatch() {
  log_header "test-system-dispatch"
  local start_time=$SECONDS

  # Launch a simple read-only task. The API accepts only
  # `{repo, workspace, task, overlay?}` — no per-tool allowlist exists
  # anywhere in the dispatch pipeline. The `system-test` workspace
  # declares no MCP servers; the danxbot infrastructure server (with
  # `danxbot_complete`) is merged in by the dispatch core, and claude
  # built-ins are all available by default — exactly what this and the
  # other happy-path tests (heartbeat, cancel, error) need.
  local launch_response
  launch_response=$(http_post "${WORKER_URL}/api/launch" "{
    \"workspace\": \"system-test\",
    \"task\": \"Read the file package.json and report the project name. Reply with just the name, nothing else.\",
    \"api_token\": \"${API_TOKEN}\"
  }")

  local job_id
  job_id=$(json_field "$launch_response" "job_id")
  local launch_status
  launch_status=$(json_field "$launch_response" "status")

  if [[ "$launch_status" == "launched" && -n "$job_id" ]]; then
    pass "Job launched (id: $job_id)"
  else
    fail "Launch failed: $launch_response"
    return
  fi

  # Poll until completion
  log_info "Polling status (timeout: 120s)..."
  local final_response
  if final_response=$(poll_status "$job_id" 120 2); then
    local final_status summary
    final_status=$(json_field "$final_response" "status")
    summary=$(json_field "$final_response" "summary")

    if [[ "$final_status" == "completed" ]]; then
      pass "Status is completed"
    else
      fail "Status is '$final_status' (expected completed)"
    fi

    if [[ -n "$summary" && "$summary" != "undefined" ]]; then
      pass "Summary is non-empty"
    else
      fail "Summary is empty"
    fi
  else
    fail "Job did not complete within 120s"
  fi

  local elapsed=$((SECONDS - start_time))
  if [[ $elapsed -lt 120 ]]; then
    pass "Completed in ${elapsed}s (< 120s)"
  else
    fail "Took ${elapsed}s (expected < 120s)"
  fi
}

test_heartbeat() {
  log_header "test-system-heartbeat"
  local start_time=$SECONDS

  # When the worker is in Docker, the capture server on the host isn't reachable
  # (Docker containers can't connect to arbitrary host ports on WSL2/Linux).
  # In Docker mode: verify dispatch + status lifecycle (heartbeat fires internally).
  # In host mode: use capture server for full HTTP verification.
  if [[ "$CAPTURE_HOST" != "127.0.0.1" ]] && ! $HOST_MODE; then
    detect_capture_host  # Ensure CAPTURE_HOST is set

    # Docker mode: verify via status API only
    local launch_response
    launch_response=$(http_post "${WORKER_URL}/api/launch" "{
      \"workspace\": \"system-test\",
      \"task\": \"Read every TypeScript file in src/ and list the filename of each one. Just filenames, one per line.\",
      \"api_token\": \"${API_TOKEN}\"
    }")

    local job_id
    job_id=$(json_field "$launch_response" "job_id")

    if [[ -z "$job_id" ]]; then
      fail "Launch failed: $launch_response"
      return
    fi
    pass "Job launched (id: $job_id)"

    # Poll and verify the job transitions through running -> completed
    local saw_running=false
    local elapsed=0
    while [[ $elapsed -lt 120 ]]; do
      local response
      response=$(http_get "${WORKER_URL}/api/status/${job_id}")
      local status
      status=$(json_field "$response" "status")
      if [[ "$status" == "running" ]]; then
        saw_running=true
      fi
      if [[ "$status" != "running" && -n "$status" ]]; then
        break
      fi
      sleep 2
      elapsed=$((elapsed + 2))
    done

    if [[ "$saw_running" == "true" ]]; then
      pass "Observed running status (heartbeat active internally)"
    else
      log_info "Job completed before running status observed (fast task)"
    fi

    local final_response
    final_response=$(http_get "${WORKER_URL}/api/status/${job_id}")
    local final_status
    final_status=$(json_field "$final_response" "status")
    if [[ "$final_status" == "completed" ]]; then
      pass "Job completed successfully"
    else
      fail "Final status is '$final_status' (expected completed)"
    fi

    local summary
    summary=$(json_field "$final_response" "summary")
    if [[ -n "$summary" && "$summary" != "undefined" ]]; then
      pass "Summary is non-empty"
    else
      fail "Summary is empty"
    fi

    log_info "Docker mode — capture server skipped (host ports not reachable from container)"
    log_info "Completed in $((SECONDS - start_time))s"
    return
  fi

  # Host mode: full capture server verification
  start_capture_server || return

  local capture_base="http://${CAPTURE_HOST}:${CAPTURE_PORT}"

  local launch_response
  launch_response=$(http_post "${WORKER_URL}/api/launch" "{
    \"workspace\": \"system-test\",
    \"task\": \"Read every TypeScript file in src/ and list the filename of each one. Just filenames, one per line.\",
    \"api_token\": \"${API_TOKEN}\",
    \"status_url\": \"${capture_base}/status\"
  }")

  local job_id
  job_id=$(json_field "$launch_response" "job_id")

  if [[ -z "$job_id" ]]; then
    fail "Launch failed: $launch_response"
    stop_capture_server
    return
  fi
  pass "Job launched with status_url (id: $job_id)"

  log_info "Waiting for completion (timeout: 120s)..."
  poll_status "$job_id" 120 2 >/dev/null || true
  sleep 2
  stop_capture_server

  if [[ -f "$CAPTURE_OUTPUT" ]]; then
    local put_count
    put_count=$(count_captured "PUT")

    local has_completed
    has_completed=$(captured_has_status "completed")
    if [[ "$has_completed" == "true" ]]; then
      pass "Received completed PUT"
    else
      fail "No completed PUT received"
    fi

    local has_running
    has_running=$(captured_has_status "running")
    if [[ "$has_running" == "true" ]]; then
      pass "Received running PUT (heartbeat)"
    else
      log_info "No running PUT received (task may have completed before heartbeat fired)"
    fi

    local post_count
    post_count=$(count_captured_by_path "/events")
    if [[ "$post_count" -gt 0 ]]; then
      pass "Received $post_count event POST(s)"
    else
      fail "No event POSTs received"
    fi

    log_info "Total captured: $put_count PUTs, $post_count event POSTs"
  else
    fail "No capture output file found"
  fi

  log_info "Completed in $((SECONDS - start_time))s"
}

test_cancel() {
  log_header "test-system-cancel"
  local start_time=$SECONDS

  # Launch a long-running task (no status_url needed — verify via status API)
  local launch_response
  launch_response=$(http_post "${WORKER_URL}/api/launch" "{
    \"workspace\": \"system-test\",
    \"task\": \"Read every file in src/ and write a detailed analysis of each file. Include line counts, function names, and complexity analysis for every file.\",
    \"api_token\": \"${API_TOKEN}\"
  }")

  local job_id
  job_id=$(json_field "$launch_response" "job_id")

  if [[ -z "$job_id" ]]; then
    fail "Launch failed: $launch_response"
    return
  fi
  pass "Long-running job launched (id: $job_id)"

  # Wait for agent to start working
  log_info "Waiting 8s for agent to start..."
  sleep 8

  # Verify it's still running
  local status_response
  status_response=$(http_get "${WORKER_URL}/api/status/${job_id}")
  local pre_cancel_status
  pre_cancel_status=$(json_field "$status_response" "status")

  if [[ "$pre_cancel_status" == "running" ]]; then
    pass "Job is running before cancel"
  else
    log_info "Job already finished (status: $pre_cancel_status) — cancel test inconclusive"
    return
  fi

  # Cancel the job
  local cancel_response
  cancel_response=$(http_post "${WORKER_URL}/api/cancel/${job_id}" "{\"api_token\": \"${API_TOKEN}\"}")
  local cancel_status
  cancel_status=$(json_field "$cancel_response" "status")

  if [[ "$cancel_status" == "canceled" ]]; then
    pass "Cancel endpoint returned canceled"
  else
    fail "Cancel returned '$cancel_status' (expected canceled)"
  fi

  # Poll to confirm final status
  sleep 2
  local final_response
  final_response=$(http_get "${WORKER_URL}/api/status/${job_id}")
  local final_status
  final_status=$(json_field "$final_response" "status")

  if [[ "$final_status" == "canceled" ]]; then
    pass "Final status is canceled"
  else
    fail "Final status is '$final_status' (expected canceled)"
  fi

  log_info "Completed in $((SECONDS - start_time))s"
}

test_error() {
  log_header "test-system-error"
  local start_time=$SECONDS

  # Launch a task designed to fail — use an invalid MCP tool reference
  local launch_response
  launch_response=$(http_post "${WORKER_URL}/api/launch" "{
    \"workspace\": \"system-test\",
    \"task\": \"This is a system test. Use the mcp__nonexistent__tool tool to do something impossible.\",
    \"api_token\": \"${API_TOKEN}\"
  }")

  local job_id
  job_id=$(json_field "$launch_response" "job_id")

  if [[ -z "$job_id" ]]; then
    fail "Launch failed: $launch_response"
    return
  fi
  pass "Error-inducing job launched (id: $job_id)"

  # Wait for completion — the agent should finish quickly
  log_info "Waiting for completion (timeout: 120s)..."
  local final_response
  if final_response=$(poll_status "$job_id" 120 2); then
    local final_status summary
    final_status=$(json_field "$final_response" "status")
    summary=$(json_field "$final_response" "summary")

    # Agent will likely "complete" even with invalid tool — Claude handles gracefully
    if [[ "$final_status" == "failed" || "$final_status" == "completed" ]]; then
      pass "Job reached terminal status: $final_status"
    else
      fail "Job status is '$final_status' (expected failed or completed)"
    fi

    if [[ -n "$summary" && "$summary" != "undefined" ]]; then
      pass "Summary is non-empty: $(echo "$summary" | head -c 80)..."
    else
      fail "Summary is empty"
    fi
  else
    fail "Job did not complete within 120s"
  fi

  log_info "Completed in $((SECONDS - start_time))s"
}

test_stall() {
  log_header "test-system-stall"

  if [[ "$HOST_MODE" != "true" ]]; then
    skip "Stall detection test requires --host-mode flag"
    return
  fi

  # Stall detection depends on Phase 4 redesign (✻-based detection)
  skip "Stall detection test deferred to Phase 4 (requires ✻-based redesign)"
}

test_poller() {
  log_header "test-system-poller"

  # This test requires Trello API credentials and a running poller.
  # It creates a real card, waits for the poller to process it, and cleans up.
  # Skipped by default since it requires a full environment setup.
  #
  # Isolation: writes overrides.issuePoller.pickupNamePrefix into the
  # repo's settings.json BEFORE creating the card so the poller only
  # picks up cards starting with the test prefix. Without this filter, a
  # pre-existing real ToDo card (or a stuck in-flight dispatch) races the
  # test card and the 120s pickup deadline expires while the worker is
  # busy with unrelated work. Cleared on every exit path. See Trello
  # `IleofrBj` and `getIssuePollerPickupPrefix` in `src/settings-file.ts`.

  if [[ -z "${TRELLO_API_KEY:-}" || -z "${TRELLO_API_TOKEN:-}" ]]; then
    skip "Poller test requires TRELLO_API_KEY and TRELLO_API_TOKEN env vars"
    return
  fi

  local start_time=$SECONDS
  local board_id="${TRELLO_BOARD_ID:-69ddc215fd43f1b7f1a710f2}"
  local todo_list="${TRELLO_TODO_LIST_ID:-69ddc38d9322fe56867b9de4}"
  local done_list="${TRELLO_DONE_LIST_ID:-69ddc38c53a99eda3c237f2b}"
  local in_progress_list="${TRELLO_IN_PROGRESS_LIST_ID:-69ddc39f8208297c5bf74a32}"
  local feature_label="${TRELLO_FEATURE_LABEL_ID:-69ddc215fd43f1b7f1a7117d}"

  local repo_dir="${PROJECT_ROOT}/repos/danxbot"
  local settings_file="${repo_dir}/.danxbot/settings.json"
  local pickup_prefix="[System Test]"

  # Engage the poller filter before doing anything else. The repo's worker
  # re-reads settings on every poll tick — no restart required.
  if ! _poller_set_pickup_prefix "$settings_file" "$pickup_prefix"; then
    fail "Failed to write pickupNamePrefix to $settings_file"
    return
  fi
  log_info "Engaged poller pickupNamePrefix=\"${pickup_prefix}\""

  # Clear any pre-existing CRITICAL_FAILURE flag from a prior test run.
  # The flag halts the poller until cleared, so a leftover from yesterday
  # would silently block today's run forever. Idempotent on no-flag.
  curl -s --max-time 10 -X DELETE \
    "${WORKER_URL}/api/poller/critical-failure" >/dev/null 2>&1 || true

  # Cancel any in-flight dispatches so the worker's `teamRunning` slot is
  # free for our test card. Without this step, a pre-existing dispatch
  # (e.g. a stuck card with a 1-hour inactivity timeout that the poller
  # already picked up before the filter was set) blocks every subsequent
  # poll tick — the test waits forever even though the filter is correct.
  # See Trello `IleofrBj` for the empirical reproduction. Best-effort: a
  # 404 / 409 / network error here just means there was nothing to cancel,
  # which is the steady-state happy path on a clean worker.
  local jobs_response
  jobs_response=$(http_get "${WORKER_URL}/api/jobs")
  local jobs_to_cancel
  jobs_to_cancel=$(node -e '
    const data = JSON.parse(process.argv[1] || "{}");
    const ids = (data.jobs || [])
      .filter((j) => j.status === "running")
      .map((j) => j.job_id);
    process.stdout.write(ids.join("\n"));
  ' "$jobs_response" 2>/dev/null)
  if [[ -n "$jobs_to_cancel" ]]; then
    while IFS= read -r jid; do
      [[ -z "$jid" ]] && continue
      log_info "Cancelling pre-existing in-flight job $jid"
      http_post "${WORKER_URL}/api/cancel/${jid}" "{\"api_token\":\"${API_TOKEN}\"}" >/dev/null 2>&1 || true
    done <<< "$jobs_to_cancel"
    # Give the worker a beat to release `teamRunning` so the next poll
    # tick (every 60s) finds it free. Cancel sends SIGTERM and waits up
    # to 5s for graceful exit before SIGKILL — 8s covers both branches.
    # Then clear any CRITICAL_FAILURE flag the post-dispatch check wrote
    # in response to our cancellation: the canceled card stayed in ToDo
    # because we killed it, not because of an env-level blocker — the
    # halt-flag semantics don't apply to operator-initiated cancels.
    # Without this clear, the poller halts and the test card never gets
    # picked up. Endpoint is idempotent on a missing flag (DELETE /api/
    # poller/critical-failure returns 200 either way).
    sleep 8
    curl -s --max-time 10 -X DELETE \
      "${WORKER_URL}/api/poller/critical-failure" >/dev/null 2>&1 || true
    log_info "Cleared CRITICAL_FAILURE flag (post-cancel housekeeping)"
  fi

  # Create a test card in ToDo
  local card_name="${pickup_prefix} Read package.json name — $(date +%s)"
  local card_desc="System test card. Read package.json and report the project name. Auto-created, safe to delete."
  local card_response
  card_response=$(curl -s --max-time 10 -X POST \
    "https://api.trello.com/1/cards?key=${TRELLO_API_KEY}&token=${TRELLO_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${card_name}\",\"desc\":\"${card_desc}\",\"idList\":\"${todo_list}\",\"idLabels\":[\"${feature_label}\"],\"pos\":\"top\"}" \
    2>/dev/null)

  local card_id
  card_id=$(json_field "$card_response" "id")

  if [[ -z "$card_id" ]]; then
    fail "Failed to create test card: $card_response"
    _poller_clear_pickup_prefix "$settings_file"
    return
  fi
  pass "Test card created (id: $card_id)"

  # Poll for card to move to In Progress (poller picks it up)
  log_info "Waiting for poller to pick up card (timeout: 120s)..."
  local elapsed=0
  local card_list=""
  while [[ $elapsed -lt 120 ]]; do
    local card_data
    # `|| true` keeps a transient curl/DNS failure (exit 6 / 7) from
    # tripping `set -e` mid-poll — `card_data` becomes empty, the
    # next json_field returns "", and the loop just retries on the
    # next sleep iteration. Without this, one DNS hiccup ends the
    # whole test instead of being absorbed by the retry budget.
    card_data=$(curl -s --max-time 10 \
      "https://api.trello.com/1/cards/${card_id}?key=${TRELLO_API_KEY}&token=${TRELLO_API_TOKEN}" \
      2>/dev/null || true)
    card_list=$(json_field "$card_data" "idList")
    if [[ "$card_list" == "$in_progress_list" || "$card_list" == "$done_list" ]]; then
      break
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  if [[ "$card_list" == "$in_progress_list" || "$card_list" == "$done_list" ]]; then
    pass "Card moved to In Progress or Done"
  else
    fail "Card still in original list after 120s — pickupNamePrefix filter failed to deliver the card. Check worker logs for the filter line ('pickupNamePrefix=...') and confirm settings.json was written before the card was created."
    # Cleanup
    curl -s -X DELETE "https://api.trello.com/1/cards/${card_id}?key=${TRELLO_API_KEY}&token=${TRELLO_API_TOKEN}" >/dev/null 2>&1
    _poller_clear_pickup_prefix "$settings_file"
    return
  fi

  # Wait for card to move to Done (agent completes)
  if [[ "$card_list" != "$done_list" ]]; then
    log_info "Waiting for agent to complete (timeout: 180s)..."
    elapsed=0
    while [[ $elapsed -lt 180 ]]; do
      local card_data
      card_data=$(curl -s --max-time 10 \
        "https://api.trello.com/1/cards/${card_id}?key=${TRELLO_API_KEY}&token=${TRELLO_API_TOKEN}" \
        2>/dev/null)
      card_list=$(json_field "$card_data" "idList")
      if [[ "$card_list" == "$done_list" ]]; then
        break
      fi
      sleep 5
      elapsed=$((elapsed + 5))
    done
  fi

  if [[ "$card_list" == "$done_list" ]]; then
    pass "Card moved to Done"
  else
    fail "Card not in Done after 180s (current list: $card_list)"
  fi

  # Check for retro comment
  local comments
  comments=$(curl -s --max-time 10 \
    "https://api.trello.com/1/cards/${card_id}/actions?filter=commentCard&key=${TRELLO_API_KEY}&token=${TRELLO_API_TOKEN}" \
    2>/dev/null)
  local comment_count
  comment_count=$(node -e "console.log(JSON.parse(process.argv[1]).length)" "$comments" 2>/dev/null || echo "0")

  if [[ "$comment_count" -gt 0 ]]; then
    pass "Card has $comment_count comment(s) (retro)"
  else
    log_info "No comments found on card (retro comment may not have been added)"
  fi

  # Cleanup: delete the test card and clear the poller filter
  curl -s -X DELETE "https://api.trello.com/1/cards/${card_id}?key=${TRELLO_API_KEY}&token=${TRELLO_API_TOKEN}" >/dev/null 2>&1
  pass "Test card cleaned up"
  _poller_clear_pickup_prefix "$settings_file"
  log_info "Cleared poller pickupNamePrefix"

  log_info "Completed in $((SECONDS - start_time))s"
}

# Helper: write a `pickupNamePrefix` into the repo's settings.json so the
# poller only dispatches matching cards. Merges into existing settings via
# node so unrelated overrides / display sections survive. Stamps the
# writer as `setup` (the closest existing SettingsWriter literal — the
# system test runner is operator-driven, not the dashboard). Returns
# non-zero on failure so the caller can `fail` cleanly.
_poller_set_pickup_prefix() {
  local settings_file="$1"
  local prefix="$2"
  mkdir -p "$(dirname "$settings_file")"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const prefix = process.argv[2];
    let cur = {
      overrides: {
        slack: { enabled: null },
        issuePoller: { enabled: null, pickupNamePrefix: null },
        dispatchApi: { enabled: null },
        ideator: { enabled: null },
      },
      display: {},
      meta: {},
    };
    if (fs.existsSync(path)) {
      try { cur = JSON.parse(fs.readFileSync(path, "utf-8")); } catch {}
    }
    cur.overrides = cur.overrides || {};
    cur.overrides.issuePoller = {
      ...(cur.overrides.issuePoller || {}),
      enabled: cur.overrides.issuePoller?.enabled ?? null,
      pickupNamePrefix: prefix,
    };
    cur.meta = { updatedAt: new Date().toISOString(), updatedBy: "setup" };
    fs.writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
  ' "$settings_file" "$prefix" 2>/dev/null
}

# Helper: clear `pickupNamePrefix` (set to null) and stamp meta. Always
# safe to call — missing file becomes a no-op since there's nothing
# to filter on. Used on every test_poller exit path so a failed test
# never leaves the live worker filtered to a deleted test card.
_poller_clear_pickup_prefix() {
  local settings_file="$1"
  if [[ ! -f "$settings_file" ]]; then return 0; fi
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    let cur;
    try {
      cur = JSON.parse(fs.readFileSync(path, "utf-8"));
    } catch {
      process.exit(0);
    }
    cur.overrides = cur.overrides || {};
    cur.overrides.issuePoller = {
      ...(cur.overrides.issuePoller || {}),
      enabled: cur.overrides.issuePoller?.enabled ?? null,
      pickupNamePrefix: null,
    };
    cur.meta = { updatedAt: new Date().toISOString(), updatedBy: "setup" };
    fs.writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
  ' "$settings_file" 2>/dev/null || true
}

test_yaml_memory() {
  log_header "test-system-yaml-memory"
  local start_time=$SECONDS

  # Phase 4 + Phase 5 (tracker-agnostic-agents) AC #6 verification.
  #
  # Purpose: end-to-end assertion that an agent dispatched into the
  # `issue-worker` workspace makes ZERO `mcp__trello__*` tool calls — the
  # structural guarantee delivered by:
  #   - Phase 4: removing the trello server entry from
  #     `src/poller/inject/workspaces/issue-worker/.mcp.json`
  #   - Phase 5: routing every poller hot-path tracker call (fetchOpenCards,
  #     moveToStatus, addComment, getCard, getComments) through the
  #     IssueTracker abstraction so a future Layer 3 harness booted with
  #     `DANXBOT_TRACKER=memory` would drive the entire lifecycle through
  #     MemoryTracker without any direct Trello HTTP traffic.
  #
  # The "MemoryTracker request log shows the expected fetchOpenCards/
  # moveToStatus/addComment sequence" half of the AC is verified
  # deterministically at Layer 2 by
  # `src/__tests__/integration/poller-memory-tracker.test.ts` (no Docker,
  # no real claude — drives `poll()` against a real MemoryTracker and
  # asserts on `getRequestLog()`). The Layer 3 harness here is the
  # JSONL/structural half: a real claude run from a real worker writes
  # ZERO `mcp__trello__*` entries to the session JSONL.
  #
  # Cost: 1 cheap dispatch (~$0.05). Worker need NOT be in DANXBOT_TRACKER
  # =memory mode — the assertion is structural (workspace MCP shape), not
  # dependent on the tracker backend.

  # Trigger a minimal dispatch in the issue-worker workspace. The task
  # is intentionally trivial — the agent is allowed to do anything; we
  # only assert on what's NOT in the JSONL.
  local launch_response
  launch_response=$(http_post "${WORKER_URL}/api/launch" "{
    \"workspace\": \"issue-worker\",
    \"task\": \"Reply with the single word OK and call danxbot_complete with status completed and summary OK. Do not perform any other tool calls.\",
    \"api_token\": \"${API_TOKEN}\"
  }")

  local job_id
  job_id=$(json_field "$launch_response" "job_id")

  if [[ -z "$job_id" ]]; then
    fail "Launch failed: $launch_response"
    return
  fi
  pass "Job launched (id: $job_id)"

  log_info "Polling status (timeout: 120s)..."
  local final_response final_status
  if ! final_response=$(poll_status "$job_id" 120 2); then
    fail "Job did not complete within 120s"
    return
  fi
  final_status=$(json_field "$final_response" "status")
  if [[ "$final_status" != "completed" ]]; then
    fail "Status is '$final_status' (expected completed)"
    return
  fi
  pass "Status is completed"

  # Locate the dispatched session JSONL inside the worker. Real claude
  # writes to ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. The
  # encoded cwd for a `issue-worker` dispatch is derived from
  # `<repo>/.danxbot/workspaces/issue-worker` — we don't need to
  # replicate the encoding logic; just grep every JSONL on the worker
  # for the dispatch tag.
  local container_name
  container_name=$(docker ps --filter "publish=${WORKER_PORT}" --format "{{.Names}}" 2>/dev/null | head -1)

  # Initialize empty so the `[[ -z ]]` check below is safe under `set -u`
  # even when neither runtime branch finds a JSONL.
  local jsonl_content=""

  # JSONL flush can lag dispatch completion by a few seconds (chokidar
  # debounce + claude's own write cadence). Retry the find a handful of
  # times before giving up.
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if [[ -n "$container_name" ]]; then
      # `/home/danxbot/.claude/projects` matches the danxbot user inside
      # the worker image (Dockerfile creates the danxbot user with that
      # home dir). If a future image change moves the home dir, this find
      # returns empty and the assertion below fails loud — a deliberate
      # canary so the test catches the path drift instead of silently
      # asserting against an empty string.
      jsonl_content=$(docker exec "$container_name" sh -c "
        for f in \$(find /home/danxbot/.claude/projects -name '*.jsonl' 2>/dev/null); do
          if grep -q 'danxbot-dispatch:${job_id}' \"\$f\" 2>/dev/null; then
            cat \"\$f\"
            break
          fi
        done
      " 2>/dev/null)
    else
      # Host-mode worker — JSONL on the same filesystem as the test runner.
      local matched_file
      # `-L` follows symlinks — required because DX-240 stores host-mode
      # JSONLs at `<repo>/claude-projects/<encoded>/` and symlinks
      # `~/.claude/projects/<encoded>` to that target. Without `-L`, find
      # treats the symlink as a leaf and never traverses into the JSONLs,
      # so every host-mode dispatch silently looks like "JSONL not found".
      matched_file=$(find -L "$HOME/.claude/projects" -name '*.jsonl' -exec grep -l "danxbot-dispatch:${job_id}" {} \; 2>/dev/null | head -1)
      if [[ -n "$matched_file" ]]; then
        jsonl_content=$(cat "$matched_file" 2>/dev/null)
      fi
    fi
    [[ -n "$jsonl_content" ]] && break
    sleep 2
  done

  if [[ -z "$jsonl_content" ]]; then
    fail "Could not locate dispatched session JSONL for job ${job_id}"
    return
  fi
  pass "Located session JSONL"

  # Assert: no mcp__trello__ tool calls anywhere in the JSONL. A literal
  # substring check is enough — the tool name appears verbatim in the
  # `name` field of every assistant tool_use entry.
  if echo "$jsonl_content" | grep -q 'mcp__trello__'; then
    local hit_count
    hit_count=$(echo "$jsonl_content" | grep -c 'mcp__trello__')
    fail "Session JSONL contains ${hit_count} mcp__trello__ reference(s) — workspace .mcp.json regression?"
    echo "$jsonl_content" | grep 'mcp__trello__' | head -3
    return
  fi
  pass "Zero mcp__trello__ tool calls in session JSONL"

  log_info "Completed in $((SECONDS - start_time))s"
}

test_multi_worker() {
  log_header "test-system-multi-worker"
  local start_time=$SECONDS

  # DX-164 Phase 6 — multi-worker concurrent dispatch verification.
  #
  # Two-tier shape:
  #
  # 1. Roster API surface (free, always runs): seed alice/bob/charlie
  #    into <repo>/.danxbot/settings.json#agents{}, hit
  #    `GET /api/agents?repo=<name>` via the dashboard, assert the new
  #    `busyOn` field shape per agent (absent when idle, joined-from-
  #    dispatches when busy). Restores the original settings on exit so
  #    the operator's roster survives a CI run.
  #
  # 2. Concurrent dispatch (REAL_CLAUDE=1, ~$1, opt-in): inject 3
  #    fixture cards on disjoint files into ToDo, observe the poller
  #    pick + dispatch all 3 within 30s, agent-finalize.sh squash-merge
  #    each onto main, every card move to Done. Skipped by default —
  #    requires ANTHROPIC_API_KEY, the per-agent worktrees bootstrapped
  #    via `make launch-worker`, and opens an agent-finalize.sh push
  #    race we don't want to hit on every CI run.
  #
  # The Layer 2 deterministic half (multi-agent picker honours locks,
  # conflict-check stamps blocked, agent-finalize.sh exit codes route
  # correctly) lives in Phase 5's `multi-agent-pick.test.ts` and the
  # Phase 4 `agent-finalize.test.ts`. This test is the LIVE one that
  # proves the assembled pipeline survives real concurrent dispatch.

  local repo_dir="${PROJECT_ROOT}/repos/danxbot"
  local settings_file="${repo_dir}/.danxbot/settings.json"

  if [[ ! -d "$repo_dir" ]]; then
    skip "Multi-worker test requires repos/danxbot bind-mount"
    return
  fi

  # ── Tier 1: roster surface ────────────────────────────────────────

  # Snapshot existing settings so we can restore on exit. Register the
  # backup with the global EXIT trap BEFORE mutating so a `set -e`
  # abort mid-helper still rolls back.
  local backup
  backup=$(mktemp /tmp/danxbot-mw-settings-XXXXXX.json)
  if [[ -f "$settings_file" ]]; then
    cp "$settings_file" "$backup"
  else
    echo "MISSING" > "$backup"
  fi
  MW_SETTINGS_FILE="$settings_file"
  MW_SETTINGS_BACKUP="$backup"

  # Seed three test agents into settings.json. Names, schedules, and
  # capabilities match the design spec (alice/bob/charlie, all
  # issue-worker, default schedule). Merges into existing settings via
  # node so the operator's overrides + display sections survive — the
  # Tier 1 surface check intentionally only mutates `agents`.
  if ! _multi_worker_seed_agents "$settings_file"; then
    fail "Failed to seed test agents into $settings_file"
    return
  fi
  log_info "Seeded alice/bob/charlie into $settings_file"

  # Hit the dashboard's agents-roster endpoint (NOT the worker — the
  # roster lives on the dashboard's HTTP plane). Dashboard listens on
  # DANXBOT_DASHBOARD_PORT (default 5555).
  local dash_port="${DANXBOT_DASHBOARD_PORT:-5555}"
  # Dashboard auth — every /api endpoint requires Bearer token. Token
  # persists at ~/.config/danxbot/dashboard-token (mode 0600). Test
  # without it lands on 401 + the `|| echo '{}'` fallback fires, masking
  # the cause as "0 agents returned".
  local dash_token=""
  if [[ -f "$HOME/.config/danxbot/dashboard-token" ]]; then
    dash_token=$(cat "$HOME/.config/danxbot/dashboard-token")
  fi
  if [[ -z "$dash_token" ]]; then
    skip "Multi-worker roster needs ~/.config/danxbot/dashboard-token (run: make create-user LOCALHOST=1 USERNAME=monitor)"
    return
  fi

  local roster_response
  roster_response=$(curl -s --max-time 10 \
    -H "Authorization: Bearer ${dash_token}" \
    "http://${WORKER_HOST}:${dash_port}/api/agents?repo=danxbot" 2>/dev/null || echo '{}')

  # Tolerant of pre-existing operator agents — assert the THREE seeded
  # names (alice/bob/charlie) are present, not that the roster has
  # exactly 3 entries. A pristine roster is the rare case in real
  # operator environments; the prior strict-equal check fired a false
  # positive any time the operator had real agents configured.
  local seeded_present
  seeded_present=$(node -e '
    try {
      const r = JSON.parse(process.argv[1] || "{}");
      const names = new Set((r.agents || []).map(a => a.name));
      const want = ["alice", "bob", "charlie"];
      console.log(want.filter(n => names.has(n)).length);
    } catch { console.log(0); }
  ' "$roster_response" 2>/dev/null)

  if [[ "$seeded_present" == "3" ]]; then
    pass "Roster includes seeded alice/bob/charlie"
  else
    fail "Roster missing seeded agents ($seeded_present/3 present): $roster_response"
    return
  fi

  # busyOn is absent on every idle agent. The contract is "no key when
  # idle" (the optional field is omitted from the response object), so
  # we assert STRICTLY against `=== undefined` — emitting `null` would
  # be a contract regression. Scope to the seeded names only so
  # pre-existing operator agents that ARE busy don't fail this check.
  local idle_seeded
  idle_seeded=$(node -e '
    try {
      const r = JSON.parse(process.argv[1] || "{}");
      const seeded = new Set(["alice", "bob", "charlie"]);
      console.log((r.agents || []).filter(a => seeded.has(a.name) && a.busyOn === undefined).length);
    } catch { console.log(0); }
  ' "$roster_response" 2>/dev/null)

  if [[ "$idle_seeded" == "3" ]]; then
    pass "All 3 seeded agents reported idle (no busyOn field)"
  else
    fail "Expected 3 idle seeded agents; got $idle_seeded idle"
  fi

  # ── Tier 2: concurrent dispatch (opt-in) ──────────────────────────

  if [[ -z "${REAL_CLAUDE:-}" || "${REAL_CLAUDE}" != "1" ]]; then
    skip "Concurrent dispatch (REAL_CLAUDE=1 to enable; ~\$1)"
    return
  fi

  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    skip "Concurrent dispatch requires ANTHROPIC_API_KEY"
    return
  fi

  # Inject 3 fixture cards on disjoint files. Each agent picks one card
  # via the multi-agent picker on the next tick. Cards are minimal —
  # one tiny no-op edit + commit so the agent-finalize.sh squash-merge
  # path runs end-to-end.
  local timestamp
  timestamp=$(date +%s)
  local issues_dir="${repo_dir}/.danxbot/issues/open"
  local fixture_ids=("DX-mw-${timestamp}-1" "DX-mw-${timestamp}-2" "DX-mw-${timestamp}-3")
  local fixture_paths=("docs/multi-worker-alice.md" "docs/multi-worker-bob.md" "docs/multi-worker-charlie.md")

  # Register fixture paths with the EXIT trap BEFORE writing so an
  # abort during write still cleans up. Both open/ and closed/ paths
  # listed (the worker moves the YAML on Done — either location may
  # hold the file at trap time).
  for i in 0 1 2; do
    MW_FIXTURE_PATHS+=" ${issues_dir}/${fixture_ids[$i]}.yml"
    MW_FIXTURE_PATHS+=" ${repo_dir}/.danxbot/issues/closed/${fixture_ids[$i]}.yml"
  done
  for i in 0 1 2; do
    _multi_worker_write_fixture \
      "${issues_dir}/${fixture_ids[$i]}.yml" \
      "${fixture_ids[$i]}" \
      "${fixture_paths[$i]}"
  done
  log_info "Injected 3 fixture cards into ${issues_dir}"

  # Wait for the poller to dispatch each card (next tick is up to 60s
  # away, then ~10s spawn latency per agent).
  log_info "Waiting up to 90s for 3 concurrent dispatches..."
  local elapsed=0
  local dispatched=0
  while [[ $elapsed -lt 90 ]]; do
    local jobs_response
    jobs_response=$(http_get "${WORKER_URL}/api/jobs")
    dispatched=$(node -e '
      try {
        const r = JSON.parse(process.argv[1] || "{}");
        const ids = process.argv[2].split(",");
        const running = (r.jobs || []).filter(j =>
          j.status === "running" && ids.some(id => (j.tracking || "").includes(id))
        );
        console.log(running.length);
      } catch { console.log(0); }
    ' "$jobs_response" "${fixture_ids[*]// /,}" 2>/dev/null || echo 0)
    if [[ "$dispatched" == "3" ]]; then break; fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  if [[ "$dispatched" == "3" ]]; then
    pass "All 3 fixture cards dispatched concurrently within ${elapsed}s"
  else
    fail "Only $dispatched of 3 fixtures dispatched after 90s — multi-agent pick may not be enabled"
  fi

  # Wait for completion (5 min budget).
  log_info "Waiting up to 5min for all 3 cards to reach terminal state..."
  elapsed=0
  local done_count=0
  while [[ $elapsed -lt 300 ]]; do
    done_count=0
    for fid in "${fixture_ids[@]}"; do
      if [[ -f "${repo_dir}/.danxbot/issues/closed/${fid}.yml" ]]; then
        done_count=$((done_count + 1))
      fi
    done
    if [[ "$done_count" == "3" ]]; then break; fi
    sleep 10
    elapsed=$((elapsed + 10))
  done

  if [[ "$done_count" == "3" ]]; then
    pass "All 3 fixture cards reached terminal state"
  else
    fail "Only $done_count of 3 fixtures completed after 300s"
  fi

  # Verify 3 commits landed on main with conventional-commit format
  # for our fixture ids.
  local commits_landed=0
  for fid in "${fixture_ids[@]}"; do
    if (cd "$repo_dir" && git log origin/main --oneline | grep -qE "^[a-f0-9]+ feat\(${fid}\):"); then
      commits_landed=$((commits_landed + 1))
    fi
  done

  if [[ "$commits_landed" == "3" ]]; then
    pass "All 3 fixture commits landed on origin/main"
  else
    fail "Only $commits_landed of 3 fixture commits found on origin/main"
  fi

  # Fixtures + settings are restored by the EXIT trap; nothing else
  # to do here.
  log_info "Completed in $((SECONDS - start_time))s"
}

# Helper: seed alice/bob/charlie into settings.json#agents preserving
# overrides + display + agentDefaults. Idempotent — re-seeding overwrites
# the three test agent records but leaves any other agents intact (the
# operator's real roster survives the test if names don't clash).
_multi_worker_seed_agents() {
  local settings_file="$1"
  mkdir -p "$(dirname "$settings_file")"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    let cur = {
      overrides: {
        slack: { enabled: null },
        issuePoller: { enabled: null, pickupNamePrefix: null },
        dispatchApi: { enabled: null },
        ideator: { enabled: null },
      },
      display: {},
      agents: {},
      agentDefaults: { conflictCheckEnabled: false },
      meta: {},
    };
    if (fs.existsSync(path)) {
      try { cur = JSON.parse(fs.readFileSync(path, "utf-8")); } catch {}
    }
    const now = new Date().toISOString();
    const baseSchedule = {
      tz: "America/Chicago",
      mon: ["00:00-23:59"], tue: ["00:00-23:59"], wed: ["00:00-23:59"],
      thu: ["00:00-23:59"], fri: ["00:00-23:59"], sat: ["00:00-23:59"], sun: ["00:00-23:59"],
    };
    // DX-281 — MERGE alice/bob/charlie into the existing agents map.
    // Pre-DX-281 this helper wholesale-replaced `cur.agents = {}` to
    // avoid the AGENTS_MAX=5 cap when combined with operator agents.
    // The raw fs.writeFileSync below bypasses the writer-merge lock,
    // so the wipe raced the worker's `syncSettingsFileOnBoot` between
    // the wipe and the EXIT restore — the worker became the last
    // writer post-wipe (confirmed via `meta.updatedBy: "worker"`
    // stamp) and re-cemented the empty agents map under its own
    // writer tag, surviving the trap restore in some interleavings.
    // Operator-added agents now survive every `make test-system`
    // invocation; the cap (if exceeded by operator + seeded entries
    // combined) drops the trailing seeded names via `normalizeAgents`
    // on the next read, which surfaces as a visible test failure
    // rather than silent operator data loss.
    cur.agents = cur.agents || {};
    for (const name of ["alice", "bob", "charlie"]) {
      cur.agents[name] = {
        type: "agent",
        bio: `Multi-worker test agent ${name}.`,
        capabilities: ["issue-worker"],
        schedule: baseSchedule,
        enabled: true,
        created_at: cur.agents[name]?.created_at || now,
        updated_at: now,
      };
    }
    cur.meta = { updatedAt: now, updatedBy: "setup" };
    fs.writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
  ' "$settings_file" 2>/dev/null
}

# Helper: restore the settings.json snapshot taken at the top of the test.
# `$backup` containing the literal "MISSING" means the file did not exist
# before the test ran — in that case we delete it.
_multi_worker_restore_settings() {
  local settings_file="$1"
  local backup="$2"
  if [[ ! -f "$backup" ]]; then return 0; fi
  if [[ "$(cat "$backup")" == "MISSING" ]]; then
    rm -f "$settings_file"
  else
    cp "$backup" "$settings_file"
  fi
  rm -f "$backup"
}

# Helper: write a minimal multi-worker fixture YAML. The card touches one
# file (`<path>`) with a tiny no-op edit so all 3 cards land disjoint
# changes that squash-merge cleanly to main.
_multi_worker_write_fixture() {
  local target="$1"
  local id="$2"
  local file="$3"
  cat > "$target" <<EOF
schema_version: 5
tracker: trello
id: $id
external_id: ""
parent_id: null
children: []
dispatch: null
status: ToDo
type: Feature
title: "Multi-worker test fixture: append marker to $file"
description: |-
  Append the marker line "<!-- marker $id -->" to \`$file\` (create the
  file if it does not exist). Commit + finalize via agent-finalize.sh.
priority: 3
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice:
    total: 0
    i: 0
    c: 0
    e: 0
  history: []
ac:
  - check_item_id: ""
    title: "Marker line appended to $file"
    checked: false
comments: []
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
waiting_on: null
blocked: null
assigned_agent: null
EOF
}

test_cleanup() {
  log_header "test-system-cleanup"

  # Check for orphaned temp dirs
  local stale_mcp stale_term
  stale_mcp=$(find /tmp -maxdepth 1 -name "danxbot-mcp-*" -mmin +60 2>/dev/null | wc -l)
  stale_term=$(find /tmp -maxdepth 1 -name "danxbot-term-*" -mmin +60 2>/dev/null | wc -l)

  if [[ "$stale_mcp" -eq 0 ]]; then
    pass "No orphaned MCP temp dirs (older than 1 hour)"
  else
    fail "Found $stale_mcp orphaned MCP temp dirs"
    # `find | head` under `set -o pipefail` exits 141 (SIGPIPE) when find
    # has more than 5 hits — kills the whole script before later tests
    # run. Buffer find into an array and slice instead.
    local stale_dirs
    mapfile -t stale_dirs < <(find /tmp -maxdepth 1 -name "danxbot-mcp-*" -mmin +60 2>/dev/null)
    local i
    for i in 0 1 2 3 4; do
      [[ -n "${stale_dirs[$i]:-}" ]] && log_info "  ${stale_dirs[$i]}"
    done
  fi

  if [[ "$stale_term" -eq 0 ]]; then
    pass "No orphaned terminal temp dirs (older than 1 hour)"
  else
    fail "Found $stale_term orphaned terminal temp dirs"
    local stale_term_dirs
    mapfile -t stale_term_dirs < <(find /tmp -maxdepth 1 -name "danxbot-term-*" -mmin +60 2>/dev/null)
    local j
    for j in 0 1 2 3 4; do
      [[ -n "${stale_term_dirs[$j]:-}" ]] && log_info "  ${stale_term_dirs[$j]}"
    done
  fi

  # Check for zombie running jobs
  local status_response
  status_response=$(http_get "${WORKER_URL}/health")
  local worker_status
  worker_status=$(json_field "$status_response" "status")

  if [[ "$worker_status" == "ok" || "$worker_status" == "degraded" ]]; then
    pass "Worker is healthy (no zombie state detected)"
  else
    fail "Worker unhealthy: $worker_status"
  fi
}

# --- Main ---

main() {
  TOTAL_START=$SECONDS

  # Clear log file
  echo "Danxbot System Tests — $(date)" > "$LOG_FILE"
  echo "Worker: ${WORKER_URL}" >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"

  log "${BOLD}Danxbot System Tests${NC}"
  log "Worker: ${WORKER_URL}"
  log "Log: ${LOG_FILE}"

  check_prerequisites

  if [[ -n "$SINGLE_TEST" ]]; then
    case "$SINGLE_TEST" in
      health)      test_health ;;
      dispatch)    test_dispatch ;;
      heartbeat)   test_heartbeat ;;
      cancel)      test_cancel ;;
      error)       test_error ;;
      stall)       test_stall ;;
      poller)      test_poller ;;
      yaml-memory) test_yaml_memory ;;
      multi-worker) test_multi_worker ;;
      cleanup)     test_cleanup ;;
      *) log "${RED}Unknown test: $SINGLE_TEST${NC}"; exit 1 ;;
    esac
  else
    test_health
    test_dispatch
    test_heartbeat
    test_cancel
    test_error
    test_stall
    test_poller
    test_yaml_memory
    test_multi_worker
    test_cleanup
  fi

  # Summary
  local total_time=$((SECONDS - TOTAL_START))
  log ""
  log "${BOLD}━━━ Results ━━━${NC}"
  log "  ${GREEN}Passed:${NC}  $PASS"
  log "  ${RED}Failed:${NC}  $FAIL"
  log "  ${YELLOW}Skipped:${NC} $SKIP"
  log "  Time:    ${total_time}s"
  log ""

  if [[ $FAIL -gt 0 ]]; then
    log "${RED}${BOLD}FAILED${NC} — $FAIL test(s) failed"
    exit 1
  else
    log "${GREEN}${BOLD}PASSED${NC} — all tests passed"
    exit 0
  fi
}

main
