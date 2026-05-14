#!/usr/bin/env bash
#
# Danxbot Card Flesh-Out — System Test (DX-348 Phase 1 / DX-349)
#
# Exercises the `/api/flesh-out` route end-to-end via the integration
# test at `src/__tests__/integration/flesh-out-flow.test.ts`. The
# integration test:
#
#   - boots a real worker HTTP server,
#   - posts JSON bodies over real HTTP loopback,
#   - mocks `dispatch()` to capture the input + return a synthetic
#     dispatchId (no Claude API spend, no spawn).
#
# Validates:
#   - happy path        → 200 + dispatch called with the right
#                         workspace / task / issueId.
#   - malformed issue_id → 400 (regex `<PREFIX>-N`).
#   - missing issue_id   → 400.
#   - GET /api/flesh-out → 404 (POST-only).
#
# Cost: free.
#
# Usage:
#   ./src/__tests__/system/run-flesh-out-system-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}=== Card flesh-out — system test ===${NC}"
echo -e "${CYAN}→${NC} Driving /api/flesh-out via flesh-out-flow integration test"
echo

cd "$PROJECT_ROOT"

if npx vitest run --reporter=verbose src/__tests__/integration/flesh-out-flow.test.ts; then
  echo
  echo -e "${GREEN}${BOLD}✓ Card flesh-out system test PASSED${NC}"
  exit 0
else
  echo
  echo -e "${RED}${BOLD}✗ Card flesh-out system test FAILED${NC}"
  exit 1
fi
