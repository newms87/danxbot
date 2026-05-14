#!/usr/bin/env bash
#
# Danxbot Per-Card Chat — System Test (DX-348 Phase 3 / DX-351)
#
# Exercises the `/api/chat` route end-to-end via the integration test
# at `src/__tests__/integration/chat-flow.test.ts`. The integration
# test:
#
#   - boots a real worker HTTP server,
#   - posts JSON bodies over real HTTP loopback,
#   - mocks `dispatch()` to capture the input + return a synthetic
#     dispatchId (no Claude API spend, no spawn),
#   - asserts the chat-sessions record round-trips to disk.
#
# Validates:
#   - FRESH path (no prior record) → 200 + task = "/danx-chat <id> + text"
#     + chat-sessions JSON persisted with the new dispatch id.
#   - Malformed issue_id → 400 (regex `<PREFIX>-N`).
#   - Missing text → 400.
#   - Missing issue_id → 400.
#   - GET /api/chat → 404 (POST-only).
#
# Cost: free.
#
# Usage:
#   ./src/__tests__/system/run-chat-system-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}=== Per-card chat — system test ===${NC}"
echo -e "${CYAN}→${NC} Driving /api/chat via chat-flow integration test"
echo

cd "$PROJECT_ROOT"

if npx vitest run --reporter=verbose src/__tests__/integration/chat-flow.test.ts; then
  echo
  echo -e "${GREEN}${BOLD}✓ Per-card chat system test PASSED${NC}"
  exit 0
else
  echo
  echo -e "${RED}${BOLD}✗ Per-card chat system test FAILED${NC}"
  exit 1
fi
